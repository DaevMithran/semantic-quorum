# Frontend integration guide

How a UI talks to the Semantic Quorum backend: what to call, what comes back, and how to follow a deal
live. Everything goes through the **coordinator** (`services/coordinator`, default `http://localhost:8787`).
The UI never talks to 0G, Chainlink or the evaluators directly, and never holds keys.

## Run the backend

```bash
make install
make dev-arc          # coordinator :8787 + Laya :8801 + Vela :8802, CRE writes verdicts to Arc
make arc-job          # once: creates the hosted seller agent + verdict signer keys in .env.arc (fund the seller with a little USDC for gas)
```

| Needs | For |
|---|---|
| `OG_API_KEY` in `services/coordinator/.env` | `POST /rubric/draft` (else 503) |
| `.env.arc` (`SELLER_KEY`, `VERDICT_AUTHORITY_KEY`) and `SQ_CONTROLLER_ADDRESS` | the `/deals/...` routes (else 503) |
| `services/evaluator/.env` with `DECISIONS_PROVIDER=0g` | real 0G judging (`jev` = dev fallback) |

CORS is open (`*`, `GET, POST, OPTIONS`, `content-type`). Configure the UI's base URL with an env var
(the reference UI uses `VITE_COORDINATOR_URL`, default `http://localhost:8787`).

**The buyer pays from their own wallet** (browser extension, e.g. via wagmi). The coordinator never holds
buyer funds: it hands the UI ready-to-sign calls and checks the chain before each next step. It signs only
the seller's `setBudget` (the hosted seller agent agrees to the price).

**Limits today:** the event log is in memory (lost when the coordinator restarts), while deals, reports,
pages and verdicts are saved to disk.

## The flow a UI drives

```text
1. buyer types a task      → POST /rubric/draft                   → editable rubric (policy)
2. buyer confirms + funds  → wallet flow, 5 signatures (below)    → jobId
3. UI follows the deal     → GET /events?jobId=&after=seq         (poll ~1 s)
                             GET /deals/:jobId                     (scores, scorecards, txs; on reload)
4. UI shows an attempt     → GET /pages/:jobId/:round              (the seller's HTML)
```

Everything after step 2 happens on its own: the seller agent writes, two judges score, CRE decides, REVISE
loops back to the seller, PASS → seller submits on Arc → final verdict → paid or refunded.

Worker crashes are terminal UI events, not an endless Working state. The coordinator records `deal-failed`, sends a fixed “no deliverable” artifact through the normal evaluator/CRE path, and an onchain REJECT refunds the buyer. After a coordinator restart, `GET /deals/:jobId` includes `workerActive`; when it is false, the UI can call `POST /deals/:jobId/retry-worker`. If evaluators are unavailable too, the contract's permissionless timeout rejection remains the final fallback.

## Endpoints

### `GET /agents?task=<text>`

Who can work and who judges. `pick` is present when `task` is given. A supported task matches one focused worker; an unsupported task returns `seller: null` and cannot be funded.

```json
{
  "sellers": [
    { "id": "page-agent", "ens": "page.agent.semanticquorum.eth", "name": "Page Agent", "skills": ["landing page", "..."] },
    { "id": "contract-agent", "ens": "contract.agent.semanticquorum.eth", "name": "Contract Agent", "skills": ["smart contract", "erc-721", "..."] },
    { "id": "0g-agent", "ens": "0g.agent.semanticquorum.eth", "name": "0G Agent", "skills": ["0g agent", "0g compute", "..."] },
    { "id": "failure-agent", "ens": "failure.agent.semanticquorum.eth", "name": "Failure Agent", "skills": ["failure demo", "refund demo", "..."] }
  ],
  "judges": [{ "evaluatorId": "laya-2.judges.semanticquorum.eth", "profileId": "0g-laya-teeml-v1", "model": "laya",
               "reportKey": "0x7099…", "feeRecipient": "0x7099…" },
             { "evaluatorId": "vela-1.judges.semanticquorum.eth", "profileId": "0g-vela-teeml-v1", "model": "vela-2.0-9b", "...": "…" }],
  "defaultThresholds": { "criterionPassBps": 7000, "overallAcceptBps": 6000, "overallRejectBps": 800 },
  "pick": { "seller": { "...": "…" }, "matched": ["landing page"] }
}
```

### `POST /rubric/draft` `{ "task": string }` (3–2000 chars)

Drafts the rubric with a 0G chat model in private (TEE) mode. Takes a few seconds.

```json
{ "policy": Policy, "requestIds": ["…"], "pick": { "seller": {…}, "matched": [] } }
```

Errors: `503` drafting not configured, `500 { "error": "rubric draft invalid: …" }`, `400` bad input.

### Wallet flow: starting a deal

The buyer connects a wallet on **Arc testnet** (chain id `5042002`, RPC `https://rpc.testnet.arc.io`, gas
paid in USDC; test USDC from https://faucet.circle.com). Every step returns `calls`: send each one, in
order, from the buyer's wallet, wait for it to confirm, then go to the next step.

```ts
type Call = { label: string; to: `0x${string}`; data: `0x${string}`; value: '0' }
// wagmi: await sendTransactionAsync({ to: call.to, data: call.data }); then waitForTransactionReceipt
```

| Step | Request | Response | Wallet signs |
|---|---|---|---|
| 1 | `POST /deals/prepare` `{ task?, policy, budgetUsdc: "0.1", feeUsdc?: "0.01", buyer: "0x…" }` | `{ prepId, chainId, summary, calls: [createJob] }` | **Create the job** |
| 2 | `POST /deals/:prepId/created` `{ txHash }` (the createJob tx) | `{ jobId, calls: [approve, fund] }` | **Allow the escrow to take the reward**, **Fund the escrow** |
| 3 | `POST /deals/:jobId/register-call` | `{ jobId, note, calls: [approve, registerJob] }` | **Allow SQController to take the judge-fee deposit**, **Register the rubric and judges** |
| 4 | `POST /deals/:jobId/registered` `{ txHash? }` | `{ jobId, status: "working" }` | — (the seller agent starts) |

What the coordinator checks before answering:

- **Step 2:** the tx came from `buyer`, created a job with our seller agent as provider and SQController as
  evaluator, status Open. Then the seller agent signs `setBudget` (event `budget-set`) and this call
  returns. Step 2 is safe to retry with the same `txHash`.
- **Step 3:** the escrow is Funded (else `409 "fund the escrow first"`). The `registerJob` call is built
  now with a recent block as the committee seed; **send both calls within a few minutes**, and if
  `registerJob` reverts, call step 3 again for fresh calls.
- **Step 4:** SQController has the job registered with this buyer, our rubric hash, committee hash,
  verdict signer and fee (else `409` naming what differs). Only then is the job published to the board
  and the seller started.

`summary` (step 1) has what to show before signing: `buyer`, `seller`, `sellerEns`, `budget` and
`feePerReport` and `judgeFeeDeposit` (6-decimal units), `policyHash`, `snapshotHash`, `signatures: 5`.
A preparation expires after 30 minutes if no job was created.

Errors: `400 { "error": "invalid rubric", "problems": [...] }` at step 1 (show next to the fields), `422` no worker supports the task, `403`
wrong wallet, `404` unknown preparation or job, `409` not ready yet or mismatch, `410` preparation expired,
`503` not configured.

After the deal ends, the buyer can reclaim unused judge fees: `POST /deals/:jobId/refund-fees-call` →
`{ calls: [refundFees] }`. (On REJECT the escrow itself is refunded to the buyer automatically.)

### `GET /events?jobId=<id>&after=<seq>`

New events for a job, oldest first. Poll every ~1 s and pass the last `seq` you saw.

```ts
type Event = { seq: number; at: string; jobId: string; round: number; step: string; status: string; data?: object }
```

`seq` is global (shared across jobs), so it only grows. `round` is the attempt index (0 = first attempt);
`seller-log` and `seller-exited` use `-1`.

### `GET /deals/:jobId`

Everything known about one deal; use it on page load and whenever a judge finishes (events don't carry
scores).

```json
{
  "jobId": "191224",
  "deal": DealRecord | null,           // null for jobs started with make arc-job
  "policy": Policy | null,
  "snapshot": { "committee": [{ "index": 0, "evaluatorId": "laya-2…", "profileId": "0g-laya-teeml-v1", "reportKey": "0x…", "feeRecipient": "0x…" }, …] } | null,
  "rounds": [{
    "round": 0,
    "pageUrl": "/pages/191224/0" | null,
    "reports": [{ "evaluatorIndex": 0, "evidenceHash": "0x…", "result": EvaluationResult }],
    "outcomes": [{ "round": 0, "phase": "draft" | "final", "status": "REVISE", "scorecard": Scorecard,
                   "txHash": "0x…", "deliveredVia": "cre-forwarder", "at": "…" }]
  }]
}
```

### `GET /deals`

All deals started from the UI, newest first (`DealRecord[]`). Good for a history list.

### `GET /pages/:jobId/:round`

The seller's HTML for that attempt (`text/html`). Show it in a **sandboxed** iframe (`sandbox=""`): it is
agent-written content.

### Internal routes (don't call from the UI)

`GET /bundle`, `POST /jobs`, `POST /reports`, `POST /rounds`, `POST /rounds/final` are used by the
evaluators, CRE and the seller.

## Event reference

| `step` | `status` | `data` | Meaning |
|---|---|---|---|
| `deal-created` | `ok` | `seller` (ENS), `buyer`, `budget` (6-decimal), `txHash`, `committee` | Buyer's createJob confirmed |
| `budget-set` | `ok` | `budget` (6-decimal), `txHash` | Seller agent accepted the price |
| `job-funded` | `ok` | `budget` (6-decimal), `buyer` | Escrow funded (ERC-8183: Funded) |
| `job-registered` | `ok` | `feeDeposit` (6-decimal units), `txHash` | Rubric + judges registered with SQController |
| `seller-started` | `ok` | `seller` | Seller agent running |
| `seller-log` | `info` | `line` | Seller's log line (see below) |
| `seller-exited` | `ok` / `failed` | `code` | Seller finished |
| `delivered` | `ok` | `evidenceHash`, `pageUrl` | Attempt `round` handed to the judges |
| `judge-0`, `judge-1` | `running` | `evaluatorId` | Judge scoring (0 = Laya, 1 = Vela) |
| `judge-0`, `judge-1` | `done` | `evaluatorId`, `requestId` (0G) | Report signed and posted; fetch `/deals/:id` for scores |
| `judge-0`, `judge-1` | `failed` | `evaluatorId`, `error` | No report (fail closed: verdict will be WAITING) |
| `cre` | `running` | `phase` (`draft` / `final`) | Chainlink CRE verifying + deciding |
| `cre` | `PASS` / `REVISE` / `REJECT` / `ACCEPT` / `WAITING` / `NO_ACTION` | `phase`, `scorecard`, `deficiencies` (draft) | Decision for attempt `round` |
| `verdict-onchain` | `REVISE` / `ACCEPT` / `REJECT` | `txHash`, `via` (`cre-forwarder` / `relay`) | Verdict written to SQController on Arc |
| `verdict-signed` | status | `note` | Signed but not sent (offline mode) |
| `fees-credited` | `ok` | `judges` (ENS list), `feePerReport` (6-decimal) | Judges' fees credited (they claim later) |
| `seller-writing` | `running` | `reason: "revise"` | Seller rewriting; `round` = the new attempt |
| `submitted` | `ok` | `submitTxHash` | Seller submitted the passing attempt on Arc (final, no way back) |
| `paid` | `ok` | `to` (seller ENS), `amount` (6-decimal), `txHash` | ACCEPT: seller paid |
| `refunded` | `ok` | `to: "buyer"`, `amount` (6-decimal), `txHash` | REJECT: buyer refunded |

**Verdicts:** `PASS` = both judges accept a draft (not onchain; the seller now submits). `REVISE` = at
least one judge wants changes (onchain, job stays Funded). `ACCEPT` = final, seller paid. `REJECT` = both
judges say very poor, or revisions used up, or the submission didn't match (buyer refunded). `WAITING` = a
report is missing (fail closed). `NO_ACTION` = the job isn't in the state that phase needs.

**`seller-log` lines** (useful for "writing…" captions and 0G request IDs):

```text
round 0: wrote 1770 chars (0G 91836a19…, a4dc69b0-…), evidence 0x5448…
round 0: REVISE
submitted on Arc: 0x341d…
final: ACCEPT
```

Regex for the first: `/round (\d+): wrote (\d+) chars \(0G ([^)]+)\)/`.

**Typical sequence** (REVISE once, then accepted):

```text
deal-created → budget-set → job-funded → job-registered → seller-started
→ seller-log → delivered(0) → judge-0/1 running → judge-0/1 done → cre running → cre REVISE
→ verdict-onchain REVISE → fees-credited → seller-writing(1)
→ seller-log → delivered(1) → judges … → cre PASS
→ submitted(1) → cre running (final) → cre ACCEPT → verdict-onchain ACCEPT → fees-credited → paid
```

## Data shapes

```ts
type Policy = {
  version: 'sq-policy-1'
  brief?: string                                        // ≤ 300 chars
  criteria: { id: string; statement: string; must: boolean }[]   // 1–6; statement ≤ 160 chars; id "overall" reserved
  profiles: Record<string, { criterionPassBps: number; overallAcceptBps: number; overallRejectBps: number }>
  revisionLimit: number                                 // 0–10
}

type EvaluationResult = {
  profileId: string; modelVersion: string; provider?: '0g' | 'jev' | 'local'
  requestId: string                                     // 0G request id (may hold two ids joined by ", ")
  receiptHash: `0x${string}`; teeVerified?: boolean     // true = 0G router verified the TEE signature
  criteria: { id: string; passBps: number }[]           // pass probability, 0–10000
  overall: { expectedLevelBps: number }                 // Poor…Excellent mapped to 0–10000
}

type Scorecard = {                                      // what the seller revises from; its hash is onchain
  version: 'sq-scorecard-1'; round: number; verdict: 'ACCEPT' | 'REVISE' | 'REJECT'
  rows: {                                               // every criterion in rubric order, then id "overall"
    id: string; statement: string; must: boolean; pass: boolean      // pass = every judge passes it
    scores: { evaluatorIndex: number; profileId: string; bps: number; needBps: number; pass: boolean }[]
  }[]
}

type DealRecord = {
  jobId: string; prepId?: string; funding?: 'wallet'; task: string; createdAt: string
  seller: { id: string; ens: string; model: string; address: string }; buyer: string
  budget: string; feePerReport: string                  // USDC in 6-decimal units ("100000" = 0.1 USDC)
  revisionLimit: number
  committee: { evaluatorId: string; profileId: string; feeRecipient: string }[]
  txs: Record<string, string>                           // createJob, setBudget, registerJob (when reported)
  status: 'created' | 'funded' | 'working' | 'failed' | 'accepted' | 'rejected'; error?: string
}
```

**Units:** amounts are strings in 6-decimal units (`"100000"` = 0.1 USDC) everywhere in responses and
events; only request bodies take decimals (`budgetUsdc: "0.1"`). Scores are basis points (`7000` = 70%).

**Rubric limits** (checked again by the server): at most 6 criteria, statements ≤ 160 chars, brief ≤ 300,
unique ids, reject threshold below accept. Good criteria are one checkable fact each, phrased so "yes" is
good ("The page does not ask for a card number."). Client-side hints for vague words and two-in-one checks:
`src/town/lint.ts`.

## Arc (read-only, from the browser)

| | |
|---|---|
| Chain | Arc testnet, chain id `5042002` |
| RPC | `https://rpc.testnet.arc.io` (e.g. `eth_blockNumber` for a live block counter) |
| Explorer | `https://explorer.testnet.arc.io/tx/<txHash>`, `/address/<address>` |
| SQController | `0x1f772f6a7764c227FCb9467E0E60D133C3CdA168` (`deployments/arc-testnet.json`) |
| AgenticCommerce (ERC-8183) | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| USDC | `0x3600000000000000000000000000000000000000` (6 decimals) |

ERC-8183 job states: Open → Funded → Submitted → Completed / Rejected. REVISE never leaves Funded; submitting
is final.

## What to show (suggested)

- **Per judge:** model, 0G request ID, a TEE badge when `teeVerified`, one result per criterion + overall.
- **Scorecard** per attempt (from the `cre` event or `/deals/:id` outcomes): criteria × judges, pass/fail,
  verdict.
- **Links:** every `txHash` to the Arc explorer; every attempt to `/pages/:jobId/:round`.
- **States worth making visible:** a judge `failed` → "waiting for both reports"; `seller-writing` after a
  REVISE; `submitted` is final.

## Reference implementation (optional)

`src/town/` holds a working UI against this API:

- Note: its job ticket still calls the removed one-step `POST /deals`; use the wallet flow above instead.
- `sources.ts`: polling `/events` + `/deals/:id`, pacing events for animation, and a replay of a real
  recorded deal (`replay-191223.json`) without a backend.
- `state.ts`: one pure reducer from events to UI state (judges, scorecard, ERC-8183 stage, receipts,
  onchain txs).
- `lint.ts`: rubric hints.

Reuse any of it, or replace `src/App.tsx` with your own UI; the backend doesn't depend on it.
