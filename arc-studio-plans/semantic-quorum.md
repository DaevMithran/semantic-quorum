## Implementation Plan: Semantic Quorum

### Confirmed from the deployed AgenticCommerce (Arc testnet 0x0747EEf0706327138c69792bF28Cd525089e4583)
Proxy (ERC1967) over verified AgenticCommerce impl 0xA316fd02827242D537F84730F8a37D0BA5fd351a, solc 0.8.28, UUPS + AccessControl. Verified from the explorer ABI; complete/reject guard logic matches the ERC-8183 reference body (not read line-by-line from the deployed source, so pin it with a fork test).
- A contract can be the evaluator: createJob rejects only a zero evaluator; complete is evaluator-only and needs status Submitted; reject is evaluator-only in Funded/Submitted (client-only in Open).
- hook = address(0) is correct: non-zero hooks must be whitelisted by the kernel admin.
- Fees: platformFeeBP, evaluatorFeeBP, platformTreasury exist with admin setters (setPlatformFee, setEvaluatorFee); no fee-changed events. initialize(paymentToken, treasury, admin) sets no fees, so default 0 unless an admin changed them. Live values NOT yet read; a fork test must read them. Fees apply on complete only. If evaluatorFeeBP > 0, the cut is paid to job.evaluator = SQController.
- Kernel is admin-upgradeable (UUPS).
- BLOCKER 1: getJob returns 9 fields (id, client, provider, evaluator, description, budget, expiredAt, status, hook). No deliverable. It is only in the JobSubmitted event. settle cannot compare deliverables onchain.
- BLOCKER 2: no Submitted -> Funded transition and no resubmit. REVISE cannot return a Submitted job to Funded.
- claimRefund is permissionless after expiredAt, so decisionDeadline must be before job.expiredAt.

### Summary
A reusable ERC-8183 evaluator contract on Arc testnet. A pinned verdict authority signs EIP-712 verdicts (ACCEPT / REVISE / REJECT) from an offchain AI committee. SQController turns them into complete/reject on the existing AgenticCommerce and holds/pays per-report USDC evaluator fees.

### Architecture
- Blockchain: Arc testnet (5042002). USDC via the 6-decimal ERC-20 interface 0x3600...0000; never msg.value.
- Contract: SQController is the job evaluator; no new escrow or kernel. Non-upgradeable, ownerless, immutables = AgenticCommerce + USDC. ReentrancyGuardTransient, SafeERC20.
- Deliverable binding (blocker 1, proposed): ACCEPT is valid only while kernel status is Submitted (deliverable immutable after that). Authority signs the deliverable it read from JobSubmitted; stored as approvedHash; evidenceHash is passed as `reason` to complete so JobCompleted sits next to JobSubmitted. settle checks status + approval, not equality. A wrong hash in a signed ACCEPT is an authority fault the contract cannot detect; documented.
- REVISE (blocker 2, approved): valid only while Funded (pre-submit draft loop). REVISE on Submitted reverts. SUBMITTING IS FINAL: the kernel has no resubmit and no Submitted -> Funded transition, so a submitted job can only be ACCEPTed or REJECTed. This is documented in the NatSpec, the README/design notes and the signer script's help text, and providers should call submit only when ready for a final verdict. REVISE at revisionCount == revisionLimit executes as REJECT (event records signed and effective kind). Rounds 0..revisionLimit => at most revisionLimit+1 reports.
- registerJob: caller must be job.client; job.evaluator == this; hook == 0; non-terminal status; decisionDeadline < job.expiredAt; committee 1..8 of (uint256 evaluatorId, feeRecipient) with 2 in the demo; feeRecipient != 0; unique evaluatorIds; records policyHash, participantSnapshotHash, verdictAuthority, revisionLimit, feePerReport, and the seed. registerJob takes seedBlock (no free-form seed) and requires seedBlock < block.number, block.number - seedBlock <= 256, and selectionSeed == keccak256(abi.encode(jobId, blockhash(seedBlock))), computed by the contract. Both seedBlock and selectionSeed are stored and emitted. Immutable after. Pulls fee x N x (R+1) from the buyer. Does NOT revert on a non-zero kernel evaluatorFeeBP (approved change): settle's balance-delta handling credits any kernel evaluator fee to the buyer's leftover.
- Selection seed (approved): derived onchain from a recent blockhash, not supplied. The draw itself is offchain; participantSnapshotHash commits the pool; the contract still cannot verify that the committee matches the draw. Caveats to document: (a) Arc blocks are sub-second, so the 256-block window is only a few minutes and registration must follow soon after picking seedBlock; (b) the registrant picks seedBlock among the last 256 blocks, so it can grind up to ~256 seeds; the seed is not unbiasable (PREVRANDAO is 0 on Arc, no VRF), it only prevents a free-form seed; (c) blockhash returns 0 outside the window, which the range check prevents.
- Verdict: EIP-712 Verdict(jobId, round, kind, deliverable, evidenceHash, reportsHash, deficiencyHash, includedMask, policyHash, participantSnapshotHash) (reportsHash and deficiencyHash are opaque bytes32 commitments with no onchain semantics; the build must avoid stack-too-deep by hashing and emitting from a memory struct), domain binds chainId + verifying contract, OZ SignatureChecker (ERC-1271 ok), anyone can relay. Digest stored per (jobId, round): identical resubmission = no-op, different = ConflictingVerdict; wrong round / after decision / after decisionDeadline revert; replay check runs before state checks.
- Fees: pull payments. Each verdict credits feePerReport to committee[i].feeRecipient for each set bit of includedMask (non-zero, no bit >= N), once per (jobId, round, index) via credited bitmap. claim() zeroes then transfers. refundFees(jobId) only when kernel status is Completed/Rejected/Expired, returns deposited - credited (+ kernel evaluator-fee delta) to the buyer once.
- settle(jobId): permissionless; needs approval and kernel status Submitted; calls complete(jobId, evidenceHash, ""); measures USDC balance delta; credits any kernel evaluator fee to the job leftover.
- rejectOnTimeout(jobId): permissionless after decisionDeadline if undecided; calls reject.
- Frontend later (jury board): escrow = getJob.budget while Funded/Submitted; status from getJob; config/committee/round/approvedHash/feeBalance from SQController views; verdict history from VerdictRecorded logs; show provider net if platform fee > 0.
- Wallet: ConnectKit (existing wagmi setup).

Events: JobRegistered(jobId, buyer, verdictAuthority, policyHash, participantSnapshotHash, revisionLimit, decisionDeadline, feePerReport, deposited, seedBlock, selectionSeed); CommitteeSelected(jobId, seedBlock, selectionSeed, evaluatorIds[], feeRecipients[]); VerdictRecorded(jobId, round, kind, effectiveKind, deliverable, evidenceHash, reportsHash, deficiencyHash, includedMask, digest); FeeCredited(jobId, round, index, recipient, amount); RevisionRequested(jobId, newRound, evidenceHash); RevisionLimitReached(jobId, round); DeliverableApproved(jobId, deliverable, evidenceHash); JobSettled(jobId, completed, reason); TimeoutRejected(jobId); KernelEvaluatorFeeReceived(jobId, amount); FeesClaimed(account, amount); FeesRefunded(jobId, buyer, amount).

Test plan:
- Mocks mirror the verified ABI (9-field Job, no deliverable getter, evaluator-only complete/reject, fee BPs, expiry refund), 6-decimal mock USDC, malicious-recipient mock.
- Registration: happy path (exact deposit, seed event); wrong caller/evaluator/hook/terminal job; bad committee (empty, too large, zero recipient, duplicate id); deadline >= expiredAt; double register; registration SUCCEEDS with a non-zero kernel evaluatorFeeBP (and settle then credits the delta to the buyer leftover). Seed: seedBlock == block.number reverts, seedBlock in the future reverts, 257 blocks old reverts, exactly 256 old succeeds (vm.roll), emitted selectionSeed equals keccak256(abi.encode(jobId, blockhash(seedBlock))), both seedBlock and seed emitted. Verdict: a tampered reportsHash or deficiencyHash invalidates the signature, and both appear in VerdictRecorded.
- Verdicts: valid sig, wrong signer, wrong domain/chain, tampered policy/snapshot, ERC-1271; ACCEPT needs Submitted; REVISE keeps Funded; REVISE on Submitted reverts; REVISE at limit becomes REJECT + refund; REJECT in Funded and Submitted; REJECT in Open reverts atomically with no fees credited; idempotent replay; conflict/wrong-round/after-decision/after-deadline revert.
- Settle: provider paid net of platform fee; reverts before ACCEPT, after expiry, on second call; kernel evaluator-fee delta goes to leftover.
- Fees: masks {0},{1},{0,1}, invalid and zero masks; no double credit; claim zeroes, second claim reverts, reentrant recipient fails; blocklisted recipient does not block others; refund only when terminal, once, correct amount after Completed/Rejected/Expired/timeout.
- Invariants/fuzz: USDC balance == unclaimed balances + unrefunded leftovers; credited <= deposited; each (job, round, index) credited at most once; round <= limit; fuzz fee/limit/masks/orderings.
- Fork tests (Arc RPC, env-flagged) against 0x0747...4583: full accept and reject lifecycles; log platformFeeBP/evaluatorFeeBP/platformTreasury and admin role; prank admin to set a non-zero evaluator fee; claimRefund vs decisionDeadline race; blocklisted address 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 as fee recipient. Plain anvil cannot reproduce Arc's blocklist or native-USDC behavior.

### Files to Create/Modify
1. contracts/SQController.sol: registration, EIP-712 verdicts, settle, timeout reject, fee ledger, claim, refund.
2. contracts/interfaces/IAgenticCommerce.sol: minimal kernel interface (Job, JobStatus, getJob, complete, reject, fee getters).
3. contracts/interfaces/ISQController.sol: structs, enums, events, errors.
4. contracts/libraries/SQVerdict.sol: typehash and hashing.
5. contracts/test/mocks/MockAgenticCommerce.sol, MockUSDC.sol, MaliciousRecipient.sol: faithful mocks.
6. contracts/test/SQController.{Registration,Verdicts,Settle,Fees}.t.sol: unit tests.
7. contracts/test/SQController.Invariants.t.sol: solvency and once-only invariants.
8. contracts/test-integration/SQController.Fork.t.sol: tests against the real kernel.
9. contracts/script/DeploySQController.s.sol: deploy with kernel + USDC addresses.
10. foundry.toml: add arc_testnet RPC endpoint (https://rpc.testnet.arc.io).
11. scripts/sq-sign-verdict.ts: viem EIP-712 signer for demos/fork scripts.

### Build Sequence
1. Add Arc RPC endpoint; write interfaces and verdict library.
2. Write mocks from the verified ABI, including the missing deliverable getter.
3. Write SQController: registration + deposit, then verdicts + fee ledger, then settle, timeout reject, claim, refund.
4. Write unit tests and invariants; review and static-analyze the contract.
5. Write fork tests; read live kernel fee values.
6. Deploy to Arc testnet; run one full job on-chain.
7. Build the jury board UI.

### Done When
- [ ] Fork tests complete real accept and reject jobs through 0x0747...4583 with SQController as evaluator.
- [ ] Live platformFeeBP, evaluatorFeeBP, platformTreasury recorded.
- [ ] Idempotency, conflict and once-per-(job, round, index) crediting tested.
- [ ] Solvency invariant holds under fuzzing.
- [ ] Registration pulls exactly fee x N x (R+1) and emits the selection seed.
- [ ] Docs state the attest-after-submit trust assumption.

### Approved decisions
1. Deliverable binding: attest-after-submit; REVISE only while Funded; submitting is final and documented.
2. Kernel evaluator fee: no registration guard; balance-delta credit to the buyer's leftover; live fee values are logged in the fork test (step 5).
3. Verdict carries reportsHash and deficiencyHash, also in VerdictRecorded.
4. Seed derived from seedBlock/blockhash as above; both emitted.
5. rejectOnTimeout included.

### Build scope for this approval
Build sequence steps 1 to 4 ONLY (RPC endpoint, interfaces and library, mocks, SQController, unit tests and invariants, plus review and static analysis of the contract). STOP after step 4 and report for review. Do not write fork tests, deploy, or build the UI until the user approves. The mock must support nonzero platformFeeBP and evaluatorFeeBP so the delta path is unit-tested.

## Ready to build?
