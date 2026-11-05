// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SQController} from "../SQController.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

/// @dev Full ABI of the REAL Arc AgenticCommerce proxy (impl 0xA316...351a, verified source).
interface IKernel is IAgenticCommerce {
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);

    error WrongStatus();
    error Unauthorized();
    error ExpiryTooShort();
    error HookNotWhitelisted();
    error FeesTooHigh();
    error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);

    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook)
        external
        returns (uint256);
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
    function fund(uint256 jobId, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function claimRefund(uint256 jobId) external;
    function jobCounter() external view returns (uint256);
    function paymentToken() external view returns (address);
    function platformTreasury() external view returns (address);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function ADMIN_ROLE() external view returns (bytes32);
    function whitelistedHooks(address hook) external view returns (bool);
    function setPlatformFee(uint256 feeBP, address treasury) external;
    function setEvaluatorFee(uint256 feeBP) external;
    function setHookWhitelist(address hook, bool status) external;
}

/// @dev EIP-8183 hook interface (the kernel ERC165-checks non-zero hooks against it).
interface IACPHookLike {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

/// @dev Minimal no-op hook so a hooked job can be created on the fork (after admin whitelisting).
contract NoopHook is IACPHookLike {
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IACPHookLike).interfaceId || id == 0x01ffc9a7;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external {}
    function afterAction(uint256, bytes4, bytes calldata) external {}
}

interface IUsdcAdmin {
    function blacklister() external view returns (address);
    function blacklist(address a) external;
    function unBlacklist(address a) external;
    function isBlacklisted(address a) external view returns (bool);
}

/// @dev Shared fixture for the Arc-testnet fork tests. Every test must carry `onlyFork`.
abstract contract SQForkBase is Test {
    uint256 internal constant FORK_BLOCK = 70872676;
    address internal constant AC = 0x0747EEf0706327138c69792bF28Cd525089e4583;
    address internal constant AC_IMPL = 0xA316fd02827242D537F84730F8a37D0BA5fd351a;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    /// @dev Chainlink CRE forwarders for arc-testnet (docs.chain.link CRE forwarder directory).
    address internal constant SIM_FORWARDER = 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1;
    address internal constant PROD_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    address internal constant TREASURY = 0xcBe5B97a069be3E4B5398663790731fb76aB620D;
    address internal constant BLOCKLISTED = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    uint256 internal constant FEE = 5e6;
    bytes32 internal constant POLICY = keccak256("policy");
    bytes32 internal constant SNAPSHOT = keccak256("participantSnapshot");

    IKernel internal ac;
    SQController internal sq;

    address internal alice = makeAddr("alice"); // buyer / kernel client
    address internal bob = makeAddr("bob"); // kernel provider
    address internal evalEoa = makeAddr("evalEoa"); // EOA evaluator for kernel-only experiments
    address internal stranger = makeAddr("stranger");
    address internal rA = makeAddr("rA");
    address internal rB = makeAddr("rB");
    address internal authority;
    uint256 internal authorityKey = 0xA11CE5EED;

    function _enabled() internal view returns (bool) {
        return vm.envOr("ARC_FORK", false);
    }

    /// @dev Every fork test is gated: plain `forge test` never touches the network.
    modifier onlyFork() {
        if (!_enabled()) vm.skip(true);
        _;
    }

    function setUp() public virtual {
        if (!_enabled()) return;
        vm.createSelectFork("arc_testnet", FORK_BLOCK);
        ac = IKernel(AC);
        authority = vm.addr(authorityKey);
        sq = new SQController(IAgenticCommerce(AC), IERC20(USDC), SIM_FORWARDER, PROD_FORWARDER);
        vm.label(AC, "AgenticCommerce");
        vm.label(USDC, "USDC");
        vm.label(TREASURY, "treasury/admin");
    }

    // ------------------------------------------------------------ USDC funding / blocklist (Arc Foundry)
    // FUNDING METHOD: Arc's USDC is the native coin seen through a 6-decimal ERC-20 facade
    // (balanceOf == native balance / 1e12; transfer/transferFrom call precompile 0x1800..00). The
    // forge-std `deal(USDC, ...)` storage-slot trick does NOT work; `vm.deal(who, amount * 1e12)` does.
    // Requires `arc-forge --network arc` (stock forge / arc-forge without the flag cannot execute the precompiles).
    // BLOCKLIST: the real USDC `blacklister()` role holder is impersonated to call the real `blacklist`/`unBlacklist`,
    // which drive the emulated precompile 0x1800..01 (no etching, no mocking).

    function usdcBal(address a) internal view returns (uint256) {
        return IERC20(USDC).balanceOf(a);
    }

    function fundUsdc(address who, uint256 amount6) internal {
        vm.deal(who, who.balance + amount6 * 1e12);
    }

    function _blocklist(address who) internal {
        vm.prank(IUsdcAdmin(USDC).blacklister());
        IUsdcAdmin(USDC).blacklist(who);
        assertTrue(IUsdcAdmin(USDC).isBlacklisted(who), "blocklisted");
    }

    function _unblocklist(address who) internal {
        vm.prank(IUsdcAdmin(USDC).blacklister());
        IUsdcAdmin(USDC).unBlacklist(who);
        assertFalse(IUsdcAdmin(USDC).isBlacklisted(who), "unblocklisted");
    }

    // ------------------------------------------------------------ kernel helpers (no USDC moves)

    function expiryIn(uint256 secs) internal view returns (uint256) {
        return block.timestamp + secs;
    }

    function createJob(address evaluator, address hook, uint256 expiredAt) internal returns (uint256 id) {
        vm.prank(alice);
        id = ac.createJob(bob, evaluator, expiredAt, "SQ fork test", hook);
    }

    /// @dev Zero-budget fund: the real kernel only moves USDC when budget > 0.
    function fundZero(uint256 id) internal {
        vm.prank(alice);
        ac.fund(id, "");
    }

    function submitJob(uint256 id) internal {
        vm.prank(bob);
        ac.submit(id, keccak256("deliverable"), "");
    }

    function statusOf(uint256 id) internal view returns (IAgenticCommerce.JobStatus) {
        return ac.getJob(id).status;
    }

    function committee() internal view returns (ISQController.CommitteeMember[] memory m) {
        m = new ISQController.CommitteeMember[](2);
        m[0] = ISQController.CommitteeMember({evaluatorId: 1, feeRecipient: rA});
        m[1] = ISQController.CommitteeMember({evaluatorId: 2, feeRecipient: rB});
    }

    function params(uint256 jobId, uint256 expiredAt) internal view returns (ISQController.RegisterParams memory p) {
        p.jobId = jobId;
        p.policyHash = POLICY;
        p.participantSnapshotHash = SNAPSHOT;
        p.verdictAuthority = authority;
        p.revisionLimit = 0;
        p.decisionDeadline = uint64(expiredAt - 2 hours);
        p.feePerReport = FEE;
        p.seedBlock = block.number - 1;
        p.committee = committee();
        p.maxPlatformFeeBP = 1000;
        p.maxEvaluatorFeeBP = 1000;
    }

    // ------------------------------------------------------------ real-USDC lifecycle helpers

    uint256 internal constant BUDGET = 1000e6;

    /// @dev Open job (evaluator = SQController, hook 0) -> provider setBudget -> buyer approve + fund with real USDC.
    function fundedJob(uint256 budget, uint256 exp) internal returns (uint256 id) {
        id = createJob(address(sq), address(0), exp);
        vm.prank(bob);
        ac.setBudget(id, budget, "");
        fundUsdc(alice, budget);
        vm.startPrank(alice);
        IERC20(USDC).approve(AC, budget);
        ac.fund(id, "");
        vm.stopPrank();
    }

    function defaultParams(uint256 id, uint256 exp, uint256 capP, uint256 capE, uint8 revLimit)
        internal
        view
        returns (ISQController.RegisterParams memory p)
    {
        p = params(id, exp);
        p.maxPlatformFeeBP = capP;
        p.maxEvaluatorFeeBP = capE;
        p.revisionLimit = revLimit;
    }

    /// @dev Buyer funds the report deposit and registers (real USDC transferFrom).
    function register(ISQController.RegisterParams memory p) internal {
        uint256 deposit = p.feePerReport * p.committee.length * (uint256(p.revisionLimit) + 1);
        fundUsdc(alice, deposit);
        vm.startPrank(alice);
        IERC20(USDC).approve(address(sq), deposit);
        sq.registerJob(p);
        vm.stopPrank();
    }

    function verdictOf(uint256 id, ISQController.VerdictKind k, uint8 round, uint256 mask)
        internal
        pure
        returns (ISQController.Verdict memory v)
    {
        v = ISQController.Verdict({
            jobId: id,
            round: round,
            kind: k,
            deliverable: keccak256("deliverable"),
            evidenceHash: keccak256("evidence"),
            reportsHash: keccak256("reports"),
            deficiencyHash: k == ISQController.VerdictKind.Revise ? keccak256("deficiency") : bytes32(0),
            includedMask: mask
        });
    }

    function sign(ISQController.Verdict memory v) internal view returns (bytes memory) {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(authorityKey, sq.hashVerdict(v));
        return abi.encodePacked(r, s, vv);
    }

    function setLiveFees(uint256 platformBP, uint256 evaluatorBP) internal {
        vm.startPrank(TREASURY);
        ac.setPlatformFee(platformBP, TREASURY);
        ac.setEvaluatorFee(evaluatorBP);
        vm.stopPrank();
    }

    /// @dev Index of the first log by `emitter` with `topic0` at or after `from`; type(uint256).max if absent.
    function logIdx(Vm.Log[] memory logs, address emitter, bytes32 topic0, uint256 from) internal pure returns (uint256) {
        for (uint256 i = from; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == topic0) return i;
        }
        return type(uint256).max;
    }
}
