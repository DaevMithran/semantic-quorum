// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Semantic Quorum evaluator public interface
/// @notice Fixed per-report fees are six-decimal USDC base units, not native currency.
/// ACCEPT atomically approves and completes the kernel job, subject to pinned fee caps.
interface ISQController {
    enum VerdictKind { None, Accept, Revise, Reject }
    enum Decision { None, Accepted, Rejected }

    /// @notice Immutable report identity and payout recipient selected at registration.
    struct CommitteeMember {
        uint256 evaluatorId;
        address feeRecipient;
    }

    /// @notice Buyer-pinned policy, authority, fee schedule and committee for one kernel job.
    /// @dev Fee caps are buyer-chosen, provider-visible terms bounding how much the
    /// admin-controlled kernel fees can shift value away from the provider. The platform
    /// fee reduces the provider's net; the evaluator cut is paid to this contract and
    /// credited to the buyer's refundable leftover. A higher evaluator fee thus shifts
    /// provider money to the buyer, which is why it is capped. Each cap and their sum
    /// must be at most 10000 basis points; registration does not read live kernel fees.
    struct RegisterParams {
        uint256 jobId;
        bytes32 policyHash;
        bytes32 participantSnapshotHash;
        address verdictAuthority;
        uint8 revisionLimit;
        uint64 decisionDeadline;
        uint256 feePerReport;
        uint256 seedBlock;
        CommitteeMember[] committee;
        uint256 maxPlatformFeeBP;
        uint256 maxEvaluatorFeeBP;
    }

    /// @notice Signed report aggregate; report and deficiency hashes are opaque commitments.
    struct Verdict {
        uint256 jobId;
        uint8 round;
        VerdictKind kind;
        bytes32 deliverable;
        bytes32 evidenceHash;
        bytes32 reportsHash;
        bytes32 deficiencyHash;
        uint256 includedMask;
    }

    /// @notice Immutable registration data, including the fully prefunded report budget.
    /// @dev The final two fields pin the provider-visible kernel fee caps for completion.
    struct JobConfig {
        address buyer;
        address verdictAuthority;
        uint8 revisionLimit;
        uint8 committeeSize;
        uint64 decisionDeadline;
        uint256 feePerReport;
        uint256 seedBlock;
        bytes32 selectionSeed;
        bytes32 policyHash;
        bytes32 participantSnapshotHash;
        uint256 deposited;
        uint256 maxPlatformFeeBP;
        uint256 maxEvaluatorFeeBP;
    }

    /// @notice Decision lifecycle and cumulative per-job accounting.
    /// @dev settled records completion during ACCEPT or its defensive settle retry;
    /// rejection is represented by decision.
    struct JobState {
        uint8 round;
        Decision decision;
        bool settled;
        bool refunded;
        bytes32 approvedDeliverable;
        bytes32 approvedEvidenceHash;
        uint256 credited;
        uint256 kernelFeeReceived;
    }

    event JobRegistered(
        uint256 indexed jobId,
        address indexed buyer,
        address indexed verdictAuthority,
        bytes32 policyHash,
        bytes32 participantSnapshotHash,
        uint8 revisionLimit,
        uint64 decisionDeadline,
        uint256 feePerReport,
        uint256 deposited,
        uint256 seedBlock,
        bytes32 selectionSeed,
        uint256 maxPlatformFeeBP,
        uint256 maxEvaluatorFeeBP
    );
    event CommitteeSelected(
        uint256 indexed jobId,
        uint256 seedBlock,
        bytes32 selectionSeed,
        uint256[] evaluatorIds,
        address[] feeRecipients
    );
    event VerdictRecorded(
        uint256 indexed jobId,
        uint8 indexed round,
        VerdictKind kind,
        VerdictKind effectiveKind,
        bytes32 deliverable,
        bytes32 evidenceHash,
        bytes32 reportsHash,
        bytes32 deficiencyHash,
        uint256 includedMask,
        bytes32 digest
    );
    event FeeCredited(uint256 indexed jobId, uint8 round, uint256 index, address indexed recipient, uint256 amount);
    event RevisionRequested(uint256 indexed jobId, uint8 newRound, bytes32 evidenceHash, bytes32 deficiencyHash);
    event RevisionLimitReached(uint256 indexed jobId, uint8 round);
    event DeliverableApproved(uint256 indexed jobId, bytes32 deliverable, bytes32 evidenceHash);
    event JobSettled(uint256 indexed jobId, bool completed, bytes32 reason);
    event TimeoutRejected(uint256 indexed jobId);
    event KernelEvaluatorFeeReceived(uint256 indexed jobId, uint256 amount);
    /// @notice Live kernel fee basis points checked against the job's caps on successful completion.
    event CompletionFeesApplied(uint256 indexed jobId, uint256 platformFeeBP, uint256 evaluatorFeeBP);
    event FeesClaimed(address indexed account, uint256 amount);
    event FeesRefunded(uint256 indexed jobId, address indexed buyer, uint256 amount);

    error ZeroAddress();
    error UnauthorizedForwarder(address caller);
    error JobNotFound();
    error NotJobClient();
    error WrongEvaluator();
    error HookNotAllowed();
    error WrongJobStatus();
    error ZeroBudget();
    error AlreadyRegistered();
    error NotRegistered();
    error BadParams();
    error BadCommittee();
    error BadDeadline();
    error BadSeedBlock();
    error InvalidSignature();
    error ConflictingVerdict();
    error AlreadyDecided();
    error WrongRound();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error BadKind();
    error BadMask();
    error NotSubmitted();
    error ZeroDeliverable();
    error ReviseRequiresFunded();
    error NotAccepted();
    error AlreadySettled();
    error PlatformFeeAboveCap(uint256 live, uint256 cap);
    error EvaluatorFeeAboveCap(uint256 live, uint256 cap);
    error NotTerminal();
    error AlreadyRefunded();
    error NothingToClaim();
    error InsolventCredit();

    /// @notice Registers a kernel job and escrows its entire possible report fee budget.
    /// @dev The decision deadline must be in the future and at least MIN_SETTLE_BUFFER
    /// (one hour) before kernel expiry. Live fees are neither read nor restricted here.
    function registerJob(RegisterParams calldata p) external;
    /// @notice Records an authority-signed verdict and atomically completes on ACCEPT.
    /// @dev Signature validation precedes idempotency: a valid signature for an exact
    /// recorded digest is a silent no-op even after termination or the deadline; an
    /// invalid signature always reverts. A different signed digest for that round conflicts.
    /// If live kernel fees exceed the job's caps, ACCEPT reverts in full. The authority
    /// can retry once fees fall; otherwise rejectOnTimeout refunds the buyer.
    function submitVerdict(Verdict calldata v, bytes calldata signature) external;
    /// @notice Permissionless defensive retry to complete an accepted-but-unsettled job.
    /// @dev Under normal operation an accepted job is already settled in the ACCEPT
    /// transaction; settle is only a defensive retry path, with the same live fee caps.
    function settle(uint256 jobId) external;
    /// @notice Rejects an undecided funded/submitted job strictly after its decision deadline.
    function rejectOnTimeout(uint256 jobId) external;
    /// @notice Withdraws all report fees credited to the caller.
    function claim() external returns (uint256 amount);
    /// @notice Returns uncredited report deposits and received kernel fees to the buyer once terminal.
    function refundFees(uint256 jobId) external returns (uint256 amount);
    /// @notice Returns stored registration data, or its zero value if not registered.
    function getConfig(uint256 jobId) external view returns (JobConfig memory);
    /// @notice Returns the pinned committee in bitmap index order.
    function getCommittee(uint256 jobId) external view returns (CommitteeMember[] memory);
    /// @notice Returns the current lifecycle/accounting state.
    function getState(uint256 jobId) external view returns (JobState memory);
    /// @notice Whether this controller has registered the job.
    function isRegistered(uint256 jobId) external view returns (bool);
    /// @notice Returns an account's currently withdrawable report fees.
    function feeBalance(address account) external view returns (uint256);
    /// @notice Returns a recorded round's EIP-712 digest, or zero if absent.
    function verdictDigestOf(uint256 jobId, uint8 round) external view returns (bytes32);
    /// @notice Returns the bitmap of committee members credited for a round.
    function creditedMaskOf(uint256 jobId, uint8 round) external view returns (uint256);
    /// @notice Computes the digest using the registered job's stored policy and snapshot commitments.
    /// @dev Reverts NotRegistered for an unknown job.
    function hashVerdict(Verdict calldata v) external view returns (bytes32);
}
