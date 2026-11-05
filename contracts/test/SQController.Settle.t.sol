// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {SQBase} from "./SQBase.sol";
import {MockAgenticCommerce} from "./mocks/MockAgenticCommerce.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

contract SQControllerSettleTest is SQBase {
    address internal treasury = makeAddr("treasury");

    /// @dev ACCEPT now completes atomically, so this is already settled.
    function _accepted() internal returns (uint256 id) {
        id = setupSubmitted(2);
        send(mkAccept(id, 0));
    }

    /// @dev Defensive-retry state: decision=Accepted, settled=false, kernel still Submitted (vm.store).
    function _forcedAccepted() internal returns (uint256 id) {
        id = setupSubmitted(2);
        forceAcceptedUnsettled(id, EVIDENCE);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
    }

    // ------------------------------------------------------------------ atomic ACCEPT settlement

    function test_AcceptSettlesAtomicallyAndPaysProvider() public {
        uint256 id = setupSubmitted(2);
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signVerdict(v);

        vm.recordLogs();
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
        assertEq(usdc.balanceOf(address(ac)), 0);
        assertTrue(sq.getState(id).settled);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Accepted));
        assertEq(sq.getState(id).kernelFeeReceived, 0);
        Vm.Log memory k = findLog(logs, address(ac), MockAgenticCommerce.JobCompleted.selector);
        assertEq(abi.decode(k.data, (bytes32)), EVIDENCE, "kernel reason == evidence hash");
        assertEq(findLog(logs, address(sq), ISQController.JobSettled.selector).data, abi.encode(true, EVIDENCE));
        assertEq(countLogs(logs, address(sq), ISQController.KernelEvaluatorFeeReceived.selector), 0);
    }

    function test_RevertWhen_SettleAfterAtomicAccept_AlreadySettled() public {
        uint256 id = _accepted();
        vm.expectRevert(ISQController.AlreadySettled.selector);
        vm.prank(stranger);
        sq.settle(id);
    }

    // ------------------------------------------------------------------ settle (defensive retry)

    function test_SettleRetryCompletesKernelJobAndPaysProvider() public {
        uint256 id = _forcedAccepted();

        vm.recordLogs();
        vm.expectEmit(true, true, false, true, address(ac));
        emit MockAgenticCommerce.JobCompleted(id, address(sq), EVIDENCE);
        vm.prank(stranger);
        sq.settle(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
        assertEq(usdc.balanceOf(address(ac)), 0);
        assertTrue(sq.getState(id).settled);
        assertEq(sq.getState(id).kernelFeeReceived, 0);
        assertEq(findLog(logs, address(sq), ISQController.JobSettled.selector).data, abi.encode(true, EVIDENCE));
        assertEq(countLogs(logs, address(sq), ISQController.KernelEvaluatorFeeReceived.selector), 0);
        Vm.Log memory c = findLog(logs, address(sq), ISQController.CompletionFeesApplied.selector);
        assertEq(c.data, abi.encode(uint256(0), uint256(0)));
    }

    function test_SettleRetryEventOrder() public {
        ac.setEvaluatorFee(1000);
        uint256 id = _forcedAccepted();
        vm.recordLogs();
        sq.settle(id);
        bytes32[] memory t = sqTopics(vm.getRecordedLogs());
        assertEq(t.length, 3);
        assertEq(t[0], ISQController.KernelEvaluatorFeeReceived.selector);
        assertEq(t[1], ISQController.CompletionFeesApplied.selector);
        assertEq(t[2], ISQController.JobSettled.selector);
    }

    function test_AnyoneCanSettle() public {
        uint256 id = _forcedAccepted();
        vm.prank(provider);
        sq.settle(id);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    function test_RevertWhen_SettleBeforeAccept() public {
        uint256 id = setupSubmitted(2);
        vm.expectRevert(ISQController.NotAccepted.selector);
        sq.settle(id);
    }

    function test_RevertWhen_SettleAfterReject() public {
        uint256 id = setupSubmitted(2);
        send(mkReject(id, 0));
        vm.expectRevert(ISQController.NotAccepted.selector);
        sq.settle(id);
    }

    function test_RevertWhen_SettleAfterTimeoutReject() public {
        uint256 id = setupSubmitted(2);
        vm.warp(DEADLINE + 1);
        sq.rejectOnTimeout(id);
        vm.expectRevert(ISQController.NotAccepted.selector);
        sq.settle(id);
    }

    function test_RevertWhen_SettleUnregistered() public {
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.settle(12345);
    }

    function test_RevertWhen_SettleTwice() public {
        uint256 id = _forcedAccepted();
        sq.settle(id);
        vm.expectRevert(ISQController.AlreadySettled.selector);
        sq.settle(id);
    }

    function test_RevertWhen_SettleAfterKernelExpired() public {
        uint256 id = _forcedAccepted();
        vm.warp(EXPIRY);
        ac.claimRefund(id);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Expired));
        vm.expectRevert(ISQController.WrongJobStatus.selector);
        sq.settle(id);
        assertFalse(sq.getState(id).settled);
        assertEq(usdc.balanceOf(provider), 0);
        assertEq(usdc.balanceOf(buyer), BUDGET);
        // the buyer's whole fee deposit (nothing credited in the forced state) is still recoverable
        assertEq(sq.refundFees(id), 6 * FEE);
    }

    function test_RevertWhen_SettleKernelCompleteFails_StateUnchanged() public {
        uint256 id = _forcedAccepted();
        ac.testOnly_setFailComplete(true);
        vm.expectRevert(MockAgenticCommerce.ForcedCompleteFailure.selector);
        sq.settle(id);
        assertFalse(sq.getState(id).settled);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
        ac.testOnly_setFailComplete(false);
        sq.settle(id);
        assertTrue(sq.getState(id).settled);
    }

    function test_PlatformFeeOnlyReducesProviderNet() public {
        ac.setPlatformFee(500, treasury); // 5%
        uint256 id = _accepted();
        assertEq(usdc.balanceOf(provider), BUDGET * 95 / 100);
        assertEq(usdc.balanceOf(treasury), BUDGET * 5 / 100);
        assertEq(usdc.balanceOf(address(sq)), 6 * FEE, "controller holds only the fee deposit");
        assertEq(sq.getState(id).kernelFeeReceived, 0);
        assertEq(sq.refundFees(id), 4 * FEE);
    }

    function test_KernelEvaluatorFeeRecordedAndRefundedToBuyer() public {
        ac.setEvaluatorFee(1000); // 10%
        uint256 id = setupSubmitted(2);
        uint256 cut = BUDGET / 10;
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory sig = signVerdict(v);

        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.KernelEvaluatorFeeReceived(id, cut);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);

        assertEq(sq.getState(id).kernelFeeReceived, cut);
        assertEq(usdc.balanceOf(provider), BUDGET - cut);
        assertEq(usdc.balanceOf(address(sq)), 6 * FEE + cut);

        uint256 expectedRefund = sq.getConfig(id).deposited - sq.getState(id).credited + cut;
        assertEq(expectedRefund, 4 * FEE + cut);
        assertEq(sq.refundFees(id), expectedRefund);
        assertEq(usdc.balanceOf(buyer), expectedRefund);

        // credited report fees stay reserved and claimable
        assertEq(usdc.balanceOf(address(sq)), 2 * FEE);
        vm.prank(rA);
        assertEq(sq.claim(), FEE);
        vm.prank(rB);
        assertEq(sq.claim(), FEE);
        assertEq(usdc.balanceOf(address(sq)), 0);
    }

    function test_PlatformAndEvaluatorFeesTogether() public {
        ac.setPlatformFee(500, treasury);
        ac.setEvaluatorFee(1000);
        uint256 id = _accepted();
        assertEq(usdc.balanceOf(provider), BUDGET * 85 / 100);
        assertEq(usdc.balanceOf(treasury), BUDGET * 5 / 100);
        assertEq(sq.getState(id).kernelFeeReceived, BUDGET * 10 / 100);
    }

    function test_SettleRetryRecordsKernelEvaluatorFee() public {
        ac.setEvaluatorFee(1000);
        uint256 id = _forcedAccepted();
        uint256 cut = BUDGET / 10;
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.KernelEvaluatorFeeReceived(id, cut);
        sq.settle(id);
        assertEq(sq.getState(id).kernelFeeReceived, cut);
        assertEq(usdc.balanceOf(provider), BUDGET - cut);
        assertEq(sq.refundFees(id), 6 * FEE + cut);
    }

    /// @dev DOCUMENTED TRUST ASSUMPTION (attest-after-submit): the kernel's getJob exposes no
    /// deliverable, so ACCEPT cannot compare the signed deliverable with the submitted one.
    /// An ACCEPT signed over a deliverable that differs from the kernel's actual submission still
    /// completes; correctness rests on the verdictAuthority attesting the JobSubmitted value.
    function test_AcceptCannotDetectSignedVsSubmittedDeliverableMismatch() public {
        uint256 id = setupFunded(2);
        bytes32 actuallySubmitted = keccak256("what the provider really submitted");
        submitJob(id, actuallySubmitted);

        send(mkAccept(id, 0)); // signed over DELIVERABLE != actuallySubmitted
        assertEq(ac.testOnly_deliverable(id), actuallySubmitted);
        assertEq(sq.getState(id).approvedDeliverable, DELIVERABLE);
        assertTrue(ac.testOnly_deliverable(id) != sq.getState(id).approvedDeliverable);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
    }

    // ------------------------------------------------------------------ rejectOnTimeout

    function test_RevertWhen_TimeoutBeforeDeadline() public {
        uint256 id = setupFunded(2);
        vm.expectRevert(ISQController.DeadlineNotPassed.selector);
        sq.rejectOnTimeout(id);
        vm.warp(DEADLINE); // strictly after the deadline is required
        vm.expectRevert(ISQController.DeadlineNotPassed.selector);
        sq.rejectOnTimeout(id);
    }

    function test_TimeoutRejectsFundedJobAndRefundsBuyer() public {
        uint256 id = setupFunded(2);
        vm.warp(DEADLINE + 1);
        bytes32 timeoutReason = sq.TIMEOUT_REASON();
        assertEq(timeoutReason, keccak256("SQ_TIMEOUT"));

        vm.expectEmit(true, true, false, true, address(ac));
        emit MockAgenticCommerce.JobRejected(id, address(sq), timeoutReason);
        vm.expectEmit(true, false, false, false, address(sq));
        emit ISQController.TimeoutRejected(id);
        vm.prank(stranger);
        sq.rejectOnTimeout(id);

        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdc.balanceOf(buyer), BUDGET);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Rejected));
        assertEq(sq.getState(id).credited, 0, "no report fees credited on timeout");
        assertEq(sq.feeBalance(rA), 0);
        assertEq(sq.feeBalance(rB), 0);
        // whole fee deposit comes back
        assertEq(sq.refundFees(id), 6 * FEE);
        assertEq(usdc.balanceOf(buyer), BUDGET + 6 * FEE);
    }

    function test_TimeoutRejectsSubmittedJobAndRefundsBuyer() public {
        uint256 id = setupSubmitted(2);
        vm.warp(DEADLINE + 1);
        sq.rejectOnTimeout(id);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdc.balanceOf(buyer), BUDGET);
        assertEq(usdc.balanceOf(provider), 0);
        assertEq(sq.getState(id).credited, 0);
    }

    function test_RevertWhen_TimeoutAfterVerdict() public {
        uint256 id = _accepted();
        vm.warp(DEADLINE + 1);
        vm.expectRevert(ISQController.AlreadyDecided.selector);
        sq.rejectOnTimeout(id);
    }

    function test_RevertWhen_TimeoutTwice() public {
        uint256 id = setupFunded(2);
        vm.warp(DEADLINE + 1);
        sq.rejectOnTimeout(id);
        vm.expectRevert(ISQController.AlreadyDecided.selector);
        sq.rejectOnTimeout(id);
    }

    /// @dev An Open job can no longer be registered (WrongJobStatus), so it has no config and
    /// rejectOnTimeout on it reverts NotRegistered; the controller never touches it.
    function test_RevertWhen_TimeoutOnOpenJob() public {
        uint256 id = newJob(EXPIRY);
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, 2, FEE);
        fundBuyerFor(p);
        vm.prank(buyer);
        vm.expectRevert(ISQController.WrongJobStatus.selector);
        sq.registerJob(p);
        vm.warp(DEADLINE + 1);
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.rejectOnTimeout(id);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.None));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Open));
    }

    function test_RevertWhen_TimeoutOnExpiredKernelJob() public {
        uint256 id = setupFunded(2);
        vm.warp(EXPIRY);
        ac.claimRefund(id);
        vm.expectRevert(ISQController.WrongJobStatus.selector);
        sq.rejectOnTimeout(id);
    }

    function test_RevertWhen_TimeoutUnregistered() public {
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.rejectOnTimeout(777);
    }
}
