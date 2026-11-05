// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {SQBase} from "./SQBase.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MaliciousRecipient} from "./mocks/MaliciousRecipient.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

/// @dev Fee crediting, claiming, refunds, blocklist isolation and reentrancy for SQController.
contract SQControllerFeesTest is SQBase {
    ISQController.VerdictKind internal constant ACCEPT = ISQController.VerdictKind.Accept;
    ISQController.VerdictKind internal constant REVISE = ISQController.VerdictKind.Revise;
    ISQController.VerdictKind internal constant REJECT = ISQController.VerdictKind.Reject;

    // ------------------------------------------------------------------ helpers

    function _members(address a0, address a1) internal pure returns (ISQController.CommitteeMember[] memory m) {
        m = new ISQController.CommitteeMember[](2);
        m[0] = ISQController.CommitteeMember({evaluatorId: 1, feeRecipient: a0});
        m[1] = ISQController.CommitteeMember({evaluatorId: 2, feeRecipient: a1});
    }

    /// @dev Funded kernel job registered with an explicit committee.
    function _setupWith(uint8 revisionLimit, ISQController.CommitteeMember[] memory c) internal returns (uint256 id) {
        id = newJob(EXPIRY);
        fundJob(id, BUDGET);
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, revisionLimit, FEE);
        p.committee = c;
        registerWith(p);
    }

    function _credits(Vm.Log[] memory logs) internal view returns (Vm.Log[] memory out) {
        uint256 n = countLogs(logs, address(sq), ISQController.FeeCredited.selector);
        out = new Vm.Log[](n);
        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(sq) && logs[i].topics[0] == ISQController.FeeCredited.selector) {
                out[k++] = logs[i];
            }
        }
    }

    function _checkCredit(Vm.Log memory l, uint256 id, uint8 round, uint256 idx, address rcpt, uint256 amt) internal {
        assertEq(l.topics[1], bytes32(id), "event jobId");
        assertEq(l.topics[2], bytes32(uint256(uint160(rcpt))), "event recipient");
        assertEq(l.data, abi.encode(round, idx, amt), "event round/index/amount");
    }

    function _sendRecorded(ISQController.Verdict memory v) internal returns (Vm.Log[] memory) {
        vm.recordLogs();
        send(v);
        return vm.getRecordedLogs();
    }

    function _popcount(uint256 x) internal pure returns (uint256 n) {
        while (x != 0) {
            n += x & 1;
            x >>= 1;
        }
    }

    // ------------------------------------------------------------------ crediting by mask

    function test_Mask1CreditsOnlyMember0() public {
        uint256 id = setupFunded(1);
        Vm.Log[] memory c = _credits(_sendRecorded(mkVerdict(id, 0, REVISE, bytes32(0), 1)));
        assertEq(c.length, 1);
        _checkCredit(c[0], id, 0, 0, rA, FEE);
        assertEq(sq.feeBalance(rA), FEE);
        assertEq(sq.feeBalance(rB), 0);
        assertEq(sq.getState(id).credited, FEE);
        assertEq(sq.creditedMaskOf(id, 0), 1);
    }

    function test_Mask2CreditsOnlyMember1() public {
        uint256 id = setupFunded(1);
        Vm.Log[] memory c = _credits(_sendRecorded(mkVerdict(id, 0, REVISE, bytes32(0), 2)));
        assertEq(c.length, 1);
        _checkCredit(c[0], id, 0, 1, rB, FEE);
        assertEq(sq.feeBalance(rA), 0);
        assertEq(sq.feeBalance(rB), FEE);
        assertEq(sq.getState(id).credited, FEE);
        assertEq(sq.creditedMaskOf(id, 0), 2);
    }

    function test_Mask3CreditsBothInIndexOrder() public {
        uint256 id = setupFunded(1);
        Vm.Log[] memory c = _credits(_sendRecorded(mkVerdict(id, 0, REVISE, bytes32(0), 3)));
        assertEq(c.length, 2);
        _checkCredit(c[0], id, 0, 0, rA, FEE);
        _checkCredit(c[1], id, 0, 1, rB, FEE);
        assertEq(sq.feeBalance(rA), FEE);
        assertEq(sq.feeBalance(rB), FEE);
        assertEq(sq.getState(id).credited, 2 * FEE);
        assertEq(sq.creditedMaskOf(id, 0), 3);
    }

    function test_FeeCreditedEventViaExpectEmit() public {
        uint256 id = setupFunded(1);
        vm.expectEmit(true, true, false, true, address(sq));
        emit ISQController.FeeCredited(id, 0, 0, rA, FEE);
        vm.expectEmit(true, true, false, true, address(sq));
        emit ISQController.FeeCredited(id, 0, 1, rB, FEE);
        send(mkRevise(id, 0));
    }

    function test_CreditsGoOnlyToPinnedCommitteeRecipients() public {
        uint256 id = setupFunded(1);
        send(mkRevise(id, 0));
        address[5] memory others = [relayer, authority, address(this), provider, buyer];
        for (uint256 i; i < others.length; ++i) {
            assertEq(sq.feeBalance(others[i]), 0);
        }
        assertEq(sq.feeBalance(rA) + sq.feeBalance(rB), sq.getState(id).credited);
    }

    function test_DuplicateRecipientAccumulatesBothCredits() public {
        uint256 id = _setupWith(1, _members(rA, rA));
        send(mkRevise(id, 0));
        assertEq(sq.feeBalance(rA), 2 * FEE);
        assertEq(sq.getState(id).credited, 2 * FEE);
        vm.prank(rA);
        assertEq(sq.claim(), 2 * FEE);
        assertEq(usdc.balanceOf(rA), 2 * FEE);
    }

    function test_DuplicateRecipientAccumulatesAcrossRounds() public {
        uint256 id = _setupWith(2, _members(rA, rA));
        send(mkVerdict(id, 0, REVISE, bytes32(0), 1));
        send(mkVerdict(id, 1, REVISE, bytes32(0), 2));
        assertEq(sq.feeBalance(rA), 2 * FEE);
        assertEq(sq.creditedMaskOf(id, 0), 1);
        assertEq(sq.creditedMaskOf(id, 1), 2);
    }

    // ------------------------------------------------------------------ once per (job, round, index)

    function test_ResubmittingIdenticalVerdictDoesNotCreditAgain() public {
        uint256 id = setupFunded(1);
        ISQController.Verdict memory v = mkRevise(id, 0);
        send(v);
        Vm.Log[] memory logs = _sendRecorded(v);
        assertEq(countLogs(logs, address(sq), ISQController.FeeCredited.selector), 0);
        assertEq(countLogs(logs, address(sq), ISQController.VerdictRecorded.selector), 0);
        assertEq(sq.getState(id).credited, 2 * FEE);
        assertEq(sq.feeBalance(rA), FEE);
        assertEq(sq.creditedMaskOf(id, 0), 3);
        assertEq(sq.getState(id).round, 1);
    }

    function test_ReplayAfterDecisionDoesNotCreditAgain() public {
        uint256 id = setupSubmitted(1);
        ISQController.Verdict memory v = mkAccept(id, 0);
        send(v);
        send(v);
        assertEq(sq.getState(id).credited, 2 * FEE);
        assertEq(sq.feeBalance(rB), FEE);
    }

    function test_ConflictingMaskSameRoundRevertsWithoutCredit() public {
        uint256 id = setupFunded(1);
        send(mkVerdict(id, 0, REVISE, bytes32(0), 1));
        sendExpectRevert(mkVerdict(id, 0, REVISE, bytes32(0), 3), ISQController.ConflictingVerdict.selector);
        assertEq(sq.getState(id).credited, FEE);
        assertEq(sq.feeBalance(rB), 0);
        assertEq(sq.creditedMaskOf(id, 0), 1);
    }

    function test_DifferentRoundCreditsAgain() public {
        uint256 id = setupFunded(2);
        send(mkRevise(id, 0));
        Vm.Log[] memory c = _credits(_sendRecorded(mkRevise(id, 1)));
        assertEq(c.length, 2);
        _checkCredit(c[0], id, 1, 0, rA, FEE);
        _checkCredit(c[1], id, 1, 1, rB, FEE);
        assertEq(sq.getState(id).credited, 4 * FEE);
        assertEq(sq.creditedMaskOf(id, 0), 3);
        assertEq(sq.creditedMaskOf(id, 1), 3);
        assertEq(sq.feeBalance(rA), 2 * FEE);
    }

    function test_ReviseRoundsThenAcceptUseWholeDepositWithFullMask() public {
        uint256 id = setupFunded(2);
        send(mkRevise(id, 0));
        send(mkRevise(id, 1));
        submitJob(id, DELIVERABLE);
        send(mkAccept(id, 2));
        ISQController.JobConfig memory cfg = sq.getConfig(id);
        assertEq(cfg.deposited, 6 * FEE);
        assertEq(sq.getState(id).credited, cfg.deposited);
        assertLe(sq.getState(id).credited, cfg.deposited);
        assertEq(sq.feeBalance(rA), 3 * FEE);
        assertEq(sq.feeBalance(rB), 3 * FEE);
    }

    function test_ReviseRoundsThenRejectUseWholeDepositWithFullMask() public {
        uint256 id = setupFunded(2);
        send(mkRevise(id, 0));
        send(mkRevise(id, 1));
        send(mkReject(id, 2));
        assertEq(sq.getState(id).credited, sq.getConfig(id).deposited);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
    }

    function test_ReviseAtLimitCreditsFinalRound() public {
        uint256 id = setupFunded(1);
        send(mkRevise(id, 0));
        send(mkRevise(id, 1));
        assertEq(sq.getState(id).credited, 4 * FEE);
        assertEq(sq.getState(id).credited, sq.getConfig(id).deposited);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Rejected));
    }

    function test_PartialMasksLeaveLargerLeftover() public {
        uint256 id = setupFunded(2);
        send(mkVerdict(id, 0, REVISE, bytes32(0), 1));
        send(mkVerdict(id, 1, REVISE, bytes32(0), 2));
        submitJob(id, DELIVERABLE);
        send(mkVerdict(id, 2, ACCEPT, DELIVERABLE, 1));
        ISQController.JobState memory st = sq.getState(id);
        assertEq(st.credited, 3 * FEE);
        assertLt(st.credited, sq.getConfig(id).deposited);
        assertTrue(st.settled, "ACCEPT settled atomically");
        uint256 before = usdc.balanceOf(buyer);
        assertEq(sq.refundFees(id), 3 * FEE);
        assertEq(usdc.balanceOf(buyer) - before, 3 * FEE);
    }

    function test_CreditedMaskPopcountMatchesCredited() public {
        uint256 id = setupFunded(2);
        send(mkVerdict(id, 0, REVISE, bytes32(0), 2));
        send(mkVerdict(id, 1, REVISE, bytes32(0), 3));
        uint256 n = _popcount(sq.creditedMaskOf(id, 0)) + _popcount(sq.creditedMaskOf(id, 1));
        assertEq(n * FEE, sq.getState(id).credited);
    }

    // ------------------------------------------------------------------ claim

    function test_ClaimPaysWholeBalanceZeroesAndEmits() public {
        uint256 id = setupFunded(1);
        send(mkRevise(id, 0));
        send(mkRevise(id, 1));
        assertEq(sq.feeBalance(rA), 2 * FEE);

        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.FeesClaimed(rA, 2 * FEE);
        vm.prank(rA);
        uint256 amt = sq.claim();

        assertEq(amt, 2 * FEE);
        assertEq(usdc.balanceOf(rA), 2 * FEE);
        assertEq(sq.feeBalance(rA), 0);
        assertEq(sq.feeBalance(rB), 2 * FEE, "other recipient untouched");
        assertEq(usdc.balanceOf(address(sq)), 4 * FEE - 2 * FEE);
    }

    function test_RevertWhen_SecondClaim() public {
        uint256 id = setupFunded(0);
        send(mkReject(id, 0));
        vm.prank(rA);
        sq.claim();
        vm.prank(rA);
        vm.expectRevert(ISQController.NothingToClaim.selector);
        sq.claim();
    }

    function test_RevertWhen_ClaimWithNoBalance() public {
        vm.prank(stranger);
        vm.expectRevert(ISQController.NothingToClaim.selector);
        sq.claim();

        uint256 id = setupFunded(0);
        send(mkReject(id, 0));
        vm.prank(stranger);
        vm.expectRevert(ISQController.NothingToClaim.selector);
        sq.claim();
        assertEq(sq.feeBalance(rA), FEE, "stranger cannot touch recipient balance");
    }

    // ------------------------------------------------------------------ blocklist isolation

    function test_BlocklistedRecipientCannotClaimButIsStillCredited() public {
        uint256 id = setupFunded(1);
        usdc.setBlocklisted(rA, true);
        send(mkRevise(id, 0)); // crediting never moves tokens, so it must succeed
        assertEq(sq.feeBalance(rA), FEE);
        assertEq(sq.feeBalance(rB), FEE);

        vm.prank(rA);
        vm.expectRevert();
        sq.claim();
        assertEq(sq.feeBalance(rA), FEE, "failed claim keeps the balance");

        vm.prank(rB);
        assertEq(sq.claim(), FEE);
        assertEq(usdc.balanceOf(rB), FEE);

        // later rounds still credit the blocklisted recipient and settle the job
        send(mkRevise(id, 1));
        assertEq(sq.feeBalance(rA), 2 * FEE);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));

        usdc.setBlocklisted(rA, false);
        vm.prank(rA);
        assertEq(sq.claim(), 2 * FEE);
    }

    /// @dev ACCEPTED, DOCUMENTED LIMITATION (buyer blocklisted AFTER funding): any path that pays USDC
    /// to the blocklisted buyer reverts atomically (REJECT, rejectOnTimeout, refundFees) and recovers
    /// once the buyer is un-blocklisted. The kernel's own claimRefund pays the same blocked buyer, so
    /// the kernel escrow is stuck regardless of SQController; SQController adds no new stuck-fund mode.
    function test_BlocklistedBuyerRefundRevertsAndCanRetry() public {
        uint256 id = setupFunded(0);
        send(mkVerdict(id, 0, REJECT, bytes32(0), 1));
        usdc.setBlocklisted(buyer, true);
        vm.expectRevert();
        sq.refundFees(id);
        assertFalse(sq.getState(id).refunded, "refunded flag rolled back");
        usdc.setBlocklisted(buyer, false);
        assertEq(sq.refundFees(id), FEE);
    }

    /// @dev ACCEPTED, DOCUMENTED LIMITATION: a REJECT verdict refunds the kernel escrow to the buyer, so with
    /// the buyer blocklisted the whole verdict reverts atomically (no digest, no credits, kernel untouched),
    /// and the same signed verdict succeeds after un-blocklisting. The kernel's claimRefund is equally blocked.
    function test_BlocklistedBuyer_RejectVerdictRevertsAtomically_RecoversAfterUnblock() public {
        uint256 id = setupFunded(0);
        usdc.setBlocklisted(buyer, true);
        ISQController.Verdict memory v = mkReject(id, 0);
        bytes memory sig = signVerdict(v);
        vm.expectRevert();
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Funded));
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.None));
        assertEq(sq.getState(id).credited, 0);
        assertEq(sq.verdictDigestOf(id, 0), bytes32(0));

        usdc.setBlocklisted(buyer, false);
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdc.balanceOf(buyer), BUDGET);
    }

    /// @dev ACCEPTED, DOCUMENTED LIMITATION: rejectOnTimeout reverts atomically while the buyer is blocklisted
    /// (decision restored to None) and recovers afterwards. The kernel's own claimRefund (permissionless after
    /// expiry) pays the same blocked buyer and reverts too, so the escrow is stuck regardless of SQController.
    function test_BlocklistedBuyer_RejectOnTimeoutAndKernelClaimRefundRevert_RecoverAfterUnblock() public {
        uint256 id = setupFunded(0);
        usdc.setBlocklisted(buyer, true);
        vm.warp(DEADLINE + 1);
        vm.expectRevert();
        sq.rejectOnTimeout(id);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.None), "decision restored");
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Funded));

        vm.warp(EXPIRY);
        vm.expectRevert();
        ac.claimRefund(id); // kernel path to the same blocked buyer is equally stuck
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Funded));

        usdc.setBlocklisted(buyer, false);
        ac.claimRefund(id); // after un-blocklisting the kernel itself can refund
        assertEq(usdc.balanceOf(buyer), BUDGET);
    }

    /// @dev ACCEPT is unaffected by a blocklisted buyer (it pays provider/fee recipients); only the later
    /// refundFees to the buyer reverts atomically until un-blocklisted (accepted, documented limitation).
    function test_BlocklistedBuyer_AcceptStillCompletes_RefundFeesRevertsAtomically() public {
        uint256 id = setupSubmitted(0);
        usdc.setBlocklisted(buyer, true);
        send(mkVerdict(id, 0, ACCEPT, DELIVERABLE, 1)); // leftover FEE for the buyer
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
        vm.expectRevert();
        sq.refundFees(id);
        assertFalse(sq.getState(id).refunded);
        usdc.setBlocklisted(buyer, false);
        assertEq(sq.refundFees(id), FEE);
    }

    // ------------------------------------------------------------------ reentrancy

    function _malJob(MaliciousRecipient mal, uint8 revisionLimit) internal returns (uint256) {
        return _setupWith(revisionLimit, _members(address(mal), rB));
    }

    function _attackViaClaim(MaliciousRecipient mal, bytes memory data) internal {
        mal.arm(address(sq), data);
        usdc.setReceiveHook(true);
        vm.prank(address(mal));
        sq.claim();
        usdc.setReceiveHook(false);
    }

    function test_ReentrancyClaimInsideClaimFails() public {
        MaliciousRecipient mal = new MaliciousRecipient();
        uint256 id = _malJob(mal, 0);
        send(mkVerdict(id, 0, REJECT, bytes32(0), 1));
        _attackViaClaim(mal, abi.encodeCall(sq.claim, ()));

        assertTrue(mal.attacked());
        assertFalse(mal.attackSucceeded());
        assertEq(usdc.balanceOf(address(mal)), FEE, "paid exactly once");
        assertEq(sq.feeBalance(address(mal)), 0);
        assertEq(usdc.balanceOf(address(sq)), FEE, "only the unspent deposit remains");
    }

    function test_ReentrancyRefundInsideClaimFails() public {
        MaliciousRecipient mal = new MaliciousRecipient();
        uint256 id = _malJob(mal, 0);
        send(mkVerdict(id, 0, REJECT, bytes32(0), 1)); // terminal, leftover FEE
        _attackViaClaim(mal, abi.encodeCall(sq.refundFees, (id)));

        assertTrue(mal.attacked());
        assertFalse(mal.attackSucceeded());
        assertFalse(sq.getState(id).refunded);
        assertEq(usdc.balanceOf(address(sq)), FEE);
        assertEq(usdc.balanceOf(buyer), BUDGET, "only the kernel budget refund, no fee refund yet");
        vm.prank(stranger);
        assertEq(sq.refundFees(id), FEE);
        assertEq(usdc.balanceOf(address(sq)), 0);
    }

    function test_ReentrancySettleInsideClaimFails() public {
        MaliciousRecipient mal = new MaliciousRecipient();
        uint256 id = _malJob(mal, 1);
        send(mkVerdict(id, 0, REVISE, bytes32(0), 1)); // credits mal FEE, round -> 1
        submitJob(id, DELIVERABLE);
        forceAcceptedUnsettled(id, EVIDENCE); // defensive-retry state (ACCEPT itself settles atomically)
        _attackViaClaim(mal, abi.encodeCall(sq.settle, (id)));

        assertTrue(mal.attacked());
        assertFalse(mal.attackSucceeded());
        assertFalse(sq.getState(id).settled);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
        assertEq(usdc.balanceOf(address(sq)), 3 * FEE);
        sq.settle(id); // still works normally afterwards
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    function test_ReentrancyAcceptCompleteCannotReenterClaim() public {
        // after an atomic ACCEPT the job is settled; a settle() re-entered from claim() cannot succeed.
        MaliciousRecipient mal = new MaliciousRecipient();
        uint256 id = _malJob(mal, 0);
        submitJob(id, DELIVERABLE);
        send(mkVerdict(id, 0, ACCEPT, DELIVERABLE, 1));
        assertTrue(sq.getState(id).settled);
        _attackViaClaim(mal, abi.encodeCall(sq.settle, (id)));
        assertTrue(mal.attacked());
        assertFalse(mal.attackSucceeded(), "settle after atomic ACCEPT reverts");
        assertEq(usdc.balanceOf(address(mal)), FEE);
    }

    function test_ReentrancySubmitVerdictInsideClaimFails() public {
        MaliciousRecipient mal = new MaliciousRecipient();
        uint256 id = _malJob(mal, 1);
        send(mkVerdict(id, 0, REVISE, bytes32(0), 1));
        ISQController.Verdict memory next = mkRevise(id, 1);
        bytes memory sig = signVerdict(next);
        _attackViaClaim(mal, abi.encodeCall(sq.submitVerdict, (next, sig)));

        assertTrue(mal.attacked());
        assertFalse(mal.attackSucceeded());
        assertEq(sq.verdictDigestOf(id, 1), bytes32(0));
        assertEq(sq.getState(id).credited, FEE);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.None));
        assertEq(usdc.balanceOf(address(sq)), 4 * FEE - FEE);
        send(next); // and the same verdict applies normally afterwards
        assertEq(sq.getState(id).credited, 3 * FEE);
    }

    function test_ReentrancyRefundInsideRefundToContractBuyerFails() public {
        MaliciousRecipient mal = new MaliciousRecipient();
        address m = address(mal);
        vm.prank(m);
        uint256 id = ac.createJob(provider, address(sq), EXPIRY, "j", address(0));
        vm.prank(provider);
        ac.setBudget(id, BUDGET, "");
        usdc.mint(m, BUDGET);
        vm.startPrank(m);
        usdc.approve(address(ac), BUDGET);
        ac.fund(id, "");
        vm.stopPrank();
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, 0, FEE);
        usdc.mint(m, depositOf(p));
        vm.startPrank(m);
        usdc.approve(address(sq), depositOf(p));
        sq.registerJob(p);
        vm.stopPrank();
        send(mkVerdict(id, 0, REJECT, bytes32(0), 1));

        mal.arm(address(sq), abi.encodeCall(sq.refundFees, (id)));
        usdc.setReceiveHook(true);
        vm.prank(stranger);
        assertEq(sq.refundFees(id), FEE);
        usdc.setReceiveHook(false);

        assertTrue(mal.attacked());
        assertFalse(mal.attackSucceeded());
        assertEq(usdc.balanceOf(m), BUDGET + FEE, "refunded exactly once");
        assertEq(usdc.balanceOf(address(sq)), FEE, "credited fee still reserved");
    }

    // ------------------------------------------------------------------ refundFees

    function _expectRefundEvent(uint256 id, uint256 amount) internal {
        vm.expectEmit(true, true, false, true, address(sq));
        emit ISQController.FeesRefunded(id, buyer, amount);
    }

    function test_RevertWhen_RefundUnregistered() public {
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.refundFees(999);
    }

    function test_RevertWhen_RefundWhileFundedOrSubmitted() public {
        // An Open job cannot be registered any more (WrongJobStatus), so refundFees on it is NotRegistered.
        uint256 open = newJob(EXPIRY);
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.refundFees(open);

        uint256 funded = setupFunded(1);
        vm.expectRevert(ISQController.NotTerminal.selector);
        sq.refundFees(funded);
        send(mkRevise(funded, 0)); // still Funded after a REVISE
        vm.expectRevert(ISQController.NotTerminal.selector);
        sq.refundFees(funded);

        submitJob(funded, DELIVERABLE);
        vm.expectRevert(ISQController.NotTerminal.selector);
        sq.refundFees(funded);
        send(mkAccept(funded, 1)); // ACCEPT completes atomically: the job is terminal at once
        assertEq(uint8(kernelStatus(funded)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(sq.refundFees(funded), 0, "all 4 reports credited");
    }

    function test_RefundAfterCompletedPaysBuyerOnlyAndKeepsCreditedFees() public {
        uint256 id = setupSubmitted(1);
        send(mkAccept(id, 0));
        uint256 before = usdc.balanceOf(buyer);

        _expectRefundEvent(id, 2 * FEE);
        vm.prank(stranger);
        uint256 amt = sq.refundFees(id);

        assertEq(amt, 2 * FEE);
        assertEq(usdc.balanceOf(buyer) - before, 2 * FEE);
        assertEq(usdc.balanceOf(stranger), 0, "caller gets nothing");
        assertTrue(sq.getState(id).refunded);
        assertEq(usdc.balanceOf(address(sq)), 2 * FEE, "credited-but-unclaimed fees are not swept");

        vm.prank(relayer);
        vm.expectRevert(ISQController.AlreadyRefunded.selector);
        sq.refundFees(id);

        vm.prank(rA);
        assertEq(sq.claim(), FEE);
        vm.prank(rB);
        assertEq(sq.claim(), FEE);
        assertEq(usdc.balanceOf(address(sq)), 0);
    }

    function test_RefundAfterRejectVerdict() public {
        uint256 id = setupFunded(2);
        send(mkVerdict(id, 0, REJECT, bytes32(0), 1));
        uint256 before = usdc.balanceOf(buyer);
        _expectRefundEvent(id, 5 * FEE);
        assertEq(sq.refundFees(id), 5 * FEE);
        assertEq(usdc.balanceOf(buyer) - before, 5 * FEE);
        assertEq(usdc.balanceOf(address(sq)), FEE);
        vm.expectRevert(ISQController.AlreadyRefunded.selector);
        sq.refundFees(id);
    }

    function test_RefundAfterReviseAtLimit() public {
        uint256 id = setupFunded(1);
        send(mkVerdict(id, 0, REVISE, bytes32(0), 3));
        send(mkVerdict(id, 1, REVISE, bytes32(0), 1));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        _expectRefundEvent(id, FEE);
        assertEq(sq.refundFees(id), FEE);
        vm.expectRevert(ISQController.AlreadyRefunded.selector);
        sq.refundFees(id);
    }

    function test_RefundAfterRejectOnTimeoutReturnsWholeDeposit() public {
        uint256 id = setupFunded(1);
        vm.warp(DEADLINE + 1);
        sq.rejectOnTimeout(id);
        uint256 before = usdc.balanceOf(buyer);
        _expectRefundEvent(id, 4 * FEE);
        assertEq(sq.refundFees(id), 4 * FEE);
        assertEq(usdc.balanceOf(buyer) - before, 4 * FEE);
        assertEq(usdc.balanceOf(address(sq)), 0);
    }

    function test_RefundAfterExpiredAndEarlierFeesStayClaimable() public {
        uint256 id = setupFunded(1);
        ISQController.Verdict memory r0 = mkRevise(id, 0);
        send(r0); // credits both members
        vm.warp(EXPIRY);
        ac.claimRefund(id);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Expired));

        // no new verdict can be applied once expired (the decision deadline necessarily passed first)
        sendExpectRevert(mkRevise(id, 1), ISQController.DeadlinePassed.selector);
        sendExpectRevert(mkReject(id, 1), ISQController.DeadlinePassed.selector);
        vm.expectRevert(ISQController.WrongJobStatus.selector);
        sq.rejectOnTimeout(id);
        send(r0); // exact replay stays a silent no-op
        assertEq(sq.getState(id).credited, 2 * FEE);

        uint256 before = usdc.balanceOf(buyer);
        _expectRefundEvent(id, 2 * FEE);
        vm.prank(provider);
        assertEq(sq.refundFees(id), 2 * FEE);
        assertEq(usdc.balanceOf(buyer) - before, 2 * FEE);
        assertEq(usdc.balanceOf(provider), 0, "funds go to the buyer, not the caller");

        vm.prank(rA);
        assertEq(sq.claim(), FEE);
        vm.prank(rB);
        assertEq(sq.claim(), FEE);
        assertEq(usdc.balanceOf(address(sq)), 0);
    }

    function test_RefundWithZeroLeftoverSucceedsWithoutTransfer() public {
        uint256 id = setupFunded(1);
        send(mkRevise(id, 0));
        send(mkRevise(id, 1));
        assertEq(sq.getState(id).credited, sq.getConfig(id).deposited);

        vm.recordLogs();
        _expectRefundEvent(id, 0);
        assertEq(sq.refundFees(id), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(countLogs(logs, address(usdc), keccak256("Transfer(address,address,uint256)")), 0);
        assertTrue(sq.getState(id).refunded);
        vm.expectRevert(ISQController.AlreadyRefunded.selector);
        sq.refundFees(id);
        assertEq(usdc.balanceOf(address(sq)), 4 * FEE);
    }

    function test_RefundIncludesKernelEvaluatorFeeCut() public {
        ac.setEvaluatorFee(1000); // 10% of BUDGET
        uint256 cut = BUDGET / 10;
        uint256 id = setupSubmitted(1);
        send(mkVerdict(id, 0, ACCEPT, DELIVERABLE, 1));
        assertEq(sq.getState(id).kernelFeeReceived, cut);
        uint256 expected = 4 * FEE - FEE + cut;
        _expectRefundEvent(id, expected);
        assertEq(sq.refundFees(id), expected);
        assertEq(usdc.balanceOf(address(sq)), FEE, "only the credited fee remains");
    }

    function test_DonatedUsdcIsNotAttributedToAnyJob() public {
        usdc.mint(address(sq), 777e6);
        ac.setEvaluatorFee(1000);
        uint256 cut = BUDGET / 10;
        uint256 id = setupSubmitted(0);
        send(mkVerdict(id, 0, ACCEPT, DELIVERABLE, 1));
        assertEq(sq.getState(id).kernelFeeReceived, cut, "only the measured delta is attributed");
        assertEq(sq.refundFees(id), FEE + cut, "deposit 2*FEE minus credited FEE, plus cut");
        vm.prank(rA);
        sq.claim();
        assertEq(usdc.balanceOf(address(sq)), 777e6, "donation is stranded, never paid out");
        vm.prank(rB);
        vm.expectRevert(ISQController.NothingToClaim.selector);
        sq.claim();
    }

    function test_DonationBeforeRegistrationDoesNotInflateRefund() public {
        uint256 id = setupFunded(0);
        usdc.mint(address(sq), 50e6);
        send(mkVerdict(id, 0, REJECT, bytes32(0), 3));
        assertEq(sq.refundFees(id), 0);
        assertEq(usdc.balanceOf(address(sq)), 2 * FEE + 50e6);
    }
}
