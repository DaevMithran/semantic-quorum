// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockAgenticCommerce} from "./mocks/MockAgenticCommerce.sol";
import {SQController} from "../SQController.sol";
import {ISQController} from "../interfaces/ISQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

/// @dev Invariant-campaign handler. Not a test file: contains no test_/invariant_ functions.
/// Every action wraps controller calls in try/catch so reverts are accepted, then ingests the
/// FeeCredited logs and snapshots job state so the invariant suite can compare against ghosts
/// that were computed independently of the controller's own accounting.
contract SQHandler is Test {
    uint256 public constant MAX_JOBS = 10;
    bytes32 internal constant FEE_SIG = keccak256("FeeCredited(uint256,uint8,uint256,address,uint256)");

    MockUSDC public immutable usdc;
    MockAgenticCommerce public immutable ac;
    SQController public immutable sq;
    uint256 public immutable authorityKey;
    address public immutable authority;
    address public immutable provider = address(0xB0B0);
    address public immutable relayer = address(0xE1A7);
    address public immutable treasury = address(0xFEE1);

    address[] public buyers;
    address[] public pool;
    uint256[] public jobIds;

    mapping(uint256 => uint256) public budgetOf;
    mapping(uint256 => uint256) public eventCount;
    mapping(uint256 => uint256) public ghostKernelFee;
    mapping(uint256 => bool) public refundedGhost;
    mapping(uint256 => ISQController.Decision) public seenDecision;
    mapping(uint256 => uint8) public seenRound;
    mapping(uint256 => mapping(uint8 => mapping(uint256 => bool))) internal seenCredit;

    uint256 public ghostDeposited;
    uint256 public ghostKernel;
    uint256 public ghostDonated;
    uint256 public ghostClaimed;
    uint256 public ghostRefunded;
    uint256 public expiries;

    uint256 public okRegister;
    uint256 public invalidRejected;
    uint256 public okVerdict;
    uint256 public okSettle;
    uint256 public okTimeout;
    uint256 public okClaim;
    uint256 public okRefund;
    uint256 public okExpire;
    uint256 public okAccept;
    uint256 public okForcedSettle;
    uint256 public acceptCapReverts;
    uint256 public garbageReplayReverts;
    uint256 public okViaSubmit;
    uint256 public okViaSim;
    uint256 public okViaProd;
    uint256 public unauthorizedAttempts;
    /// @dev Set if an unauthorized onReport caller ever succeeded, reverted with the wrong error, or changed state.
    bool public unauthorizedViolation;
    bytes internal constant META = abi.encodePacked(
        keccak256("sq-workflow-id"), bytes10("sq-verdict"), address(uint160(0xC0FFEE))
    );
    /// @dev Storage slot of SQController._states (forge inspect SQController storage-layout).
    uint256 internal constant STATES_SLOT = 4;

    bool public violation;
    string public violationMsg;

    ISQController.Verdict[] internal sentV;
    bytes[] internal sentSig;

    constructor(MockUSDC usdc_, MockAgenticCommerce ac_, SQController sq_, uint256 authorityKey_) {
        usdc = usdc_;
        ac = ac_;
        sq = sq_;
        authorityKey = authorityKey_;
        authority = vm.addr(authorityKey_);
        for (uint256 i; i < 3; ++i) buyers.push(makeAddr(string.concat("hbuyer", vm.toString(i))));
        for (uint256 i; i < 4; ++i) pool.push(makeAddr(string.concat("hrcpt", vm.toString(i))));
    }

    modifier tracked() {
        vm.recordLogs();
        _;
        _post();
    }

    function jobCount() external view returns (uint256) {
        return jobIds.length;
    }

    function poolLength() external view returns (uint256) {
        return pool.length;
    }

    function buyersLength() external view returns (uint256) {
        return buyers.length;
    }

    function _fail(string memory m) internal {
        if (!violation) {
            violation = true;
            violationMsg = m;
        }
    }

    // ------------------------------------------------------------------ registration + kernel steps

    function registerJob(uint256 seed) external tracked {
        if (jobIds.length >= MAX_JOBS) return;
        address b = buyers[seed % buyers.length];
        vm.prank(b);
        uint256 id = ac.createJob(provider, address(sq), block.timestamp + 7 days, "j", address(0));
        budgetOf[id] = 1e6 + (seed >> 96) % 500e6; // always > 0: only Funded, non-zero-budget jobs are registered
        _fund(id);
        bool ok = _register(id, b, seed);
        // The provider submits only AFTER registration (registering a Submitted job reverts WrongJobStatus).
        if (ok && (seed >> 56) % 3 == 2) _submit(id);
    }

    /// @dev Negative-space action: a job that is Open, never-funded Submitted (budget 0, submit from
    /// Open) or Funded with a zero budget must NEVER register, with the specific error, and must
    /// leave no deposit behind. Such jobs are not added to jobIds.
    function attemptInvalidRegistration(uint256 seed) external tracked {
        address b = buyers[seed % buyers.length];
        vm.prank(b);
        uint256 id = ac.createJob(provider, address(sq), block.timestamp + 7 days, "bad", address(0));
        uint256 shape = (seed >> 8) % 3;
        bytes4 expected = ISQController.WrongJobStatus.selector;
        if (shape == 1) {
            _submit(id); // Open -> Submitted with budget 0 (real-kernel shape)
        } else if (shape == 2) {
            vm.prank(b);
            ac.fund(id, ""); // Funded with budget 0
            expected = ISQController.ZeroBudget.selector;
        }
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = _params(id, seed);
        uint256 dep = p.feePerReport * p.committee.length * (uint256(p.revisionLimit) + 1);
        usdc.mint(b, dep);
        vm.prank(b);
        usdc.approve(address(sq), dep);
        uint256 balBefore = usdc.balanceOf(address(sq));
        vm.prank(b);
        try sq.registerJob(p) {
            _fail("invalid job shape registered");
        } catch (bytes memory err) {
            if (err.length < 4 || bytes4(err) != expected) _fail("invalid shape reverted with wrong error");
        }
        if (sq.isRegistered(id) || usdc.balanceOf(address(sq)) != balBefore) _fail("invalid shape left state");
        ++invalidRejected;
    }

    function _params(uint256 id, uint256 seed) internal view returns (ISQController.RegisterParams memory p) {
        p.jobId = id;
        p.policyHash = keccak256(abi.encode("policy", seed % 3));
        p.participantSnapshotHash = keccak256(abi.encode("snapshot", id));
        p.verdictAuthority = authority;
        p.revisionLimit = uint8((seed >> 16) % 4);
        p.decisionDeadline = uint64(block.timestamp + 1 hours + (seed >> 64) % 3 days);
        p.feePerReport = 1e6 + (seed >> 24) % 20e6;
        p.seedBlock = block.number - 1;
        uint256 n = 1 + (seed >> 8) % 4;
        p.committee = new ISQController.CommitteeMember[](n);
        for (uint256 i; i < n; ++i) {
            p.committee[i] = ISQController.CommitteeMember({
                evaluatorId: i + 1, feeRecipient: pool[(seed >> (120 + 8 * i)) % pool.length]
            });
        }
        // Fee caps: generous (live fees always fit), zero (any live fee blocks ACCEPT), or random
        // (sometimes below the live fee so ACCEPT reverts atomically). Registration never reads live fees.
        uint256 mode = (seed >> 200) % 3;
        if (mode == 0) {
            p.maxPlatformFeeBP = 5000;
            p.maxEvaluatorFeeBP = 5000;
        } else if (mode == 1) {
            p.maxPlatformFeeBP = 0;
            p.maxEvaluatorFeeBP = 0;
        } else {
            p.maxPlatformFeeBP = (seed >> 210) % 2501;
            p.maxEvaluatorFeeBP = (seed >> 230) % 3501;
        }
    }

    function _register(uint256 id, address b, uint256 seed) internal returns (bool ok) {
        vm.roll(block.number + 1);
        ISQController.RegisterParams memory p = _params(id, seed);
        uint256 dep = p.feePerReport * p.committee.length * (uint256(p.revisionLimit) + 1);
        usdc.mint(b, dep);
        vm.prank(b);
        usdc.approve(address(sq), dep);
        vm.prank(b);
        try sq.registerJob(p) {
            jobIds.push(id);
            ghostDeposited += dep;
            ++okRegister;
            ok = true;
        } catch {
            _fail("valid registration reverted");
        }
    }

    function _fund(uint256 id) internal {
        address c = ac.getJob(id).client;
        vm.prank(provider);
        ac.setBudget(id, budgetOf[id], "");
        usdc.mint(c, budgetOf[id]);
        vm.prank(c);
        usdc.approve(address(ac), budgetOf[id]);
        vm.prank(c);
        ac.fund(id, "");
    }

    function _submit(uint256 id) internal {
        vm.prank(provider);
        ac.submit(id, keccak256(abi.encode("deliverable", id)), "");
    }

    function submitJob(uint256 seed) external tracked {
        if (jobIds.length == 0) return;
        uint256 id = jobIds[seed % jobIds.length];
        if (ac.getJob(id).status == IAgenticCommerce.JobStatus.Funded) _submit(id);
    }

    function expireJob(uint256 seed) external tracked {
        if (jobIds.length == 0 || expiries >= 2) return;
        uint256 id = jobIds[seed % jobIds.length];
        IAgenticCommerce.Job memory j = ac.getJob(id);
        if (j.status != IAgenticCommerce.JobStatus.Funded && j.status != IAgenticCommerce.JobStatus.Submitted) return;
        if (block.timestamp < j.expiredAt) vm.warp(j.expiredAt);
        ac.claimRefund(id);
        ++expiries;
        ++okExpire;
    }

    function warpTime(uint256 dt) external tracked {
        vm.warp(block.timestamp + dt % 18 hours);
        vm.roll(block.number + 1);
    }

    function setKernelFees(uint256 evalBP, uint256 platformBP) external tracked {
        ac.setEvaluatorFee(evalBP % 4 == 0 ? 0 : (evalBP >> 2) % 3001);
        ac.setPlatformFee(platformBP % 2001, treasury);
    }

    function donate(uint256 amt) external tracked {
        amt = 1 + amt % 10e6;
        usdc.mint(address(sq), amt);
        ghostDonated += amt;
    }

    // ------------------------------------------------------------------ verdicts

    function _buildVerdict(uint256 id, uint256 seed, uint256 seed2)
        internal
        view
        returns (ISQController.Verdict memory v)
    {
        ISQController.JobState memory st = sq.getState(id);
        uint256 n = sq.getConfig(id).committeeSize;
        v.jobId = id;
        v.round = (seed >> 8) % 8 < 6 ? st.round : uint8((seed >> 12) % 4);
        uint256 k = (seed >> 16) % 12;
        v.kind = k < 4
            ? ISQController.VerdictKind.Accept
            : k < 9 ? ISQController.VerdictKind.Revise : k < 11
                ? ISQController.VerdictKind.Reject
                : ISQController.VerdictKind.None;
        v.deliverable = (seed >> 24) % 8 == 0 ? bytes32(0) : keccak256(abi.encode("d", (seed >> 28) % 2));
        v.evidenceHash = keccak256(abi.encode("e", seed2 % 2));
        v.reportsHash = keccak256(abi.encode("r", (seed2 >> 4) % 2));
        v.deficiencyHash = keccak256(abi.encode("f", (seed2 >> 8) % 2));
        uint256 m = (seed2 >> 16) % (uint256(1) << n);
        uint256 sel = (seed2 >> 48) % 16;
        if (sel == 0) m = 0;
        else if (sel == 1) m = uint256(1) << n;
        v.includedMask = m;
    }

    function sendVerdict(uint256 seed, uint256 seed2) external tracked {
        if (jobIds.length == 0) return;
        uint256 id = jobIds[seed % jobIds.length];
        ISQController.Verdict memory v = _buildVerdict(id, seed, seed2);
        _send(v, (seed2 >> 56) % 10 == 0 ? 0xBAD : authorityKey, _pickRoute(seed, seed2));
    }

    /// @dev Directed action: builds a verdict consistent with the live kernel status and round so
    /// that a good share of calls actually apply (the unconstrained action mostly hits reverts).
    function sendValidVerdict(uint256 seed, uint256 seed2) external tracked {
        if (jobIds.length == 0) return;
        uint256 id = jobIds[seed % jobIds.length];
        ISQController.JobState memory st = sq.getState(id);
        IAgenticCommerce.JobStatus s = ac.getJob(id).status;
        ISQController.Verdict memory v = _validVerdict(id, seed, seed2);
        bool checkable = (s == IAgenticCommerce.JobStatus.Funded || s == IAgenticCommerce.JobStatus.Submitted)
            && st.decision == ISQController.Decision.None;
        bool feesOk = _feesWithinCaps(id);
        bool ok = _send(v, authorityKey, _pickRoute(seed, seed2));
        if (checkable) _verifyOutcome(v, feesOk, ok);
    }

    function _validVerdict(uint256 id, uint256 seed, uint256 seed2)
        internal
        view
        returns (ISQController.Verdict memory v)
    {
        ISQController.JobState memory st = sq.getState(id);
        IAgenticCommerce.JobStatus s = ac.getJob(id).status;
        v = _buildVerdict(id, seed, seed2);
        v.round = st.round;
        if (s == IAgenticCommerce.JobStatus.Funded) {
            v.kind = (seed >> 40) % 5 == 0 ? ISQController.VerdictKind.Reject : ISQController.VerdictKind.Revise;
        } else if (s == IAgenticCommerce.JobStatus.Submitted) {
            v.kind = (seed >> 40) % 5 == 0 ? ISQController.VerdictKind.Reject : ISQController.VerdictKind.Accept;
            v.deliverable = keccak256(abi.encode("d", seed2 % 2));
        }
        v.includedMask = 1 + (seed2 >> 16) % ((uint256(1) << sq.getConfig(id).committeeSize) - 1);
    }

    /// @dev A state-consistent verdict must apply iff in time and, for ACCEPT, live fees fit the job's caps.
    function _verifyOutcome(ISQController.Verdict memory v, bool feesOk, bool ok) internal {
        bool inTime = block.timestamp <= sq.getConfig(v.jobId).decisionDeadline;
        bool isAccept = v.kind == ISQController.VerdictKind.Accept;
        bool expectOk = inTime && (!isAccept || feesOk);
        if (ok != expectOk) _fail("verdict outcome != deadline/fee-cap expectation");
        if (isAccept && inTime && !feesOk && !ok) ++acceptCapReverts;
    }

    function _feesWithinCaps(uint256 id) internal view returns (bool) {
        ISQController.JobConfig memory cfg = sq.getConfig(id);
        return ac.platformFeeBP() <= cfg.maxPlatformFeeBP && ac.evaluatorFeeBP() <= cfg.maxEvaluatorFeeBP;
    }

    function replayVerdict(uint256 seed) external tracked {
        if (sentV.length == 0) return;
        uint256 i = seed % sentV.length;
        ISQController.Verdict memory v = sentV[i];
        bytes memory sig = sentSig[i];
        uint256 route = _pickRoute(seed, 7);
        if ((seed >> 8) % 4 == 0) {
            // signature is verified BEFORE idempotency: garbage must always revert, never no-op, on every path
            if (_routeCall(route, v, hex"deadbeef")) {
                _fail("garbage-signature replay succeeded");
            } else {
                ++garbageReplayReverts;
                _dropRevertedLogs();
            }
            return;
        }
        ISQController.Decision before = sq.getState(v.jobId).decision;
        if (_routeCall(route, v, sig)) {
            ++okVerdict;
            // A replay of a verdict that earlier reverted (deadline/status/fee cap) can be the FIRST applied
            // decision; account for it exactly like _send does so the ghost kernel-fee flow stays complete.
            if (before == ISQController.Decision.None) _onFirstDecision(v.jobId);
        } else {
            _dropRevertedLogs();
        }
    }

    /// @dev Hash-derived path selector: fuzzer inputs are often small, so shifting raw seeds would pin route 0.
    function _pickRoute(uint256 a, uint256 b) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("route", a, b))) % 3;
    }

    /// @dev Delivers (v, sig) through route % 3: 0 = submitVerdict, 1 = onReport via the simulation
    /// forwarder, 2 = onReport via the production forwarder. Returns whether the call succeeded.
    function _routeCall(uint256 route, ISQController.Verdict memory v, bytes memory sig) internal returns (bool ok) {
        route %= 3;
        if (route == 0) {
            vm.prank(relayer);
            try sq.submitVerdict(v, sig) {
                ok = true;
                ++okViaSubmit;
            } catch {}
        } else {
            address fwd = route == 1 ? sq.simulationForwarder() : sq.productionForwarder();
            bytes memory report = abi.encode(v, sig);
            vm.prank(fwd);
            try sq.onReport(META, report) {
                ok = true;
                if (route == 1) ++okViaSim;
                else ++okViaProd;
            } catch {}
        }
    }

    /// @dev Returns whether the verdict was applied (via the route selected by `route % 3`).
    function _send(ISQController.Verdict memory v, uint256 key, uint256 route) internal returns (bool ok) {
        bytes32 d = sq.hashVerdict(v);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, d);
        bytes memory sig = abi.encodePacked(r, s, vv);
        sentV.push(v);
        sentSig.push(sig);
        ISQController.Decision before = sq.getState(v.jobId).decision;
        ok = _routeCall(route, v, sig);
        if (ok) {
            ++okVerdict;
            if (before == ISQController.Decision.None) _onFirstDecision(v.jobId);
        } else {
            _dropRevertedLogs();
        }
    }

    // ------------------------------------------------------------------ unauthorized onReport callers

    function _unauthCaller(uint256 seed) internal view returns (address) {
        uint256 k = seed % 11;
        if (k < 3) return buyers[k];
        if (k == 3) return relayer;
        if (k == 4) return pool[0];
        if (k == 5) return authority;
        if (k == 6) return address(sq);
        if (k == 7) return address(0);
        if (k == 8) return address(this);
        if (k == 9) return provider;
        return address(uint160(uint256(keccak256(abi.encode("rnd", seed)))));
    }

    function _fp(uint256 id) internal view returns (bytes32) {
        bytes memory acc = abi.encode(
            sq.getState(id), usdc.balanceOf(address(sq)), uint8(ac.getJob(id).status), ac.getJob(id).budget
        );
        for (uint8 r; r < 4; ++r) {
            acc = bytes.concat(acc, abi.encode(sq.verdictDigestOf(id, r), sq.creditedMaskOf(id, r)));
        }
        for (uint256 j; j < pool.length; ++j) acc = bytes.concat(acc, abi.encode(sq.feeBalance(pool[j])));
        return keccak256(acc);
    }

    /// @dev Any caller that is not one of the two forwarders must always be rejected with
    /// UnauthorizedForwarder(caller), even carrying a state-consistent, correctly signed verdict,
    /// and must change nothing (state, balances, logs).
    function unauthorizedReport(uint256 seed, uint256 seed2) external tracked {
        if (jobIds.length == 0) return;
        uint256 id = jobIds[seed % jobIds.length];
        address caller = _unauthCaller(seed >> 8);
        if (caller == sq.simulationForwarder() || caller == sq.productionForwarder()) return;
        ISQController.Verdict memory v = _validVerdict(id, seed, seed2);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(authorityKey, sq.hashVerdict(v));
        bytes memory report = abi.encode(v, abi.encodePacked(r, s, vv));
        bytes32 fp = _fp(id);
        vm.getRecordedLogs();
        vm.recordLogs();
        vm.prank(caller);
        try sq.onReport(META, report) {
            unauthorizedViolation = true;
            _fail("unauthorized onReport succeeded");
        } catch (bytes memory err) {
            bytes memory expected = abi.encodeWithSelector(ISQController.UnauthorizedForwarder.selector, caller);
            if (keccak256(err) != keccak256(expected)) {
                unauthorizedViolation = true;
                _fail("unauthorized onReport reverted with wrong error");
            }
        }
        if (_fp(id) != fp) {
            unauthorizedViolation = true;
            _fail("unauthorized onReport changed state");
        }
        if (vm.getRecordedLogs().length != 0) {
            unauthorizedViolation = true;
            _fail("unauthorized onReport emitted logs");
        }
        vm.recordLogs();
        ++unauthorizedAttempts;
    }

    /// @dev vm.recordLogs also captures logs emitted inside a call that later reverted (e.g. FeeCredited
    /// before an atomic ACCEPT rollback on a fee-cap breach). Those logs never happened onchain, so discard.
    function _dropRevertedLogs() internal {
        vm.getRecordedLogs();
        vm.recordLogs();
    }

    /// @dev On an applied first ACCEPT, completion is atomic: kernel Completed, settled, and the
    /// evaluator-fee cut is recorded in that same transaction. The cut is recomputed from the live
    /// fee (fees cannot change inside the transaction).
    function _onFirstDecision(uint256 id) internal {
        ISQController.JobState memory st = sq.getState(id);
        if (st.decision != ISQController.Decision.Accepted) return;
        ++okAccept;
        if (!st.settled) _fail("accepted but not settled in the ACCEPT tx");
        if (ac.getJob(id).status != IAgenticCommerce.JobStatus.Completed) _fail("accept left kernel open");
        uint256 cut = ac.getJob(id).budget * ac.evaluatorFeeBP() / 10000;
        ghostKernelFee[id] += cut;
        ghostKernel += cut;
        if (st.kernelFeeReceived != cut) _fail("kernel fee not recorded in ACCEPT tx");
        if (!_feesWithinCaps(id)) _fail("accepted above fee cap");
    }

    // ------------------------------------------------------------------ settle / timeout / money out

    function _caller(uint256 seed) internal view returns (address) {
        uint256 k = seed % 5;
        if (k < 3) return buyers[k];
        return k == 3 ? relayer : pool[0];
    }

    /// @dev Through the public API an accepted-but-unsettled job is unreachable, so plain settle
    /// must never succeed here.
    function settleJob(uint256 seed) external tracked {
        if (jobIds.length == 0) return;
        uint256 id = jobIds[seed % jobIds.length];
        vm.prank(_caller(seed >> 8));
        try sq.settle(id) {
            _fail("settle succeeded without an accepted-unsettled state");
        } catch {}
    }

    /// @dev Defensive-retry path: forces decision=Accepted/settled=false (vm.store) on a Submitted job
    /// whose live fees fit its caps, then settles it. The settle must succeed and be fee-accounted.
    function forceAndSettle(uint256 seed) external tracked {
        if (jobIds.length == 0) return;
        uint256 id = jobIds[seed % jobIds.length];
        if (sq.getState(id).decision != ISQController.Decision.None) return;
        if (ac.getJob(id).status != IAgenticCommerce.JobStatus.Submitted) return;
        if (!_feesWithinCaps(id)) return;
        bytes32 base = keccak256(abi.encode(id, STATES_SLOT));
        uint256 w = uint256(vm.load(address(sq), base));
        w = (w & ~(uint256(0xFFFF) << 8)) | (uint256(1) << 8);
        vm.store(address(sq), base, bytes32(w));
        vm.store(address(sq), bytes32(uint256(base) + 1), keccak256("forced deliverable"));
        vm.store(address(sq), bytes32(uint256(base) + 2), keccak256("forced evidence"));
        uint256 cut = ac.getJob(id).budget * ac.evaluatorFeeBP() / 10000;
        vm.prank(_caller(seed >> 8));
        try sq.settle(id) {
            ++okSettle;
            ++okForcedSettle;
            ghostKernelFee[id] += cut;
            ghostKernel += cut;
            if (sq.getState(id).kernelFeeReceived != cut) _fail("settle kernel fee mismatch");
        } catch {
            _fail("forced settle reverted");
        }
    }

    function timeoutJob(uint256 seed) external tracked {
        if (jobIds.length == 0) return;
        uint256 id = jobIds[seed % jobIds.length];
        vm.prank(_caller(seed >> 8));
        try sq.rejectOnTimeout(id) {
            ++okTimeout;
        } catch {}
    }

    function claimFees(uint256 seed) external tracked {
        uint256 k = seed % 7;
        address a = k < 4 ? pool[k] : buyers[k - 4];
        uint256 pre = sq.feeBalance(a);
        vm.prank(a);
        try sq.claim() returns (uint256 amt) {
            ghostClaimed += amt;
            ++okClaim;
            if (amt != pre) _fail("claim paid != balance");
            if (sq.feeBalance(a) != 0) _fail("claim left a balance");
        } catch {
            if (pre != 0) _fail("claim with balance reverted");
        }
    }

    function refundJob(uint256 seed) external tracked {
        if (jobIds.length == 0) return;
        uint256 id = jobIds[seed % jobIds.length];
        ISQController.JobConfig memory cfg = sq.getConfig(id);
        IAgenticCommerce.JobStatus s = ac.getJob(id).status;
        bool terminal = s == IAgenticCommerce.JobStatus.Completed || s == IAgenticCommerce.JobStatus.Rejected
            || s == IAgenticCommerce.JobStatus.Expired;
        uint256 balBefore = usdc.balanceOf(cfg.buyer);
        vm.prank(_caller(seed >> 8));
        try sq.refundFees(id) returns (uint256 amt) {
            uint256 expected = cfg.deposited - eventCount[id] * cfg.feePerReport + ghostKernelFee[id];
            if (amt != expected) _fail("refund amount mismatch");
            if (usdc.balanceOf(cfg.buyer) - balBefore != amt) _fail("buyer not paid refund");
            if (!terminal) _fail("refund on non-terminal job");
            if (refundedGhost[id]) _fail("double refund");
            refundedGhost[id] = true;
            ghostRefunded += amt;
            ++okRefund;
        } catch {
            if (terminal && !refundedGhost[id]) _fail("refund of terminal job reverted");
        }
    }

    // ------------------------------------------------------------------ post-action bookkeeping

    function _post() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(sq) || l.topics.length < 3 || l.topics[0] != FEE_SIG) continue;
            uint256 id = uint256(l.topics[1]);
            (uint8 round, uint256 idx, uint256 amt) = abi.decode(l.data, (uint8, uint256, uint256));
            if (seenCredit[id][round][idx]) _fail("slot credited twice");
            seenCredit[id][round][idx] = true;
            ++eventCount[id];
            if (amt != sq.getConfig(id).feePerReport) _fail("credit amount != fee");
            if (address(uint160(uint256(l.topics[2]))) != sq.getCommittee(id)[idx].feeRecipient) {
                _fail("credit recipient != pinned member");
            }
        }
        for (uint256 j; j < jobIds.length; ++j) {
            uint256 id = jobIds[j];
            ISQController.JobState memory st = sq.getState(id);
            ISQController.Decision d = seenDecision[id];
            if (d != ISQController.Decision.None && st.decision != d) _fail("decision changed");
            if (st.round < seenRound[id]) _fail("round went backwards");
            seenDecision[id] = st.decision;
            seenRound[id] = st.round;
        }
    }
}
