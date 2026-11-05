// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {SQBase} from "./SQBase.sol";
import {MaliciousRecipient} from "./mocks/MaliciousRecipient.sol";
import {SQController} from "../SQController.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";
import {IReceiver} from "../interfaces/IReceiver.sol";

/// @dev Chainlink CRE receiver: constructor, ERC-165, forwarder gating, happy paths and event parity.
contract SQControllerCRETest is SQBase {
    ISQController.VerdictKind internal constant ACCEPT = ISQController.VerdictKind.Accept;
    ISQController.VerdictKind internal constant REVISE = ISQController.VerdictKind.Revise;
    ISQController.VerdictKind internal constant REJECT = ISQController.VerdictKind.Reject;
    uint256 internal constant EVAL_BP = 500;
    uint256 internal constant PLAT_BP = 250;

    function _fwds() internal view returns (address[2] memory f) {
        f[0] = simForwarder;
        f[1] = prodForwarder;
    }

    function _newSq(address sim, address prod) internal returns (SQController) {
        return new SQController(IAgenticCommerce(address(ac)), IERC20(address(usdc)), sim, prod);
    }

    // ------------------------------------------------------------------ constructor

    function test_Constructor_StoresBothForwardersAndPins() public view {
        assertEq(sq.simulationForwarder(), simForwarder);
        assertEq(sq.productionForwarder(), prodForwarder);
        assertEq(address(sq.agenticCommerce()), address(ac));
        assertEq(address(sq.usdc()), address(usdc));
    }

    function test_RevertWhen_ConstructorZeroSimulationForwarder() public {
        vm.expectRevert(ISQController.ZeroAddress.selector);
        _newSq(address(0), prodForwarder);
    }

    function test_RevertWhen_ConstructorZeroProductionForwarder() public {
        vm.expectRevert(ISQController.ZeroAddress.selector);
        _newSq(simForwarder, address(0));
    }

    function test_RevertWhen_ConstructorBothForwardersZero() public {
        vm.expectRevert(ISQController.ZeroAddress.selector);
        _newSq(address(0), address(0));
    }

    function test_RevertWhen_ConstructorEqualForwarders() public {
        vm.expectRevert(ISQController.BadParams.selector);
        _newSq(simForwarder, simForwarder);
    }

    function test_RevertWhen_ConstructorZeroKernelOrUsdc() public {
        vm.expectRevert(ISQController.ZeroAddress.selector);
        new SQController(IAgenticCommerce(address(0)), IERC20(address(usdc)), simForwarder, prodForwarder);
        vm.expectRevert(ISQController.ZeroAddress.selector);
        new SQController(IAgenticCommerce(address(ac)), IERC20(address(0)), simForwarder, prodForwarder);
    }

    function testFuzz_ConstructorStoresDistinctForwarders(address a, address b) public {
        vm.assume(a != address(0) && b != address(0) && a != b);
        SQController c = _newSq(a, b);
        assertEq(c.simulationForwarder(), a);
        assertEq(c.productionForwarder(), b);
    }

    // ------------------------------------------------------------------ ERC-165

    function test_SupportsInterface_IReceiverAndIERC165() public view {
        assertTrue(sq.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(sq.supportsInterface(IReceiver.onReport.selector), "IReceiver id is the onReport selector");
        assertTrue(sq.supportsInterface(type(IERC165).interfaceId));
        assertTrue(sq.supportsInterface(0x01ffc9a7));
    }

    function test_SupportsInterface_FalseForInvalidAndForeignIds() public view {
        assertFalse(sq.supportsInterface(0xffffffff));
        assertFalse(sq.supportsInterface(bytes4(0)));
        assertFalse(sq.supportsInterface(type(ISQController).interfaceId));
        assertFalse(sq.supportsInterface(type(IERC20).interfaceId));
        assertFalse(sq.supportsInterface(0x12345678));
    }

    function testFuzz_SupportsInterface_FalseForEverythingElse(bytes4 id) public view {
        vm.assume(id != type(IReceiver).interfaceId && id != type(IERC165).interfaceId);
        assertFalse(sq.supportsInterface(id));
    }

    // ------------------------------------------------------------------ happy paths

    function _kernelFees() internal {
        ac.setEvaluatorFee(EVAL_BP);
        ac.setPlatformFee(PLAT_BP, address(0xFEE));
    }

    function _assertAcceptedAtomically(uint256 id, bytes32 digest) internal view {
        ISQController.JobState memory st = sq.getState(id);
        assertEq(uint8(st.decision), uint8(ISQController.Decision.Accepted));
        assertTrue(st.settled, "settled in the same tx");
        assertEq(st.approvedDeliverable, DELIVERABLE);
        assertEq(st.approvedEvidenceHash, EVIDENCE);
        assertEq(st.credited, 2 * FEE);
        assertEq(st.kernelFeeReceived, BUDGET * EVAL_BP / 10000, "evaluator cut recorded");
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(sq.feeBalance(rA), FEE);
        assertEq(sq.feeBalance(rB), FEE);
        assertEq(sq.creditedMaskOf(id, 0), 3);
        assertEq(sq.verdictDigestOf(id, 0), digest);
        assertEq(usdc.balanceOf(provider), BUDGET - BUDGET * (EVAL_BP + PLAT_BP) / 10000, "provider net paid");
    }

    function _acceptViaForwarder(address fwd) internal {
        _kernelFees();
        uint256 id = setupSubmitted(2);
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes32 digest = sq.hashVerdict(v);
        bytes memory sig = signVerdict(v);

        vm.expectEmit(true, true, false, true, address(sq));
        emit ISQController.FeeCredited(id, 0, 0, rA, FEE);
        vm.expectEmit(true, true, false, true, address(sq));
        emit ISQController.FeeCredited(id, 0, 1, rB, FEE);
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.DeliverableApproved(id, DELIVERABLE, EVIDENCE);
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.KernelEvaluatorFeeReceived(id, BUDGET * EVAL_BP / 10000);
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.CompletionFeesApplied(id, PLAT_BP, EVAL_BP);
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.JobSettled(id, true, EVIDENCE);
        vm.expectEmit(true, true, false, true, address(sq));
        emit ISQController.VerdictRecorded(id, 0, ACCEPT, ACCEPT, DELIVERABLE, EVIDENCE, REPORTS, DEFICIENCY, 3, digest);
        deliver(fwd, v, sig);

        _assertAcceptedAtomically(id, digest);
    }

    function test_AcceptViaSimulationForwarderCompletesAtomically() public {
        _acceptViaForwarder(simForwarder);
    }

    function test_AcceptViaProductionForwarderCompletesAtomically() public {
        _acceptViaForwarder(prodForwarder);
    }

    function test_ReviseViaEachForwarderAdvancesRoundKeepsFunded() public {
        address[2] memory f = _fwds();
        for (uint256 i; i < 2; ++i) {
            uint256 id = setupFunded(2);
            ISQController.Verdict memory v = mkRevise(id, 0);
            vm.expectEmit(true, false, false, true, address(sq));
            emit ISQController.RevisionRequested(id, 1, EVIDENCE, DEFICIENCY);
            deliverSigned(f[i], v);
            ISQController.JobState memory st = sq.getState(id);
            assertEq(st.round, 1);
            assertEq(uint8(st.decision), uint8(ISQController.Decision.None));
            assertEq(st.credited, 2 * FEE);
            assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Funded));
            assertEq(sq.verdictDigestOf(id, 0), sq.hashVerdict(v));
        }
    }

    function test_RejectViaEachForwarderRejectsKernelJob() public {
        address[2] memory f = _fwds();
        for (uint256 i; i < 2; ++i) {
            uint256 id = i == 0 ? setupFunded(1) : setupSubmitted(1);
            ISQController.Verdict memory v = mkReject(id, 0);
            vm.expectEmit(true, false, false, true, address(sq));
            emit ISQController.JobSettled(id, false, EVIDENCE);
            deliverSigned(f[i], v);
            ISQController.JobState memory st = sq.getState(id);
            assertEq(uint8(st.decision), uint8(ISQController.Decision.Rejected));
            assertFalse(st.settled);
            assertEq(st.credited, 2 * FEE);
            assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
            assertEq(usdc.balanceOf(buyer), i == 0 ? BUDGET : 2 * BUDGET, "kernel escrow refunded (buyer cumulative)");
        }
    }

    function test_ReviseAtLimitViaForwarderExecutesAsReject() public {
        uint256 id = setupFunded(0);
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.RevisionLimitReached(id, 0);
        deliverSigned(prodForwarder, mkRevise(id, 0));
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Rejected));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
    }

    function test_PartialMaskViaForwarderCreditsOnlyIncluded() public {
        uint256 id = setupFunded(1);
        deliverSigned(simForwarder, mkVerdict(id, 0, REVISE, bytes32(0), 2));
        assertEq(sq.feeBalance(rA), 0);
        assertEq(sq.feeBalance(rB), FEE);
        assertEq(sq.creditedMaskOf(id, 0), 2);
    }

    // ------------------------------------------------------------------ log parity with submitVerdict

    function _scenario(uint256 kind) internal returns (uint256 id, ISQController.Verdict memory v) {
        _kernelFees();
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
            v = mkRevise(id, 0); // revise at limit
        }
    }

    function _assertSameLogs(Vm.Log[] memory a, Vm.Log[] memory b) internal pure {
        assertEq(a.length, b.length, "log count");
        for (uint256 i; i < a.length; ++i) {
            assertEq(a[i].emitter, b[i].emitter, "emitter");
            assertEq(a[i].topics.length, b[i].topics.length, "topic count");
            for (uint256 j; j < a[i].topics.length; ++j) assertEq(a[i].topics[j], b[i].topics[j], "topic");
            assertEq(a[i].data, b[i].data, "data");
        }
    }

    function _logParity(uint256 kind, address fwd) internal {
        (uint256 id, ISQController.Verdict memory v) = _scenario(kind);
        bytes memory sig = signVerdict(v);
        uint256 snap = vm.snapshotState();

        vm.recordLogs();
        vm.prank(relayer);
        sq.submitVerdict(v, sig);
        Vm.Log[] memory direct = vm.getRecordedLogs();
        bytes32 fpDirect = fingerprint(id);
        assertGt(direct.length, 0, "direct path emitted");

        assertTrue(vm.revertToState(snap));
        vm.recordLogs();
        deliver(fwd, v, sig);
        Vm.Log[] memory viaCre = vm.getRecordedLogs();

        _assertSameLogs(direct, viaCre);
        assertEq(fingerprint(id), fpDirect, "identical end state");
    }

    function test_LogParity_AcceptSim() public {
        _logParity(0, simForwarder);
    }

    function test_LogParity_AcceptProd() public {
        _logParity(0, prodForwarder);
    }

    function test_LogParity_ReviseSim() public {
        _logParity(1, simForwarder);
    }

    function test_LogParity_ReviseProd() public {
        _logParity(1, prodForwarder);
    }

    function test_LogParity_RejectSim() public {
        _logParity(2, simForwarder);
    }

    function test_LogParity_RejectProd() public {
        _logParity(2, prodForwarder);
    }

    function test_LogParity_ReviseAtLimitSim() public {
        _logParity(3, simForwarder);
    }

    function test_LogParity_ReviseAtLimitProd() public {
        _logParity(3, prodForwarder);
    }

    function testFuzz_LogParity_AnyKindAnyForwarder(uint256 kind, bool prod) public {
        _logParity(kind % 4, prod ? prodForwarder : simForwarder);
    }

    // ------------------------------------------------------------------ forwarder gating

    function _unauth(address caller) internal {
        uint256 id = setupSubmitted(2);
        ISQController.Verdict memory v = mkAccept(id, 0); // fully valid and signed: only the caller is wrong
        bytes memory sig = signVerdict(v);
        bytes32 fp = fingerprint(id);
        vm.recordLogs();
        deliverExpectRevert(
            caller, v, sig, abi.encodeWithSelector(ISQController.UnauthorizedForwarder.selector, caller)
        );
        assertEq(vm.getRecordedLogs().length, 0, "no events");
        assertEq(fingerprint(id), fp, "nothing stored");
        assertEq(sq.verdictDigestOf(id, 0), bytes32(0));
        assertEq(sq.getState(id).credited, 0);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
    }

    function test_RevertWhen_BuyerCallsOnReport() public {
        _unauth(buyer);
    }

    function test_RevertWhen_ProviderCallsOnReport() public {
        _unauth(provider);
    }

    function test_RevertWhen_VerdictAuthorityCallsOnReport() public {
        _unauth(authority);
    }

    function test_RevertWhen_ControllerItselfCallsOnReport() public {
        _unauth(address(sq));
    }

    function test_RevertWhen_ZeroAddressCallsOnReport() public {
        _unauth(address(0));
    }

    function test_RevertWhen_RandomAddressCallsOnReport() public {
        _unauth(makeAddr("random"));
        _unauth(relayer);
        _unauth(stranger);
        _unauth(rA);
        _unauth(address(ac));
        _unauth(address(usdc));
        _unauth(address(this));
    }

    function testFuzz_RevertWhen_AnyOtherCallerCallsOnReport(address caller) public {
        vm.assume(caller != simForwarder && caller != prodForwarder);
        _unauth(caller);
    }

    function test_RevertWhen_TxOriginIsForwarderButSenderIsNot() public {
        uint256 id = setupSubmitted(2);
        ISQController.Verdict memory v = mkAccept(id, 0);
        bytes memory report = encodeReport(v, signVerdict(v));
        bytes memory meta = creMetadata();
        vm.expectRevert(abi.encodeWithSelector(ISQController.UnauthorizedForwarder.selector, stranger));
        vm.prank(stranger, simForwarder);
        sq.onReport(meta, report);
    }

    function test_RevertWhen_ContractRelaysOnReportOnBehalfOfForwarder() public {
        uint256 id = setupSubmitted(2);
        ISQController.Verdict memory v = mkAccept(id, 0);
        MaliciousRecipient relay = new MaliciousRecipient();
        bytes memory data = abi.encodeCall(sq.onReport, (creMetadata(), encodeReport(v, signVerdict(v))));
        bytes32 fp = fingerprint(id);
        vm.prank(simForwarder, simForwarder);
        (bool ok, bytes memory ret) = relay.callTarget(address(sq), data);
        assertFalse(ok);
        assertEq(bytes4(ret), ISQController.UnauthorizedForwarder.selector);
        assertEq(fingerprint(id), fp);
    }

    function test_BothForwardersCanDeliverAndOthersStillCannot() public {
        uint256 id = setupFunded(3);
        deliverSigned(simForwarder, mkRevise(id, 0));
        deliverSigned(prodForwarder, mkRevise(id, 1));
        assertEq(sq.getState(id).round, 2);
        ISQController.Verdict memory v = mkRevise(id, 2);
        bytes memory sig = signVerdict(v);
        deliverExpectRevert(
            stranger, v, sig, abi.encodeWithSelector(ISQController.UnauthorizedForwarder.selector, stranger)
        );
    }

    function test_SubmitVerdictStillPermissionless() public {
        uint256 id = setupFunded(1);
        ISQController.Verdict memory v = mkRevise(id, 0);
        bytes memory sig = signVerdict(v);
        vm.prank(simForwarder); // being a forwarder confers no extra rights on submitVerdict either
        sq.submitVerdict(v, sig);
        assertEq(sq.getState(id).round, 1);
        send(mkRevise(id, 1)); // relayer path
        assertEq(uint8(sq.getState(id).decision), uint8(ISQController.Decision.Rejected));
    }
}
