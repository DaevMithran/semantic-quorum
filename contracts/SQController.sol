// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IAgenticCommerce} from "./interfaces/IAgenticCommerce.sol";
import {ISQController} from "./interfaces/ISQController.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {SQVerdict} from "./libraries/SQVerdict.sol";

/// @title Semantic Quorum: ownerless, reusable ERC-8183 evaluator for Arc testnet
/// @notice Intended kernel: 0x0747EEf0706327138c69792bF28Cd525089e4583 on Arc testnet.
/// Jobs must designate this controller as evaluator and have no hook. The buyer pins an
/// authority (EOA or ERC-1271 contract), committee, policy and participant snapshot per job.
/// The controller holds only evaluator report fees, not the kernel's job escrow.
/// @dev SUBMITTING IS FINAL: REVISE exists only while the kernel job is Funded, as a
/// pre-submit draft-review loop. A Submitted job can only be ACCEPTed or REJECTed.
/// Providers should call submit only when ready for a final verdict.
///
/// ATTEST-AFTER-SUBMIT TRUST ASSUMPTION: ACCEPT requires kernel status Submitted.
/// The deployed kernel's getJob returns no deliverable; it exists only in JobSubmitted.
/// The kernel has no resubmit or Submitted-to-Funded transition, so that submitted
/// deliverable is immutable thereafter. The verdictAuthority attests that the deliverable
/// read from JobSubmitted equals the signed v.deliverable. Neither submitVerdict nor
/// settle can compare these hashes onchain. A wrong hash in a signed ACCEPT is an
/// authority fault this contract cannot detect. Reports/deficiency hashes are opaque.
///
/// SELECTION IS NOT UNBIASABLE: selectionSeed binds jobId and a recent blockhash, not
/// PREVRANDAO (which is zero on Arc). There is no VRF. Arc blocks are sub-second, so
/// the 256-block window lasts only a few minutes. The registrant chooses seedBlock
/// among the last 256 blocks and can grind up to approximately 256 seeds. The seed
/// is only not free-form; this contract cannot verify that the committee matches an
/// offchain draw. Neither evaluator IDs nor committee membership certify report quality.
///
/// ACCEPT atomically approves and completes the Submitted kernel job; completion or
/// fee-cap failure rolls back the entire verdict, including report credits and its digest.
/// The kernel is admin-upgradeable and may charge platformFeeBP/evaluatorFeeBP on
/// complete. Buyer-chosen, provider-visible caps bound how these admin-controlled fees
/// can shift value away from the provider. The platform fee reduces the provider's net;
/// the evaluator cut is paid to this contract and credited to the buyer's refundable
/// leftover, not report recipients. A higher evaluator fee thus shifts provider money
/// to the buyer, which is why it is capped too. Registration never reads live fees.
/// If live fees exceed the caps, ACCEPT reverts; the authority can retry once fees fall,
/// otherwise rejectOnTimeout refunds the buyer. Kernel upgrades can change assumptions.
/// USDC is used exclusively through its six-decimal ERC-20 interface, never msg.value.
/// This controller is non-upgradeable and has no owner, privileged setters or rescue path.
contract SQController is ISQController, IReceiver, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_COMMITTEE = 8;
    uint256 public constant MAX_REVISION_LIMIT = 10;
    uint256 public constant SEED_WINDOW = 256;
    /// @notice Minimum time between the decision deadline and kernel expiry.
    uint256 public constant MIN_SETTLE_BUFFER = 1 hours;
    bytes32 public constant TIMEOUT_REASON = keccak256("SQ_TIMEOUT");

    /// @notice Existing kernel whose jobs this evaluator services.
    IAgenticCommerce public immutable agenticCommerce;
    /// @notice Six-decimal USDC ERC-20 used for report fees and kernel fee receipts.
    IERC20 public immutable usdc;
    /// @notice CRE simulation forwarder accepted only as transport for authority-signed verdicts.
    address public immutable simulationForwarder;
    /// @notice CRE production forwarder accepted only as transport for authority-signed verdicts.
    address public immutable productionForwarder;

    mapping(uint256 jobId => JobConfig) private _configs;
    mapping(uint256 jobId => CommitteeMember[]) private _committees;
    mapping(uint256 jobId => JobState) private _states;
    mapping(address recipient => uint256 amount) private _balances;
    mapping(uint256 jobId => mapping(uint8 round => bytes32 digest)) private _verdictDigest;
    mapping(uint256 jobId => mapping(uint8 round => uint256 mask)) private _creditedMask;

    /// @notice Pins the existing kernel, USDC and CRE forwarders; no administration is installed.
    /// @param agenticCommerce_ Arc testnet AgenticCommerce kernel, not a new escrow.
    /// @param usdc_ Arc testnet six-decimal USDC ERC-20 address.
    /// @param simulationForwarder_ CRE simulation forwarder, distinct from the production forwarder.
    /// @param productionForwarder_ CRE production forwarder, distinct from the simulation forwarder.
    /// @dev All addresses must be nonzero; deployment tooling selects the intended chain/addresses.
    /// Chainlink's CRE forwarder directory (chain name arc-testnet) lists MockKeystoneForwarder
    /// 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1 for simulation and KeystoneForwarder
    /// 0x76c9cf548b4179F8901cda1f8623568b58215E62 for production, both verified onchain
    /// via typeAndVersion. See docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts.md.
    /// These addresses are deployment arguments, not hard-coded contract constants.
    constructor(
        IAgenticCommerce agenticCommerce_,
        IERC20 usdc_,
        address simulationForwarder_,
        address productionForwarder_
    ) EIP712("SemanticQuorum", "1") {
        if (
            address(agenticCommerce_) == address(0) || address(usdc_) == address(0) ||
            simulationForwarder_ == address(0) || productionForwarder_ == address(0)
        ) revert ZeroAddress();
        if (simulationForwarder_ == productionForwarder_) revert BadParams();
        agenticCommerce = agenticCommerce_;
        usdc = usdc_;
        simulationForwarder = simulationForwarder_;
        productionForwarder = productionForwarder_;
    }

    /// @notice Cheap ERC-165 discovery for CRE forwarders before each delivery.
    function supportsInterface(bytes4 id) external pure override returns (bool) {
        return id == type(IReceiver).interfaceId || id == type(IERC165).interfaceId;
    }

    /// @inheritdoc ISQController
    /// @dev All config/committee effects precede the single transferFrom; failure rolls them back.
    /// Live kernel fees are deliberately not read; buyer-pinned caps apply only at completion.
    function registerJob(RegisterParams calldata p) external override nonReentrant {
        IAgenticCommerce.Job memory job = agenticCommerce.getJob(p.jobId);
        _validateRegistration(p, job);
        bytes32 selectionSeed = keccak256(abi.encode(p.jobId, blockhash(p.seedBlock)));
        uint256 deposit = p.feePerReport * p.committee.length * (uint256(p.revisionLimit) + 1);
        _configs[p.jobId] = JobConfig({
            buyer: msg.sender,
            verdictAuthority: p.verdictAuthority,
            revisionLimit: p.revisionLimit,
            committeeSize: uint8(p.committee.length),
            decisionDeadline: p.decisionDeadline,
            feePerReport: p.feePerReport,
            seedBlock: p.seedBlock,
            selectionSeed: selectionSeed,
            policyHash: p.policyHash,
            participantSnapshotHash: p.participantSnapshotHash,
            deposited: deposit,
            maxPlatformFeeBP: p.maxPlatformFeeBP,
            maxEvaluatorFeeBP: p.maxEvaluatorFeeBP
        });
        for (uint256 i; i < p.committee.length; ++i) {
            _committees[p.jobId].push(p.committee[i]);
        }
        usdc.safeTransferFrom(msg.sender, address(this), deposit);
        _emitRegistration(p.jobId);
    }

    /// @dev Validates the deployed kernel's shape and all buyer-supplied registration constraints.
    function _validateRegistration(RegisterParams calldata p, IAgenticCommerce.Job memory job) internal view {
        if (job.id != p.jobId) revert JobNotFound();
        if (msg.sender != job.client) revert NotJobClient();
        if (job.evaluator != address(this)) revert WrongEvaluator();
        if (job.hook != address(0)) revert HookNotAllowed();
        // Registration requires an escrowed, still-unsubmitted job: Funded with a non-zero budget.
        // This rules out never-funded jobs (the kernel lets a provider submit from Open with budget 0)
        // and jobs already Submitted before the config exists. Fund and register atomically
        // (e.g. via Arc's Multicall3From) so the provider cannot submit in between.
        if (job.status != IAgenticCommerce.JobStatus.Funded) revert WrongJobStatus();
        if (job.budget == 0) revert ZeroBudget();
        if (_configs[p.jobId].buyer != address(0)) revert AlreadyRegistered();
        if (p.verdictAuthority == address(0)) revert ZeroAddress();
        if (p.feePerReport == 0 || p.revisionLimit > MAX_REVISION_LIMIT) revert BadParams();
        if (
            p.maxPlatformFeeBP > 10000 || p.maxEvaluatorFeeBP > 10000 ||
            p.maxPlatformFeeBP + p.maxEvaluatorFeeBP > 10000
        ) revert BadParams();
        if (p.committee.length == 0 || p.committee.length > MAX_COMMITTEE) revert BadCommittee();
        for (uint256 i; i < p.committee.length; ++i) {
            if (p.committee[i].feeRecipient == address(0)) revert ZeroAddress();
            for (uint256 j; j < i; ++j) {
                if (p.committee[i].evaluatorId == p.committee[j].evaluatorId) revert BadCommittee();
            }
        }
        if (
            p.decisionDeadline <= block.timestamp ||
            job.expiredAt < uint256(p.decisionDeadline) + MIN_SETTLE_BUFFER
        ) revert BadDeadline();
        if (
            p.seedBlock >= block.number || block.number - p.seedBlock > SEED_WINDOW ||
            blockhash(p.seedBlock) == bytes32(0)
        ) revert BadSeedBlock();
    }

    /// @dev Keeps registration event encoding out of the registration stack frame.
    function _emitRegistration(uint256 jobId) internal {
        JobConfig storage cfg = _configs[jobId];
        emit JobRegistered(
            jobId, cfg.buyer, cfg.verdictAuthority, cfg.policyHash, cfg.participantSnapshotHash,
            cfg.revisionLimit, cfg.decisionDeadline, cfg.feePerReport, cfg.deposited,
            cfg.seedBlock, cfg.selectionSeed, cfg.maxPlatformFeeBP, cfg.maxEvaluatorFeeBP
        );
        CommitteeMember[] storage committee = _committees[jobId];
        uint256[] memory evaluatorIds = new uint256[](committee.length);
        address[] memory feeRecipients = new address[](committee.length);
        for (uint256 i; i < committee.length; ++i) {
            evaluatorIds[i] = committee[i].evaluatorId;
            feeRecipients[i] = committee[i].feeRecipient;
        }
        emit CommitteeSelected(jobId, cfg.seedBlock, cfg.selectionSeed, evaluatorIds, feeRecipients);
    }

    /// @inheritdoc ISQController
    /// @dev Signature validation precedes digest idempotency. With a valid signature,
    /// idempotency precedes deadline, decision and kernel checks, including after termination.
    /// A different validly signed digest for a recorded round reverts ConflictingVerdict.
    /// Credits and completion/rejection are atomic: a failed kernel call or fee-cap check
    /// rolls back the entire verdict, including its digest and approval.
    function submitVerdict(Verdict calldata v, bytes calldata signature) external override nonReentrant {
        _submitVerdict(v, signature);
    }

    /// @notice Receives abi.encode(Verdict, signature) from either configured CRE forwarder.
    /// @param report ABI-encoded verdict and its EIP-712 verdictAuthority signature.
    /// @dev The unnamed first parameter is the CRE metadata: workflowId (32 bytes), workflowName
    /// (10 bytes), then workflowOwner (20 bytes); intentionally unused for authorization.
    /// Authority comes exclusively from the verdictAuthority signature, never metadata
    /// or the forwarder; neither forwarder can inject an unsigned verdict. The mock forwarder
    /// is accepted in production deployments too: it adds no authority beyond what any caller
    /// of submitVerdict already has. The workflow's gasLimit must cover signature verification
    /// plus, for ACCEPT, kernel completion and fee accounting. A revert is reported by the
    /// forwarder and delivery can be retried; identical valid redelivery is a no-op success.
    function onReport(bytes calldata, bytes calldata report) external override nonReentrant {
        if (msg.sender != simulationForwarder && msg.sender != productionForwarder) {
            revert UnauthorizedForwarder(msg.sender);
        }
        (Verdict memory v, bytes memory signature) = abi.decode(report, (Verdict, bytes));
        _submitVerdict(v, signature);
    }

    /// @dev Shared path for direct and CRE submissions; calldata callers copy arguments to memory.
    /// Signature verification must remain before recorded-digest idempotency and lifecycle checks.
    function _submitVerdict(Verdict memory v, bytes memory signature) internal {
        JobConfig storage cfg = _registeredConfig(v.jobId);
        bytes32 digest = _hashTypedDataV4(SQVerdict.hash(v, cfg.policyHash, cfg.participantSnapshotHash));
        if (!SignatureChecker.isValidSignatureNow(cfg.verdictAuthority, digest, signature)) revert InvalidSignature();
        bytes32 recorded = _verdictDigest[v.jobId][v.round];
        if (recorded != bytes32(0)) {
            if (recorded == digest) return;
            revert ConflictingVerdict();
        }
        JobState storage state = _states[v.jobId];
        _validateVerdict(v, cfg, state);
        _verdictDigest[v.jobId][v.round] = digest;
        _creditFees(v, cfg, state);
        VerdictKind effectiveKind = _applyVerdict(v, cfg, state);
        _emitVerdictRecorded(v, effectiveKind, digest);
    }

    /// @dev Checks lifecycle before reading the current kernel status. No report hash semantics.
    function _validateVerdict(Verdict memory v, JobConfig storage cfg, JobState storage state) internal view {
        if (state.decision != Decision.None) revert AlreadyDecided();
        if (v.round != state.round) revert WrongRound();
        if (block.timestamp > cfg.decisionDeadline) revert DeadlinePassed();
        if (v.kind != VerdictKind.Accept && v.kind != VerdictKind.Revise && v.kind != VerdictKind.Reject) {
            revert BadKind();
        }
        if (v.includedMask == 0 || v.includedMask >> cfg.committeeSize != 0) revert BadMask();
        IAgenticCommerce.JobStatus status = agenticCommerce.getJob(v.jobId).status;
        if (v.kind == VerdictKind.Accept) {
            if (status != IAgenticCommerce.JobStatus.Submitted) revert NotSubmitted();
            if (v.deliverable == bytes32(0)) revert ZeroDeliverable();
        } else if (v.kind == VerdictKind.Revise) {
            if (status != IAgenticCommerce.JobStatus.Funded) revert ReviseRequiresFunded();
        } else if (!_rejectable(status)) {
            revert WrongJobStatus();
        }
    }

    /// @dev Each set bit pays the pinned recipient once per round, never an address in a verdict.
    function _creditFees(Verdict memory v, JobConfig storage cfg, JobState storage state) internal {
        uint256 mask = _creditedMask[v.jobId][v.round];
        for (uint256 i; i < cfg.committeeSize; ++i) {
            uint256 bit = uint256(1) << i;
            if ((v.includedMask & bit) == 0 || (mask & bit) != 0) continue;
            if (state.credited > cfg.deposited || cfg.feePerReport > cfg.deposited - state.credited) {
                revert InsolventCredit();
            }
            mask |= bit;
            _creditedMask[v.jobId][v.round] = mask;
            address recipient = _committees[v.jobId][i].feeRecipient;
            _balances[recipient] += cfg.feePerReport;
            state.credited += cfg.feePerReport;
            emit FeeCredited(v.jobId, v.round, i, recipient, cfg.feePerReport);
        }
    }

    /// @dev ACCEPT records approval and completes atomically; REVISE at its limit rejects the funded kernel job.
    function _applyVerdict(
        Verdict memory v,
        JobConfig storage cfg,
        JobState storage state
    ) internal returns (VerdictKind effectiveKind) {
        effectiveKind = v.kind;
        if (v.kind == VerdictKind.Accept) {
            state.decision = Decision.Accepted;
            state.approvedDeliverable = v.deliverable;
            state.approvedEvidenceHash = v.evidenceHash;
            emit DeliverableApproved(v.jobId, v.deliverable, v.evidenceHash);
            _completeJob(v.jobId, state);
        } else if (v.kind == VerdictKind.Revise && state.round < cfg.revisionLimit) {
            ++state.round;
            emit RevisionRequested(v.jobId, state.round, v.evidenceHash, v.deficiencyHash);
        } else {
            state.decision = Decision.Rejected;
            effectiveKind = VerdictKind.Reject;
            if (v.kind == VerdictKind.Revise) emit RevisionLimitReached(v.jobId, v.round);
            agenticCommerce.reject(v.jobId, v.evidenceHash, "");
            emit JobSettled(v.jobId, false, v.evidenceHash);
        }
    }

    /// @dev Isolated event encoder to avoid a large submitVerdict stack without viaIR.
    function _emitVerdictRecorded(Verdict memory v, VerdictKind effectiveKind, bytes32 digest) internal {
        emit VerdictRecorded(
            v.jobId, v.round, v.kind, effectiveKind, v.deliverable, v.evidenceHash,
            v.reportsHash, v.deficiencyHash, v.includedMask, digest
        );
    }

    /// @inheritdoc ISQController
    /// @dev Under normal operation an accepted job is already settled in the ACCEPT
    /// transaction, so this is only a defensive retry path. No onchain deliverable
    /// comparison is possible: getJob has no deliverable. The authority's ACCEPT
    /// attests to JobSubmitted as documented at contract level.
    function settle(uint256 jobId) external override nonReentrant {
        _registeredConfig(jobId);
        JobState storage state = _states[jobId];
        if (state.decision != Decision.Accepted) revert NotAccepted();
        if (state.settled) revert AlreadySettled();
        if (agenticCommerce.getJob(jobId).status != IAgenticCommerce.JobStatus.Submitted) revert WrongJobStatus();
        _completeJob(jobId, state);
    }

    /// @dev Shared atomic completion for ACCEPT and defensive settle retries. Mark settled
    /// before external calls and check live kernel fees against the pinned job terms.
    /// Only the measured USDC increase is added to this job's buyer refund; any failure
    /// rolls back all effects of the calling transaction.
    function _completeJob(uint256 jobId, JobState storage state) internal {
        state.settled = true;
        JobConfig storage cfg = _configs[jobId];
        uint256 livePlatformFeeBP = agenticCommerce.platformFeeBP();
        uint256 liveEvaluatorFeeBP = agenticCommerce.evaluatorFeeBP();
        if (livePlatformFeeBP > cfg.maxPlatformFeeBP) {
            revert PlatformFeeAboveCap(livePlatformFeeBP, cfg.maxPlatformFeeBP);
        }
        if (liveEvaluatorFeeBP > cfg.maxEvaluatorFeeBP) {
            revert EvaluatorFeeAboveCap(liveEvaluatorFeeBP, cfg.maxEvaluatorFeeBP);
        }
        uint256 balBefore = usdc.balanceOf(address(this));
        agenticCommerce.complete(jobId, state.approvedEvidenceHash, "");
        uint256 delta = usdc.balanceOf(address(this)) - balBefore;
        if (delta > 0) {
            state.kernelFeeReceived += delta;
            emit KernelEvaluatorFeeReceived(jobId, delta);
        }
        emit CompletionFeesApplied(jobId, livePlatformFeeBP, liveEvaluatorFeeBP);
        emit JobSettled(jobId, true, state.approvedEvidenceHash);
    }

    /// @inheritdoc ISQController
    /// @dev Credits no report fees. Kernel rejection failure restores the undecided state.
    function rejectOnTimeout(uint256 jobId) external override nonReentrant {
        JobConfig storage cfg = _registeredConfig(jobId);
        JobState storage state = _states[jobId];
        if (state.decision != Decision.None) revert AlreadyDecided();
        if (block.timestamp <= cfg.decisionDeadline) revert DeadlineNotPassed();
        if (!_rejectable(agenticCommerce.getJob(jobId).status)) revert WrongJobStatus();
        state.decision = Decision.Rejected;
        agenticCommerce.reject(jobId, TIMEOUT_REASON, "");
        emit TimeoutRejected(jobId);
    }

    /// @inheritdoc ISQController
    /// @dev Pull payments isolate a blocklisted recipient's failure to that recipient's claim.
    function claim() external override nonReentrant returns (uint256 amount) {
        amount = _balances[msg.sender];
        if (amount == 0) revert NothingToClaim();
        _balances[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit FeesClaimed(msg.sender, amount);
    }

    /// @inheritdoc ISQController
    /// @dev Terminal kernel status excludes any new valid verdict. Credited, unclaimed
    /// report fees remain reserved for their recipients and are not included in this refund.
    function refundFees(uint256 jobId) external override nonReentrant returns (uint256 amount) {
        JobConfig storage cfg = _registeredConfig(jobId);
        IAgenticCommerce.JobStatus status = agenticCommerce.getJob(jobId).status;
        if (
            status != IAgenticCommerce.JobStatus.Completed &&
            status != IAgenticCommerce.JobStatus.Rejected &&
            status != IAgenticCommerce.JobStatus.Expired
        ) revert NotTerminal();
        JobState storage state = _states[jobId];
        if (state.refunded) revert AlreadyRefunded();
        state.refunded = true;
        amount = cfg.deposited - state.credited + state.kernelFeeReceived;
        if (amount > 0) usdc.safeTransfer(cfg.buyer, amount);
        emit FeesRefunded(jobId, cfg.buyer, amount);
    }

    /// @dev Existence is represented by the nonzero client/buyer stored at registration.
    function _registeredConfig(uint256 jobId) internal view returns (JobConfig storage cfg) {
        cfg = _configs[jobId];
        if (cfg.buyer == address(0)) revert NotRegistered();
    }

    /// @dev Kernel evaluator rejection is only supported for funded or submitted jobs.
    function _rejectable(IAgenticCommerce.JobStatus status) internal pure returns (bool) {
        return status == IAgenticCommerce.JobStatus.Funded || status == IAgenticCommerce.JobStatus.Submitted;
    }

    /// @inheritdoc ISQController
    function getConfig(uint256 jobId) external view override returns (JobConfig memory) {
        return _configs[jobId];
    }

    /// @inheritdoc ISQController
    function getCommittee(uint256 jobId) external view override returns (CommitteeMember[] memory) {
        return _committees[jobId];
    }

    /// @inheritdoc ISQController
    function getState(uint256 jobId) external view override returns (JobState memory) {
        return _states[jobId];
    }

    /// @inheritdoc ISQController
    function isRegistered(uint256 jobId) external view override returns (bool) {
        return _configs[jobId].buyer != address(0);
    }

    /// @inheritdoc ISQController
    function feeBalance(address account) external view override returns (uint256) {
        return _balances[account];
    }

    /// @inheritdoc ISQController
    function verdictDigestOf(uint256 jobId, uint8 round) external view override returns (bytes32) {
        return _verdictDigest[jobId][round];
    }

    /// @inheritdoc ISQController
    function creditedMaskOf(uint256 jobId, uint8 round) external view override returns (uint256) {
        return _creditedMask[jobId][round];
    }

    /// @inheritdoc ISQController
    function hashVerdict(Verdict calldata v) external view override returns (bytes32) {
        JobConfig storage cfg = _registeredConfig(v.jobId);
        return _hashTypedDataV4(SQVerdict.hash(v, cfg.policyHash, cfg.participantSnapshotHash));
    }
}
