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

**Arc testnet:** `SQController` at [`0x1f772f6a7764c227FCb9467E0E60D133C3CdA168`](https://explorer.testnet.arc.io/address/0x1f772f6a7764c227FCb9467E0E60D133C3CdA168).

## Repo layout

| Path | What | Status |
|---|---|---|
| `contracts/` | `SQController` + interfaces, unit/invariant tests, Arc fork tests | Done, 325 tests passing; **deployed on Arc testnet** (see `deployments/arc-testnet.json`) |
| `cre/` | Chainlink CRE verdict workflow + shared protocol code (`cre/src/protocol`) | Done; simulates locally |
| `services/evaluator/` | Decision-model evaluator: scores, signs and posts reports | Done; one-line switch between 0G (TEE) and Jev (dev fallback) |
| `services/seller/` | Page Agent: writes a compact landing page on 0G, revises, submits on PASS | Done; tested with mocks |
| `services/contract-agent/` | Contract Agent: loads Circle/Arc skills and creates a reviewable contract artifact; never deploys autonomously | Done; tested with mocks |
| `services/0g-agent/` | 0G Agent: loads official 0G agent skills and creates a reviewable project scaffold; never funds or deploys autonomously | Done; tested with mocks |
| `services/coordinator/` | Report board, round runner (judges → CRE), relay to Arc, event log | Done; runs the full loop locally |
| `scripts/arc-job.ts` | Creates, funds and registers one real job on Arc testnet for the CRE forwarder path | Done |
| `scripts/ens/` | ENSv2 identities on Sepolia | Planned |
| `src/` | Jury-board frontend | Starter app |
| `docs/semantic-quorum.md` | Contract design, trust assumptions, known limitations | |

## How a round works

1. The buyer creates a job on `AgenticCommerce` with `SQController` as evaluator, funds it and registers it
   (rubric hash, committee of two judges drawn from a pool, fee deposit, revision limit, deadline).
2. The coordinator selects Page Agent, Contract Agent, or 0G Agent by capability; the selected worker writes the work on 0G.
3. Laya and Vela score it on 0G and sign reports.
4. CRE verifies the reports and decides. REVISE is recorded on Arc and the seller tries again; on PASS the
   seller submits that exact version (submitting is final).
5. CRE reads the seller's `JobSubmitted` event, signs ACCEPT over that deliverable and delivers it to
   `SQController` (through the CRE forwarder, or a relay), which completes the job and pays the seller.

## Development

Prerequisites: [Bun](https://bun.sh), [Foundry](https://book.getfoundry.sh), the
[CRE CLI](https://docs.chain.link/cre) (`cre login`), and for fork tests
[Arc Foundry](https://docs.arc.io/arc/tutorials/install-arc-foundry) (`arc-forge`).

**Quick start (Makefile):**

```bash
make install        # all dependencies
make env            # create missing .env files from the examples, then fill them in
make test           # every test suite (contracts need Foundry)
make dev            # coordinator :8787 + laya judge :8801 + vela judge :8802 (Ctrl-C stops all)
make round-revise   # in another terminal: expect REVISE (no UPI on the page)
make round-pass     # expect PASS

# on Arc testnet: CRE writes verdicts through the CRE forwarder (no relay)
make dev-arc                 # same stack, pointed at the deployed SQController
make arc-job                 # 1st run: makes dev wallets in .env.arc and prints what to fund; 2nd run: job N
make round-revise JOB=N      # REVISE lands on Arc via the forwarder
make seller JOB=N            # seller agent on 0G: write → revise → submit on PASS → ACCEPT
```

**Judges' provider:** `DECISIONS_PROVIDER=0g` or `jev` in `services/evaluator/.env` switches both judges
(keys and models stay in the file). The demo uses `0g`; Jev is the fallback while 0G is unavailable.

**Step by step:**

```bash
# clone with the forge-std submodule (lib/forge-std, pinned to v1.16.2)
git clone --recursive <repo-url>   # already cloned? run: git submodule update --init

# contracts
bun install
bun run contracts:test          # unit + invariant tests (fork tests skipped)
bun run contracts:test:fork     # against Arc testnet (needs arc-forge)

# CRE workflow (see cre/README.md)
cd cre && bun install && bun test tools && bun run fixtures && bun run board

# evaluator (see services/evaluator/README.md)
cd services/evaluator && bun install && cp .env.example .env && bun test && bun run start

# coordinator: runs a whole round (see services/coordinator/README.md)
cd services/coordinator && bun install && cp .env.example .env && bun test && bun run start
```

Each folder with secrets has a `.env.example`. Real `.env` files are git-ignored; never commit keys.

## Deploy to Arc testnet

Plain Foundry; no Arc Studio needed for deployment.

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup   # if Foundry isn't installed
cast wallet import sq-deployer --interactive               # encrypted keystore; never pass keys as flags
# fund that address with testnet USDC (gas on Arc is USDC): https://faucet.circle.com
make deploy
```

`contracts/script/DeploySQController.s.sol` deploys against Arc's `AgenticCommerce` (`0x0747…4583`), USDC
(`0x3600…0000`) and the CRE forwarders (simulation `0x6E9E…eDc1`, production `0x76c9…5E62`), and refuses to run on
any chain other than Arc testnet (5042002). Afterwards, put the printed address in
`cre/src/workflows/sq-verdict/config.arc.json` (`sqController`) and `services/coordinator/.env`
(`SQ_CONTROLLER_ADDRESS`).

## Trust assumptions

Arc's `AgenticCommerce` doesn't store the submitted deliverable (it only emits it in `JobSubmitted`), so
`SQController` can't compare it onchain. The verdict authority attests to it when signing ACCEPT, and
anyone can cross-check `JobSubmitted` against `JobCompleted` in public logs. Details and the other known
limitations are in `docs/semantic-quorum.md`.
