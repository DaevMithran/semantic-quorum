// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SQBase} from "./SQBase.sol";
import {MockAgenticCommerce} from "./mocks/MockAgenticCommerce.sol";
import {Mock1271Wallet} from "./mocks/Mock1271Wallet.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

/// @dev Cross-path (submitVerdict <-> onReport via either forwarder) idempotency, conflicts, rounds, lifecycle.
contract SQControllerCREReplayTest is SQBase {
    ISQController.VerdictKind internal constant ACCEPT = ISQController.VerdictKind.Accept;
    ISQController.VerdictKind internal constant REVISE = ISQController.VerdictKind.Revise;
    ISQController.VerdictKind internal constant REJECT = ISQController.VerdictKind.Reject;

    // path: 0 = submitVerdict, 1 = onReport(simulation), 2 = onReport(production)

    function _fwd(uint256 p) internal view returns (address) {
        return p == 1 ? simForwarder : prodForwarder;
    }

    function _via(uint256 p, ISQController.Verdict memory v, bytes memory sig) internal {
        if (p == 0) {
            vm.prank(relayer);
            sq.submitVerdict(v, sig);
        } else {
            deliver(_fwd(p), v, sig);
        }
    }

    function _viaRevert(uint256 p, ISQController.Verdict memory v, bytes memory sig, bytes4 err) internal {
        if (p == 0) {
            vm.expectRevert(err);
            vm.prank(relayer);
            sq.submitVerdict(v, sig);
        } else {
            deliverExpectRevert(_fwd(p), v, sig, abi.encodePacked(err));
        }
    }

    /// @dev kind: 0 ACCEPT, 1 REVISE (limit 2), 2 REJECT while Submitted, 3 REVISE at its limit.
    function _make(uint256 kind) internal returns (uint256 id, ISQController.Verdict memory v, bytes memory sig) {
        vm.warp(T0); // earlier loop iterations may have warped past the decision deadline
        ac.setEvaluatorFee(300);
        if (kind == 0) {
            id = setupSubmitted(2);
            v = mkAccept(id, 0);
        } else if (kind == 1) {
            id = setupFunded(2);
            v = mkRevise(id, 0);
        } else if (kind == 2) {
            id = setupSubmitted(1);
            v = mkReject(id, 0);
        } else {
            id = setupFunded(0);
            v = mkRevise(id, 0);
        }
        sig = signVerdict(v);
    }

    // ------------------------------------------------------------------ identical redelivery across paths

    function _replayNoOp(uint256 first, uint256 second, uint256 kind, bool late) internal {
        (uint256 id, ISQController.Verdict memory v, bytes memory sig) = _make(kind);
        _via(first, v, sig);
        if (late) vm.warp(DEADLINE + 1 hours);
        bytes32 fp = fingerprint(id);
        uint256 creditedBefore = sq.getState(id).credited;
        vm.recordLogs();
        _via(second, v, sig);
        assertEq(vm.getRecordedLogs().length, 0, "replay emits nothing");
        assertEq(fingerprint(id), fp, "replay changes nothing");
        assertEq(sq.getState(id).credited, creditedBefore, "no second credit");
    }

    function test_IdenticalVerdictOnAnySecondPathIsSilentNoOp() public {
        for (uint256 kind; kind < 4; ++kind) {
            for (uint256 a; a < 3; ++a) {
                for (uint256 b; b < 3; ++b) {
                    _replayNoOp(a, b, kind, false);
                }
            }
        }
    }

    function test_IdenticalVerdictOnAnySecondPathIsNoOpAfterDeadline() public {
        for (uint256 kind; kind < 4; ++kind) {
            for (uint256 a; a < 3; ++a) {
                for (uint256 b; b < 3; ++b) {
                    _replayNoOp(a, b, kind, true);
                }
            }
        }
    }

    function test_OnReportThenSubmitVerdict_AcceptNoSecondCredit() public {
        _replayNoOp(1, 0, 0, false);
    }

    function test_SubmitVerdictThenOnReport_AcceptNoSecondCredit() public {
        _replayNoOp(0, 2, 0, false);
    }

    function test_RedeliveryThroughOtherForwarderIsNoOp() public {
        _replayNoOp(1, 2, 0, false);
        _replayNoOp(2, 1, 0, true);
    }

    // ------------------------------------------------------------------ conflicts across paths

    function test_RevertWhen_ConflictingSignedVerdictOnAnyOtherPath() public {
        for (uint256 kind; kind < 4; ++kind) {
            for (uint256 a; a < 3; ++a) {
                for (uint256 b; b < 3; ++b) {
                    (uint256 id, ISQController.Verdict memory v, bytes memory sig) = _make(kind);
                    _via(a, v, sig);
                    ISQController.Verdict memory twin = v;
                    twin.evidenceHash = keccak256("conflicting evidence");
                    bytes memory twinSig = signVerdict(twin);
                    bytes32 fp = fingerprint(id);
                    _viaRevert(b, twin, twinSig, ISQController.ConflictingVerdict.selector);
                    assertEq(fingerprint(id), fp, "conflict changes nothing");
                }
            }
        }
    }

    function test_RevertWhen_ConflictingKindForSameRoundViaOtherPath() public {
        for (uint256 a; a < 3; ++a) {
            for (uint256 b; b < 3; ++b) {
                uint256 id = setupFunded(2);
                _via(a, mkRevise(id, 0), signVerdict(mkRevise(id, 0)));
                ISQController.Verdict memory rej = mkReject(id, 0);
                _viaRevert(b, rej, signVerdict(rej), ISQController.ConflictingVerdict.selector);
                assertEq(sq.getState(id).round, 1);
                assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.None));
            }
        }
    }

    function test_RevertWhen_ConflictingVerdictAfterAcceptViaOnReport_EvenAfterDeadline() public {
        (uint256 id, ISQController.Verdict memory v, bytes memory sig) = _make(0);
        _via(1, v, sig);
        vm.warp(DEADLINE + 1);
        ISQController.Verdict memory twin = v;
        twin.reportsHash = keccak256("other reports");
        bytes memory twinSig = signVerdict(twin);
        _viaRevert(0, twin, twinSig, ISQController.ConflictingVerdict.selector);
        _viaRevert(2, twin, twinSig, ISQController.ConflictingVerdict.selector);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Accepted));
    }

    // ------------------------------------------------------------------ replay with bad signatures

    function test_RevertWhen_ReplayWithBadSignatureOnAnyPath() public {
        for (uint256 kind; kind < 4; ++kind) {
            for (uint256 a; a < 3; ++a) {
                for (uint256 b; b < 3; ++b) {
                    (uint256 id, ISQController.Verdict memory v, bytes memory sig) = _make(kind);
                    _via(a, v, sig);
                    bytes32 fp = fingerprint(id);
                    _viaRevert(b, v, hex"deadbeef", ISQController.InvalidSignature.selector);
                    _viaRevert(b, v, "", ISQController.InvalidSignature.selector);
                    _viaRevert(b, v, signDigest(0xBAD, sq.hashVerdict(v)), ISQController.InvalidSignature.selector);
                    assertEq(fingerprint(id), fp);
                    _via(b, v, sig); // and the valid replay is still a no-op afterwards
                    assertEq(fingerprint(id), fp);
                }
            }
        }
    }

    function test_RevertWhen_TerminalReplayWithBadSignatureAfterDeadlineViaOnReport() public {
        (, ISQController.Verdict memory v, bytes memory sig) = _make(0);
        _via(0, v, sig);
        vm.warp(DEADLINE + 1 days);
        _viaRevert(1, v, hex"00", ISQController.InvalidSignature.selector);
        _viaRevert(2, v, hex"00", ISQController.InvalidSignature.selector);
    }

    // ------------------------------------------------------------------ round progression, mixed paths

    function test_ReviseViaOnReportThenAcceptViaSubmitVerdict() public {
        uint256 id = setupFunded(2);
        _via(1, mkRevise(id, 0), signVerdict(mkRevise(id, 0)));
        _via(0, mkRevise(id, 1), signVerdict(mkRevise(id, 1)));
        submitJob(id, DELIVERABLE);
        ISQController.Verdict memory acc = mkAccept(id, 2);
        _via(2, acc, signVerdict(acc));
        ISQController.JobState memory st = sq.getState(id);
        assertEq(uint8(st.decision), uint8(ISQController.Decision.Accepted));
        assertTrue(st.settled);
        assertEq(st.round, 2);
        assertEq(st.credited, 6 * FEE);
        assertEq(sq.feeBalance(rA), 3 * FEE);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    function test_ReviseViaSubmitVerdictThenAcceptViaOnReport() public {
        uint256 id = setupFunded(1);
        send(mkRevise(id, 0));
        submitJob(id, DELIVERABLE);
        ISQController.Verdict memory acc = mkAccept(id, 1);
        _via(1, acc, signVerdict(acc));
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Accepted));
        assertEq(sq.getState(id).credited, 4 * FEE);
    }

    function test_OldRoundReplayViaOtherPathAfterAdvanceDoesNotMoveRound() public {
        uint256 id = setupFunded(2);
        ISQController.Verdict memory r0 = mkRevise(id, 0);
        _via(1, r0, signVerdict(r0));
        _via(0, mkRevise(id, 1), signVerdict(mkRevise(id, 1)));
        bytes32 fp = fingerprint(id);
        vm.recordLogs();
        _via(2, r0, signVerdict(r0));
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(fingerprint(id), fp);
        assertEq(sq.getState(id).round, 2);
    }

    function _runMixed(uint256 seed, bool allDirect) internal returns (bytes32) {
        uint256 id = setupFunded(2);
        for (uint8 r; r < 2; ++r) {
            ISQController.Verdict memory rv = mkRevise(id, r);
            sendVia(rv, allDirect ? 0 : seed >> (8 * r));
            if ((seed >> (20 + r)) & 1 == 1) sendVia(rv, allDirect ? 0 : seed >> (30 + 8 * r)); // redelivery
        }
        uint256 end = (seed >> 60) % 3;
        if (end == 0) {
            submitJob(id, DELIVERABLE);
            sendVia(mkAccept(id, 2), allDirect ? 0 : seed >> 70);
        } else if (end == 1) {
            sendVia(mkReject(id, 2), allDirect ? 0 : seed >> 70);
        } else {
            sendVia(mkRevise(id, 2), allDirect ? 0 : seed >> 70); // revision limit reached -> reject
        }
        return fingerprint(id);
    }

    function testFuzz_MixedPathsEquivalentToDirectOnly(uint256 seed) public {
        uint256 snap = vm.snapshotState();
        bytes32 direct = _runMixed(seed, true);
        assertTrue(vm.revertToState(snap));
        bytes32 mixed = _runMixed(seed, false);
        assertEq(mixed, direct, "any mix of paths ends in the same state");
    }

    // ------------------------------------------------------------------ lifecycle checks apply to onReport

    function _expectLifecycle(uint256 id, ISQController.Verdict memory v, bytes4 err) internal {
        bytes memory sig = signVerdict(v);
        bytes32 fp = fingerprint(id);
        for (uint256 p = 1; p < 3; ++p) {
            vm.recordLogs();
            _viaRevert(p, v, sig, err);
            assertEq(vm.getRecordedLogs().length, 0);
            assertEq(fingerprint(id), fp, "revert leaves no trace");
        }
    }

    function test_RevertWhen_OnReportAfterDeadline() public {
        uint256 id = setupFunded(1);
        vm.warp(DEADLINE + 1);
        _expectLifecycle(id, mkRevise(id, 0), ISQController.DeadlinePassed.selector);
    }

    function test_OnReportAtExactDeadlineSucceeds() public {
        uint256 id = setupFunded(1);
        vm.warp(DEADLINE);
        deliverSigned(prodForwarder, mkRevise(id, 0));
        assertEq(sq.getState(id).round, 1);
    }

    function test_RevertWhen_OnReportWrongRound() public {
        uint256 id = setupFunded(2);
        _expectLifecycle(id, mkRevise(id, 1), ISQController.WrongRound.selector);
    }

    function test_RevertWhen_OnReportAlreadyDecided() public {
        uint256 id = setupFunded(2);
        send(mkReject(id, 0));
        ISQController.Verdict memory later = mkRevise(id, 1);
        _expectLifecycle(id, later, ISQController.AlreadyDecided.selector);
    }

    function test_RevertWhen_OnReportAcceptNotSubmitted() public {
        uint256 id = setupFunded(2);
        _expectLifecycle(id, mkAccept(id, 0), ISQController.NotSubmitted.selector);
    }

    function test_RevertWhen_OnReportReviseWhileSubmitted() public {
        uint256 id = setupSubmitted(2);
        _expectLifecycle(id, mkRevise(id, 0), ISQController.ReviseRequiresFunded.selector);
    }

    function test_RevertWhen_OnReportBadMask() public {
        uint256 id = setupFunded(2);
        _expectLifecycle(id, mkVerdict(id, 0, REVISE, bytes32(0), 0), ISQController.BadMask.selector);
        _expectLifecycle(id, mkVerdict(id, 0, REVISE, bytes32(0), 4), ISQController.BadMask.selector);
        _expectLifecycle(id, mkVerdict(id, 0, REVISE, bytes32(0), 7), ISQController.BadMask.selector);
    }

    function test_RevertWhen_OnReportKindNone() public {
        uint256 id = setupFunded(2);
        _expectLifecycle(
            id, mkVerdict(id, 0, ISQController.VerdictKind.None, bytes32(0), 3), ISQController.BadKind.selector
        );
    }

    function test_RevertWhen_OnReportAcceptZeroDeliverable() public {
        uint256 id = setupSubmitted(2);
        _expectLifecycle(id, mkVerdict(id, 0, ACCEPT, bytes32(0), 3), ISQController.ZeroDeliverable.selector);
    }

    function test_RevertWhen_OnReportUnregisteredJob() public {
        uint256 id = newJob(EXPIRY);
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signDigest(authorityKey, digestFor(v, POLICY, SNAPSHOT, block.chainid, address(sq)));
        deliverExpectRevert(simForwarder, v, sig, abi.encodePacked(ISQController.NotRegistered.selector));
        deliverExpectRevert(prodForwarder, v, sig, abi.encodePacked(ISQController.NotRegistered.selector));
        deliverExpectRevert(prodForwarder, mkAccept(777, 0), sig, abi.encodePacked(ISQController.NotRegistered.selector));
    }

    // ------------------------------------------------------------------ fee-cap / kernel-failure atomicity

    function test_OnReportAcceptAboveEvaluatorCapRevertsAtomicallyThenRetries() public {
        uint256 id = setupSubmittedWithCaps(1, 100, 100);
        ac.setEvaluatorFee(300);
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signVerdict(v);
        bytes32 fp = fingerprint(id);
        for (uint256 p = 1; p < 3; ++p) {
            deliverExpectRevert(
                _fwd(p), v, sig, abi.encodeWithSelector(ISQController.EvaluatorFeeAboveCap.selector, 300, 100)
            );
            assertEq(fingerprint(id), fp, "credits and digest rolled back");
        }
        assertEq(sq.feeBalance(rA), 0);
        ac.setEvaluatorFee(100);
        deliver(simForwarder, v, sig);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(sq.feeBalance(rA), FEE);
    }

    function test_OnReportAcceptAbovePlatformCapRevertsAtomically() public {
        uint256 id = setupSubmittedWithCaps(1, 100, 100);
        ac.setPlatformFee(300, address(0xFEE));
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signVerdict(v);
        bytes32 fp = fingerprint(id);
        deliverExpectRevert(
            prodForwarder, v, sig, abi.encodeWithSelector(ISQController.PlatformFeeAboveCap.selector, 300, 100)
        );
        assertEq(fingerprint(id), fp);
    }

    function test_OnReportAcceptRevertsWhollyWhenKernelCompleteFails() public {
        uint256 id = setupSubmitted(1);
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signVerdict(v);
        bytes32 fp = fingerprint(id);
        ac.testOnly_setFailComplete(true);
        deliverExpectRevert(
            simForwarder, v, sig, abi.encodePacked(MockAgenticCommerce.ForcedCompleteFailure.selector)
        );
        assertEq(fingerprint(id), fp, "no digest, no credit, no approval");
        ac.testOnly_setFailComplete(false);
        deliver(simForwarder, v, sig);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    // ------------------------------------------------------------------ ERC-1271 authority

    function _register1271() internal returns (uint256 id, Mock1271Wallet wallet) {
        id = newJob(EXPIRY);
        fundJob(id, BUDGET);
        wallet = new Mock1271Wallet(authority);
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, 2, FEE);
        p.verdictAuthority = address(wallet);
        registerWith(p);
        submitJob(id, DELIVERABLE);
    }

    function test_Erc1271AuthorityWorksThroughOnReport() public {
        (uint256 id,) = _register1271();
        ISQController.Verdict memory v = mkAccept(id, 0);
        deliverExpectRevert(
            simForwarder, v, signDigest(0xBAD, sq.hashVerdict(v)), abi.encodePacked(ISQController.InvalidSignature.selector)
        );
        bytes memory sig = signVerdict(v);
        deliver(prodForwarder, v, sig);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Accepted));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        bytes32 fp = fingerprint(id);
        deliver(simForwarder, v, sig); // valid redelivery: no-op
        _via(0, v, sig);
        assertEq(fingerprint(id), fp);
        deliverExpectRevert(simForwarder, v, hex"deadbeef", abi.encodePacked(ISQController.InvalidSignature.selector));
    }
}
