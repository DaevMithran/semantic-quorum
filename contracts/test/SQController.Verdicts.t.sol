// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {SQBase} from "./SQBase.sol";
import {Mock1271Wallet} from "./mocks/Mock1271Wallet.sol";
import {MockAgenticCommerce} from "./mocks/MockAgenticCommerce.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

contract SQControllerVerdictsTest is SQBase {
    bytes32 internal constant OTHER = keccak256("other");

    // ------------------------------------------------------------------ helpers

    function _expectInvalid(ISQController.Verdict memory v, bytes memory sig) internal {
        vm.expectRevert(ISQController.InvalidSignature.selector);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
    }

    function _signedAccept() internal returns (uint256 id, ISQController.Verdict memory v, bytes memory sig) {
        id = setupSubmitted(2);
        v = mkAccept(id, 0);
        sig = signVerdict(v);
    }

    function _logsOf(ISQController.Verdict memory v) internal returns (Vm.Log[] memory) {
        vm.recordLogs();
        send(v);
        return vm.getRecordedLogs();
    }

    // ------------------------------------------------------------------ signatures

    function test_ValidSignatureAccepted() public {
        (uint256 id, ISQController.Verdict memory v, bytes memory sig) = _signedAccept();
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Accepted));
        assertEq(sq.verdictDigestOf(id, 0), sq.hashVerdict(v));
    }

    function test_IndependentDigestMatchesContract() public {
        (, ISQController.Verdict memory v,) = _signedAccept();
        assertEq(digestFor(v, POLICY, SNAPSHOT, block.chainid, address(sq)), sq.hashVerdict(v));
    }

    function test_RevertWhen_WrongSigner() public {
        (, ISQController.Verdict memory v,) = _signedAccept();
        _expectInvalid(v, signDigest(0xBAD, sq.hashVerdict(v)));
    }

    function test_RevertWhen_ChainIdDiffers() public {
        (, ISQController.Verdict memory v, bytes memory sig) = _signedAccept();
        vm.chainId(block.chainid + 1);
        _expectInvalid(v, sig);
    }

    function test_RevertWhen_SignedForOtherContractDomain() public {
        (, ISQController.Verdict memory v,) = _signedAccept();
        bytes32 foreign = digestFor(v, POLICY, SNAPSHOT, block.chainid, address(0xdead));
        _expectInvalid(v, signDigest(authorityKey, foreign));
    }

    function test_RevertWhen_SignedForOtherChainDomain() public {
        (, ISQController.Verdict memory v,) = _signedAccept();
        bytes32 foreign = digestFor(v, POLICY, SNAPSHOT, block.chainid + 1, address(sq));
        _expectInvalid(v, signDigest(authorityKey, foreign));
    }

    function test_RevertWhen_SignedOverDifferentPolicy() public {
        (, ISQController.Verdict memory v,) = _signedAccept();
        _expectInvalid(v, signDigest(authorityKey, digestFor(v, OTHER, SNAPSHOT, block.chainid, address(sq))));
    }

    function test_RevertWhen_SignedOverDifferentSnapshot() public {
        (, ISQController.Verdict memory v,) = _signedAccept();
        _expectInvalid(v, signDigest(authorityKey, digestFor(v, POLICY, OTHER, block.chainid, address(sq))));
    }

    function test_RevertWhen_ReportsHashTampered() public {
        (, ISQController.Verdict memory v, bytes memory sig) = _signedAccept();
        v.reportsHash = OTHER;
        _expectInvalid(v, sig);
    }

    function test_RevertWhen_DeficiencyHashTampered() public {
        (, ISQController.Verdict memory v, bytes memory sig) = _signedAccept();
        v.deficiencyHash = OTHER;
        _expectInvalid(v, sig);
    }

    function test_RevertWhen_DeliverableTampered() public {
        (, ISQController.Verdict memory v, bytes memory sig) = _signedAccept();
        v.deliverable = OTHER;
        _expectInvalid(v, sig);
    }

    function test_RevertWhen_EvidenceHashTampered() public {
        (, ISQController.Verdict memory v, bytes memory sig) = _signedAccept();
        v.evidenceHash = OTHER;
        _expectInvalid(v, sig);
    }

    function test_RevertWhen_IncludedMaskTampered() public {
        (, ISQController.Verdict memory v, bytes memory sig) = _signedAccept();
        v.includedMask = 1;
        _expectInvalid(v, sig);
    }

    function test_RevertWhen_KindTampered() public {
        (, ISQController.Verdict memory v, bytes memory sig) = _signedAccept();
        v.kind = ISQController.VerdictKind.Reject;
        _expectInvalid(v, sig);
    }

    function test_Erc1271AuthorityAccepted() public {
        uint256 id = newJob(EXPIRY);
        fundJob(id, BUDGET);
        Mock1271Wallet wallet = new Mock1271Wallet(authority);
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, 2, FEE);
        p.verdictAuthority = address(wallet);
        registerWith(p);
        submitJob(id, DELIVERABLE);

        ISQController.Verdict memory v = mkAccept(id, 0);
        _expectInvalid(v, signDigest(0xBAD, sq.hashVerdict(v))); // wallet rejects a non-owner key
        send(v);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Accepted));
    }

    // ------------------------------------------------------------------ ACCEPT

    function test_RevertWhen_AcceptWhileFunded_NotSubmitted() public {
        uint256 id = setupFunded(2);
        sendExpectRevert(mkAccept(id, 0), ISQController.NotSubmitted.selector);
    }

    function test_RevertWhen_AcceptWhileOpen_NotRegistered() public {
        uint256 id = newJob(EXPIRY);
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.submitVerdict(mkAccept(id, 0), hex"deadbeef");
    }

    function test_RevertWhen_AcceptZeroDeliverable() public {
        uint256 id = setupSubmitted(2);
        sendExpectRevert(
            mkVerdict(id, 0, ISQController.VerdictKind.Accept, bytes32(0), 3), ISQController.ZeroDeliverable.selector
        );
    }

    function test_AcceptCompletesAtomicallyInSameTx() public {
        uint256 id = setupSubmitted(2);
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signVerdict(v);

        vm.recordLogs();
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.DeliverableApproved(id, DELIVERABLE, EVIDENCE);
        vm.expectEmit(true, false, false, true, address(ac));
        emit MockAgenticCommerce.JobCompleted(id, address(sq), EVIDENCE);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        ISQController.JobState memory s = sq.getState(id);
        assertEq(uint8(s.decision), uint8(ISQController.Decision.Accepted));
        assertEq(s.approvedDeliverable, DELIVERABLE);
        assertEq(s.approvedEvidenceHash, EVIDENCE);
        assertTrue(s.settled, "settled in the ACCEPT tx");
        assertEq(s.kernelFeeReceived, 0);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
        assertEq(usdc.balanceOf(address(ac)), 0);
        assertEq(countLogs(logs, address(ac), MockAgenticCommerce.JobCompleted.selector), 1);
        assertEq(findLog(logs, address(sq), ISQController.JobSettled.selector).data, abi.encode(true, EVIDENCE));
        assertEq(countLogs(logs, address(sq), ISQController.KernelEvaluatorFeeReceived.selector), 0);
    }

    function _assertOrder(bytes32[] memory got, bytes32[] memory want) internal pure {
        assertEq(got.length, want.length, "sq log count");
        for (uint256 i; i < want.length; ++i) {
            assertEq(got[i], want[i], "sq log order");
        }
    }

    function test_AcceptEventOrder_NoKernelFee() public {
        uint256 id = setupSubmitted(2);
        Vm.Log[] memory logs = _logsOf(mkAccept(id, 0));
        bytes32[] memory want = new bytes32[](6);
        want[0] = ISQController.FeeCredited.selector;
        want[1] = ISQController.FeeCredited.selector;
        want[2] = ISQController.DeliverableApproved.selector;
        want[3] = ISQController.CompletionFeesApplied.selector;
        want[4] = ISQController.JobSettled.selector;
        want[5] = ISQController.VerdictRecorded.selector;
        _assertOrder(sqTopics(logs), want);
    }

    function test_AcceptEventOrder_WithKernelEvaluatorFee() public {
        ac.setEvaluatorFee(1000);
        uint256 id = setupSubmitted(2);
        Vm.Log[] memory logs = _logsOf(mkAccept(id, 0));
        bytes32[] memory want = new bytes32[](7);
        want[0] = ISQController.FeeCredited.selector;
        want[1] = ISQController.FeeCredited.selector;
        want[2] = ISQController.DeliverableApproved.selector;
        want[3] = ISQController.KernelEvaluatorFeeReceived.selector;
        want[4] = ISQController.CompletionFeesApplied.selector;
        want[5] = ISQController.JobSettled.selector;
        want[6] = ISQController.VerdictRecorded.selector;
        _assertOrder(sqTopics(logs), want);
        assertEq(sq.getState(id).kernelFeeReceived, BUDGET / 10);
    }

    function test_AcceptRevertsWholly_WhenKernelCompleteFails() public {
        uint256 id = setupFunded(2);
        send(mkRevise(id, 0)); // round 1, 2*FEE credited
        submitJob(id, DELIVERABLE);
        uint256 balBefore = usdc.balanceOf(address(sq));
        ac.testOnly_setFailComplete(true);

        ISQController.Verdict memory v = mkAccept(id, 1);
        bytes memory sig = signVerdict(v);
        vm.expectRevert(MockAgenticCommerce.ForcedCompleteFailure.selector);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);

        ISQController.JobState memory s = sq.getState(id);
        assertEq(sq.verdictDigestOf(id, 1), bytes32(0), "no digest stored");
        assertEq(sq.creditedMaskOf(id, 1), 0, "no credit mask");
        assertEq(s.credited, 2 * FEE, "no fees credited");
        assertEq(sq.feeBalance(rA), FEE);
        assertEq(sq.feeBalance(rB), FEE);
        assertEq(s.round, 1, "round unchanged");
        assertEq(uint8(s.decision), uint8(ISQController.Decision.None), "no approval");
        assertEq(s.approvedEvidenceHash, bytes32(0));
        assertEq(s.approvedDeliverable, bytes32(0));
        assertFalse(s.settled);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
        assertEq(usdc.balanceOf(address(sq)), balBefore);

        // the same signed verdict succeeds once the kernel works again
        ac.testOnly_setFailComplete(false);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(sq.getState(id).credited, 4 * FEE);
        assertTrue(sq.getState(id).settled);
    }

    // ------------------------------------------------------------------ fee credit + VerdictRecorded

    function test_VerdictRecordedCarriesHashesAndCreditsFees() public {
        uint256 id = setupSubmitted(2);
        ISQController.Verdict memory v = mkAccept(id, 0);
        Vm.Log[] memory logs = _logsOf(v);

        Vm.Log memory l = findLog(logs, address(sq), ISQController.VerdictRecorded.selector);
        assertEq(uint256(l.topics[1]), id);
        assertEq(uint256(l.topics[2]), 0);
        assertEq(l.data, recordedData(v, ISQController.VerdictKind.Accept, sq.hashVerdict(v)));
        assertEq(countLogs(logs, address(sq), ISQController.FeeCredited.selector), 2);

        assertEq(sq.feeBalance(rA), FEE);
        assertEq(sq.feeBalance(rB), FEE);
        assertEq(sq.getState(id).credited, 2 * FEE);
        assertEq(sq.creditedMaskOf(id, 0), 3);
    }

    function test_PartialMaskCreditsOnlyIncludedMembers() public {
        uint256 id = setupSubmitted(2);
        send(mkVerdict(id, 0, ISQController.VerdictKind.Accept, DELIVERABLE, 2));
        assertEq(sq.feeBalance(rA), 0);
        assertEq(sq.feeBalance(rB), FEE);
        assertEq(sq.creditedMaskOf(id, 0), 2);
        assertEq(sq.getState(id).credited, FEE);
    }

    // ------------------------------------------------------------------ REVISE

    function test_ReviseWhileFundedAdvancesRoundAndKeepsKernelFunded() public {
        uint256 id = setupFunded(2);
        ISQController.Verdict memory v = mkRevise(id, 0);
        bytes memory sig = signVerdict(v);

        vm.recordLogs();
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.RevisionRequested(id, 1, EVIDENCE, DEFICIENCY);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(sq.getState(id).round, 1);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.None));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Funded));
        Vm.Log memory l = findLog(logs, address(sq), ISQController.VerdictRecorded.selector);
        assertEq(l.data, recordedData(v, ISQController.VerdictKind.Revise, sq.hashVerdict(v)));
        assertEq(sq.feeBalance(rA), FEE);
    }

    function test_RevertWhen_ReviseWhileSubmitted() public {
        uint256 id = setupSubmitted(2);
        sendExpectRevert(mkRevise(id, 0), ISQController.ReviseRequiresFunded.selector);
    }

    function test_ReviseAtLimitExecutesAsReject() public {
        uint256 id = setupFunded(1);
        send(mkRevise(id, 0));
        assertEq(sq.getState(id).round, 1);

        ISQController.Verdict memory v = mkRevise(id, 1);
        Vm.Log[] memory logs = _logsOf(v);

        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdc.balanceOf(buyer), BUDGET, "budget refunded");
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Rejected));
        assertEq(sq.getState(id).round, 1);

        Vm.Log memory lim = findLog(logs, address(sq), ISQController.RevisionLimitReached.selector);
        assertEq(uint256(lim.topics[1]), id);
        assertEq(lim.data, abi.encode(uint8(1)));
        Vm.Log memory settled = findLog(logs, address(sq), ISQController.JobSettled.selector);
        assertEq(settled.data, abi.encode(false, EVIDENCE));
        Vm.Log memory rec = findLog(logs, address(sq), ISQController.VerdictRecorded.selector);
        assertEq(rec.data, recordedData(v, ISQController.VerdictKind.Reject, sq.hashVerdict(v)));
        // recordedData encodes kind=Revise (from v) and effectiveKind=Reject, so the above pins both.
        // kernel saw reason == evidenceHash
        Vm.Log memory kr = findLog(logs, address(ac), MockAgenticCommerce.JobRejected.selector);
        assertEq(address(uint160(uint256(kr.topics[2]))), address(sq));
        assertEq(abi.decode(kr.data, (bytes32)), EVIDENCE);
    }

    function test_RevisionLimitZero_FirstReviseIsReject() public {
        uint256 id = setupFunded(0);
        Vm.Log[] memory logs = _logsOf(mkRevise(id, 0));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdc.balanceOf(buyer), BUDGET);
        assertEq(countLogs(logs, address(sq), ISQController.RevisionLimitReached.selector), 1);
        assertEq(countLogs(logs, address(sq), ISQController.RevisionRequested.selector), 0);
        assertEq(sq.getState(id).round, 0);
    }

    // ------------------------------------------------------------------ REJECT

    function test_RejectWhileFundedRefundsBuyer() public {
        uint256 id = setupFunded(2);
        Vm.Log[] memory logs = _logsOf(mkReject(id, 0));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdc.balanceOf(buyer), BUDGET);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Rejected));
        assertEq(findLog(logs, address(sq), ISQController.JobSettled.selector).data, abi.encode(false, EVIDENCE));
        assertEq(countLogs(logs, address(sq), ISQController.RevisionLimitReached.selector), 0);
        assertEq(sq.feeBalance(rA), FEE);
    }

    function test_RejectWhileSubmittedRefundsBuyer() public {
        uint256 id = setupSubmitted(2);
        send(mkReject(id, 0));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdc.balanceOf(buyer), BUDGET);
        assertEq(usdc.balanceOf(provider), 0);
    }

    /// @dev Open jobs cannot be registered (WrongJobStatus), so any verdict on one hits NotRegistered
    /// before signatures are even checked. No fees can be credited and nothing is recorded.
    function test_RejectWhileOpen_NotRegistered_NoFeesCredited() public {
        uint256 id = newJob(EXPIRY);
        ISQController.Verdict memory v = mkReject(id, 0);
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.submitVerdict(v, hex"deadbeef");
        assertEq(sq.feeBalance(rA), 0);
        assertEq(sq.feeBalance(rB), 0);
        assertEq(sq.getState(id).credited, 0);
        assertEq(sq.creditedMaskOf(id, 0), 0);
        assertEq(sq.verdictDigestOf(id, 0), bytes32(0));
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.None));
    }

    function test_RevertWhen_ReviseWhileOpen_NotRegistered() public {
        uint256 id = newJob(EXPIRY);
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.submitVerdict(mkRevise(id, 0), hex"deadbeef");
    }

    /// @dev A never-funded Submitted job (mock mirrors the real kernel: submit from Open with budget 0)
    /// cannot be registered, hence cannot be accepted, pay fees, or complete through SQController.
    function test_RevertWhen_AcceptNeverFundedSubmitted_NotRegistered() public {
        uint256 id = newJob(EXPIRY);
        submitJob(id, DELIVERABLE); // budget 0, status Open -> Submitted
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.submitVerdict(mkAccept(id, 0), hex"deadbeef");
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.settle(id);
        assertEq(sq.feeBalance(rA) + sq.feeBalance(rB), 0);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
    }

    // ------------------------------------------------------------------ validation order / errors

    function test_RevertWhen_KindNone() public {
        uint256 id = setupFunded(2);
        sendExpectRevert(mkVerdict(id, 0, ISQController.VerdictKind.None, bytes32(0), 3), ISQController.BadKind.selector);
    }

    function test_RevertWhen_MaskZero() public {
        uint256 id = setupSubmitted(2);
        sendExpectRevert(
            mkVerdict(id, 0, ISQController.VerdictKind.Accept, DELIVERABLE, 0), ISQController.BadMask.selector
        );
    }

    function test_RevertWhen_MaskBitBeyondCommittee() public {
        uint256 id = setupSubmitted(2);
        sendExpectRevert(
            mkVerdict(id, 0, ISQController.VerdictKind.Accept, DELIVERABLE, 4), ISQController.BadMask.selector
        );
        sendExpectRevert(
            mkVerdict(id, 0, ISQController.VerdictKind.Accept, DELIVERABLE, 7), ISQController.BadMask.selector
        );
        sendExpectRevert(
            mkVerdict(id, 0, ISQController.VerdictKind.Accept, DELIVERABLE, 1 << 255), ISQController.BadMask.selector
        );
    }

    function test_RevertWhen_WrongRound() public {
        uint256 id = setupSubmitted(2);
        sendExpectRevert(mkAccept(id, 1), ISQController.WrongRound.selector);
    }

    function test_RevertWhen_AlreadyDecidedAfterAccept() public {
        uint256 id = setupSubmitted(2);
        send(mkAccept(id, 0));
        sendExpectRevert(mkReject(id, 1), ISQController.AlreadyDecided.selector);
    }

    function test_RevertWhen_AlreadyDecidedAfterReject() public {
        uint256 id = setupFunded(2);
        send(mkReject(id, 0));
        sendExpectRevert(mkRevise(id, 1), ISQController.AlreadyDecided.selector);
    }

    function test_RevertWhen_DeadlinePassed() public {
        uint256 id = setupSubmitted(2);
        vm.warp(DEADLINE + 1);
        sendExpectRevert(mkAccept(id, 0), ISQController.DeadlinePassed.selector);
    }

    function test_VerdictAcceptedAtExactDeadline() public {
        uint256 id = setupSubmitted(2);
        vm.warp(DEADLINE);
        send(mkAccept(id, 0));
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Accepted));
    }

    function test_NoVerdictOnceKernelRefundClaimable() public {
        uint256 id = setupSubmitted(2);
        assertLt(sq.getConfig(id).decisionDeadline, ac.getJob(id).expiredAt);
        vm.warp(EXPIRY);
        sendExpectRevert(mkAccept(id, 0), ISQController.DeadlinePassed.selector);
        sendExpectRevert(mkReject(id, 0), ISQController.DeadlinePassed.selector);
        sendExpectRevert(mkRevise(id, 0), ISQController.DeadlinePassed.selector);
        ac.claimRefund(id); // kernel refund is now possible/executed
        sendExpectRevert(mkReject(id, 0), ISQController.DeadlinePassed.selector);
        assertEq(sq.getState(id).credited, 0);
    }

    // ------------------------------------------------------------------ idempotency / conflicts

    function test_IdenticalVerdictTwiceIsSilentNoOp() public {
        uint256 id = setupFunded(2);
        ISQController.Verdict memory v = mkRevise(id, 0);
        send(v);
        uint256 credited = sq.getState(id).credited;

        bytes memory sig = signVerdict(v);
        vm.recordLogs();
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        assertEq(vm.getRecordedLogs().length, 0, "no events on replay");
        assertEq(sq.getState(id).credited, credited);
        assertEq(sq.getState(id).round, 1, "old-round replay does not move round");
        assertEq(sq.feeBalance(rA), FEE);
    }

    function test_IdenticalVerdictReplayNoOpAfterTerminal() public {
        uint256 id = setupSubmitted(2);
        ISQController.Verdict memory v = mkReject(id, 0);
        send(v);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));

        bytes memory sig = signVerdict(v);
        vm.recordLogs();
        vm.prank(stranger);
        sq.submitVerdict(v, sig);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(sq.getState(id).credited, 2 * FEE);
        assertEq(usdc.balanceOf(buyer), BUDGET);
    }

    function test_IdenticalAcceptReplayNoOpAfterSettleAndDeadline() public {
        uint256 id = setupSubmitted(2);
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signVerdict(v);
        send(v);
        vm.warp(DEADLINE + 1 days);

        vm.recordLogs();
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(sq.getState(id).credited, 2 * FEE);
    }

    function test_RevertWhen_ConflictingVerdictSameRound() public {
        uint256 id = setupSubmitted(2);
        send(mkAccept(id, 0));
        sendExpectRevert(mkReject(id, 0), ISQController.ConflictingVerdict.selector);
        // same kind but different payload also conflicts
        ISQController.Verdict memory v = mkAccept(id, 0);
        v.evidenceHash = OTHER;
        sendExpectRevert(v, ISQController.ConflictingVerdict.selector);
        assertEq(sq.getState(id).credited, 2 * FEE);
    }

    function test_ReplayOfOldRoundReviseAfterAdvanceIsNoOp() public {
        uint256 id = setupFunded(2);
        ISQController.Verdict memory v0 = mkRevise(id, 0);
        send(v0);
        send(mkRevise(id, 1));
        assertEq(sq.getState(id).round, 2);
        uint256 credited = sq.getState(id).credited;

        bytes memory sig = signVerdict(v0);
        vm.recordLogs();
        vm.prank(relayer);
        sq.submitVerdict(v0, sig);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(sq.getState(id).round, 2);
        assertEq(sq.getState(id).credited, credited);
        // a different (conflicting) old-round verdict still reverts
        sendExpectRevert(mkReject(id, 0), ISQController.ConflictingVerdict.selector);
    }

    // ------------------------------------------------------------------ multi-round flow

    function test_MultiRound_Revise_Revise_Accept_SettlesAtomically() public {
        uint256 id = setupFunded(2);
        send(mkRevise(id, 0));
        assertEq(sq.getState(id).round, 1);
        send(mkRevise(id, 1));
        assertEq(sq.getState(id).round, 2);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Funded));

        submitJob(id, DELIVERABLE);
        send(mkAccept(id, 2));
        ISQController.JobState memory s = sq.getState(id);
        assertEq(uint8(s.decision), uint8(ISQController.Decision.Accepted));
        assertEq(s.credited, 6 * FEE);
        assertEq(s.credited, sq.getConfig(id).deposited, "full deposit credited");
        assertEq(sq.feeBalance(rA), 3 * FEE);
        assertEq(sq.feeBalance(rB), 3 * FEE);

        assertTrue(s.settled, "ACCEPT settled atomically");
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
        assertEq(sq.refundFees(id), 0);
    }

    // ------------------------------------------------------------------ signature precedes idempotency

    function test_RevertWhen_ReplayWithGarbageSignature() public {
        uint256 id = setupFunded(2);
        ISQController.Verdict memory v = mkRevise(id, 0);
        send(v);
        _expectInvalid(v, hex"deadbeef");
        _expectInvalid(v, new bytes(65));
        _expectInvalid(v, bytes.concat(bytes32(uint256(1)), bytes32(uint256(2)), bytes1(0x1b)));
        assertEq(sq.getState(id).round, 1);
        assertEq(sq.getState(id).credited, 2 * FEE);
    }

    function test_RevertWhen_ReplayWithEmptySignature() public {
        uint256 id = setupFunded(2);
        ISQController.Verdict memory v = mkRevise(id, 0);
        send(v);
        _expectInvalid(v, "");
        assertEq(sq.getState(id).credited, 2 * FEE);
    }

    function test_RevertWhen_ReplayWithWrongSigner() public {
        uint256 id = setupFunded(2);
        ISQController.Verdict memory v = mkRevise(id, 0);
        send(v);
        _expectInvalid(v, signDigest(0xBAD, sq.hashVerdict(v)));
        assertEq(sq.getState(id).credited, 2 * FEE);
    }

    function test_RevertWhen_TerminalAcceptReplayWithBadSignature_AfterDeadline() public {
        uint256 id = setupSubmitted(2);
        ISQController.Verdict memory v = mkAccept(id, 0);
        send(v);
        vm.warp(DEADLINE + 1 days);
        _expectInvalid(v, hex"deadbeef");
        _expectInvalid(v, "");
        _expectInvalid(v, signDigest(0xBAD, sq.hashVerdict(v)));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    function test_ValidReplayStillSilentNoOp_TerminalAndAfterDeadline() public {
        uint256 id = setupSubmitted(2);
        ISQController.Verdict memory v = mkReject(id, 0);
        bytes memory sig = signVerdict(v);
        send(v);
        vm.warp(EXPIRY + 1);
        vm.recordLogs();
        vm.prank(stranger);
        sq.submitVerdict(v, sig);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(sq.getState(id).credited, 2 * FEE);
    }

    function test_RevertWhen_ConflictingDigestWithBadSignature_InvalidSignatureNotConflict() public {
        uint256 id = setupSubmitted(2);
        send(mkAccept(id, 0));
        ISQController.Verdict memory other = mkReject(id, 0);
        _expectInvalid(other, hex"deadbeef");
        _expectInvalid(other, signDigest(0xBAD, sq.hashVerdict(other)));
        // the original verdict's signature does not validate the different payload either
        ISQController.Verdict memory orig = mkAccept(id, 0);
        _expectInvalid(other, signVerdict(orig));
    }

    function test_ConflictingDigestWithValidSignature_AfterTerminalAndDeadline() public {
        uint256 id = setupSubmitted(2);
        send(mkAccept(id, 0));
        vm.warp(DEADLINE + 1 days);
        sendExpectRevert(mkReject(id, 0), ISQController.ConflictingVerdict.selector);
    }

    function test_InvalidSignatureTakesPrecedenceOverLifecycleChecks() public {
        uint256 id = setupSubmitted(2);
        send(mkAccept(id, 0));
        // different round, already decided: bad signature must win over AlreadyDecided / WrongRound
        _expectInvalid(mkReject(id, 1), hex"deadbeef");
        vm.warp(DEADLINE + 1);
        _expectInvalid(mkReject(id, 5), "");
    }

    function test_RevertWhen_BadSignatureOnUnregisteredJob_NotRegistered() public {
        ISQController.Verdict memory v = mkAccept(4242, 0);
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.submitVerdict(v, hex"deadbeef");
    }

    function test_Erc1271Replay_BadSignatureReverts_ValidReplayNoOp() public {
        uint256 id = newJob(EXPIRY);
        fundJob(id, BUDGET);
        Mock1271Wallet wallet = new Mock1271Wallet(authority);
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, 2, FEE);
        p.verdictAuthority = address(wallet);
        registerWith(p);
        ISQController.Verdict memory v = mkRevise(id, 0);
        bytes memory sig = signVerdict(v);
        send(v);
        _expectInvalid(v, signDigest(0xBAD, sq.hashVerdict(v)));
        vm.recordLogs();
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    // ------------------------------------------------------------------ settle buffer vs kernel refund

    function _registeredWithDeadline(uint64 deadline, bool submitted) internal returns (uint256 id) {
        id = newJob(EXPIRY);
        fundJob(id, BUDGET);
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, 2, FEE);
        p.decisionDeadline = deadline;
        registerWith(p);
        // register while Funded, then (optionally) the provider submits
        if (submitted) submitJob(id, DELIVERABLE);
    }

    function test_VerdictWindowClosesAtLeastOneHourBeforeKernelRefundPossible() public {
        uint256 id = _registeredWithDeadline(uint64(EXPIRY - 1 hours), true);
        vm.warp(EXPIRY - 1 hours);
        // last second of the verdict window: claimRefund is still impossible, so ACCEPT completes
        vm.expectRevert(MockAgenticCommerce.WrongStatus.selector);
        ac.claimRefund(id);
        send(mkAccept(id, 0));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
    }

    function test_AfterWindowNoVerdict_ButKernelRefundStillImpossibleForAnHour() public {
        uint256 id = _registeredWithDeadline(uint64(EXPIRY - 1 hours), true);
        vm.warp(EXPIRY - 1 hours + 1);
        sendExpectRevert(mkAccept(id, 0), ISQController.DeadlinePassed.selector);
        sendExpectRevert(mkReject(id, 0), ISQController.DeadlinePassed.selector);
        vm.expectRevert(MockAgenticCommerce.WrongStatus.selector);
        ac.claimRefund(id);
        // the permissionless timeout rejection is available in the buffer, before the kernel expiry
        sq.rejectOnTimeout(id);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdc.balanceOf(buyer), BUDGET);
    }

    function test_NoVerdictOnceClaimRefundPossible_ExactExpiry() public {
        uint256 id = _registeredWithDeadline(uint64(EXPIRY - 1 hours), true);
        vm.warp(EXPIRY);
        sendExpectRevert(mkAccept(id, 0), ISQController.DeadlinePassed.selector);
        sendExpectRevert(mkReject(id, 0), ISQController.DeadlinePassed.selector);
        sendExpectRevert(mkRevise(id, 0), ISQController.DeadlinePassed.selector);
        assertEq(sq.getState(id).credited, 0);
    }
}
