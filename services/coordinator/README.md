# Coordinator

The minimal glue that runs a round. It replaces `cre/tools/report-board.ts` (same port and routes).

| Route | What |
|---|---|
| `POST /jobs` `{jobId, policy, snapshot}` | Register a job's policy and committee snapshot (exact JSON text; their hashes are what `registerJob` stores) |
| `GET /bundle?jobId=&round=` | Policy, snapshot and signed reports. Read by the evaluators and the CRE workflow |
| `POST /reports` | Evaluators post signed reports here |
| `GET /pages/:jobId/:round` | The delivered page, fetched by the evaluators |
| `POST /rounds` `{jobId, round, evidenceHash, html}` | **Draft round:** store the page → both judges score it → CRE → relay a REVISE/REJECT to Arc. Returns `PASS` when both judges accept |
| `POST /rounds/final` `{jobId, round, evidenceHash, submitTxHash}` | **After the seller submits on Arc:** CRE checks `JobSubmitted` and signs ACCEPT/REJECT → relay |
| `GET /events?jobId=&after=` | Event log for the UI: `deal-created`, `job-funded`, `job-registered`, `seller-started`, `seller-log`, `seller-writing`, `delivered`, `judge-0/1`, `cre` (with the scorecard), `verdict-onchain`, `fees-credited`, `submitted`, `paid` / `refunded` |

**Marketplace routes (used by the UI):**

| Route | What |
|---|---|
| `GET /agents?task=` | Worker catalog + judge committee (`agents.json`), and the focused worker picked by capability. Unsupported tasks return no match. |
| `POST /rubric/draft` `{task}` | Drafts `{brief, criteria}` with the configured 0G Router model (`qwen3.7-flash` by default); validated with `checkPolicy` (one retry). Needs `OG_API_KEY` |
| `POST /deals/prepare` → `/:prepId/created` → `/:jobId/register-call` → `/:jobId/registered` | Starts a deal **funded from the buyer's wallet**: each step returns ready-to-sign calls (createJob; approve + fund; approve fee deposit + registerJob) and checks Arc before the next. The coordinator signs only the hosted seller's `setBudget`, then starts the seller agent. Needs `.env.arc` (`SELLER_KEY`, `VERDICT_AUTHORITY_KEY`) and `SQ_CONTROLLER_ADDRESS`. Details: `docs/frontend-integration.md` |
| `POST /deals/:jobId/refund-fees-call` | The buyer's call to reclaim unused judge fees after the job ends |
| `POST /deals/:jobId/retry-worker` | Restart a persisted/failed worker when no worker process is active |
| `GET /deals`, `GET /deals/:jobId` | Deal list; one deal's policy, committee, txs, and per round: page URL, reports, CRE outcome + scorecard (survives restarts) |

The buyer always pays from their own wallet; the server holds only the hosted seller agent's key (it agrees to the price with `setBudget`) and the verdict signer.

## Worker services

- `page-agent` (`../seller`) creates compact landing pages.
- `contract-agent` (`../contract-agent`) uses the installed Circle/Arc skills to create reviewable Arc contract artifacts. It never deploys autonomously.
- `0g-agent` (`../0g-agent`) uses the official `0gfoundation/0g-agent-skills` checkout to create reviewable 0G project scaffolds. It never funds or deploys autonomously.
- `failure-agent` (`../failure-agent`) deterministically simulates an exhausted 0G 502 without making a paid model request. It exists only to demonstrate SQ rejection and refund recovery.

All workers use the same hosted provider wallet for the MVP and the same SQ revision/evaluation flow. Productive workers use the model declared in `agents.json`; `SELLER_DIRS` can override their local service directories.

If a worker exits unsuccessfully (including an exhausted 0G 502 retry), the deal becomes `failed` immediately and the coordinator submits a deterministic “no deliverable” failure artifact through Laya, Vela and CRE. A REJECT settles through `SQController` and refunds the buyer. If that evaluation path is also unavailable, the escrow remains protected by `rejectOnTimeout`; the UI shows the failure instead of leaving the job marked Working.

CRE runs through the CLI: `cre workflow simulate ./src/workflows/sq-verdict --target $CRE_TARGET --non-interactive --trigger-index 0 --http-payload <file>` in `CRE_DIR`, and the coordinator parses the "Workflow Simulation Result".

**Delivery to Arc:** if the CRE target writes through the forwarder (`config.write: true` + `CRE_BROADCAST=true`), the verdict is already onchain. Otherwise, with `RELAY_ENABLED=true`, the coordinator calls `SQController.submitVerdict(verdict, signature)`; the relay key only pays gas, and the contract checks the verdict authority's signature. With both off, verdicts are signed but not sent (offline mode).

## Run the loop locally (offline: no Arc)

```bash
# 1. coordinator (seeded with cre/ fixtures so the old scenarios still work)
cd services/coordinator && bun install && cp .env.example .env && bun run start

# 2. two evaluators (Jev for now)
cd services/evaluator && bun run start                                   # laya-2 on :8801 (from .env)
PORT=8802 EVALUATOR_ID=vela-1.judges.semanticquorum.eth EVALUATOR_PROFILE=0g-vela-teeml-v1 \
  EVALUATOR_REPORT_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a bun run start

# 3. a round (job 1 is in the fixtures)
curl -s localhost:8787/rounds -H 'content-type: application/json' -d '{
  "jobId":"1","round":0,"evidenceHash":"0x'$(printf '%064x' 1)'",
  "html":"<h1>Chai Corner</h1><p>Masala chai ₹20, ginger chai ₹25. Open 7am–9pm.</p><p>Pay by cash.</p>"}' | jq
```

Expect `REVISE` with `c3` (UPI) first. Send a page that mentions UPI as round 1 and expect `PASS`.

`EVALUATORS` maps each committee member's ENS id to its service URL. The vela key above is a public test key that matches the fixtures; never fund it.

## Against Arc

Set `CRE_TARGET=arc-settings` (and the deployed `sqController` in `cre/src/workflows/sq-verdict/config.arc.json`), then either `CRE_BROADCAST=true` (forwarder) or `RELAY_ENABLED=true` with `SQ_CONTROLLER_ADDRESS` and a funded `RELAY_PRIVATE_KEY`. Register the job with `POST /jobs` using the same policy and snapshot whose hashes went into `registerJob`.

## Tests

`bun test`: CRE output parsing, and rounds wired to the real evaluator code in-process (decisions API, CRE and relay mocked).
