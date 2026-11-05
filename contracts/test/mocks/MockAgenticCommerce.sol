// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAgenticCommerce} from "../../interfaces/IAgenticCommerce.sol";

/// @notice Test-only mirror of Arc's deployed AgenticCommerce (proxy 0x0747...4583, verified ABI).
///         Deliberately faithful in the ways that shaped SQController:
///         - getJob returns 9 fields and NO deliverable; the deliverable exists only in JobSubmitted.
///         - complete is evaluator-only and needs Submitted; reject is client-only in Open and
///           evaluator-only in Funded/Submitted.
///         - There is no Submitted -> Funded transition and no resubmit.
///         - platformFeeBP / evaluatorFeeBP are charged on complete only; the evaluator cut is paid to job.evaluator.
///         - claimRefund is permissionless once block.timestamp >= expiredAt.
///         - non-zero hooks must be whitelisted.
///         Quirks confirmed on the real kernel via the Arc fork tests (contracts/test-integration):
///         - createJob requires expiredAt > block.timestamp + 5 minutes (else ExpiryTooShort).
///         - setBudget is provider-only (client gets Unauthorized).
///         - fund reverts (WrongStatus) once block.timestamp >= expiredAt, and accepts budget 0 (no transfer).
///         - submit is allowed from Open when budget is 0, so a Submitted never-funded job can exist.
contract MockAgenticCommerce {
    using SafeERC20 for IERC20;

    IERC20 public immutable paymentToken;
    uint256 public platformFeeBP;
    address public platformTreasury;
    uint256 public evaluatorFeeBP;
    uint256 public jobCounter;
    mapping(address => bool) public whitelistedHooks;

    mapping(uint256 => IAgenticCommerce.Job) private _jobs;
    mapping(uint256 => bytes32) private _deliverables; // not exposed by getJob (like the real contract)
    mapping(uint256 => bool) public jobHasBudget;

    event JobCreated(
        uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook
    );
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    error InvalidJob();
    error WrongStatus();
    error Unauthorized();
    error ZeroAddress();
    error ExpiryTooShort();
    error ZeroBudget();
    error ProviderNotSet();
    error FeesTooHigh();
    error HookNotWhitelisted();
    error ForcedCompleteFailure();

    /// @dev TEST TOGGLE ONLY: when set, complete() reverts so atomicity of callers can be exercised.
    bool public testOnly_failComplete;

    constructor(IERC20 token) {
        paymentToken = token;
        platformTreasury = address(0xFEE);
    }

    // ---------------------------------------------------------------- test-only admin
    function setPlatformFee(uint256 feeBP_, address treasury_) external {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBP_ + evaluatorFeeBP > 10000) revert FeesTooHigh();
        platformFeeBP = feeBP_;
        platformTreasury = treasury_;
    }

    function setEvaluatorFee(uint256 feeBP_) external {
        if (feeBP_ + platformFeeBP > 10000) revert FeesTooHigh();
        evaluatorFeeBP = feeBP_;
    }

    function testOnly_setFailComplete(bool fail) external {
        testOnly_failComplete = fail;
    }

    function setHookWhitelist(address hook, bool status) external {
        whitelistedHooks[hook] = status;
    }

    /// @dev TEST HELPER ONLY. The real contract has no such getter; SQController must never rely on one.
    function testOnly_deliverable(uint256 jobId) external view returns (bytes32) {
        return _deliverables[jobId];
    }

    // ---------------------------------------------------------------- lifecycle
    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook)
        external
        returns (uint256 jobId)
    {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp + 5 minutes) revert ExpiryTooShort();
        if (hook != address(0) && !whitelistedHooks[hook]) revert HookNotWhitelisted();
        jobId = ++jobCounter;
        _jobs[jobId] = IAgenticCommerce.Job({
            id: jobId,
            client: msg.sender,
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: IAgenticCommerce.JobStatus.Open,
            hook: hook
        });
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
    }

    function setProvider(uint256 jobId, address provider_) external {
        IAgenticCommerce.Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != IAgenticCommerce.JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (provider_ == address(0)) revert ZeroAddress();
        job.provider = provider_;
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external {
        IAgenticCommerce.Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != IAgenticCommerce.JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        job.budget = amount;
        jobHasBudget[jobId] = true;
        emit BudgetSet(jobId, amount);
    }

    function fund(uint256 jobId, bytes calldata) external {
        IAgenticCommerce.Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != IAgenticCommerce.JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();
        job.status = IAgenticCommerce.JobStatus.Funded;
        if (job.budget > 0) paymentToken.safeTransferFrom(job.client, address(this), job.budget);
        emit JobFunded(jobId, job.client, job.budget);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external {
        IAgenticCommerce.Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        bool neverFunded = job.status == IAgenticCommerce.JobStatus.Open && job.budget == 0;
        if (job.status != IAgenticCommerce.JobStatus.Funded && !neverFunded) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        job.status = IAgenticCommerce.JobStatus.Submitted;
        _deliverables[jobId] = deliverable;
        emit JobSubmitted(jobId, job.provider, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata) external {
        if (testOnly_failComplete) revert ForcedCompleteFailure();
        IAgenticCommerce.Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != IAgenticCommerce.JobStatus.Submitted) revert WrongStatus();
        if (msg.sender != job.evaluator) revert Unauthorized();
        job.status = IAgenticCommerce.JobStatus.Completed;

        uint256 amount = job.budget;
        uint256 platformFee = (amount * platformFeeBP) / 10000;
        uint256 evalFee = (amount * evaluatorFeeBP) / 10000;
        uint256 net = amount - platformFee - evalFee;

        if (platformFee > 0) paymentToken.safeTransfer(platformTreasury, platformFee);
        if (evalFee > 0) {
            paymentToken.safeTransfer(job.evaluator, evalFee);
            emit EvaluatorFeePaid(jobId, job.evaluator, evalFee);
        }
        if (net > 0) paymentToken.safeTransfer(job.provider, net);

        emit JobCompleted(jobId, job.evaluator, reason);
        emit PaymentReleased(jobId, job.provider, net);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata) external {
        IAgenticCommerce.Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();

        if (job.status == IAgenticCommerce.JobStatus.Open) {
            if (msg.sender != job.client) revert Unauthorized();
        } else if (job.status == IAgenticCommerce.JobStatus.Funded || job.status == IAgenticCommerce.JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }

        IAgenticCommerce.JobStatus prev = job.status;
        job.status = IAgenticCommerce.JobStatus.Rejected;

        if (prev != IAgenticCommerce.JobStatus.Open && job.budget > 0) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
        emit JobRejected(jobId, msg.sender, reason);
    }

    function claimRefund(uint256 jobId) external {
        IAgenticCommerce.Job storage job = _jobs[jobId];
        if (job.id == 0) revert InvalidJob();
        if (job.status != IAgenticCommerce.JobStatus.Funded && job.status != IAgenticCommerce.JobStatus.Submitted) {
            revert WrongStatus();
        }
        if (block.timestamp < job.expiredAt) revert WrongStatus();
        job.status = IAgenticCommerce.JobStatus.Expired;
        if (job.budget > 0) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
        emit JobExpired(jobId);
    }

    function getJob(uint256 jobId) external view returns (IAgenticCommerce.Job memory) {
        return _jobs[jobId];
    }
}
