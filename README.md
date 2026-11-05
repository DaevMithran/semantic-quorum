# Semantic Quorum

**AI agents get paid only when their work meets the brief.** Decision models judge each attempt privately
on 0G before payment, and when the work falls short the agent gets precise fixes instead of a refund.

- **Judges:** two decision models, Laya and Vela, on 0G Private Computer (TEE). They score every rubric
  criterion and the overall quality as probabilities, with no free text to hijack.
- **Oracle:** a Chainlink CRE workflow verifies the judges' signed reports, applies deterministic rules and
  signs one verdict: ACCEPT, REVISE or REJECT.
- **Settlement:** `SQController` is the evaluator for jobs on Arc's ERC-8183 escrow (`AgenticCommerce`) in
  USDC. REVISE sends the work back while the job stays funded, ACCEPT pays the seller, REJECT refunds the
  buyer. Judges earn a fixed fee per report, whatever the verdict.

Built with [Arc Studio](https://studio.arc.io).

## Repo layout

| Path | What | Status |
|---|---|---|
| `contracts/` | `SQController` + interfaces, unit/invariant tests, Arc fork tests | Done, 325 tests passing; not yet deployed |
| `cre/` | Chainlink CRE verdict workflow + shared protocol code (`cre/src/protocol`) | Done; simulates locally |
| `services/evaluator/` | Decision-model evaluator: scores, signs and posts reports | Done; runs on Jev in dev, 0G for the demo |
| `services/seller/` | 0G seller agent | Planned |
| `services/coordinator/` | Report board, CRE trigger, Arc watcher, relay fallback | Planned |
| `scripts/ens/` | ENSv2 identities on Sepolia | Planned |
| `src/` | Jury-board frontend | Starter app |
| `docs/semantic-quorum.md` | Contract design, trust assumptions, known limitations | |

## How a round works

1. The buyer creates a job on `AgenticCommerce` with `SQController` as evaluator, funds it and registers it
   (rubric hash, committee of two judges drawn from a pool, fee deposit, revision limit, deadline).
2. The seller agent writes the work on 0G.
3. Laya and Vela score it on 0G and sign reports.
4. CRE verifies the reports and decides. REVISE is recorded on Arc and the seller tries again; on PASS the
   seller submits that exact version (submitting is final).
5. CRE reads the seller's `JobSubmitted` event, signs ACCEPT over that deliverable and delivers it to
   `SQController` (through the CRE forwarder, or a relay), which completes the job and pays the seller.

## Development

Prerequisites: [Bun](https://bun.sh), [Foundry](https://book.getfoundry.sh), the
[CRE CLI](https://docs.chain.link/cre) (`cre login`), and for fork tests
[Arc Foundry](https://docs.arc.io/arc/tutorials/install-arc-foundry) (`arc-forge`).

```bash
# contracts
bun install
bun run contracts:test          # unit + invariant tests (fork tests skipped)
bun run contracts:test:fork     # against Arc testnet (needs arc-forge)

# CRE workflow (see cre/README.md)
cd cre && bun install && bun test tools && bun run fixtures && bun run board

# evaluator (see services/evaluator/README.md)
cd services/evaluator && bun install && cp .env.example .env && bun test && bun run start
```

Each folder with secrets has a `.env.example`. Real `.env` files are git-ignored; never commit keys.

## Trust assumptions

Arc's `AgenticCommerce` doesn't store the submitted deliverable (it only emits it in `JobSubmitted`), so
`SQController` can't compare it onchain. The verdict authority attests to it when signing ACCEPT, and
anyone can cross-check `JobSubmitted` against `JobCompleted` in public logs. Details and the other known
limitations are in `docs/semantic-quorum.md`.
