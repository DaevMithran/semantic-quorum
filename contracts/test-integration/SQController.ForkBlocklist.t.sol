// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/Test.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";
import {SQForkBase, IKernel} from "./SQForkBase.sol";

/// @notice Blocklist behaviour with REAL USDC. The fee recipient case uses the address that is blocklisted on the fork
/// at the pinned block; the buyer case blocklists the buyer AFTER funding through the real USDC `blacklister()` role
/// (impersonated), which drives the emulated precompile 0x1800..01 -- no etching, no logic faked.
contract SQControllerForkBlocklistTest is SQForkBase {
    ISQController.VerdictKind internal constant ACCEPT = ISQController.VerdictKind.Accept;
    ISQController.VerdictKind internal constant REJECT = ISQController.VerdictKind.Reject;
    bytes internal constant BLOCKED_ERR = abi.encodeWithSignature("Error(string)", "Blocked address");
    address internal rC = makeAddr("rC");

    // ------------------------------------------------------------------ 7: blocklisted FEE RECIPIENT

    function _threeMemberParams(uint256 id, uint256 exp) internal view returns (ISQController.RegisterParams memory p) {
        p = defaultParams(id, exp, 1000, 1000, 0);
        ISQController.CommitteeMember[] memory m = new ISQController.CommitteeMember[](3);
        m[0] = ISQController.CommitteeMember({evaluatorId: 1, feeRecipient: BLOCKLISTED}); // A: blocklisted
        m[1] = ISQController.CommitteeMember({evaluatorId: 2, feeRecipient: rB}); // B: normal
        m[2] = ISQController.CommitteeMember({evaluatorId: 3, feeRecipient: rC}); // C: never credited -> leftover
        p.committee = m;
    }

    function test_07_BlocklistedRecipient_AcceptCreditsBoth_OnlyItsClaimFails() public onlyFork {
        assertTrue(IUsdcView(USDC).isBlacklisted(BLOCKLISTED), "precondition: A is blocklisted on the fork");
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp);
        register(_threeMemberParams(id, exp)); // registration with a blocklisted recipient is fine (no transfer to it)
        submitJob(id);

        ISQController.Verdict memory v = verdictOf(id, ACCEPT, 0, 3); // credit A and B
        vm.expectEmit(true, true, false, true, address(sq));
        emit ISQController.FeeCredited(id, 0, 0, BLOCKLISTED, FEE);
        vm.expectEmit(true, true, false, true, address(sq));
        emit ISQController.FeeCredited(id, 0, 1, rB, FEE);
        sq.submitVerdict(v, sign(v));

        // a blocklisted fee recipient does NOT block ACCEPT: accounting only, kernel completed
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(sq.feeBalance(BLOCKLISTED), FEE);
        assertEq(sq.feeBalance(rB), FEE);
        assertEq(usdcBal(bob), BUDGET, "provider paid in full (live fees are applied to this figure only if non-zero)");

        // A's claim reverts with the USDC blocklist error; the revert rolls back A's balance
        vm.prank(BLOCKLISTED);
        (bool okA, bytes memory retA) = address(sq).call(abi.encodeCall(ISQController.claim, ()));
        console2.log("A.claim() ok:", okA);
        console2.logBytes(retA);
        assertFalse(okA, "blocklisted recipient cannot claim");
        assertEq(keccak256(retA), keccak256(BLOCKED_ERR), "revert data bubbles USDC Error('Blocked address')");
        assertEq(sq.feeBalance(BLOCKLISTED), FEE, "A's credit is preserved after the failed claim");

        // B is unaffected
        vm.prank(rB);
        assertEq(sq.claim(), FEE);
        assertEq(usdcBal(rB), FEE);

        // refundFees is unaffected: leftover (member C's slot) returns to the buyer
        assertEq(sq.refundFees(id), FEE);
        assertEq(usdcBal(alice), FEE);
        assertEq(usdcBal(address(sq)), FEE, "only A's blocked credit remains reserved in SQController");

        // once the real blacklister un-blocklists A, the preserved credit is claimable
        _unblocklist(BLOCKLISTED);
        uint256 aBefore = usdcBal(BLOCKLISTED); // A has a pre-existing native balance on the fork
        vm.prank(BLOCKLISTED);
        assertEq(sq.claim(), FEE);
        assertEq(usdcBal(BLOCKLISTED) - aBefore, FEE);
        assertEq(usdcBal(address(sq)), 0);
    }

    function test_07_BlocklistedRecipient_RejectVerdictAlsoOnlyAccounting() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp);
        register(_threeMemberParams(id, exp));
        ISQController.Verdict memory v = verdictOf(id, REJECT, 0, 3);
        sq.submitVerdict(v, sign(v));
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdcBal(alice), BUDGET);
        assertEq(sq.feeBalance(BLOCKLISTED), FEE);
        vm.prank(rB);
        sq.claim();
        assertEq(sq.refundFees(id), FEE);
    }

    // ------------------------------------------------------------------ 9: BUYER blocklisted AFTER funding
    //
    // ACCEPTED, DOCUMENTED LIMITATION: if the buyer is blocklisted by USDC after funding, every SQController
    // path that pays USDC to the buyer (REJECT verdict, rejectOnTimeout, refundFees) reverts atomically and
    // recovers once the buyer is un-blocklisted. The REAL kernel's own claimRefund pays the same blocked buyer
    // and reverts too (test_09b), so the escrow is stuck regardless of SQController; SQController introduces
    // no additional stuck-fund mode (ACCEPT still completes, test_09c).

    function _fundedAndRegistered() internal returns (uint256 id, uint256 exp) {
        exp = expiryIn(1 days);
        id = fundedJob(BUDGET, exp);
        register(defaultParams(id, exp, 1000, 1000, 0));
    }

    function test_09a_BuyerBlocklisted_RejectVerdictReverts_AtomicAndRecoverable() public onlyFork {
        (uint256 id,) = _fundedAndRegistered();
        _blocklist(alice);
        ISQController.Verdict memory v = verdictOf(id, REJECT, 0, 3);
        bytes memory sig = sign(v);
        (bool ok, bytes memory ret) = address(sq).call(abi.encodeCall(ISQController.submitVerdict, (v, sig)));
        console2.log("REJECT with blocklisted buyer ok:", ok);
        console2.logBytes(ret);
        assertFalse(ok, "kernel refund to a blocklisted buyer reverts the whole REJECT");
        assertEq(keccak256(ret), keccak256(BLOCKED_ERR));
        // atomic: nothing recorded, nothing credited, kernel untouched
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Funded));
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.None));
        assertEq(sq.getState(id).credited, 0);
        assertEq(sq.verdictDigestOf(id, 0), bytes32(0));

        // recoverable once the buyer is un-blocklisted: same signature works
        _unblocklist(alice);
        sq.submitVerdict(v, sig);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdcBal(alice), BUDGET);
    }

    function test_09b_BuyerBlocklisted_RejectOnTimeoutReverts_AtomicAndRecoverable() public onlyFork {
        (uint256 id,) = _fundedAndRegistered();
        _blocklist(alice);
        vm.warp(sq.getConfig(id).decisionDeadline + 1);
        (bool ok, bytes memory ret) = address(sq).call(abi.encodeCall(ISQController.rejectOnTimeout, (id)));
        console2.log("rejectOnTimeout with blocklisted buyer ok:", ok);
        console2.logBytes(ret);
        assertFalse(ok);
        assertEq(keccak256(ret), keccak256(BLOCKED_ERR));
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Funded));
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.None), "decision restored");

        // kernel-level claimRefund after expiry is blocked the same way (escrow can't reach a blocklisted client)
        vm.warp(ac.getJob(id).expiredAt);
        vm.prank(stranger);
        (bool okC, bytes memory retC) = AC.call(abi.encodeCall(IKernel.claimRefund, (id)));
        console2.log("kernel claimRefund with blocklisted client ok:", okC);
        console2.logBytes(retC);
        assertFalse(okC, "kernel claimRefund also reverts while the client is blocklisted");

        _unblocklist(alice);
        sq.rejectOnTimeout(id);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(usdcBal(alice), BUDGET);
    }

    function test_09c_BuyerBlocklisted_AcceptStillCompletes_RefundFeesRevertsAtomically() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp);
        register(defaultParams(id, exp, 1000, 1000, 0));
        submitJob(id);
        _blocklist(alice);

        // ACCEPT pays provider / fee recipients, never the buyer -> unaffected
        ISQController.Verdict memory v = verdictOf(id, ACCEPT, 0, 1); // leftover FEE for the buyer
        sq.submitVerdict(v, sign(v));
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdcBal(bob), BUDGET, "live fees are 0 at the pinned block");

        // refundFees to a blocklisted buyer reverts and rolls back `refunded`
        (bool ok, bytes memory ret) = address(sq).call(abi.encodeCall(ISQController.refundFees, (id)));
        console2.log("refundFees with blocklisted buyer ok:", ok);
        console2.logBytes(ret);
        assertFalse(ok);
        assertEq(keccak256(ret), keccak256(BLOCKED_ERR));
        assertFalse(sq.getState(id).refunded, "refunded flag rolled back");

        // recipients are not blocked by the buyer's status
        vm.prank(rA);
        assertEq(sq.claim(), FEE);

        _unblocklist(alice);
        assertEq(sq.refundFees(id), FEE);
        assertEq(usdcBal(alice), FEE);
        assertEq(usdcBal(address(sq)), 0);
    }
}

interface IUsdcView {
    function isBlacklisted(address a) external view returns (bool);
}
