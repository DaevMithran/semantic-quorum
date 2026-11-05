// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";
import {SQForkBase, IKernel} from "./SQForkBase.sol";

/// @notice ACCEPT / REJECT / REVISE lifecycles on the REAL kernel with REAL USDC (arc-forge --network arc).
contract SQControllerForkLifecycleTest is SQForkBase {
    ISQController.VerdictKind internal constant ACCEPT = ISQController.VerdictKind.Accept;
    ISQController.VerdictKind internal constant REVISE = ISQController.VerdictKind.Revise;
    ISQController.VerdictKind internal constant REJECT = ISQController.VerdictKind.Reject;

    // ------------------------------------------------------------------ 3a: full ACCEPT lifecycle

    function test_03a_AcceptLifecycle_BothRecipientsClaim_RefundReturnsFeesToBuyer() public onlyFork {
        _acceptLifecycle(3);
    }

    /// @dev Only member 0 is credited: the uncredited slot is the leftover refunded to the buyer.
    function test_03a_AcceptLifecycle_PartialMask_LeftoverRefunded() public onlyFork {
        _acceptLifecycle(1);
    }

    uint256 internal liveP;
    uint256 internal liveE;
    uint256 internal platFee;
    uint256 internal evalFee;

    function _acceptLifecycle(uint256 mask) internal {
        uint256 id = _acceptAndCheck(mask);
        uint256 credits = _bits(mask) * FEE;

        // recipients claim real USDC
        vm.prank(rA);
        assertEq(sq.claim(), FEE);
        assertEq(usdcBal(rA), FEE);
        if (mask == 3) {
            vm.prank(rB);
            assertEq(sq.claim(), FEE);
            assertEq(usdcBal(rB), FEE);
        } else {
            vm.prank(rB);
            vm.expectRevert(ISQController.NothingToClaim.selector);
            sq.claim();
        }

        // refund = deposit - credited + kernelFeeReceived, paid to the buyer
        uint256 expectRefund = 2 * FEE - credits + evalFee;
        vm.expectEmit(true, true, false, true, address(sq));
        emit ISQController.FeesRefunded(id, alice, expectRefund);
        vm.prank(stranger);
        assertEq(sq.refundFees(id), expectRefund);
        assertEq(usdcBal(alice), expectRefund, "buyer receives leftover + evaluator cut in real USDC");
        assertEq(usdcBal(address(sq)), 0, "SQController USDC balance ends at 0");
        vm.expectRevert(ISQController.AlreadyRefunded.selector);
        sq.refundFees(id);
    }

    function _acceptAndCheck(uint256 mask) internal returns (uint256 id) {
        uint256 exp = expiryIn(1 days);
        id = fundedJob(BUDGET, exp);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Funded));
        assertEq(ac.getJob(id).budget, BUDGET);
        liveP = ac.platformFeeBP();
        liveE = ac.evaluatorFeeBP();
        platFee = BUDGET * liveP / 10_000;
        evalFee = BUDGET * liveE / 10_000;
        register(defaultParams(id, exp, liveP + 100, liveE + 100, 0));
        submitJob(id);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Submitted));

        uint256 bobBefore = usdcBal(bob);
        uint256 treasuryBefore = usdcBal(ac.platformTreasury());
        uint256 kernelBefore = usdcBal(AC);

        ISQController.Verdict memory v = verdictOf(id, ACCEPT, 0, mask);
        bytes memory sig = sign(v);
        vm.recordLogs();
        vm.prank(stranger); // submission is permissionless; the signature is the authority
        sq.submitVerdict(v, sig);
        _assertAcceptEventOrder(vm.getRecordedLogs(), id, mask);

        // kernel terminal state and money movement (real USDC)
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Completed), "kernel Completed atomically");
        assertEq(usdcBal(bob) - bobBefore, BUDGET - platFee - evalFee, "provider gets budget minus fees");
        if (ac.platformTreasury() != bob) {
            assertEq(usdcBal(ac.platformTreasury()) - treasuryBefore, platFee, "treasury gets platform fee");
        }
        assertEq(kernelBefore - usdcBal(AC), BUDGET, "kernel escrow fully released");
        assertEq(usdcBal(address(sq)), 2 * FEE + evalFee, "SQ holds deposit + evaluator cut");
        ISQController.JobState memory st = sq.getState(id);
        assertEq(st.kernelFeeReceived, evalFee);
        assertTrue(st.settled);
        assertEq(st.credited, _bits(mask) * FEE);
        assertEq(sq.feeBalance(rA), FEE);
        assertEq(sq.feeBalance(rB), mask == 3 ? FEE : 0);
    }

    function _bits(uint256 m) internal pure returns (uint256 n) {
        for (; m != 0; m >>= 1) n += m & 1;
    }

    /// @dev SQ events in order: FeeCredited* , DeliverableApproved, [KernelEvaluatorFeeReceived], CompletionFeesApplied,
    /// JobSettled, VerdictRecorded; the kernel's JobCompleted sits between DeliverableApproved and CompletionFeesApplied.
    function _assertAcceptEventOrder(Vm.Log[] memory logs, uint256 id, uint256 mask) internal view {
        uint256 none = type(uint256).max;
        uint256 last = logIdx(logs, address(sq), ISQController.FeeCredited.selector, 0);
        assertTrue(last != none, "FeeCredited present");
        if (_bits(mask) == 2) {
            last = logIdx(logs, address(sq), ISQController.FeeCredited.selector, last + 1);
            assertTrue(last != none, "second FeeCredited");
            assertEq(logIdx(logs, address(sq), ISQController.FeeCredited.selector, last + 1), none, "exactly two credits");
        }
        uint256 iAppr = logIdx(logs, address(sq), ISQController.DeliverableApproved.selector, 0);
        assertTrue(iAppr != none && last < iAppr, "FeeCredited before DeliverableApproved");
        uint256 iDone = logIdx(logs, AC, IKernel.JobCompleted.selector, 0);
        assertTrue(iDone != none && iAppr < iDone, "DeliverableApproved before kernel JobCompleted");
        assertTrue(logIdx(logs, AC, IKernel.PaymentReleased.selector, 0) != none, "kernel PaymentReleased");
        uint256 iKfee = logIdx(logs, address(sq), ISQController.KernelEvaluatorFeeReceived.selector, 0);
        uint256 iApply = logIdx(logs, address(sq), ISQController.CompletionFeesApplied.selector, 0);
        assertTrue(iApply != none && iDone < iApply, "kernel JobCompleted before CompletionFeesApplied");
        if (evalFee > 0) {
            assertTrue(iKfee != none && iDone < iKfee && iKfee < iApply, "KernelEvaluatorFeeReceived after complete");
        } else {
            assertEq(iKfee, none, "no evaluator cut event when live evaluator fee is 0");
        }
        uint256 iSettled = logIdx(logs, address(sq), ISQController.JobSettled.selector, 0);
        assertTrue(iSettled != none && iApply < iSettled, "CompletionFeesApplied before JobSettled");
        uint256 iRec = logIdx(logs, address(sq), ISQController.VerdictRecorded.selector, 0);
        assertTrue(iRec != none && iSettled < iRec, "JobSettled before VerdictRecorded");
        // CompletionFeesApplied carries the LIVE fee values
        assertEq(logs[iApply].topics[1], bytes32(id));
        (uint256 gotP, uint256 gotE) = abi.decode(logs[iApply].data, (uint256, uint256));
        assertEq(gotP, liveP, "live platform fee BP");
        assertEq(gotE, liveE, "live evaluator fee BP");
    }

    // ------------------------------------------------------------------ 4: REJECT lifecycles

    function test_04a_RejectFunded_KernelRefundsBuyer() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp);
        register(defaultParams(id, exp, 1000, 1000, 0));
        assertEq(usdcBal(alice), 0);
        uint256 kernelBefore = usdcBal(AC);

        ISQController.Verdict memory v = verdictOf(id, REJECT, 0, 1);
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.JobSettled(id, false, v.evidenceHash);
        sq.submitVerdict(v, sign(v));

        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Rejected));
        assertEq(usdcBal(alice), BUDGET, "real kernel refunded the funded budget to the buyer");
        assertEq(kernelBefore - usdcBal(AC), BUDGET);
        assertEq(usdcBal(bob), 0, "provider gets nothing on reject");

        vm.prank(rA);
        sq.claim();
        assertEq(usdcBal(rA), FEE);
        sq.refundFees(id);
        assertEq(usdcBal(alice), BUDGET + FEE, "refundFees returns the uncredited member slot");
        assertEq(usdcBal(address(sq)), 0);
    }

    function test_04b_RejectSubmitted_KernelRefundsBuyer() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp);
        register(defaultParams(id, exp, 1000, 1000, 0));
        submitJob(id);
        ISQController.Verdict memory v = verdictOf(id, REJECT, 0, 3);
        sq.submitVerdict(v, sign(v));

        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdcBal(alice), BUDGET, "buyer refunded even though provider submitted");
        assertEq(usdcBal(bob), 0);
        assertEq(sq.feeBalance(rA), FEE);
        assertEq(sq.feeBalance(rB), FEE);
        // REJECT after terminal: idempotent replay of the same signed digest is a silent no-op
        sq.submitVerdict(v, sign(v));
        assertEq(sq.refundFees(id), 0, "all deposit credited, nothing left to refund");
    }

    function test_04c_ReviseThenReviseAtLimit_RejectsAndRealKernelRefundsBuyer() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp);
        register(defaultParams(id, exp, 1000, 1000, 1)); // deposit = FEE * 2 * 2
        assertEq(usdcBal(address(sq)), 4 * FEE);

        ISQController.Verdict memory v0 = verdictOf(id, REVISE, 0, 3);
        sq.submitVerdict(v0, sign(v0));
        assertEq(sq.getState(id).round, 1, "first REVISE advances the round");
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Funded), "kernel unchanged by REVISE");
        assertEq(usdcBal(alice), 0);

        ISQController.Verdict memory v1 = verdictOf(id, REVISE, 1, 3);
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.RevisionLimitReached(id, 1);
        sq.submitVerdict(v1, sign(v1));

        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Rejected), "REVISE at limit -> kernel reject");
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Rejected));
        assertEq(usdcBal(alice), BUDGET, "real kernel refunds the buyer");
        assertEq(sq.getState(id).credited, 4 * FEE);
        vm.prank(rA);
        assertEq(sq.claim(), 2 * FEE);
        vm.prank(rB);
        assertEq(sq.claim(), 2 * FEE);
        assertEq(sq.refundFees(id), 0);
        assertEq(usdcBal(address(sq)), 0);
    }
}
