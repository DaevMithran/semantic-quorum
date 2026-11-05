# Semantic Quorum: design notes

A reusable evaluator for Arc's deployed ERC-8183 `AgenticCommerce` (Arc testnet,
`0x0747EEf0706327138c69792bF28Cd525089e4583`, an ERC1967/UUPS proxy over the verified
implementation `0xA316fd02827242D537F84730F8a37D0BA5fd351a`). Jobs are created there with
`evaluator = SQController` and `hook = address(0)`. A pinned `verdictAuthority` signs
EIP-712 verdicts (ACCEPT / REVISE / REJECT) from an offchain AI committee. SQController
turns them into `complete` / `reject` on the kernel and holds and pays the per-report USDC
evaluator fees itself. It holds no job escrow. It is non-upgradeable and has no owner.

## Job lifecycle

1. Buyer creates the job on the kernel (`evaluator = SQController`, no hook), the provider sets
   the budget, and the buyer funds it.
2. Buyer calls `registerJob`. The kernel job must be **Funded with a budget above zero**. Open,
   Submitted, terminal and zero-budget jobs revert. Registration is one-shot and immutable.
3. The committee works off-chain. REVISE verdicts may be issued while the job is Funded.
4. The provider calls `submit` on the kernel when ready for a final verdict.
5. The authority signs ACCEPT or REJECT. **ACCEPT completes the kernel job in the same
   transaction.** REJECT rejects it in the same transaction.

Fund and register in a single transaction (for example from a client contract). Otherwise the
provider can `submit` between the two, which makes the job unregisterable; the job is then
stranded until the kernel's expiry refund. This is covered by the unit tests with a client
contract; Arc's `Multicall3From` should work the same way but is not tested here.

## Submitting is final

The kernel has no resubmit and no Submitted -> Funded transition. So:

- REVISE exists only while the job is **Funded**, as a pre-submit draft-review loop.
- Once the provider calls `submit`, the job can only be **ACCEPTed** or **REJECTed**.
  REVISE on a Submitted job reverts.
- A REVISE at `revisionLimit` is executed as REJECT (the event records both the signed
  and the effective kind). Rounds run 0..`revisionLimit`, so at most `revisionLimit + 1`
  reports are paid, which is what the buyer's deposit covers.
- Providers should call `submit` only when they are ready for a final verdict.

## Attest-after-submit (trust assumption)

The deployed kernel's `getJob` returns nine fields and **no deliverable**; the deliverable
exists only in the `JobSubmitted` event, which a contract cannot read. Therefore:

- ACCEPT is valid only while the kernel is Submitted. The deliverable is immutable from
  then on.
- The verdict authority attests that the deliverable it read from `JobSubmitted` equals
  the `deliverable` it signs. SQController checks status and approval, not equality.
- `evidenceHash` is passed as the `reason` to `complete`, so the kernel's `JobCompleted`
  event sits next to `JobSubmitted` for anyone to cross-check.
- A wrong hash in a signed ACCEPT is an authority fault the contract cannot detect.
- `reportsHash` and `deficiencyHash` are opaque commitments with no onchain meaning.

## Deadlines and the real kernel's expiry behavior

Observed on the real kernel (fork tests and live read-only simulations):

- `complete` and `reject` have **no expiry check**. They still succeed after `expiredAt` until
  someone calls `claimRefund`.
- `claimRefund` is permissionless once `block.timestamp >= expiredAt`. After it, the job is
  Expired and both `complete` and `reject` revert.
- `createJob` requires `expiredAt` more than 5 minutes ahead; `fund` reverts after `expiredAt`.

SQController therefore never relies on the kernel to stop late verdicts:

- `registerJob` requires `job.expiredAt >= decisionDeadline + MIN_SETTLE_BUFFER` (1 hour), and
  `decisionDeadline` in the future.
- No verdict is accepted after `decisionDeadline`, so none can apply once `claimRefund` is
  possible.
- `rejectOnTimeout` is permissionless after `decisionDeadline` and rejects an undecided Funded
  or Submitted job, refunding the buyer through the kernel.

## Kernel fees and fee caps

The kernel is admin-controlled and may charge `platformFeeBP` and `evaluatorFeeBP` on
`complete`. At the pinned fork block (70872676) both are **0**, and the platform treasury
(`0xcBe5B97a069be3E4B5398663790731fb76aB620D`) is also the holder of the admin role. The ABI has
no fee-changed events, so a change cannot be audited from logs.

- The platform fee reduces the provider's net. The evaluator cut is paid to SQController (the
  job's evaluator) and is credited to the **buyer's refundable leftover**, so a higher evaluator
  fee shifts provider money to the buyer.
- `registerJob` therefore takes `maxPlatformFeeBP` and `maxEvaluatorFeeBP` as job terms (each at
  most 10000, sum at most 10000), visible to the provider before work starts.
- Right before `complete`, SQController reads the live `platformFeeBP()` and `evaluatorFeeBP()`
  and reverts the whole ACCEPT if either exceeds its cap. It emits `CompletionFeesApplied` with
  the live values it used. REJECT, REVISE and `rejectOnTimeout` are unaffected by the caps.
- If fees rise above the caps, the authority can retry ACCEPT after they fall; otherwise
  `rejectOnTimeout` refunds the buyer.
- Registration does not read the live fees and does not revert on non-zero fees.

## Verdicts

- EIP-712 `Verdict(jobId, round, kind, deliverable, evidenceHash, reportsHash, deficiencyHash,
  includedMask, policyHash, participantSnapshotHash)`. The policy and snapshot hashes come from
  the registered config, so a signature over different values is invalid. The domain binds the
  chain and the contract. ERC-1271 authorities are supported. Anyone can relay a verdict.
- The signature is verified **before** the replay check. A replay of a recorded verdict with a bad
  signature reverts; an identical valid replay is a silent no-op; a different valid verdict for
  the same round reverts with `ConflictingVerdict`.
- If the kernel call (or fee-cap check) fails, the whole verdict reverts, including fee credits.
- `settle` remains only as a defensive retry for an accepted-but-unsettled job. Through the
  public interface an accepted job is always already settled.

## Selection seed

`registerJob` takes `seedBlock` and computes
`selectionSeed = keccak256(abi.encode(jobId, blockhash(seedBlock)))`, requiring
`seedBlock < block.number` and `block.number - seedBlock <= 256`. Both are emitted.

- Arc blocks are sub-second, so the 256-block window is only a few minutes.
- The registrant picks `seedBlock` among the last 256 blocks, so it can grind up to about
  256 seeds. Arc's `PREVRANDAO` is 0 and there is no VRF: the seed is not free-form, but
  it is not unbiasable either.
- The pool draw is offchain; the contract cannot verify that the committee matches it.

## Fees

- Registration pulls `feePerReport x committeeSize x (revisionLimit + 1)` USDC from the buyer.
- Each verdict carries an `includedMask` over the registered committee and credits
  `feePerReport` to each included member's registered `feeRecipient`, once per
  `(jobId, round, index)`. Verdicts never carry payout addresses.
- `claim()` pays the caller's balance (pull payments, so a blocklisted recipient only
  blocks itself). `refundFees(jobId)` returns the leftover, plus any kernel evaluator cut, to the
  buyer once the kernel job is Completed, Rejected or Expired.

## Known limitations

- **Buyer blocklisted after funding (accepted, documented).** The kernel pays rejection and expiry
  refunds to the job's client. If the client is blocklisted by the USDC issuer after funding, the
  kernel's refund transfer reverts. Consequently a REJECT verdict, `rejectOnTimeout` and the
  kernel's own `claimRefund` all revert until the buyer is unblocklisted, and `refundFees` cannot
  pay the buyer. REJECT stays all-or-nothing: the final report's fee credits are rolled back along
  with the failed kernel call. The escrow is stuck in the kernel regardless of SQController. ACCEPT
  is unaffected. Everything recovers once the buyer is unblocklisted (tested on a fork).
- A blocklisted fee recipient cannot `claim`, but crediting, other recipients and refunds are
  unaffected.
- The kernel is admin-upgradeable (UUPS); its behavior can change under SQController.
- The real kernel lets a provider `submit` from Open with budget 0, and `fund` accepts budget 0.
  Registration requires Funded with a non-zero budget, so such jobs can never be registered.
- Providers should read the registered config (authority, policy, committee, deadline, fee caps)
  before starting work on a job.
- USDC is used only through its 6-decimal ERC-20 interface, never `msg.value`.

## Testing

- `bun run contracts:test` runs the unit and invariant tests with a faithful mock of the kernel.
  Fork tests are skipped unless `ARC_FORK=1`.
- `bun run contracts:test:fork` runs the fork tests against the real kernel and real USDC at a
  pinned block. It needs Arc Foundry (`arc-forge`) with `--network arc`, because stock Foundry
  cannot run Arc's native-coin precompiles (USDC `transfer` and the blocklist).
