// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SQController} from "../SQController.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";
import {SQForkBase, IKernel, NoopHook} from "./SQForkBase.sol";

interface IUsdcProbe {
    function decimals() external view returns (uint8);
    function balanceOf(address a) external view returns (uint256);
    function transfer(address to, uint256 v) external returns (bool);
    function approve(address s, uint256 v) external returns (bool);
    function transferFrom(address f, address t, uint256 v) external returns (bool);
    function allowance(address o, address s) external view returns (uint256);
    function isBlacklisted(address a) external view returns (bool);
}

/// @notice Fork tests of SQController against the REAL Arc testnet AgenticCommerce kernel, pinned to
/// block 70872676. Every test is gated on ARC_FORK=1 and must run under `arc-forge test --network arc`: Arc's USDC
/// ERC-20 interface delegates to native-coin precompiles (0x1800...0000 transfer, 0x1800...0001 blocklist) that only
/// Arc Foundry emulates. Lifecycle tests with real USDC live in SQController.ForkLifecycle/ForkFees/ForkBlocklist.
contract SQControllerForkTest is SQForkBase {
    // ------------------------------------------------------------------ 0: what the stock fork can do

    function test_00_UsdcForkCapabilities() public onlyFork {
        IUsdcProbe usdc = IUsdcProbe(USDC);
        address carol = makeAddr("carol");
        address dave = makeAddr("dave");
        console2.log("code len @0x1800..00 (transfer precompile):", address(0x1800000000000000000000000000000000000000).code.length);
        console2.log("code len @0x1800..01 (isBlocklisted precompile):", address(0x1800000000000000000000000000000000000001).code.length);

        // 1. balanceOf: ERC-20 view == native balance / 1e12 (same asset).
        vm.deal(carol, 7e18);
        assertEq(usdc.balanceOf(carol), 7e6, "erc20 balanceOf == native / 1e12");

        // 2. approve + transfer + transferFrom move real USDC through the native-transfer precompile.
        vm.prank(carol);
        assertTrue(usdc.approve(dave, 5e6));
        assertEq(usdc.allowance(carol, dave), 5e6);
        vm.prank(carol);
        assertTrue(usdc.transfer(dave, 1e6));
        assertEq(usdc.balanceOf(carol), 6e6, "transfer debits sender");
        assertEq(usdc.balanceOf(dave), 1e6, "transfer credits receiver");
        vm.prank(dave);
        assertTrue(usdc.transferFrom(carol, dave, 2e6));
        assertEq(usdc.balanceOf(carol), 4e6, "transferFrom debits owner");
        assertEq(usdc.balanceOf(dave), 3e6, "transferFrom credits receiver");
        assertEq(usdc.allowance(carol, dave), 3e6, "allowance consumed");

        // 3. blocklist view + enforcement on transfers to / from the blocklisted address.
        assertTrue(usdc.isBlacklisted(BLOCKLISTED), "BLOCKLISTED is blocklisted on the fork");
        assertFalse(usdc.isBlacklisted(carol), "carol is not blocklisted");
        vm.prank(carol);
        (bool okTo, bytes memory retTo) = USDC.call(abi.encodeCall(IUsdcProbe.transfer, (BLOCKLISTED, 1e6)));
        console2.log("transfer TO blocklisted reverted:", !okTo);
        console2.logBytes(retTo);
        assertFalse(okTo, "transfer to a blocklisted address reverts");
        vm.deal(BLOCKLISTED, 5e18);
        vm.prank(BLOCKLISTED);
        (bool okFrom, bytes memory retFrom) = USDC.call(abi.encodeCall(IUsdcProbe.transfer, (carol, 1e6)));
        console2.log("transfer FROM blocklisted reverted:", !okFrom);
        console2.logBytes(retFrom);
        assertFalse(okFrom, "transfer from a blocklisted address reverts");
        vm.prank(carol);
        (bool okAp,) = USDC.call(abi.encodeCall(IUsdcProbe.approve, (BLOCKLISTED, 1e6)));
        console2.log("approve(blocklisted spender) ok:", okAp);

        // 4. forge-std deal(USDC) (erc20 slot hack) is not the funding path; native deal is.
        try this.dealErc20{gas: 5_000_000}(makeAddr("erin")) {
            console2.log("forge-std deal(USDC) worked");
        } catch {
            console2.log("forge-std deal(USDC) REVERTS (balanceOf does not read a storage slot)");
        }
    }

    function dealErc20(address who) external {
        deal(USDC, who, 5e6);
    }

    // ------------------------------------------------------------------ 1: live kernel facts

    function test_01_LiveKernelFacts() public onlyFork {
        address impl = address(uint160(uint256(vm.load(AC, IMPL_SLOT))));
        bytes32 adminRole = keccak256("ADMIN_ROLE");
        console2.log("block", block.number);
        console2.log("platformFeeBP", ac.platformFeeBP());
        console2.log("evaluatorFeeBP", ac.evaluatorFeeBP());
        console2.log("platformTreasury", ac.platformTreasury());
        console2.log("paymentToken", ac.paymentToken());
        console2.log("ERC1967 impl slot", impl);
        console2.log("hasRole(ADMIN_ROLE, treasury)", ac.hasRole(adminRole, ac.platformTreasury()));
        console2.log("jobCounter", ac.jobCounter());
        console2.log("USDC decimals", IUsdcProbe(USDC).decimals());
        assertEq(ac.paymentToken(), USDC, "paymentToken == USDC");
        assertEq(impl, AC_IMPL, "implementation == 0xA316...351a");
        assertEq(ac.ADMIN_ROLE(), adminRole, "ADMIN_ROLE constant");
        assertEq(IUsdcProbe(USDC).decimals(), 6, "USDC ERC-20 interface is 6 decimals");
        assertTrue(ac.whitelistedHooks(address(0)), "hook 0 is whitelisted (createJob requires it)");
    }

    // ------------------------------------------------------------------ 2: interface / shape conformance

    function test_02a_GetJobDecodesForRealJob() public onlyFork {
        uint256 n = ac.jobCounter();
        for (uint256 id = n; id > n - 5; --id) {
            IAgenticCommerce.Job memory j = ac.getJob(id);
            console2.log("real job", id);
            console2.log("  client", j.client);
            console2.log("  provider", j.provider);
            console2.log("  evaluator", j.evaluator);
            console2.log("  budget", j.budget);
            console2.log("  expiredAt", j.expiredAt);
            console2.log("  status", uint8(j.status));
            console2.log("  hook", j.hook);
            assertEq(j.id, id, "nine-field struct decodes with the right id");
            assertTrue(j.client != address(0) && j.expiredAt != 0, "populated record");
            assertLe(uint8(j.status), uint8(IAgenticCommerce.JobStatus.Expired), "status within the 6-value enum");
        }
        assertEq(ac.getJob(n + 1).id, 0, "unknown id decodes to the zero record (id == 0)");
    }

    function test_02b_GetJobDecodesForCreatedJob_AndControllerConstructs() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = createJob(address(sq), address(0), exp);
        IAgenticCommerce.Job memory j = ac.getJob(id);
        assertEq(j.id, id);
        assertEq(j.client, alice);
        assertEq(j.provider, bob);
        assertEq(j.evaluator, address(sq));
        assertEq(j.description, "SQ fork test");
        assertEq(j.budget, 0);
        assertEq(j.expiredAt, exp);
        assertEq(uint8(j.status), uint8(IAgenticCommerce.JobStatus.Open));
        assertEq(j.hook, address(0));
        SQController fresh = new SQController(IAgenticCommerce(AC), IERC20(USDC), SIM_FORWARDER, PROD_FORWARDER);
        assertEq(address(fresh.agenticCommerce()), AC);
        assertEq(address(fresh.usdc()), USDC);
        assertEq(fresh.simulationForwarder(), SIM_FORWARDER);
        assertEq(fresh.productionForwarder(), PROD_FORWARDER);
    }

    // ------------------------------------------------------------------ 3 / 4 / 5 / 7: need USDC movement

    /// @dev Registration against the REAL getJob and REAL USDC: validation passes and exactly the deposit is pulled.
    function test_03b_RegistrationPullsExactDepositOfRealUsdc() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp); // registration requires a Funded job with budget > 0
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Funded));
        ISQController.RegisterParams memory p = params(id, exp);
        uint256 deposit = FEE * 2;
        assertEq(usdcBal(alice), 0, "buyer spent the budget on funding");
        fundUsdc(alice, deposit + 3e6);
        vm.prank(alice);
        IERC20(USDC).approve(address(sq), deposit);
        vm.prank(alice);
        sq.registerJob(p);
        assertTrue(sq.isRegistered(id));
        assertEq(usdcBal(address(sq)), deposit, "SQController holds exactly the deposit");
        assertEq(usdcBal(alice), 3e6, "buyer paid exactly the deposit");
        assertEq(IERC20(USDC).allowance(alice, address(sq)), 0, "allowance fully consumed");
        assertEq(sq.getConfig(id).deposited, deposit);
    }

    function test_05a_AdminFeeKnobsOnRealKernel() public onlyFork {
        vm.expectRevert(abi.encodeWithSelector(IKernel.AccessControlUnauthorizedAccount.selector, stranger, ac.ADMIN_ROLE()));
        vm.prank(stranger);
        ac.setEvaluatorFee(100);

        vm.startPrank(TREASURY);
        ac.setPlatformFee(500, TREASURY);
        ac.setEvaluatorFee(300);
        vm.expectRevert(IKernel.FeesTooHigh.selector);
        ac.setEvaluatorFee(9501);
        vm.stopPrank();
        assertEq(ac.platformFeeBP(), 500);
        assertEq(ac.evaluatorFeeBP(), 300);

        // Zero-budget complete under non-zero fees: real kernel pays nothing, reports net 0.
        uint256 id = createJob(evalEoa, address(0), expiryIn(1 days));
        fundZero(id);
        submitJob(id);
        vm.expectEmit(true, true, false, true, AC);
        emit IKernel.PaymentReleased(id, bob, 0);
        vm.prank(evalEoa);
        ac.complete(id, bytes32(0), "");
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    // ------------------------------------------------------------------ 6: the expiry question (zero-budget, no USDC)

    function _call(address to, bytes memory data) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = to.call(data);
    }

    function _selector(bytes memory ret) internal pure returns (bytes4 s) {
        if (ret.length >= 4) s = bytes4(ret);
    }

    function test_06a_RealCompleteAfterExpiredAtSucceeds() public onlyFork {
        uint256 id = createJob(evalEoa, address(0), expiryIn(1 days));
        fundZero(id);
        submitJob(id);
        vm.warp(ac.getJob(id).expiredAt + 1);
        vm.prank(evalEoa);
        (bool ok, bytes memory ret) = _call(AC, abi.encodeCall(IAgenticCommerce.complete, (id, bytes32(0), "")));
        console2.log("complete after expiredAt (Submitted, claimRefund NOT called): reverted =", !ok);
        console2.logBytes(ret);
        // FINDING: the real complete() has no expiry check; it only needs status Submitted + evaluator.
        assertTrue(ok, "real kernel allows complete after expiredAt until claimRefund flips status");
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    function test_06b_RealRejectAfterExpiredAtSucceedsWhenFundedAndSubmitted() public onlyFork {
        uint256 idF = createJob(evalEoa, address(0), expiryIn(1 days));
        fundZero(idF);
        uint256 idS = createJob(evalEoa, address(0), expiryIn(1 days));
        fundZero(idS);
        submitJob(idS);
        vm.warp(ac.getJob(idF).expiredAt + 1);
        vm.prank(evalEoa);
        (bool okF, bytes memory retF) = _call(AC, abi.encodeCall(IAgenticCommerce.reject, (idF, bytes32(0), "")));
        vm.prank(evalEoa);
        (bool okS, bytes memory retS) = _call(AC, abi.encodeCall(IAgenticCommerce.reject, (idS, bytes32(0), "")));
        console2.log("reject Funded after expiredAt: reverted =", !okF);
        console2.logBytes(retF);
        console2.log("reject Submitted after expiredAt: reverted =", !okS);
        console2.logBytes(retS);
        // FINDING: real reject() has no expiry check either.
        assertTrue(okF && okS, "real kernel allows evaluator reject after expiredAt until claimRefund");
        assertEq(uint8(statusOf(idF)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(uint8(statusOf(idS)), uint8(IAgenticCommerce.JobStatus.Rejected));
    }

    function test_06c_AfterClaimRefundCompleteAndRejectRevertWrongStatus() public onlyFork {
        uint256 idF = createJob(evalEoa, address(0), expiryIn(1 days));
        fundZero(idF);
        uint256 idS = createJob(evalEoa, address(0), expiryIn(1 days));
        fundZero(idS);
        submitJob(idS);
        uint256 exp = ac.getJob(idF).expiredAt;
        // claimRefund before expiry is refused
        vm.expectRevert(IKernel.WrongStatus.selector);
        vm.prank(stranger);
        ac.claimRefund(idF);
        vm.warp(exp);
        vm.prank(stranger); // permissionless; boundary is inclusive (block.timestamp >= expiredAt)
        ac.claimRefund(idF);
        vm.prank(stranger);
        ac.claimRefund(idS);
        assertEq(uint8(statusOf(idF)), uint8(IAgenticCommerce.JobStatus.Expired));
        assertEq(uint8(statusOf(idS)), uint8(IAgenticCommerce.JobStatus.Expired));

        vm.prank(evalEoa);
        (bool okC, bytes memory retC) = _call(AC, abi.encodeCall(IAgenticCommerce.complete, (idS, bytes32(0), "")));
        vm.prank(evalEoa);
        (bool okR, bytes memory retR) = _call(AC, abi.encodeCall(IAgenticCommerce.reject, (idF, bytes32(0), "")));
        console2.log("complete after claimRefund: reverted =", !okC);
        console2.logBytes(retC);
        console2.log("reject after claimRefund: reverted =", !okR);
        console2.logBytes(retR);
        assertFalse(okC);
        assertFalse(okR);
        assertEq(_selector(retC), IKernel.WrongStatus.selector);
        assertEq(_selector(retR), IKernel.WrongStatus.selector);
    }

    function test_06d_FundAfterExpiryAndShortExpiryRevert() public onlyFork {
        uint256 id = createJob(evalEoa, address(0), expiryIn(1 days));
        vm.warp(ac.getJob(id).expiredAt);
        vm.expectRevert(IKernel.WrongStatus.selector);
        vm.prank(alice);
        ac.fund(id, "");
    }

    function test_06e_ShortExpiryRevertsExpiryTooShort() public onlyFork {
        vm.expectRevert(IKernel.ExpiryTooShort.selector);
        vm.prank(alice);
        ac.createJob(bob, evalEoa, block.timestamp + 5 minutes, "short", address(0));
    }

    function test_06f_SqEvaluatorJob_OnlySqCanCompleteOrReject() public onlyFork {
        uint256 id = createJob(address(sq), address(0), expiryIn(1 days));
        fundZero(id);
        submitJob(id);
        vm.warp(ac.getJob(id).expiredAt + 1);
        vm.expectRevert(IKernel.Unauthorized.selector);
        vm.prank(evalEoa);
        ac.complete(id, bytes32(0), "");
        vm.expectRevert(IKernel.Unauthorized.selector);
        vm.prank(alice);
        ac.reject(id, bytes32(0), "");
        // SQController itself cannot act without a registration (no verdict, no timeout path).
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.rejectOnTimeout(id);
    }

    // ------------------------------------------------------------------ 8: registration guards on the real getJob

    function test_08a_RegisterUnknownJobIdReverts() public onlyFork {
        uint256 id = ac.jobCounter() + 1;
        vm.expectRevert(ISQController.JobNotFound.selector);
        vm.prank(alice);
        sq.registerJob(params(id, expiryIn(1 days)));
    }

    function test_08b_RealExistingJob_NotClientThenWrongEvaluator() public onlyFork {
        uint256 id = ac.jobCounter();
        IAgenticCommerce.Job memory j = ac.getJob(id);
        ISQController.RegisterParams memory p = params(id, expiryIn(1 days));
        vm.expectRevert(ISQController.NotJobClient.selector);
        vm.prank(stranger);
        sq.registerJob(p);
        assertTrue(j.evaluator != address(sq), "real job does not name SQController");
        vm.expectRevert(ISQController.WrongEvaluator.selector);
        vm.prank(j.client);
        sq.registerJob(p);
    }

    function test_08c_TerminalStatusRejected() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = createJob(address(sq), address(0), exp);
        vm.prank(alice); // real kernel: client may reject an Open job
        ac.reject(id, bytes32(0), "");
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Rejected));
        vm.expectRevert(ISQController.WrongJobStatus.selector);
        vm.prank(alice);
        sq.registerJob(params(id, exp));
    }

    function test_08d_HookedJobRejected_AndKernelRequiresHookWhitelist() public onlyFork {
        NoopHook hook = new NoopHook();
        uint256 exp = expiryIn(1 days);
        vm.expectRevert(IKernel.HookNotWhitelisted.selector);
        vm.prank(alice);
        ac.createJob(bob, address(sq), exp, "hooked", address(hook));

        vm.prank(TREASURY); // real admin whitelists the hook on the fork
        ac.setHookWhitelist(address(hook), true);
        uint256 id = createJob(address(sq), address(hook), exp);
        assertEq(ac.getJob(id).hook, address(hook));
        vm.expectRevert(ISQController.HookNotAllowed.selector);
        vm.prank(alice);
        sq.registerJob(params(id, exp));
    }

    function test_08e_DeadlineWithinOneHourOfRealExpiryReverts() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp); // must be Funded to reach the deadline check
        ISQController.RegisterParams memory p = params(id, exp);
        p.decisionDeadline = uint64(exp - 30 minutes);
        vm.expectRevert(ISQController.BadDeadline.selector);
        vm.prank(alice);
        sq.registerJob(p);
    }

    function test_08f_RealKernelAllowsZeroBudgetSubmitFromOpen() public onlyFork {
        // FINDING: submit() accepts an Open job with budget 0, so a Submitted (never-funded) job exists.
        uint256 id = createJob(address(sq), address(0), expiryIn(1 days));
        submitJob(id);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
        assertEq(ac.getJob(id).budget, 0);
    }

    /// @dev REAL kernel: the never-funded Submitted shape (submit from Open with budget 0) is rejected at
    /// registration with WrongJobStatus, so it can never pay fees or complete through SQController.
    function test_08g_RealNeverFundedSubmittedJob_RejectedAtRegistration_WrongJobStatus() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = createJob(address(sq), address(0), exp);
        submitJob(id); // real kernel: Open -> Submitted, budget 0
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
        assertEq(ac.getJob(id).budget, 0);
        ISQController.RegisterParams memory p = params(id, exp);
        fundUsdc(alice, 2 * FEE);
        vm.prank(alice);
        IERC20(USDC).approve(address(sq), 2 * FEE);
        vm.expectRevert(ISQController.WrongJobStatus.selector);
        vm.prank(alice);
        sq.registerJob(p);
        assertFalse(sq.isRegistered(id));
        assertEq(usdcBal(address(sq)), 0, "no deposit pulled");
        // Because it cannot be registered, a verdict on it reverts NotRegistered: no fees, no completion.
        ISQController.Verdict memory v = verdictOf(id, ISQController.VerdictKind.Accept, 0, 3);
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.submitVerdict(v, hex"deadbeef");
        vm.expectRevert(ISQController.NotRegistered.selector);
        sq.settle(id);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
    }

    /// @dev REAL kernel: an Open job (never funded) is rejected at registration with WrongJobStatus.
    function test_08h_RealOpenJob_RejectedAtRegistration_WrongJobStatus() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = createJob(address(sq), address(0), exp);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Open));
        ISQController.RegisterParams memory p = params(id, exp);
        fundUsdc(alice, 2 * FEE);
        vm.prank(alice);
        IERC20(USDC).approve(address(sq), 2 * FEE);
        vm.expectRevert(ISQController.WrongJobStatus.selector);
        vm.prank(alice);
        sq.registerJob(p);
        assertFalse(sq.isRegistered(id));
        assertEq(usdcBal(address(sq)), 0);
    }

    /// @dev REAL kernel: a properly funded job that the provider then submits (before the buyer
    /// registered) is rejected too -- register after fund and BEFORE the provider can submit
    /// (atomically, e.g. via Multicall3From).
    function test_08i_RealFundedThenSubmittedBeforeRegistration_WrongJobStatus() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = fundedJob(BUDGET, exp);
        submitJob(id);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Submitted));
        assertEq(ac.getJob(id).budget, BUDGET);
        ISQController.RegisterParams memory p = params(id, exp);
        fundUsdc(alice, 2 * FEE);
        vm.prank(alice);
        IERC20(USDC).approve(address(sq), 2 * FEE);
        vm.expectRevert(ISQController.WrongJobStatus.selector);
        vm.prank(alice);
        sq.registerJob(p);
        assertFalse(sq.isRegistered(id));
    }

    /// @dev REAL kernel: fund() accepts a zero budget (moves no USDC), giving a Funded job with
    /// budget 0; registration refuses it with ZeroBudget.
    function test_08j_RealFundedZeroBudget_RejectedAtRegistration_ZeroBudget() public onlyFork {
        uint256 exp = expiryIn(1 days);
        uint256 id = createJob(address(sq), address(0), exp);
        fundZero(id);
        assertEq(uint8(statusOf(id)), uint8(IAgenticCommerce.JobStatus.Funded));
        assertEq(ac.getJob(id).budget, 0);
        ISQController.RegisterParams memory p = params(id, exp);
        fundUsdc(alice, 2 * FEE);
        vm.prank(alice);
        IERC20(USDC).approve(address(sq), 2 * FEE);
        vm.expectRevert(ISQController.ZeroBudget.selector);
        vm.prank(alice);
        sq.registerJob(p);
        assertFalse(sq.isRegistered(id));
    }

    // ------------------------------------------------------------------ helpers

    function _isSqValidationError(bytes memory ret) internal pure returns (bool) {
        bytes4 s = _selector(ret);
        return s == ISQController.JobNotFound.selector || s == ISQController.NotJobClient.selector
            || s == ISQController.WrongEvaluator.selector || s == ISQController.HookNotAllowed.selector
            || s == ISQController.WrongJobStatus.selector || s == ISQController.AlreadyRegistered.selector
            || s == ISQController.ZeroAddress.selector || s == ISQController.BadParams.selector
            || s == ISQController.BadCommittee.selector || s == ISQController.BadDeadline.selector
            || s == ISQController.BadSeedBlock.selector;
    }
}
