# Evaluator service

Scores a seller's deliverable with a decision model (Laya or Vela), signs the result as an EIP-712
report and posts it to the report board, where the CRE workflow picks it up.

One codebase, one process per pool member (`laya-1..3`, `vela-1..3`).

## Providers: swap with config only

The decisions API uses the TypeSafe Jev request shape (a `state` plus typed `questions`). 0G's Laya and
Vela use the same shape, so switching provider means changing four env vars:

| Provider | `DECISIONS_BASE_URL` | `DECISIONS_PATH` | Notes |
|---|---|---|---|
| `jev` (dev now) | `https://api.typesafe.ai` | `/v1/systemone` | model `jev-1.14.0`; Jev API key; scores labelled `provider: "jev"` |
| `0g` (demo) | `https://router-api.0g.ai` | `/v1/decisions` (confirm) | Private-mode key; model IDs from `GET /v1/models` |
| `local` | `http://127.0.0.1:8000` | `/v1/systemone` | `laya-server` on your Mac, no key |

Get the model ID with `curl -s $DECISIONS_BASE_URL/v1/models -H "Authorization: Bearer $KEY"`.

**The demo and prize submission must use `0g`.** Dev scores carry `provider: "jev"` or `"local"` in every
report so they can never be mistaken for 0G output.

## Run

```bash
cd ../../cre && bun install && cd -     # shared protocol code lives in cre/src/protocol
bun install
cp .env.example .env                    # fill in identity, key and provider
bun run start                           # :8801
```

A second evaluator on another port: `PORT=8802 EVALUATOR_ID=vela-1... EVALUATOR_PROFILE=0g-vela-teeml-v1 EVALUATOR_REPORT_KEY=... bun run start`.

**Evaluate an attempt** (normally the coordinator calls this):

```bash
curl -s localhost:8801/evaluate -H 'content-type: application/json' -d '{
  "jobId": "1", "round": 0, "evaluatorIndex": 0,
  "evidenceHash": "0x…", "pageUrl": "http://localhost:8787/pages/1-0.html"
}'
```

The job and round must already be on the board (`POST /jobs` with the policy and snapshot), and this
evaluator must be the committee member at `evaluatorIndex`.

## What it does

1. Fetches the policy and committee for the job from the board, and checks it is the registered member at
   that index (ENS ID, profile, report key, chain, controller).
2. Extracts the page's **visible text** plus section headings. Scripts, comments and hidden elements are
   dropped, since hidden text is a common injection channel.
3. **Token budget:** if the text doesn't fit (`TOKEN_BUDGET`; Laya 512, Vela 16384), it **fails closed**
   and publishes nothing. Keep demo pages short.
4. One decisions call: a `noul` question per criterion, one `score` question over Poor/Fair/Good/Excellent,
   and (Vela on 0G, `ENABLE_SPANS=true`) a `span` question.
5. Maps the answers to integers: `passBps = round(noul × 10000)`, `expectedLevelBps = round(score ÷ 3 × 10000)`.
   Records the provider request ID, a hash of the raw response (`receiptHash`) and any attestation header.
6. Signs the EIP-712 `EvaluatorReport` and posts it to the board.

**Why it signs:** the provider's receipt shows *which model ran*; the signature shows *which judge vouches
for the report* and that nobody changed it in transit. CRE only counts reports signed by the job's two
registered judges, and fees go to those judges.

## Tests

`bun test`: text extraction (including a hidden-div injection), score mapping, the decisions client,
and an end-to-end round with a mock decisions API and board: v1 without UPI → REVISE on c3, v2 → ACCEPT,
reports verified exactly as CRE verifies them, wrong committee slot refused, over-budget input fails closed.
