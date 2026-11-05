// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {SQBase} from "./SQBase.sol";
import {MockAgenticCommerce} from "./mocks/MockAgenticCommerce.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

/// @dev Buyer-pinned kernel fee caps: checked against LIVE kernel fees right before complete,
/// in ACCEPT (atomic) and in the defensive settle retry. Registration never reads live fees.
contract SQControllerFeeCapsTest is SQBase {
    address internal treasury = makeAddr("treasury");

    function _snapshotUnchanged(uint256 id, uint256 sqBal) internal view {
        ISQController.JobState memory s = sq.getState(id);
        assertEq(sq.verdictDigestOf(id, 0), bytes32(0), "no digest");
        assertEq(sq.creditedMaskOf(id, 0), 0, "no credit mask");
        assertEq(s.credited, 0, "nothing credited");
        assertEq(s.kernelFeeReceived, 0);
        assertEq(s.round, 0);
        assertEq(uint8(s.decision), uint8(ISQController.Decision.None), "no approval");
        assertEq(s.approvedDeliverable, bytes32(0));
        assertEq(s.approvedEvidenceHash, bytes32(0));
        assertFalse(s.settled);
        assertEq(sq.feeBalance(rA), 0);
        assertEq(sq.feeBalance(rB), 0);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Submitted), "kernel still Submitted");
        assertEq(usdc.balanceOf(address(ac)), BUDGET);
        assertEq(usdc.balanceOf(provider), 0);
        assertEq(usdc.balanceOf(address(sq)), sqBal);
    }

    function _acceptExpectRevert(uint256 id, bytes memory err) internal {
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signVerdict(v);
        vm.expectRevert(err);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
    }

    function _platErr(uint256 live, uint256 cap) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ISQController.PlatformFeeAboveCap.selector, live, cap);
    }

    function _evalErr(uint256 live, uint256 cap) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ISQController.EvaluatorFeeAboveCap.selector, live, cap);
    }

    // ------------------------------------------------------------------ ACCEPT boundaries

    function test_Accept_PlatformFeeEqualToCapPasses() public {
        ac.setPlatformFee(500, treasury);
        uint256 id = setupSubmittedWithCaps(1, 500, 0);
        send(mkAccept(id, 0));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET * 95 / 100);
        assertEq(usdc.balanceOf(treasury), BUDGET * 5 / 100);
    }

    function test_Accept_PlatformFeeOneAboveCapReverts() public {
        ac.setPlatformFee(501, treasury);
        uint256 id = setupSubmittedWithCaps(1, 500, 5000);
        uint256 bal = usdc.balanceOf(address(sq));
        _acceptExpectRevert(id, _platErr(501, 500));
        _snapshotUnchanged(id, bal);
    }

    function test_Accept_EvaluatorFeeEqualToCapPasses() public {
        ac.setEvaluatorFee(700);
        uint256 id = setupSubmittedWithCaps(1, 0, 700);
        send(mkAccept(id, 0));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(sq.getState(id).kernelFeeReceived, BUDGET * 700 / 10000);
    }

    function test_Accept_EvaluatorFeeOneAboveCapReverts() public {
        ac.setEvaluatorFee(701);
        uint256 id = setupSubmittedWithCaps(1, 5000, 700);
        uint256 bal = usdc.balanceOf(address(sq));
        _acceptExpectRevert(id, _evalErr(701, 700));
        _snapshotUnchanged(id, bal);
    }

    function test_Accept_BothAboveCap_PlatformCheckedFirst() public {
        ac.setPlatformFee(300, treasury);
        ac.setEvaluatorFee(400);
        uint256 id = setupSubmittedWithCaps(1, 299, 399);
        _acceptExpectRevert(id, _platErr(300, 299));
    }

    function test_Accept_ZeroCapsWithZeroLiveFeesPass() public {
        uint256 id = setupSubmittedWithCaps(1, 0, 0);
        send(mkAccept(id, 0));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
        assertTrue(sq.getState(id).settled);
    }

    function test_Accept_ZeroCapsWithLiveEvaluatorFee_RevertsAtomically_RetryAfterLoweringSucceeds() public {
        ac.setEvaluatorFee(100);
        uint256 id = setupSubmittedWithCaps(2, 0, 0);
        uint256 bal = usdc.balanceOf(address(sq));
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signVerdict(v);

        vm.expectRevert(_evalErr(100, 0));
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        _snapshotUnchanged(id, bal);

        // lower the live fee; the very same signed verdict now succeeds
        ac.setEvaluatorFee(0);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        ISQController.JobState memory s = sq.getState(id);
        assertEq(uint8(s.decision), uint8(ISQController.Decision.Accepted));
        assertTrue(s.settled);
        assertEq(s.credited, 2 * FEE);
        assertEq(sq.feeBalance(rA), FEE);
        assertEq(sq.verdictDigestOf(id, 0), sq.hashVerdict(v));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
    }

    function test_Accept_ZeroCapsWithLivePlatformFee_Reverts() public {
        ac.setPlatformFee(1, treasury);
        uint256 id = setupSubmittedWithCaps(0, 0, 0);
        _acceptExpectRevert(id, _platErr(1, 0));
    }

    function test_Accept_FeeRaisedAfterRegistrationAboveCap_Reverts() public {
        uint256 id = setupSubmittedWithCaps(1, 100, 100);
        ac.setEvaluatorFee(101); // admin raises after the buyer registered
        _acceptExpectRevert(id, _evalErr(101, 100));
        ac.setEvaluatorFee(100);
        send(mkAccept(id, 0));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    function test_Accept_FeeAboveCap_ThenTimeoutRefundsBuyer() public {
        ac.setEvaluatorFee(100);
        uint256 id = setupSubmittedWithCaps(2, 0, 0);
        _acceptExpectRevert(id, _evalErr(100, 0));
        vm.warp(DEADLINE + 1);
        sq.rejectOnTimeout(id);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdc.balanceOf(buyer), BUDGET);
        assertEq(usdc.balanceOf(provider), 0);
        assertEq(sq.refundFees(id), 6 * FEE);
    }

    function test_Accept_FeeAboveCapOnLaterRound_KeepsEarlierRoundIntact() public {
        uint256 id = newJob(EXPIRY);
        fundJob(id, BUDGET);
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, 2, FEE);
        p.maxEvaluatorFeeBP = 0;
        p.maxPlatformFeeBP = 0;
        registerWith(p);
        send(mkRevise(id, 0));
        submitJob(id, DELIVERABLE);
        ac.setEvaluatorFee(50);
        ISQController.Verdict memory v = mkAccept(id, 1);
        bytes memory sig = signVerdict(v);
        vm.expectRevert(_evalErr(50, 0));
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        ISQController.JobState memory s = sq.getState(id);
        assertEq(s.round, 1, "round unchanged");
        assertEq(s.credited, 2 * FEE, "only round 0 credited");
        assertEq(sq.verdictDigestOf(id, 1), bytes32(0));
        assertEq(sq.creditedMaskOf(id, 1), 0);
        assertEq(uint8(s.decision), uint8(ISQController.Decision.None));
    }

    function testFuzz_Accept_SucceedsIffLiveFeesWithinCaps(uint256 liveP, uint256 liveE, uint256 capP, uint256 capE)
        public
    {
        liveP = bound(liveP, 0, 5000);
        liveE = bound(liveE, 0, 5000);
        capP = bound(capP, 0, 5000);
        capE = bound(capE, 0, 5000);
        ac.setPlatformFee(liveP, treasury);
        ac.setEvaluatorFee(liveE);
        uint256 id = setupSubmittedWithCaps(1, capP, capE);
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signVerdict(v);
        if (liveP > capP) {
            vm.expectRevert(_platErr(liveP, capP));
        } else if (liveE > capE) {
            vm.expectRevert(_evalErr(liveE, capE));
        }
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        bool ok = liveP <= capP && liveE <= capE;
        assertEq(sq.getState(id).settled, ok);
        assertEq(uint8(kernelStatus(id)), uint8(ok ? IAgenticCommerce.JobStatus.Completed : IAgenticCommerce.JobStatus.Submitted));
        assertEq(sq.getState(id).credited, ok ? 2 * FEE : 0);
    }

    // ------------------------------------------------------------------ CompletionFeesApplied

    function test_CompletionFeesAppliedCarriesLiveValuesNotCaps() public {
        ac.setPlatformFee(300, treasury);
        ac.setEvaluatorFee(700);
        uint256 id = setupSubmittedWithCaps(1, 1000, 2000);
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signVerdict(v);
        vm.recordLogs();
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.CompletionFeesApplied(id, 300, 700);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(countLogs(logs, address(sq), ISQController.CompletionFeesApplied.selector), 1);
        Vm.Log memory l = findLog(logs, address(sq), ISQController.CompletionFeesApplied.selector);
        assertEq(l.data, abi.encode(uint256(300), uint256(700)));
        assertEq(usdc.balanceOf(provider), BUDGET - BUDGET * 300 / 10000 - BUDGET * 700 / 10000);
    }

    // ------------------------------------------------------------------ registration independent of live fees

    function test_RegistrationSucceedsEvenWhenLiveFeesAlreadyExceedCaps_ThenAcceptReverts() public {
        ac.setPlatformFee(400, treasury);
        ac.setEvaluatorFee(600);
        uint256 id = setupSubmittedWithCaps(1, 10, 20);
        assertTrue(sq.isRegistered(id));
        assertEq(sq.getConfig(id).maxPlatformFeeBP, 10);
        assertEq(sq.getConfig(id).maxEvaluatorFeeBP, 20);
        _acceptExpectRevert(id, _platErr(400, 10));
    }

    // ------------------------------------------------------------------ REJECT / timeout / revise unaffected

    function test_RejectUnaffectedByCaps() public {
        ac.setPlatformFee(900, treasury);
        ac.setEvaluatorFee(900);
        uint256 id = setupSubmittedWithCaps(1, 0, 0);
        vm.recordLogs();
        send(mkReject(id, 0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdc.balanceOf(buyer), BUDGET);
        assertEq(countLogs(logs, address(sq), ISQController.CompletionFeesApplied.selector), 0);
        assertEq(sq.getState(id).credited, 2 * FEE);
    }

    function test_RejectWhileFundedUnaffectedByCaps() public {
        ac.setEvaluatorFee(900);
        uint256 id = newJob(EXPIRY);
        fundJob(id, BUDGET);
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, 1, FEE);
        p.maxPlatformFeeBP = 0;
        p.maxEvaluatorFeeBP = 0;
        registerWith(p);
        send(mkRevise(id, 0));
        send(mkReject(id, 1));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
    }

    function test_RejectOnTimeoutUnaffectedByCaps() public {
        ac.setPlatformFee(900, treasury);
        ac.setEvaluatorFee(900);
        uint256 id = setupSubmittedWithCaps(1, 0, 0);
        vm.warp(DEADLINE + 1);
        vm.recordLogs();
        sq.rejectOnTimeout(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdc.balanceOf(buyer), BUDGET);
        assertEq(countLogs(logs, address(sq), ISQController.CompletionFeesApplied.selector), 0);
        assertEq(countLogs(logs, address(sq), ISQController.TimeoutRejected.selector), 1);
    }

    // ------------------------------------------------------------------ settle retry uses the same caps

    function _forced(uint256 platCap, uint256 evalCap) internal returns (uint256 id) {
        id = setupSubmittedWithCaps(1, platCap, evalCap);
        forceAcceptedUnsettled(id, EVIDENCE);
    }

    function _settleExpectRevert(uint256 id, bytes memory err) internal {
        vm.expectRevert(err);
        vm.prank(stranger);
        sq.settle(id);
        assertFalse(sq.getState(id).settled, "settled flag rolled back");
        assertEq(sq.getState(id).kernelFeeReceived, 0);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
        assertEq(usdc.balanceOf(provider), 0);
    }

    function test_Settle_PlatformFeeEqualCapPasses_OneAboveReverts() public {
        uint256 id = _forced(500, 0);
        ac.setPlatformFee(501, treasury);
        _settleExpectRevert(id, _platErr(501, 500));
        ac.setPlatformFee(500, treasury);
        sq.settle(id);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET * 95 / 100);
    }

    function test_Settle_EvaluatorFeeEqualCapPasses_OneAboveReverts() public {
        uint256 id = _forced(0, 700);
        ac.setEvaluatorFee(701);
        _settleExpectRevert(id, _evalErr(701, 700));
        ac.setEvaluatorFee(700);
        sq.settle(id);
        assertTrue(sq.getState(id).settled);
        assertEq(sq.getState(id).kernelFeeReceived, BUDGET * 700 / 10000);
    }

    function test_Settle_ZeroCapsZeroFeesPass() public {
        uint256 id = _forced(0, 0);
        sq.settle(id);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    function test_Settle_ZeroCapsNonZeroEvaluatorFeeReverts_RetryAfterLoweringSucceeds() public {
        uint256 id = _forced(0, 0);
        ac.setEvaluatorFee(1);
        _settleExpectRevert(id, _evalErr(1, 0));
        ac.setEvaluatorFee(0);
        sq.settle(id);
        assertTrue(sq.getState(id).settled);
    }

    function test_Settle_CompletionFeesAppliedCarriesLiveValues() public {
        ac.setPlatformFee(250, treasury);
        ac.setEvaluatorFee(450);
        uint256 id = _forced(1000, 1000);
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.CompletionFeesApplied(id, 250, 450);
        sq.settle(id);
    }

    function test_Settle_AfterAtomicAcceptIsAlreadySettled_EvenIfFeesNowAboveCap() public {
        uint256 id = setupSubmittedWithCaps(1, 0, 0);
        send(mkAccept(id, 0));
        ac.setEvaluatorFee(500);
        vm.expectRevert(ISQController.AlreadySettled.selector);
        sq.settle(id);
    }
}
