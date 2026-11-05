// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {SQBase} from "./SQBase.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";
import {MockAgenticCommerce} from "./mocks/MockAgenticCommerce.sol";
import {AtomicFundRegister} from "./mocks/AtomicFundRegister.sol";

contract SQControllerRegistrationTest is SQBase {
    uint256 internal jobId;

    function setUp() public override {
        super.setUp();
        jobId = newJob(EXPIRY);
        fundJob(jobId, BUDGET);
        vm.roll(block.number + 1);
    }

    function _expectRegisterRevert(ISQController.RegisterParams memory p, bytes4 sel) internal {
        fundBuyerFor(p);
        vm.expectRevert(sel);
        vm.prank(buyer);
        sq.registerJob(p);
    }

    // ------------------------------------------------------------------ happy path

    function test_RegisterHappyPath_PullsExactDepositAndStoresState() public {
        ISQController.RegisterParams memory p = params(jobId, 2, FEE);
        uint256 deposit = FEE * 2 * 3;
        fundBuyerFor(p);

        bytes32 seed = keccak256(abi.encode(jobId, blockhash(p.seedBlock)));
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        address[] memory recips = new address[](2);
        recips[0] = rA;
        recips[1] = rB;

        vm.recordLogs();
        vm.expectEmit(true, false, false, true, address(sq));
        emit ISQController.CommitteeSelected(jobId, p.seedBlock, seed, ids, recips);
        vm.prank(buyer);
        sq.registerJob(p);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        _checkState(p, seed, deposit);
        _checkLog(logs, p, seed, deposit);
    }

    function _checkState(ISQController.RegisterParams memory p, bytes32 seed, uint256 deposit) internal view {
        assertEq(usdc.balanceOf(buyer), 0, "buyer fully debited");
        assertEq(usdc.balanceOf(address(sq)), deposit, "controller holds deposit");

        ISQController.JobConfig memory c = sq.getConfig(jobId);
        assertEq(c.buyer, buyer);
        assertEq(c.verdictAuthority, authority);
        assertEq(c.revisionLimit, 2);
        assertEq(c.committeeSize, 2);
        assertEq(c.decisionDeadline, DEADLINE);
        assertEq(c.feePerReport, FEE);
        assertEq(c.seedBlock, p.seedBlock);
        assertEq(c.selectionSeed, seed);
        assertEq(c.policyHash, POLICY);
        assertEq(c.participantSnapshotHash, SNAPSHOT);
        assertEq(c.deposited, deposit);
        assertEq(c.maxPlatformFeeBP, CAP);
        assertEq(c.maxEvaluatorFeeBP, CAP);

        ISQController.CommitteeMember[] memory m = sq.getCommittee(jobId);
        assertEq(m.length, 2);
        assertEq(m[0].evaluatorId, 1);
        assertEq(m[0].feeRecipient, rA);
        assertEq(m[1].evaluatorId, 2);
        assertEq(m[1].feeRecipient, rB);

        assertTrue(sq.isRegistered(jobId));
        ISQController.JobState memory s = sq.getState(jobId);
        assertEq(s.round, 0);
        assertEq(uint8(s.decision), uint8(ISQController.Decision.None));
        assertEq(s.credited, 0);
    }

    function _checkLog(Vm.Log[] memory logs, ISQController.RegisterParams memory p, bytes32 seed, uint256 deposit)
        internal
        view
    {
        Vm.Log memory l = findLog(logs, address(sq), ISQController.JobRegistered.selector);
        assertEq(uint256(l.topics[1]), jobId);
        assertEq(address(uint160(uint256(l.topics[2]))), buyer);
        assertEq(address(uint160(uint256(l.topics[3]))), authority);
        bytes memory head = abi.encode(POLICY, SNAPSHOT, uint8(2), uint64(DEADLINE));
        bytes memory rest = abi.encode(FEE, deposit, p.seedBlock, seed);
        bytes memory caps = abi.encode(CAP, CAP);
        assertEq(l.data, bytes.concat(head, rest, caps), "JobRegistered data");
        assertEq(countLogs(logs, address(sq), ISQController.CommitteeSelected.selector), 1);
    }

    function test_SelectionSeedBindsJobIdAndBlockhash() public {
        ISQController.RegisterParams memory p = params(jobId, 0, FEE);
        registerWith(p);
        assertEq(sq.getConfig(jobId).selectionSeed, keccak256(abi.encode(jobId, blockhash(p.seedBlock))));
        assertEq(sq.getConfig(jobId).seedBlock, block.number - 1);
    }

    function _fundedJob(uint256 expiry) internal returns (uint256 id) {
        id = newJob(expiry);
        fundJob(id, BUDGET);
    }

    function test_RevertWhen_JobOpen_WrongJobStatus() public {
        uint256 id = newJob(EXPIRY);
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Open));
        _expectRegisterRevert(params(id, 1, FEE), ISQController.WrongJobStatus.selector);
        assertFalse(sq.isRegistered(id));
        assertEq(usdc.balanceOf(address(sq)), 0, "no deposit pulled");
    }

    /// @dev A Submitted job (even one that was properly funded first) can no longer be registered.
    function test_RevertWhen_JobSubmitted_WrongJobStatus() public {
        submitJob(jobId, DELIVERABLE);
        assertEq(uint8(kernelStatus(jobId)), uint8(IAgenticCommerce.JobStatus.Submitted));
        assertEq(ac.getJob(jobId).budget, BUDGET);
        _expectRegisterRevert(params(jobId, 1, FEE), ISQController.WrongJobStatus.selector);
        assertFalse(sq.isRegistered(jobId));
    }

    /// @dev The never-funded Submitted shape: the (mock, like the real) kernel lets the provider
    /// submit straight from Open while budget == 0. It is rejected at registration, so a never-funded
    /// job can never pay fees or complete through SQController.
    function test_RevertWhen_NeverFundedSubmitted_WrongJobStatus() public {
        uint256 id = newJob(EXPIRY);
        submitJob(id, DELIVERABLE);
        IAgenticCommerce.Job memory j = ac.getJob(id);
        assertEq(uint8(j.status), uint8(IAgenticCommerce.JobStatus.Submitted));
        assertEq(j.budget, 0);
        _expectRegisterRevert(params(id, 1, FEE), ISQController.WrongJobStatus.selector);
        assertFalse(sq.isRegistered(id));
        assertEq(usdc.balanceOf(address(sq)), 0);
    }

    /// @dev Funded with a zero budget (mock's fund() accepts budget 0, as does the real kernel).
    function test_RevertWhen_FundedZeroBudget_ZeroBudget() public {
        uint256 id = newJob(EXPIRY);
        vm.prank(buyer);
        ac.fund(id, ""); // budget never set -> 0, status Open -> Funded with no transfer
        IAgenticCommerce.Job memory j = ac.getJob(id);
        assertEq(uint8(j.status), uint8(IAgenticCommerce.JobStatus.Funded));
        assertEq(j.budget, 0);
        _expectRegisterRevert(params(id, 1, FEE), ISQController.ZeroBudget.selector);
        assertFalse(sq.isRegistered(id));
        assertEq(usdc.balanceOf(address(sq)), 0);
    }

    /// @dev Check order: status (Funded) is checked before budget, and both before AlreadyRegistered.
    function test_RevertOrder_StatusBeforeBudgetBeforeAlreadyRegistered() public {
        // Open (budget 0) -> WrongJobStatus, not ZeroBudget
        uint256 open = newJob(EXPIRY);
        _expectRegisterRevert(params(open, 1, FEE), ISQController.WrongJobStatus.selector);
        // registered Funded job that later becomes Submitted -> re-register reports WrongJobStatus first
        registerWith(params(jobId, 1, FEE));
        submitJob(jobId, DELIVERABLE);
        _expectRegisterRevert(params(jobId, 1, FEE), ISQController.WrongJobStatus.selector);
        // client / evaluator checks precede status
        vm.prank(stranger);
        vm.expectRevert(ISQController.NotJobClient.selector);
        sq.registerJob(params(open, 1, FEE));
    }

    /// @dev Fund and register in one transaction through a client contract: the provider has no
    /// window between the two steps to submit (the non-atomic path is griefable, see next test).
    function test_AtomicFundThenRegister_ViaHelperContract() public {
        AtomicFundRegister h = new AtomicFundRegister(address(ac), address(sq), address(usdc));
        uint256 id = h.createJob(provider, EXPIRY);
        vm.prank(provider);
        ac.setBudget(id, BUDGET, "");
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Open));

        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = params(id, 1, FEE);
        usdc.mint(address(h), BUDGET + depositOf(p));
        h.fundAndRegister(p); // one tx: Open -> Funded -> registered

        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Funded));
        assertTrue(sq.isRegistered(id));
        assertEq(sq.getConfig(id).buyer, address(h));
        assertEq(usdc.balanceOf(address(sq)), depositOf(p));

        // The provider can only submit after registration; the full flow then completes.
        submitJob(id, DELIVERABLE);
        send(mkAccept(id, 0));
        assertEq(uint8(kernelStatus(id)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(usdc.balanceOf(provider), BUDGET);
    }

    /// @dev Contrast to the atomic path: fund and register as two transactions lets the provider
    /// submit in between, after which registration is impossible (a griefing the atomic path avoids).
    function test_NonAtomicFundThenRegister_ProviderCanSlipSubmitInBetween() public {
        submitJob(jobId, DELIVERABLE); // provider acts between buyer's fund (setUp) and register
        _expectRegisterRevert(params(jobId, 1, FEE), ISQController.WrongJobStatus.selector);
    }

    /// @dev Kernel-side check that submit is impossible from Open once a budget is set, so the only
    /// pre-fund submit shape is the zero-budget never-funded one.
    function test_KernelRejectsSubmitFromOpenWithBudget() public {
        uint256 id = newJob(EXPIRY);
        vm.prank(provider);
        ac.setBudget(id, BUDGET, "");
        vm.expectRevert(MockAgenticCommerce.WrongStatus.selector);
        submitJob(id, DELIVERABLE);
    }

    function test_RegisterAllowedWhileFunded() public {
        assertEq(uint8(kernelStatus(jobId)), uint8(IAgenticCommerce.JobStatus.Funded));
        registerWith(params(jobId, 1, FEE));
        assertTrue(sq.isRegistered(jobId));
    }

    function test_RegisterSucceedsWithNonZeroKernelEvaluatorFee() public {
        ac.setEvaluatorFee(500);
        registerWith(params(jobId, 1, FEE));
        assertTrue(sq.isRegistered(jobId));
    }

    function test_RegisterSucceedsWithNonZeroKernelPlatformFee() public {
        ac.setPlatformFee(300, address(0xFEE));
        registerWith(params(jobId, 1, FEE));
        assertTrue(sq.isRegistered(jobId));
    }

    function test_RegisterSucceedsWhenLiveFeesAlreadyExceedCaps() public {
        ac.setPlatformFee(300, address(0xFEE));
        ac.setEvaluatorFee(500);
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.maxPlatformFeeBP = 0;
        p.maxEvaluatorFeeBP = 0;
        registerWith(p);
        assertTrue(sq.isRegistered(jobId));
        assertEq(sq.getConfig(jobId).maxPlatformFeeBP, 0);
        assertEq(sq.getConfig(jobId).maxEvaluatorFeeBP, 0);
    }

    // ------------------------------------------------------------------ fee caps

    function test_JobRegisteredEventCarriesCaps() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.maxPlatformFeeBP = 1234;
        p.maxEvaluatorFeeBP = 4321;
        fundBuyerFor(p);
        vm.recordLogs();
        vm.prank(buyer);
        sq.registerJob(p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory l = findLog(logs, address(sq), ISQController.JobRegistered.selector);
        (,,,,,,,, uint256 pc, uint256 ec) = abi.decode(
            l.data, (bytes32, bytes32, uint8, uint64, uint256, uint256, uint256, bytes32, uint256, uint256)
        );
        assertEq(pc, 1234, "platform cap in event");
        assertEq(ec, 4321, "evaluator cap in event");
        ISQController.JobConfig memory c = sq.getConfig(jobId);
        assertEq(c.maxPlatformFeeBP, 1234);
        assertEq(c.maxEvaluatorFeeBP, 4321);
    }

    function test_CapsAtBoundariesAccepted() public {
        uint256 a = _fundedJob(EXPIRY);
        ISQController.RegisterParams memory p = params(a, 0, FEE);
        p.maxPlatformFeeBP = 10000;
        p.maxEvaluatorFeeBP = 0;
        registerWith(p);
        uint256 b = _fundedJob(EXPIRY);
        p = params(b, 0, FEE);
        p.maxPlatformFeeBP = 0;
        p.maxEvaluatorFeeBP = 10000;
        registerWith(p);
        uint256 c = _fundedJob(EXPIRY);
        p = params(c, 0, FEE);
        p.maxPlatformFeeBP = 6000;
        p.maxEvaluatorFeeBP = 4000;
        registerWith(p);
        uint256 d = _fundedJob(EXPIRY);
        p = params(d, 0, FEE);
        p.maxPlatformFeeBP = 0;
        p.maxEvaluatorFeeBP = 0;
        registerWith(p);
        assertTrue(sq.isRegistered(a) && sq.isRegistered(b) && sq.isRegistered(c) && sq.isRegistered(d));
    }

    function test_RevertWhen_PlatformCapAbove10000() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.maxPlatformFeeBP = 10001;
        p.maxEvaluatorFeeBP = 0;
        _expectRegisterRevert(p, ISQController.BadParams.selector);
    }

    function test_RevertWhen_EvaluatorCapAbove10000() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.maxPlatformFeeBP = 0;
        p.maxEvaluatorFeeBP = 10001;
        _expectRegisterRevert(p, ISQController.BadParams.selector);
    }

    function test_RevertWhen_CapSumAbove10000() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.maxPlatformFeeBP = 5001;
        p.maxEvaluatorFeeBP = 5000;
        _expectRegisterRevert(p, ISQController.BadParams.selector);
    }

    function test_RevertWhen_CapsHuge_NoOverflowPanic() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.maxPlatformFeeBP = type(uint256).max;
        p.maxEvaluatorFeeBP = type(uint256).max;
        _expectRegisterRevert(p, ISQController.BadParams.selector);
        p.maxPlatformFeeBP = 1;
        _expectRegisterRevert(p, ISQController.BadParams.selector);
    }

    function testFuzz_CapValidation(uint256 pc, uint256 ec) public {
        pc = bound(pc, 0, 20000);
        ec = bound(ec, 0, 20000);
        ISQController.RegisterParams memory p = params(jobId, 0, FEE);
        p.maxPlatformFeeBP = pc;
        p.maxEvaluatorFeeBP = ec;
        if (pc > 10000 || ec > 10000 || pc + ec > 10000) {
            _expectRegisterRevert(p, ISQController.BadParams.selector);
            assertFalse(sq.isRegistered(jobId));
        } else {
            registerWith(p);
            assertEq(sq.getConfig(jobId).maxPlatformFeeBP, pc);
            assertEq(sq.getConfig(jobId).maxEvaluatorFeeBP, ec);
        }
    }

    // ------------------------------------------------------------------ job-shape reverts

    function test_RevertWhen_CallerNotJobClient() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        usdc.mint(stranger, depositOf(p));
        vm.prank(stranger);
        usdc.approve(address(sq), type(uint256).max);
        vm.expectRevert(ISQController.NotJobClient.selector);
        vm.prank(stranger);
        sq.registerJob(p);
    }

    function test_RevertWhen_EvaluatorNotController() public {
        vm.prank(buyer);
        uint256 id = ac.createJob(provider, makeAddr("otherEvaluator"), EXPIRY, "x", address(0));
        _expectRegisterRevert(params(id, 1, FEE), ISQController.WrongEvaluator.selector);
    }

    function test_RevertWhen_JobHasHook() public {
        address hook = makeAddr("hook");
        ac.setHookWhitelist(hook, true);
        vm.prank(buyer);
        uint256 id = ac.createJob(provider, address(sq), EXPIRY, "x", hook);
        _expectRegisterRevert(params(id, 1, FEE), ISQController.HookNotAllowed.selector);
    }

    function test_RevertWhen_JobRejected() public {
        vm.prank(address(sq));
        ac.reject(jobId, bytes32(0), "");
        assertEq(uint8(kernelStatus(jobId)), uint8(IAgenticCommerce.JobStatus.Rejected));
        _expectRegisterRevert(params(jobId, 1, FEE), ISQController.WrongJobStatus.selector);
    }

    function test_RevertWhen_JobRejectedFromOpen() public {
        uint256 id = newJob(EXPIRY);
        vm.prank(buyer);
        ac.reject(id, bytes32(0), "");
        _expectRegisterRevert(params(id, 1, FEE), ISQController.WrongJobStatus.selector);
    }

    function test_RevertWhen_JobCompleted() public {
        submitJob(jobId, DELIVERABLE);
        vm.prank(address(sq));
        ac.complete(jobId, bytes32(0), "");
        assertEq(uint8(kernelStatus(jobId)), uint8(IAgenticCommerce.JobStatus.Completed));
        _expectRegisterRevert(params(jobId, 1, FEE), ISQController.WrongJobStatus.selector);
    }

    function test_RevertWhen_JobExpired() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        vm.warp(EXPIRY);
        ac.claimRefund(jobId);
        assertEq(uint8(kernelStatus(jobId)), uint8(IAgenticCommerce.JobStatus.Expired));
        _expectRegisterRevert(p, ISQController.WrongJobStatus.selector);
    }

    function test_RevertWhen_UnknownJob() public {
        _expectRegisterRevert(params(999, 1, FEE), ISQController.JobNotFound.selector);
    }

    function test_RevertWhen_JobIdZero_NotJobClient() public {
        // Kernel returns an all-zero Job for id 0 (id == 0 matches), so the client check rejects it.
        _expectRegisterRevert(params(0, 1, FEE), ISQController.NotJobClient.selector);
    }

    function test_RevertWhen_AlreadyRegistered() public {
        registerWith(params(jobId, 1, FEE));
        _expectRegisterRevert(params(jobId, 1, FEE), ISQController.AlreadyRegistered.selector);
    }

    // ------------------------------------------------------------------ param reverts

    function test_RevertWhen_ZeroAuthority() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.verdictAuthority = address(0);
        _expectRegisterRevert(p, ISQController.ZeroAddress.selector);
    }

    function test_RevertWhen_ZeroFee() public {
        ISQController.RegisterParams memory p = params(jobId, 1, 0);
        _expectRegisterRevert(p, ISQController.BadParams.selector);
    }

    function test_RevisionLimitMaxAccepted() public {
        registerWith(params(jobId, 10, FEE));
        assertEq(sq.getConfig(jobId).revisionLimit, 10);
        assertEq(sq.getConfig(jobId).deposited, FEE * 2 * 11);
    }

    function test_RevertWhen_RevisionLimitAboveMax() public {
        ISQController.RegisterParams memory p = params(jobId, 11, FEE);
        _expectRegisterRevert(p, ISQController.BadParams.selector);
    }

    function test_RevertWhen_EmptyCommittee() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.committee = committee(0);
        _expectRegisterRevert(p, ISQController.BadCommittee.selector);
    }

    function test_CommitteeOfEightAccepted() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.committee = committee(8);
        registerWith(p);
        assertEq(sq.getConfig(jobId).committeeSize, 8);
        assertEq(sq.getCommittee(jobId).length, 8);
    }

    function test_RevertWhen_CommitteeOfNine() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.committee = committee(9);
        _expectRegisterRevert(p, ISQController.BadCommittee.selector);
    }

    function test_RevertWhen_ZeroFeeRecipient() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.committee[1].feeRecipient = address(0);
        _expectRegisterRevert(p, ISQController.ZeroAddress.selector);
    }

    function test_RevertWhen_DuplicateEvaluatorId() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.committee[1].evaluatorId = p.committee[0].evaluatorId;
        _expectRegisterRevert(p, ISQController.BadCommittee.selector);
    }

    function test_DuplicateFeeRecipientWithDistinctIdsAllowed() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.committee[1].feeRecipient = rA;
        registerWith(p);
        assertTrue(sq.isRegistered(jobId));
    }

    // ------------------------------------------------------------------ deadline

    function test_RevertWhen_DeadlineEqualsNow() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.decisionDeadline = uint64(block.timestamp);
        _expectRegisterRevert(p, ISQController.BadDeadline.selector);
    }

    function test_RevertWhen_DeadlineInPast() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.decisionDeadline = uint64(block.timestamp - 1);
        _expectRegisterRevert(p, ISQController.BadDeadline.selector);
    }

    function test_RevertWhen_DeadlineEqualsExpiredAt() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.decisionDeadline = uint64(EXPIRY);
        _expectRegisterRevert(p, ISQController.BadDeadline.selector);
    }

    function test_RevertWhen_DeadlineAfterExpiredAt() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.decisionDeadline = uint64(EXPIRY + 1);
        _expectRegisterRevert(p, ISQController.BadDeadline.selector);
    }

    function test_MinSettleBufferIsOneHour() public view {
        assertEq(sq.MIN_SETTLE_BUFFER(), 1 hours);
    }

    function test_DeadlineExactlyOneHourBeforeExpiryAccepted() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.decisionDeadline = uint64(EXPIRY - 1 hours);
        registerWith(p);
        assertEq(sq.getConfig(jobId).decisionDeadline, EXPIRY - 1 hours);
    }

    function test_RevertWhen_DeadlineOneSecondInsideBuffer() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.decisionDeadline = uint64(EXPIRY - 1 hours + 1);
        _expectRegisterRevert(p, ISQController.BadDeadline.selector);
    }

    function test_RevertWhen_DeadlineHalfHourBeforeExpiry() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.decisionDeadline = uint64(EXPIRY - 30 minutes);
        _expectRegisterRevert(p, ISQController.BadDeadline.selector);
    }

    function test_RevertWhen_DeadlineOneSecondBeforeExpiry() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.decisionDeadline = uint64(EXPIRY - 1);
        _expectRegisterRevert(p, ISQController.BadDeadline.selector);
    }

    function test_ShortLivedJobBufferBoundary() public {
        // expiry = now + 1h + 1 admits deadline = now + 1 exactly; expiry = now + 1h does not.
        uint256 tooShort = _fundedJob(block.timestamp + 1 hours);
        ISQController.RegisterParams memory p = params(tooShort, 0, FEE);
        p.decisionDeadline = uint64(block.timestamp + 1);
        _expectRegisterRevert(p, ISQController.BadDeadline.selector);

        uint256 ok = _fundedJob(block.timestamp + 1 hours + 1);
        p = params(ok, 0, FEE);
        p.decisionDeadline = uint64(block.timestamp + 1);
        registerWith(p);
        assertTrue(sq.isRegistered(ok));
    }

    function test_DeadlineNextSecondAccepted() public {
        uint256 a = _fundedJob(EXPIRY);
        ISQController.RegisterParams memory p = params(a, 0, FEE);
        p.decisionDeadline = uint64(block.timestamp + 1);
        registerWith(p);
        assertTrue(sq.isRegistered(a));
    }

    // ------------------------------------------------------------------ seed block

    function test_RevertWhen_SeedBlockIsCurrentBlock() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.seedBlock = block.number;
        _expectRegisterRevert(p, ISQController.BadSeedBlock.selector);
    }

    function test_RevertWhen_SeedBlockInFuture() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.seedBlock = block.number + 1;
        _expectRegisterRevert(p, ISQController.BadSeedBlock.selector);
    }

    function test_SeedBlock256BlocksOldSucceeds() public {
        vm.roll(block.number + 300);
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.seedBlock = block.number - 256;
        registerWith(p);
        assertEq(sq.getConfig(jobId).seedBlock, block.number - 256);
        assertEq(sq.getConfig(jobId).selectionSeed, keccak256(abi.encode(jobId, blockhash(p.seedBlock))));
    }

    function test_RevertWhen_SeedBlock257BlocksOld() public {
        vm.roll(block.number + 300);
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        p.seedBlock = block.number - 257;
        _expectRegisterRevert(p, ISQController.BadSeedBlock.selector);
    }

    // ------------------------------------------------------------------ deposit & atomicity

    function testFuzz_ExactDepositPulled(uint256 fee, uint8 limit, uint8 size) public {
        fee = bound(fee, 1, 1_000_000e6);
        limit = uint8(bound(limit, 0, 10));
        size = uint8(bound(size, 1, 8));
        ISQController.RegisterParams memory p = params(jobId, limit, fee);
        p.committee = committee(size);
        uint256 deposit = fee * size * (uint256(limit) + 1);
        assertEq(depositOf(p), deposit);

        registerWith(p);

        assertEq(sq.getConfig(jobId).deposited, deposit);
        assertEq(usdc.balanceOf(address(sq)), deposit);
        assertEq(usdc.balanceOf(buyer), 0);
        assertEq(sq.getCommittee(jobId).length, size);
    }

    function test_RevertWhen_NoAllowance_NothingRegistered() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        usdc.mint(buyer, depositOf(p)); // balance but no allowance
        vm.expectRevert();
        vm.prank(buyer);
        sq.registerJob(p);

        assertFalse(sq.isRegistered(jobId));
        assertEq(sq.getCommittee(jobId).length, 0);
        assertEq(sq.getConfig(jobId).deposited, 0);
        assertEq(usdc.balanceOf(address(sq)), 0);
        assertEq(usdc.balanceOf(buyer), depositOf(p));
    }

    function test_RevertWhen_InsufficientBalance_NothingRegistered() public {
        ISQController.RegisterParams memory p = params(jobId, 1, FEE);
        vm.prank(buyer);
        usdc.approve(address(sq), type(uint256).max);
        vm.expectRevert();
        vm.prank(buyer);
        sq.registerJob(p);
        assertFalse(sq.isRegistered(jobId));
    }
}
