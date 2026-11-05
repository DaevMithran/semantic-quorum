// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SQBase} from "./SQBase.sol";
import {MaliciousRecipient} from "./mocks/MaliciousRecipient.sol";
import {SQController} from "../SQController.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

/// @dev onReport and submitVerdict share one reentrancy guard. The attacker contract is made the
/// simulation forwarder so a blocked re-entry is stopped by the guard and not by forwarder gating.
contract SQControllerCREReentrancyTest is SQBase {
    ISQController.VerdictKind internal constant ACCEPT = ISQController.VerdictKind.Accept;
    ISQController.VerdictKind internal constant REVISE = ISQController.VerdictKind.Revise;

    MaliciousRecipient internal mal;

    function setUp() public override {
        super.setUp();
        mal = new MaliciousRecipient();
        simForwarder = address(mal);
        sq = new SQController(IAgenticCommerce(address(ac)), IERC20(address(usdc)), simForwarder, prodForwarder);
    }

    function _reportCall(ISQController.Verdict memory v) internal view returns (bytes memory) {
        return abi.encodeCall(sq.onReport, (creMetadata(), encodeReport(v, signVerdict(v))));
    }

    function _submitCall(ISQController.Verdict memory v) internal view returns (bytes memory) {
        return abi.encodeCall(sq.submitVerdict, (v, signVerdict(v)));
    }

    /// @dev Submitted job whose provider is the attacker: ACCEPT pays it the net budget, firing the hook.
    function _providerIsAttackerJob() internal returns (uint256 id) {
        provider = address(mal);
        id = setupSubmitted(1);
    }

    function _assertAcceptedOnce(uint256 id) internal view {
        assertTrue(mal.attacked(), "hook fired");
        assertFalse(mal.attackSucceeded(), "re-entry blocked by the shared guard");
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Accepted));
        assertEq(sq.getState(id).credited, 2 * FEE, "credited once");
        assertEq(usdc.balanceOf(address(mal)), BUDGET, "provider paid once");
    }

    // ------------------------------------------------------------------ re-entry during the kernel payout

    function test_OnReportCannotBeReenteredViaOnReport() public {
        uint256 id = _providerIsAttackerJob();
        ISQController.Verdict memory v = mkAccept(id, 0);
        mal.arm(address(sq), _reportCall(v)); // re-delivering the SAME verdict would silently no-op without a guard
        bytes memory sig = signVerdict(v);
        usdc.setReceiveHook(true);
        deliver(simForwarder, v, sig);
        usdc.setReceiveHook(false);
        _assertAcceptedOnce(id);
    }

    function test_OnReportCannotBeReenteredViaSubmitVerdict() public {
        uint256 id = _providerIsAttackerJob();
        ISQController.Verdict memory v = mkAccept(id, 0);
        mal.arm(address(sq), _submitCall(v));
        bytes memory sig = signVerdict(v);
        usdc.setReceiveHook(true);
        deliver(prodForwarder, v, sig);
        usdc.setReceiveHook(false);
        _assertAcceptedOnce(id);
    }

    function test_SubmitVerdictCannotBeReenteredViaOnReport() public {
        uint256 id = _providerIsAttackerJob();
        ISQController.Verdict memory v = mkAccept(id, 0);
        mal.arm(address(sq), _reportCall(v));
        usdc.setReceiveHook(true);
        send(v);
        usdc.setReceiveHook(false);
        _assertAcceptedOnce(id);
    }

    function test_SubmitVerdictCannotBeReenteredViaSubmitVerdict() public {
        uint256 id = _providerIsAttackerJob();
        ISQController.Verdict memory v = mkAccept(id, 0);
        mal.arm(address(sq), _submitCall(v));
        usdc.setReceiveHook(true);
        send(v);
        usdc.setReceiveHook(false);
        _assertAcceptedOnce(id);
    }

    // ------------------------------------------------------------------ re-entry from a fee recipient's claim

    function _recipientIsAttackerJob() internal returns (uint256 id) {
        id = newJob(EXPIRY);
        fundJob(id, BUDGET);
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, 2, FEE);
        p.committee[0].feeRecipient = address(mal);
        registerWith(p);
        deliverSigned(prodForwarder, mkRevise(id, 0)); // credits the attacker FEE and moves to round 1
    }

    function _claimAttack(uint256 id, bytes memory attack) internal {
        mal.arm(address(sq), attack);
        usdc.setReceiveHook(true);
        vm.prank(address(mal));
        sq.claim();
        usdc.setReceiveHook(false);
        assertTrue(mal.attacked());
        assertFalse(mal.attackSucceeded(), "re-entry from claim blocked");
        assertEq(usdc.balanceOf(address(mal)), FEE, "paid exactly once");
        assertEq(sq.getState(id).round, 1, "round untouched");
        assertEq(sq.verdictDigestOf(id, 1), bytes32(0));
        assertEq(sq.getState(id).credited, 2 * FEE);
    }

    function test_FeeRecipientCannotReenterOnReportFromClaim() public {
        uint256 id = _recipientIsAttackerJob();
        _claimAttack(id, _reportCall(mkRevise(id, 1)));
        deliverSigned(simForwarder, mkRevise(id, 1)); // the same report applies normally afterwards
        assertEq(sq.getState(id).round, 2);
    }

    function test_FeeRecipientCannotReenterSubmitVerdictFromClaim() public {
        uint256 id = _recipientIsAttackerJob();
        _claimAttack(id, _submitCall(mkRevise(id, 1)));
        deliverSigned(prodForwarder, mkRevise(id, 1));
        assertEq(sq.getState(id).round, 2);
    }

    function test_FeeRecipientCannotCreditTwiceByReenteringReplayOfCreditedVerdict() public {
        uint256 id = _recipientIsAttackerJob();
        // replaying the credited round-0 verdict would be a silent no-op without the guard
        _claimAttack(id, _reportCall(mkRevise(id, 0)));
        assertEq(sq.feeBalance(rB), FEE);
    }

    // ------------------------------------------------------------------ guard does not wedge the contract

    function test_GuardReleasedAfterRevertedOnReport() public {
        uint256 id = setupFunded(1);
        ISQController.Verdict memory v = mkRevise(id, 1); // wrong round
        deliverExpectRevert(simForwarder, v, signVerdict(v), abi.encodePacked(ISQController.WrongRound.selector));
        deliverSigned(prodForwarder, mkRevise(id, 0));
        assertEq(sq.getState(id).round, 1);
    }
}

/// @dev Gas of one CRE delivery. Each test runs in its own transaction after setUp, so storage and
/// accounts start cold (conservative). The CRE workflow's default gasLimit is 500000. The numbers are
/// logged; the assertions are (a) committees up to 5 fit the default limit and (b) a regression ceiling.
contract SQControllerCREGasTest is SQBase {
    ISQController.VerdictKind internal constant ACCEPT = ISQController.VerdictKind.Accept;
    uint256 internal constant CRE_GAS_LIMIT = 500_000;
    uint256 internal constant REGRESSION_CEILING = 800_000;

    mapping(uint256 n => ISQController.Verdict) internal verdicts;
    mapping(uint256 n => bytes) internal sigs;
    mapping(uint256 n => bytes) internal reports;
    // a second, identical-shape job per size so the direct-path baseline is also measured cold
    mapping(uint256 n => ISQController.Verdict) internal verdictsB;
    mapping(uint256 n => bytes) internal sigsB;

    function _prep(uint256 n) internal returns (ISQController.Verdict memory v, bytes memory sig) {
        uint256 id = newJob(EXPIRY);
        fundJob(id, BUDGET);
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, 2, FEE);
        p.committee = committee(n);
        registerWith(p);
        submitJob(id, DELIVERABLE);
        v = mkVerdict(id, 0, ACCEPT, DELIVERABLE, (uint256(1) << n) - 1);
        sig = signVerdict(v);
    }

    function setUp() public override {
        super.setUp();
        ac.setEvaluatorFee(500); // 5% evaluator cut paid to the controller
        ac.setPlatformFee(250, address(0xFEE)); // 2.5% platform fee
        for (uint256 n = 1; n <= 8; ++n) {
            (verdicts[n], sigs[n]) = _prep(n);
            reports[n] = encodeReport(verdicts[n], sigs[n]);
            (verdictsB[n], sigsB[n]) = _prep(n);
        }
    }

    function _measureOnReport(uint256 n, address fwd) internal returns (uint256 g) {
        bytes memory meta = creMetadata();
        bytes memory report = reports[n];
        uint256 id = verdicts[n].jobId;
        vm.prank(fwd);
        g = gasleft();
        sq.onReport(meta, report);
        g = g - gasleft();
        console2.log("gas onReport ACCEPT, committee size / gas:", n, g);
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Accepted));
        assertEq(sq.getState(id).credited, n * FEE, "all fees credited");
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertLt(g, REGRESSION_CEILING, "regression ceiling");
    }

    function _measureDirect(uint256 n) internal returns (uint256 g) {
        ISQController.Verdict memory v = verdictsB[n];
        bytes memory sig = sigsB[n];
        vm.prank(relayer);
        g = gasleft();
        sq.submitVerdict(v, sig);
        g = g - gasleft();
        console2.log("gas submitVerdict ACCEPT (baseline), committee size / gas:", n, g);
        assertEq(sq.getState(v.jobId).credited, n * FEE);
    }

    function test_Gas_OnReportAccept_Committee1() public {
        assertLt(_measureOnReport(1, simForwarder), CRE_GAS_LIMIT, "n=1 fits the default 500000 gasLimit");
    }

    function test_Gas_OnReportAccept_Committee2() public {
        assertLt(_measureOnReport(2, simForwarder), CRE_GAS_LIMIT);
    }

    function test_Gas_OnReportAccept_Committee3() public {
        assertLt(_measureOnReport(3, prodForwarder), CRE_GAS_LIMIT);
    }

    function test_Gas_OnReportAccept_Committee4() public {
        assertLt(_measureOnReport(4, simForwarder), CRE_GAS_LIMIT);
    }

    function test_Gas_OnReportAccept_Committee5() public {
        assertLt(_measureOnReport(5, simForwarder), CRE_GAS_LIMIT);
    }

    function test_Gas_OnReportAccept_Committee6() public {
        _measureOnReport(6, simForwarder); // logged only: may exceed the default 500000
    }

    function test_Gas_OnReportAccept_Committee7() public {
        _measureOnReport(7, simForwarder);
    }

    function test_Gas_OnReportAccept_Committee8() public {
        _measureOnReport(8, simForwarder);
    }

    function test_Gas_OnReportAccept_Committee8_ProductionForwarder() public {
        _measureOnReport(8, prodForwarder);
    }

    /// @dev With the forwarder's gas capped at exactly 500000, committee 1 completes.
    function test_Gas_Committee1_CompletesWithExact500kForwarded() public {
        bytes memory meta = creMetadata();
        bytes memory report = reports[1];
        vm.prank(simForwarder);
        sq.onReport{gas: CRE_GAS_LIMIT}(meta, report);
        assertEq(sq.getState(verdicts[1].jobId).credited, FEE);
    }

    /// @dev A too-small gasLimit makes the delivery revert atomically (nothing stored); a retry with more gas works.
    function test_Gas_Committee8_UnderfundedDeliveryRevertsAtomicallyAndRetrySucceeds() public {
        bytes memory meta = creMetadata();
        bytes memory report = reports[8];
        uint256 id = verdicts[8].jobId;
        bytes32 fp = fingerprint(id);
        vm.prank(simForwarder);
        (bool ok,) = address(sq).call{gas: 300_000}(abi.encodeCall(sq.onReport, (meta, report)));
        assertFalse(ok, "300k gas is not enough for committee 8");
        assertEq(fingerprint(id), fp, "out-of-gas delivery leaves no trace");
        vm.prank(simForwarder);
        sq.onReport(meta, report);
        assertEq(sq.getState(id).credited, 8 * FEE);
    }

    function test_Gas_SubmitVerdictAccept_Committee1_Baseline() public {
        _measureDirect(1);
    }

    function test_Gas_SubmitVerdictAccept_Committee8_Baseline() public {
        _measureDirect(8);
    }

    function test_Gas_IdempotentRedeliveryIsCheap() public {
        bytes memory meta = creMetadata();
        bytes memory report = reports[8];
        vm.prank(simForwarder);
        sq.onReport(meta, report);
        vm.prank(prodForwarder);
        uint256 g = gasleft();
        sq.onReport{gas: CRE_GAS_LIMIT}(meta, report);
        g = g - gasleft();
        console2.log("gas onReport redelivery no-op n=8", g);
        assertLt(g, 100_000);
    }
}
