// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {SQBase} from "./SQBase.sol";
import {SQHandler} from "./SQHandler.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

/// @dev Invariant campaign settings (inline config so foundry.toml is untouched):
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 60
/// forge-config: default.invariant.fail-on-revert = false
contract SQControllerInvariantTest is SQBase {
    SQHandler internal h;

    function setUp() public override {
        super.setUp();
        ac.setEvaluatorFee(500); // non-zero kernel evaluator fee baseline; the handler re-fuzzes it
        h = new SQHandler(usdc, ac, sq, authorityKey);
        bytes4[] memory sel = new bytes4[](21);
        sel[18] = SQHandler.unauthorizedReport.selector;
        sel[19] = SQHandler.unauthorizedReport.selector; // double weight: unauthorized callers are always rejected
        sel[20] = SQHandler.replayVerdict.selector; // extra cross-path replay weight
        sel[14] = SQHandler.sendValidVerdict.selector;
        sel[15] = SQHandler.sendValidVerdict.selector; // double weight for state-consistent verdicts
        sel[16] = SQHandler.forceAndSettle.selector;
        sel[17] = SQHandler.sendValidVerdict.selector;
        sel[0] = SQHandler.registerJob.selector;
        sel[1] = SQHandler.attemptInvalidRegistration.selector;
        sel[2] = SQHandler.submitJob.selector;
        sel[3] = SQHandler.registerJob.selector; // double weight: every registered job is Funded, budget > 0
        sel[4] = SQHandler.expireJob.selector;
        sel[5] = SQHandler.warpTime.selector;
        sel[6] = SQHandler.setKernelFees.selector;
        sel[7] = SQHandler.donate.selector;
        sel[8] = SQHandler.sendVerdict.selector;
        sel[9] = SQHandler.replayVerdict.selector;
        sel[10] = SQHandler.settleJob.selector;
        sel[11] = SQHandler.timeoutJob.selector;
        sel[12] = SQHandler.claimFees.selector;
        sel[13] = SQHandler.refundJob.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    // ------------------------------------------------------------------ helpers

    function _popcount(uint256 x) internal pure returns (uint256 n) {
        while (x != 0) {
            n += x & 1;
            x >>= 1;
        }
    }

    function _sumBalances() internal view returns (uint256 s) {
        for (uint256 i; i < h.poolLength(); ++i) s += sq.feeBalance(h.pool(i));
        for (uint256 i; i < h.buyersLength(); ++i) s += sq.feeBalance(h.buyers(i));
        s += sq.feeBalance(h.relayer()) + sq.feeBalance(h.provider()) + sq.feeBalance(h.authority());
        s += sq.feeBalance(address(h)) + sq.feeBalance(address(sq)) + sq.feeBalance(h.treasury());
    }

    function afterInvariant() public view {
        console2.log("jobs", h.jobCount());
        console2.log("ok reg/verdict/accept", h.okRegister(), h.okVerdict(), h.okAccept());
        console2.log("invalid-shape registrations rejected", h.invalidRejected());
        console2.log("ok settle/forcedSettle/timeout/expire", h.okSettle(), h.okForcedSettle(), h.okTimeout());
        console2.log("expire/acceptCapReverts/garbageReplayReverts", h.okExpire(), h.acceptCapReverts(), h.garbageReplayReverts());
        console2.log("ok claim/refund", h.okClaim(), h.okRefund());
        console2.log("verdicts ok via submit/sim/prod", h.okViaSubmit(), h.okViaSim(), h.okViaProd());
        console2.log("unauthorized onReport attempts", h.unauthorizedAttempts());
    }

    // ------------------------------------------------------------------ (a) solvency

    /// usdc.balanceOf(sq) == sum(feeBalance) + sum(unrefunded leftovers) (+ donations), checked against
    /// both the controller's own state and independent handler ghosts.
    function invariant_A_BalanceEqualsLedgerPlusUnrefundedLeftovers() public {
        uint256 left;
        uint256 credited;
        for (uint256 i; i < h.jobCount(); ++i) {
            uint256 id = h.jobIds(i);
            ISQController.JobConfig memory cfg = sq.getConfig(id);
            ISQController.JobState memory st = sq.getState(id);
            credited += st.credited;
            if (!st.refunded) left += cfg.deposited - st.credited + st.kernelFeeReceived;
        }
        uint256 bal = usdc.balanceOf(address(sq));
        uint256 ledger = _sumBalances();
        assertEq(bal, ledger + left + h.ghostDonated(), "state identity");
        assertEq(
            bal,
            h.ghostDeposited() + h.ghostKernel() + h.ghostDonated() - h.ghostClaimed() - h.ghostRefunded(),
            "ghost flow identity"
        );
        assertEq(ledger + h.ghostClaimed(), credited, "fee ledger conservation");
    }

    // ------------------------------------------------------------------ (b) credited <= deposited

    function invariant_B_CreditedNeverExceedsDeposit() public {
        for (uint256 i; i < h.jobCount(); ++i) {
            uint256 id = h.jobIds(i);
            assertLe(sq.getState(id).credited, sq.getConfig(id).deposited);
        }
    }

    // ------------------------------------------------------------------ (c) one credit per slot

    function invariant_C_EachSlotCreditedOnceAndEventsMatchCredited() public {
        assertFalse(h.violation(), h.violationMsg());
        for (uint256 i; i < h.jobCount(); ++i) {
            uint256 id = h.jobIds(i);
            ISQController.JobConfig memory cfg = sq.getConfig(id);
            uint256 total;
            for (uint256 r; r <= cfg.revisionLimit; ++r) {
                uint256 mask = sq.creditedMaskOf(id, uint8(r));
                assertEq(mask >> cfg.committeeSize, 0, "mask within committee");
                total += _popcount(mask);
            }
            assertEq(h.eventCount(id), total, "events == credited bits");
            assertEq(h.eventCount(id) * cfg.feePerReport, sq.getState(id).credited, "events * fee == credited");
        }
    }

    // ------------------------------------------------------------------ (d) round bound / final decision

    function invariant_D_RoundBoundedAndDecisionFinal() public {
        assertFalse(h.violation(), h.violationMsg());
        for (uint256 i; i < h.jobCount(); ++i) {
            uint256 id = h.jobIds(i);
            ISQController.JobState memory st = sq.getState(id);
            assertLe(st.round, sq.getConfig(id).revisionLimit);
            assertEq(uint8(st.decision), uint8(h.seenDecision(id)), "decision matches last snapshot");
            if (st.settled) assertEq(uint8(st.decision), uint8(ISQController.Decision.Accepted));
            if (st.decision == ISQController.Decision.Rejected) assertFalse(st.settled);
            if (st.decision == ISQController.Decision.Accepted) {
                // ACCEPT completes atomically: accepted <=> settled <=> kernel Completed
                assertTrue(st.settled, "accepted but unsettled");
                assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed), "accepted not completed");
            }
        }
    }

    // ------------------------------------------------------------------ (e) refunded => terminal

    function invariant_E_RefundedJobsAreTerminal() public {
        for (uint256 i; i < h.jobCount(); ++i) {
            uint256 id = h.jobIds(i);
            ISQController.JobState memory st = sq.getState(id);
            assertEq(st.refunded, h.refundedGhost(id), "refund flag matches ghost");
            if (st.refunded) {
                IAgenticCommerce.JobStatus s = kernelStatus(id);
                assertTrue(
                    s == IAgenticCommerce.JobStatus.Completed || s == IAgenticCommerce.JobStatus.Rejected
                        || s == IAgenticCommerce.JobStatus.Expired,
                    "refunded job not terminal"
                );
            }
        }
    }

    // ------------------------------------------------------------------ (g) unauthorized onReport callers never change state

    /// Every non-forwarder caller of onReport, even with a state-consistent, correctly signed verdict,
    /// reverts UnauthorizedForwarder(caller) and leaves state, balances and logs untouched.
    function invariant_G_UnauthorizedOnReportCallersNeverChangeState() public {
        assertFalse(h.unauthorizedViolation(), h.violationMsg());
        assertFalse(h.violation(), h.violationMsg());
    }

    // ------------------------------------------------------------------ (f) digests <= revisionLimit + 1

    function invariant_F_RoundsWithDigestBoundedByRevisionLimitPlusOne() public {
        for (uint256 i; i < h.jobCount(); ++i) {
            uint256 id = h.jobIds(i);
            ISQController.JobConfig memory cfg = sq.getConfig(id);
            uint256 recorded;
            for (uint256 r; r < 16; ++r) {
                bool has = sq.verdictDigestOf(id, uint8(r)) != bytes32(0);
                if (has) {
                    ++recorded;
                    assertLe(r, cfg.revisionLimit, "digest above revision limit");
                }
                if (r < sq.getState(id).round) assertTrue(has, "advanced round without a digest");
            }
            assertLe(recorded, uint256(cfg.revisionLimit) + 1);
        }
    }

}

/// @dev Stateless fuzz of the whole lifecycle: random fee, revisionLimit, committee size, masks,
/// ending (accept / reject / revise-at-limit / timeout / reject-on-submitted / kernel expiry),
/// replay and conflict injection, and random ordering of settle / refund / claims. After every
/// step the solvency identity must hold against an independently tallied credit total.
contract SQControllerLifecycleFuzzTest is SQBase {
    ISQController.VerdictKind internal constant ACCEPT = ISQController.VerdictKind.Accept;
    ISQController.VerdictKind internal constant REVISE = ISQController.VerdictKind.Revise;
    ISQController.VerdictKind internal constant REJECT = ISQController.VerdictKind.Reject;

    uint256 internal id;
    uint8 internal limit;
    uint256 internal n;
    uint256 internal fee;
    uint256 internal bp;
    uint256 internal maskSeed;
    uint256 internal credited; // independent tally: popcount(mask) * fee per credited round
    uint256 internal kernelFee;
    bool internal refunded;
    bool internal accepted;
    bool internal tight;
    uint256 internal routeSeed;
    uint256 internal step;

    /// @dev Next delivery path (submitVerdict / onReport sim / onReport prod), pseudo-random per step.
    function _route() internal returns (uint256) {
        return uint256(keccak256(abi.encode(routeSeed, ++step)));
    }

    function _popcount(uint256 x) internal pure returns (uint256 c) {
        while (x != 0) {
            c += x & 1;
            x >>= 1;
        }
    }

    function _mask(uint256 round) internal view returns (uint256) {
        return 1 + uint256(keccak256(abi.encode(maskSeed, round))) % ((uint256(1) << n) - 1);
    }

    function _checkSolvency() internal {
        ISQController.CommitteeMember[] memory c = sq.getCommittee(id);
        uint256 sum;
        for (uint256 i; i < c.length; ++i) sum += sq.feeBalance(c[i].feeRecipient);
        ISQController.JobConfig memory cfg = sq.getConfig(id);
        ISQController.JobState memory st = sq.getState(id);
        uint256 left = refunded ? 0 : cfg.deposited - st.credited + st.kernelFeeReceived;
        assertEq(usdc.balanceOf(address(sq)), sum + left, "solvency identity");
        assertEq(st.credited, credited, "credited == independent tally");
        assertEq(st.kernelFeeReceived, kernelFee, "kernel fee");
        assertLe(st.credited, cfg.deposited);
        assertLe(st.round, cfg.revisionLimit);
    }

    function _register() internal {
        id = newJob(EXPIRY);
        fundJob(id, BUDGET);
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, limit, fee);
        p.committee = committee(n);
        if (tight) p.maxEvaluatorFeeBP = bp - 1; // cap one below the live evaluator fee
        registerWith(p);
        _checkSolvency();
    }

    /// @dev Sends v, tallies its credits, optionally replays it and injects a conflicting twin.
    function _sendTallied(ISQController.Verdict memory v, bool replay) internal {
        sendVia(v, _route());
        credited += _popcount(v.includedMask) * fee;
        _checkSolvency();
        if (replay) {
            sendVia(v, _route()); // exact replay on any path: silent no-op
            _checkSolvency();
            ISQController.Verdict memory twin = v;
            twin.evidenceHash = keccak256("other evidence");
            sendViaExpectRevert(twin, ISQController.ConflictingVerdict.selector, _route());
            _checkSolvency();
        }
    }

    /// @dev ACCEPT with live evaluator fee above the cap reverts atomically; lowering the fee unblocks it.
    function _acceptBlockedByCap(uint8 k) internal {
        ISQController.Verdict memory v = mkVerdict(id, k, ACCEPT, DELIVERABLE, _mask(k));
        bytes memory sig = signVerdict(v);
        bytes memory err = abi.encodeWithSelector(ISQController.EvaluatorFeeAboveCap.selector, bp, bp - 1);
        uint256 rt = _route() % 3;
        if (rt == 0) {
            vm.expectRevert(err);
            vm.prank(relayer);
            sq.submitVerdict(v, sig);
        } else {
            deliverExpectRevert(rt == 1 ? simForwarder : prodForwarder, v, sig, err);
        }
        assertEq(sq.verdictDigestOf(id, k), bytes32(0), "no digest after blocked accept");
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
        _checkSolvency();
        bp -= 1;
        ac.setEvaluatorFee(bp);
    }

    function _finish(uint256 end, uint8 k, uint256 order, bool replay) internal {
        if (end == 0) {
            submitJob(id, DELIVERABLE);
            if (tight) _acceptBlockedByCap(k);
            kernelFee = BUDGET * bp / 10000; // recorded in the ACCEPT tx itself
            _sendTallied(mkVerdict(id, k, ACCEPT, DELIVERABLE, _mask(k)), replay);
            accepted = true;
        } else if (end == 1 || end == 4) {
            if (end == 4 || order & 1 == 1) submitJob(id, DELIVERABLE);
            _sendTallied(mkVerdict(id, k, REJECT, bytes32(0), _mask(k)), replay);
        } else if (end == 2) {
            _sendTallied(mkVerdict(id, k, REVISE, bytes32(0), _mask(k)), replay); // k == limit: rejects
        } else if (end == 3) {
            vm.warp(DEADLINE + 1);
            sq.rejectOnTimeout(id);
        } else {
            vm.warp(EXPIRY);
            ac.claimRefund(id);
        }
        _checkSolvency();
    }

    function _refund() internal {
        ISQController.JobConfig memory cfg = sq.getConfig(id);
        uint256 expected = cfg.deposited - credited + kernelFee;
        uint256 before = usdc.balanceOf(buyer);
        vm.prank(stranger);
        assertEq(sq.refundFees(id), expected, "refund amount");
        assertEq(usdc.balanceOf(buyer) - before, expected, "buyer paid");
        refunded = true;
        _checkSolvency();
        vm.expectRevert(ISQController.AlreadyRefunded.selector);
        sq.refundFees(id);
    }

    function _claimAll() internal {
        ISQController.CommitteeMember[] memory c = sq.getCommittee(id);
        for (uint256 i; i < c.length; ++i) {
            address a = c[i].feeRecipient;
            uint256 bal = sq.feeBalance(a);
            vm.prank(a);
            if (bal == 0) {
                vm.expectRevert(ISQController.NothingToClaim.selector);
                sq.claim();
            } else {
                assertEq(sq.claim(), bal);
                assertEq(usdc.balanceOf(a), bal);
            }
            _checkSolvency();
        }
    }

    function testFuzz_LifecycleSolvency(uint256 feeSeed, uint256 shape, uint256 seed) public {
        fee = bound(feeSeed, 1, 100e6);
        limit = uint8(shape % 4);
        n = 1 + (shape >> 8) % 4;
        uint256 end = (shape >> 16) % 6;
        uint256 order = shape >> 24;
        bp = (shape >> 40) % 3001;
        bool replay = (shape >> 56) & 1 == 1;
        tight = (shape >> 90) & 1 == 1 && bp > 0;
        maskSeed = seed;
        routeSeed = uint256(keccak256(abi.encode(seed, shape)));
        ac.setEvaluatorFee(bp);
        ac.setPlatformFee((shape >> 100) % 2001, address(0xFEE));
        _register();

        uint8 k = end == 2 ? limit : uint8(uint256(keccak256(abi.encode(seed, "k"))) % (uint256(limit) + 1));
        for (uint8 r; r < k; ++r) _sendTallied(mkVerdict(id, r, REVISE, bytes32(0), _mask(r)), replay);
        _finish(end, k, order, replay);

        if (accepted) {
            // settled in the ACCEPT tx: terminal immediately, settle is only a (now unreachable) retry
            assertTrue(sq.getState(id).settled);
            assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
            vm.expectRevert(ISQController.AlreadySettled.selector);
            sq.settle(id);
            _checkSolvency();
        }

        if (order & 4 != 0) {
            _claimAll();
            _refund();
        } else {
            _refund();
            _claimAll();
        }
        assertEq(usdc.balanceOf(address(sq)), 0, "everything paid out");
        assertTrue(sq.getState(id).refunded);
    }
}
