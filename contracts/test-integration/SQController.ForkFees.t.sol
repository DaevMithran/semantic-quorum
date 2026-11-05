// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/Test.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";
import {SQForkBase, IKernel} from "./SQForkBase.sol";

/// @notice Non-zero kernel fees (set by the REAL admin) and decision-deadline / expiry behaviour on the REAL kernel.
contract SQControllerForkFeesTest is SQForkBase {
    ISQController.VerdictKind internal constant ACCEPT = ISQController.VerdictKind.Accept;
    uint256 internal constant PLAT_BP = 500; // 5%  of 1000e6 = 50e6
    uint256 internal constant EVAL_BP = 300; // 3%  of 1000e6 = 30e6

    function _submittedJob(uint256 capP, uint256 capE) internal returns (uint256 id, uint256 exp) {
        exp = expiryIn(1 days);
        id = fundedJob(BUDGET, exp);
        register(defaultParams(id, exp, capP, capE, 0));
        submitJob(id);
    }

    function _assertNothingChanged(uint256 id) internal view {
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Submitted), "kernel still Submitted");
        ISQController.JobState memory st = sq.getState(id);
        assertEq(st.credited, 0, "nothing credited");
        assertFalse(st.settled);
        assertEq(uint8(st.decision), uint8(ISQController.Decision.None));
        assertEq(sq.feeBalance(rA), 0);
        assertEq(sq.feeBalance(rB), 0);
        assertEq(sq.verdictDigestOf(id, 0), bytes32(0), "digest rolled back");
        assertEq(usdcBal(address(sq)), 2 * FEE, "SQ holds only the deposit");
        assertEq(usdcBal(bob), 0, "provider unpaid");
    }

    // ------------------------------------------------------------------ 5b: fee caps on the real kernel

    function test_05b_PlatformCapBelowLive_AtomicRevert_ThenRetrySucceedsAfterFeeDrop() public onlyFork {
        setLiveFees(PLAT_BP, EVAL_BP);
        (uint256 id,) = _submittedJob(400, 1000);
        ISQController.Verdict memory v = verdictOf(id, ACCEPT, 0, 3);
        bytes memory sig = sign(v);
        vm.expectRevert(abi.encodeWithSelector(ISQController.PlatformFeeAboveCap.selector, PLAT_BP, 400));
        sq.submitVerdict(v, sig);
        _assertNothingChanged(id);

        // the admin lowers the platform fee to the cap; the SAME signed verdict now completes
        vm.prank(TREASURY);
        ac.setPlatformFee(400, TREASURY);
        sq.submitVerdict(v, sig);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdcBal(bob), BUDGET - 40e6 - 30e6, "provider net uses the lowered fee");
    }

    function test_05b_EvaluatorCapBelowLive_AtomicRevert() public onlyFork {
        setLiveFees(PLAT_BP, EVAL_BP);
        (uint256 id,) = _submittedJob(1000, 200);
        ISQController.Verdict memory v = verdictOf(id, ACCEPT, 0, 3);
        bytes memory sig = sign(v);
        vm.expectRevert(abi.encodeWithSelector(ISQController.EvaluatorFeeAboveCap.selector, EVAL_BP, 200));
        sq.submitVerdict(v, sig);
        _assertNothingChanged(id);
        // defensive settle() is not available either: nothing was accepted
        vm.expectRevert(ISQController.NotAccepted.selector);
        sq.settle(id);
    }

    function test_05b_CapsEqualLive_Completes_EvaluatorCutPaidToSQ_RefundedToBuyer() public onlyFork {
        setLiveFees(PLAT_BP, EVAL_BP);
        (uint256 id,) = _submittedJob(PLAT_BP, EVAL_BP); // boundary: caps == live
        address treasury = ac.platformTreasury();
        uint256 treasuryBefore = usdcBal(treasury);
        uint256 sqBefore = usdcBal(address(sq));

        ISQController.Verdict memory v = verdictOf(id, ACCEPT, 0, 1); // only member 0 -> leftover FEE
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.KernelEvaluatorFeeReceived(id, 30e6);
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.CompletionFeesApplied(id, PLAT_BP, EVAL_BP);
        sq.submitVerdict(v, sign(v));

        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        uint256 measured = usdcBal(address(sq)) - sqBefore;
        assertEq(measured, 30e6, "real kernel paid the evaluator cut to SQController");
        assertEq(sq.getState(id).kernelFeeReceived, measured, "state.kernelFeeReceived == measured delta");
        assertEq(usdcBal(bob), BUDGET - 50e6 - 30e6, "provider gets budget minus both fees");
        assertEq(usdcBal(treasury) - treasuryBefore, 50e6, "treasury gets the platform fee");
        console2.log("provider net / platform fee / evaluator cut:", usdcBal(bob), usdcBal(treasury) - treasuryBefore, measured);

        // evaluator cut is NOT claimable by report recipients; only the credited member can claim
        vm.prank(rA);
        sq.claim();
        vm.prank(rB);
        vm.expectRevert(ISQController.NothingToClaim.selector);
        sq.claim();

        vm.prank(stranger);
        uint256 refunded = sq.refundFees(id);
        assertEq(refunded, FEE + 30e6, "leftover slot + kernelFeeReceived");
        assertEq(usdcBal(alice), FEE + 30e6, "buyer receives the evaluator cut and leftover in real USDC");
        assertEq(usdcBal(address(sq)), 0);
    }

    // ------------------------------------------------------------------ 6g: deadline / timeout / expiry

    function test_06g_DeadlinePassed_AfterDecisionDeadline_NoAcceptEver() public onlyFork {
        (uint256 id, uint256 exp) = _submittedJob(1000, 1000);
        uint64 dd = sq.getConfig(id).decisionDeadline;
        ISQController.Verdict memory v = verdictOf(id, ACCEPT, 0, 3);
        bytes memory sig = sign(v);

        vm.warp(dd + 1);
        vm.expectRevert(ISQController.DeadlinePassed.selector);
        sq.submitVerdict(v, sig);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Submitted));

        // still refused just before expiry, at expiry, and after the kernel's claimRefund flips it to Expired
        vm.warp(exp - 1);
        vm.expectRevert(ISQController.DeadlinePassed.selector);
        sq.submitVerdict(v, sig);
        vm.warp(exp + 1);
        vm.expectRevert(ISQController.DeadlinePassed.selector);
        sq.submitVerdict(v, sig);
        vm.prank(stranger);
        ac.claimRefund(id);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Expired));
        vm.expectRevert(ISQController.DeadlinePassed.selector);
        sq.submitVerdict(v, sig);
        assertEq(sq.verdictDigestOf(id, 0), bytes32(0), "no verdict was ever recorded");
        assertEq(usdcBal(bob), 0, "provider never paid");
    }

    function test_06g_RejectOnTimeout_Funded_AfterDeadlineBeforeExpiry() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp);
        register(defaultParams(id, exp, 1000, 1000, 0));
        uint64 dd = sq.getConfig(id).decisionDeadline;

        vm.warp(dd); // inclusive: block.timestamp == decisionDeadline is NOT yet timed out
        vm.expectRevert(ISQController.DeadlineNotPassed.selector);
        sq.rejectOnTimeout(id);

        vm.warp(dd + 1);
        assertLt(block.timestamp, exp);
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.TimeoutRejected(id);
        vm.prank(stranger);
        sq.rejectOnTimeout(id);

        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdcBal(alice), BUDGET, "real kernel refunded the buyer");
        assertEq(sq.getState(id).credited, 0, "timeout credits no report fees");
        vm.expectRevert(ISQController.AlreadyDecided.selector);
        sq.rejectOnTimeout(id);
        assertEq(sq.refundFees(id), 2 * FEE);
        assertEq(usdcBal(alice), BUDGET + 2 * FEE);
        assertEq(usdcBal(address(sq)), 0);
    }

    function test_06g_RejectOnTimeout_Submitted_AfterDeadlineBeforeExpiry() public onlyFork {
        (uint256 id,) = _submittedJob(1000, 1000);
        vm.warp(sq.getConfig(id).decisionDeadline + 1);
        sq.rejectOnTimeout(id);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdcBal(alice), BUDGET);
        assertEq(usdcBal(bob), 0);
    }

    /// @dev Past expiredAt but before anyone calls claimRefund the real reject() still works (no expiry check),
    /// so rejectOnTimeout still refunds; once claimRefund ran, the kernel is Expired and rejectOnTimeout is WrongJobStatus
    /// while refundFees (Expired is terminal) returns the full deposit.
    function test_06g_AfterExpiry_RejectOnTimeoutOnlyUntilClaimRefund_ThenRefundFees() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp);
        register(defaultParams(id, exp, 1000, 1000, 0));
        vm.warp(exp + 1);
        vm.prank(stranger);
        ac.claimRefund(id);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Expired));
        assertEq(usdcBal(alice), BUDGET, "kernel claimRefund returned the escrow to the buyer");
        vm.expectRevert(ISQController.WrongJobStatus.selector);
        sq.rejectOnTimeout(id);
        assertEq(sq.refundFees(id), 2 * FEE, "Expired is terminal: full report deposit returns");
        assertEq(usdcBal(alice), BUDGET + 2 * FEE);
        assertEq(usdcBal(address(sq)), 0);
    }

    function test_06g_RejectOnTimeout_AfterExpiryBeforeClaimRefund_StillSettlesOnRealKernel() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp);
        register(defaultParams(id, exp, 1000, 1000, 0));
        vm.warp(exp + 1);
        (bool ok, bytes memory ret) = address(sq).call(abi.encodeCall(ISQController.rejectOnTimeout, (id)));
        console2.log("rejectOnTimeout after expiredAt (before claimRefund) ok:", ok);
        console2.logBytes(ret);
        // FINDING: the real kernel's reject() has no expiry check, so this succeeds and refunds the buyer.
        assertTrue(ok);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdcBal(alice), BUDGET);
    }
}
