// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockAgenticCommerce} from "./mocks/MockAgenticCommerce.sol";
import {SQController} from "../SQController.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

/// @dev Shared fixture for SQController tests. Not a .t.sol: contains no test functions.
abstract contract SQBase is Test {
    bytes32 internal constant VERDICT_TYPEHASH = keccak256(
        "Verdict(uint256 jobId,uint8 round,uint8 kind,bytes32 deliverable,bytes32 evidenceHash,bytes32 reportsHash,bytes32 deficiencyHash,uint256 includedMask,bytes32 policyHash,bytes32 participantSnapshotHash)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 internal constant T0 = 1_700_000_000;
    uint256 internal constant START_BLOCK = 1000;
    uint256 internal constant DEADLINE = T0 + 3 days;
    uint256 internal constant EXPIRY = T0 + 7 days;
    uint256 internal constant BUDGET = 1_000e6;
    uint256 internal constant FEE = 5e6;
    /// @dev Generous default fee caps (BP) so tests that set kernel fees still complete.
    uint256 internal constant CAP = 5000;
    /// @dev Storage slot of SQController._states (see `forge inspect SQController storage-layout`).
    uint256 internal constant STATES_SLOT = 4;

    bytes32 internal constant POLICY = keccak256("policy");
    bytes32 internal constant SNAPSHOT = keccak256("participantSnapshot");
    bytes32 internal constant DELIVERABLE = keccak256("deliverable");
    bytes32 internal constant EVIDENCE = keccak256("evidence");
    bytes32 internal constant REPORTS = keccak256("reports");
    bytes32 internal constant DEFICIENCY = keccak256("deficiency");

    MockUSDC internal usdc;
    MockAgenticCommerce internal ac;
    SQController internal sq;

    address internal buyer = makeAddr("buyer");
    address internal provider = makeAddr("provider");
    address internal relayer = makeAddr("relayer");
    address internal rA = makeAddr("rA");
    address internal rB = makeAddr("rB");
    address internal stranger = makeAddr("stranger");
    address internal simForwarder = makeAddr("simForwarder");
    address internal prodForwarder = makeAddr("prodForwarder");

    uint256 internal authorityKey = 0xA11CE5EED;
    address internal authority;

    function setUp() public virtual {
        vm.warp(T0);
        vm.roll(START_BLOCK);
        authority = vm.addr(authorityKey);
        usdc = new MockUSDC();
        ac = new MockAgenticCommerce(IERC20(address(usdc)));
        sq = new SQController(
            IAgenticCommerce(address(ac)), IERC20(address(usdc)), simForwarder, prodForwarder
        );
    }

    // ------------------------------------------------------------------ CRE delivery helpers

    /// @dev Realistic 62-byte CRE metadata: workflowId (32) | workflowName (10) | workflowOwner (20).
    function creMetadata() internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256("sq-workflow-id"), bytes10("sq-verdict"), address(uint160(0xC0FFEE)));
    }

    /// @dev CRE report = abi.encode(Verdict, bytes signature).
    function encodeReport(ISQController.Verdict memory v, bytes memory sig) internal pure returns (bytes memory) {
        return abi.encode(v, sig);
    }

    /// @dev Delivers (v, sig) to onReport as `fwd` with realistic metadata.
    function deliver(address fwd, ISQController.Verdict memory v, bytes memory sig) internal {
        bytes memory report = encodeReport(v, sig);
        bytes memory meta = creMetadata();
        vm.prank(fwd);
        sq.onReport(meta, report);
    }

    function deliverRaw(address fwd, bytes memory meta, bytes memory report) internal {
        vm.prank(fwd);
        sq.onReport(meta, report);
    }

    /// @dev Signs with the authority key and delivers through `fwd`.
    function deliverSigned(address fwd, ISQController.Verdict memory v) internal {
        bytes memory sig = signVerdict(v);
        deliver(fwd, v, sig);
    }

    function deliverExpectRevert(address fwd, ISQController.Verdict memory v, bytes memory sig, bytes memory err)
        internal
    {
        bytes memory report = encodeReport(v, sig);
        bytes memory meta = creMetadata();
        vm.expectRevert(err);
        vm.prank(fwd);
        sq.onReport(meta, report);
    }

    /// @dev route % 3: 0 = submitVerdict, 1 = onReport via simulation forwarder, 2 = via production forwarder.
    function sendVia(ISQController.Verdict memory v, uint256 route_) internal {
        route_ %= 3;
        if (route_ == 0) send(v);
        else deliverSigned(route_ == 1 ? simForwarder : prodForwarder, v);
    }

    function sendViaExpectRevert(ISQController.Verdict memory v, bytes4 selector, uint256 route_) internal {
        route_ %= 3;
        bytes memory sig = signVerdict(v);
        if (route_ == 0) {
            vm.expectRevert(selector);
            vm.prank(relayer);
            sq.submitVerdict(v, sig);
        } else {
            deliverExpectRevert(route_ == 1 ? simForwarder : prodForwarder, v, sig, abi.encodePacked(selector));
        }
    }

    /// @dev Hash of every piece of controller/kernel state a verdict can touch for `id`.
    function fingerprint(uint256 id) internal view returns (bytes32) {
        bytes memory acc = abi.encode(
            sq.getState(id), usdc.balanceOf(address(sq)), uint8(kernelStatus(id)), sq.feeBalance(rA), sq.feeBalance(rB)
        );
        for (uint8 r; r < 4; ++r) {
            acc = bytes.concat(acc, abi.encode(sq.verdictDigestOf(id, r), sq.creditedMaskOf(id, r)));
        }
        return keccak256(acc);
    }

    // ------------------------------------------------------------------ kernel job helpers

    function newJob(uint256 expiredAt) internal returns (uint256 jobId) {
        vm.prank(buyer);
        jobId = ac.createJob(provider, address(sq), expiredAt, "SQ job", address(0));
    }

    function fundJob(uint256 jobId, uint256 budget) internal {
        vm.prank(provider);
        ac.setBudget(jobId, budget, "");
        usdc.mint(buyer, budget);
        vm.startPrank(buyer);
        usdc.approve(address(ac), budget);
        ac.fund(jobId, "");
        vm.stopPrank();
    }

    function submitJob(uint256 jobId, bytes32 deliverable) internal {
        vm.prank(provider);
        ac.submit(jobId, deliverable, "");
    }

    function kernelStatus(uint256 jobId) internal view returns (IAgenticCommerce.JobStatus) {
        return ac.getJob(jobId).status;
    }

    // ------------------------------------------------------------------ registration helpers

    function committee(uint256 n) internal view returns (ISQController.CommitteeMember[] memory m) {
        m = new ISQController.CommitteeMember[](n);
        for (uint256 i; i < n; ++i) {
            address r = i == 0 ? rA : i == 1 ? rB : address(uint160(0xC0DE00 + i));
            m[i] = ISQController.CommitteeMember({evaluatorId: i + 1, feeRecipient: r});
        }
    }

    /// @dev Params with seedBlock = block.number - 1 (caller rolls forward first when needed).
    function params(uint256 jobId, uint8 revisionLimit, uint256 fee)
        internal
        view
        returns (ISQController.RegisterParams memory p)
    {
        p.jobId = jobId;
        p.policyHash = POLICY;
        p.participantSnapshotHash = SNAPSHOT;
        p.verdictAuthority = authority;
        p.revisionLimit = revisionLimit;
        p.decisionDeadline = uint64(DEADLINE);
        p.feePerReport = fee;
        p.seedBlock = block.number - 1;
        p.committee = committee(2);
        p.maxPlatformFeeBP = CAP;
        p.maxEvaluatorFeeBP = CAP;
    }

    /// @dev Registers a Submitted job (2-member committee) with explicit fee caps.
    function setupSubmittedWithCaps(uint8 revisionLimit, uint256 platCap, uint256 evalCap)
        internal
        returns (uint256 jobId)
    {
        jobId = newJob(EXPIRY);
        fundJob(jobId, BUDGET);
        // Registration requires a Funded job, so register BEFORE the provider submits.
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(jobId, revisionLimit, FEE);
        p.maxPlatformFeeBP = platCap;
        p.maxEvaluatorFeeBP = evalCap;
        registerWith(p);
        submitJob(jobId, DELIVERABLE);
    }

    /// @dev ACCEPT now completes atomically, so "accepted but unsettled" is unreachable through the
    /// public API. Forces it via vm.store: decision=Accepted, settled=false, approvedDeliverable and
    /// approvedEvidenceHash set. Slot layout of JobState: slot0 = round(byte0) decision(1) settled(2)
    /// refunded(3); slot1 = approvedDeliverable; slot2 = approvedEvidenceHash.
    function forceAcceptedUnsettled(uint256 jobId, bytes32 evidence) internal {
        bytes32 base = keccak256(abi.encode(jobId, STATES_SLOT));
        uint256 w = uint256(vm.load(address(sq), base));
        w = (w & ~(uint256(0xFFFF) << 8)) | (uint256(1) << 8);
        vm.store(address(sq), base, bytes32(w));
        vm.store(address(sq), bytes32(uint256(base) + 1), DELIVERABLE);
        vm.store(address(sq), bytes32(uint256(base) + 2), evidence);
        ISQController.JobState memory s = sq.getState(jobId);
        assertEq(uint8(s.decision), uint8(ISQController.Decision.Accepted), "forced decision");
        assertFalse(s.settled, "forced unsettled");
        assertEq(s.approvedEvidenceHash, evidence, "forced evidence");
    }

    /// @dev Topic0 of every controller-emitted log, in emission order.
    function sqTopics(Vm.Log[] memory logs) internal view returns (bytes32[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(sq)) ++n;
        }
        out = new bytes32[](n);
        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(sq)) out[k++] = logs[i].topics[0];
        }
    }

    function depositOf(ISQController.RegisterParams memory p) internal pure returns (uint256) {
        return p.feePerReport * p.committee.length * (uint256(p.revisionLimit) + 1);
    }

    /// @dev Mints exactly the deposit to the buyer and approves the controller.
    function fundBuyerFor(ISQController.RegisterParams memory p) internal {
        uint256 dep = depositOf(p);
        usdc.mint(buyer, dep);
        vm.prank(buyer);
        usdc.approve(address(sq), dep);
    }

    function registerWith(ISQController.RegisterParams memory p) internal {
        fundBuyerFor(p);
        vm.prank(buyer);
        sq.registerJob(p);
    }

    function registerDefault(uint256 jobId, uint8 revisionLimit, uint256 fee) internal {
        vm.roll(block.number + 1);
        registerWith(params(jobId, revisionLimit, fee));
    }

    /// @dev Open -> Funded kernel job, registered with a 2-member committee.
    function setupFunded(uint8 revisionLimit) internal returns (uint256 jobId) {
        jobId = newJob(EXPIRY);
        fundJob(jobId, BUDGET);
        registerDefault(jobId, revisionLimit, FEE);
    }

    function setupSubmitted(uint8 revisionLimit) internal returns (uint256 jobId) {
        jobId = setupFunded(revisionLimit);
        submitJob(jobId, DELIVERABLE);
    }

    // ------------------------------------------------------------------ verdict helpers

    function mkVerdict(uint256 jobId, uint8 round, ISQController.VerdictKind kind, bytes32 deliverable, uint256 mask)
        internal
        pure
        returns (ISQController.Verdict memory v)
    {
        v = ISQController.Verdict({
            jobId: jobId,
            round: round,
            kind: kind,
            deliverable: deliverable,
            evidenceHash: EVIDENCE,
            reportsHash: REPORTS,
            deficiencyHash: DEFICIENCY,
            includedMask: mask
        });
    }

    function mkAccept(uint256 jobId, uint8 round) internal pure returns (ISQController.Verdict memory) {
        return mkVerdict(jobId, round, ISQController.VerdictKind.Accept, DELIVERABLE, 3);
    }

    function mkRevise(uint256 jobId, uint8 round) internal pure returns (ISQController.Verdict memory) {
        return mkVerdict(jobId, round, ISQController.VerdictKind.Revise, bytes32(0), 3);
    }

    function mkReject(uint256 jobId, uint8 round) internal pure returns (ISQController.Verdict memory) {
        return mkVerdict(jobId, round, ISQController.VerdictKind.Reject, bytes32(0), 3);
    }

    function signDigest(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, vv);
    }

    /// @dev Signs sq.hashVerdict(v) with the authority key.
    function signVerdict(ISQController.Verdict memory v) internal view returns (bytes memory) {
        return signDigest(authorityKey, sq.hashVerdict(v));
    }

    /// @dev Independent EIP-712 struct hash (does not use the library under test).
    function structHash(ISQController.Verdict memory v, bytes32 policy, bytes32 snapshot)
        internal
        pure
        returns (bytes32)
    {
        bytes memory head = abi.encode(VERDICT_TYPEHASH, v.jobId, v.round, uint8(v.kind), v.deliverable, v.evidenceHash);
        bytes memory tail = abi.encode(v.reportsHash, v.deficiencyHash, v.includedMask, policy, snapshot);
        return keccak256(bytes.concat(head, tail));
    }

    function domainSeparator(uint256 chainId, address verifying) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("SemanticQuorum"), keccak256("1"), chainId, verifying)
        );
    }

    function digestFor(
        ISQController.Verdict memory v,
        bytes32 policy,
        bytes32 snapshot,
        uint256 chainId,
        address verifying
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(chainId, verifying), structHash(v, policy, snapshot))
        );
    }

    /// @dev Signs with the authority key and submits through the relayer.
    function send(ISQController.Verdict memory v) internal {
        bytes memory sig = signVerdict(v);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
    }

    function sendExpectRevert(ISQController.Verdict memory v, bytes4 selector) internal {
        bytes memory sig = signVerdict(v);
        vm.expectRevert(selector);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
    }

    // ------------------------------------------------------------------ log helpers

    function countLogs(Vm.Log[] memory logs, address emitter, bytes32 sig) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == sig) ++n;
        }
    }

    function findLog(Vm.Log[] memory logs, address emitter, bytes32 sig) internal pure returns (Vm.Log memory) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == sig) return logs[i];
        }
        revert("log not found");
    }

    function recordedData(ISQController.Verdict memory v, ISQController.VerdictKind effective, bytes32 digest)
        internal
        pure
        returns (bytes memory)
    {
        return bytes.concat(
            abi.encode(v.kind, effective, v.deliverable, v.evidenceHash),
            abi.encode(v.reportsHash, v.deficiencyHash, v.includedMask, digest)
        );
    }
}
