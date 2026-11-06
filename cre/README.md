# Semantic Quorum: CRE verdict workflow

Chainlink CRE workflow that turns two signed evaluator reports (Laya + Vela) into one signed
Semantic Quorum verdict and delivers it to `SQController` on Arc testnet.

```text
coordinator --HTTP trigger--> sq-verdict workflow
                                1. GET report board: policy, snapshot, signed reports
                                2. verify each EIP-712 report (snapshot report key, evidence, policy)
                                3. vote + committee rules (both ACCEPT -> ACCEPT, both REJECT -> REJECT, else REVISE)
                                4. Arc reads: job status; final phase: decode JobSubmitted from the submit tx
                                5. sign Verdict as verdictAuthority (EIP-712, matches SQController)
                                6. write via CRE forwarder -> SQController.onReport      (config.write = true)
                                   or return {verdict, signature} -> relay -> SQController.submitVerdict
```

**Phases**
- `draft` (job `Funded`): committee ACCEPT returns `PASS` (no onchain write; ACCEPT is only valid after submit). REVISE / REJECT are written.
- `final` (job `Submitted`): ACCEPT only if the committee accepts **and** the deliverable in the seller's `JobSubmitted` event equals the evaluated `evidenceHash`; otherwise REJECT.
- Fewer valid reports than committee members returns `WAITING` (fail closed, nothing signed).

## Layout

```text
project.yaml, secrets.yaml      CRE project config (targets: local-settings, arc-settings)
src/workflows/sq-verdict/       the workflow (main.ts, workflow.yaml, config.local.json, config.arc.json)
src/protocol/                   shared types, EIP-712 definitions and decision rules (no CRE imports)
tools/make-fixtures.ts          signed test reports for 7 scenarios + payloads/
tools/report-board.ts           minimal report board on :8787 (stand-in for the coordinator)
tools/protocol.test.ts          rule tests + check that the Verdict digest matches SQController
```

## Run it locally (offline scenarios)

```bash
bun install
bun test tools                  # 12 tests
bun run fixtures                # writes fixtures/board.json and payloads/*.json
bun run board                   # keep running in another terminal
cp .env.example .env            # set SQ_VERDICT_AUTHORITY_KEY (any test key for offline runs)
cre login                       # simulation needs a CRE account

cre workflow simulate ./src/workflows/sq-verdict --target local-settings \
  --non-interactive --trigger-index 0 --http-payload payloads/revise.json
```

| Payload | Expected |
|---|---|
| `revise.json` | REVISE: both models flag c3 (UPI) |
| `pass.json` | PASS: seller may submit |
| `accept-final.json` | ACCEPT over the submitted deliverable |
| `disagree.json` | REVISE: Laya accepts, Vela flags c2 |
| `missing.json` | WAITING: only one report |
| `reject.json` | REJECT: both overall scores below the reject threshold |
| `forged.json` | WAITING: Vela slot signed by the wrong key |

`local-settings` uses `chainChecks: false` and `write: false`: no Arc reads, no transactions.

## Run it against Arc

1. Deploy `SQController` (with `onReport` for forwarder delivery) and put its address in
   `config.arc.json` as `sqController`.
2. Regenerate fixtures bound to it with `CONTROLLER=0x... bun run fixtures`, and register the printed
   `policyHash`, `participantSnapshotHash` and the verdict authority's address in `registerJob`.
3. Check `jobSubmittedEvent` in `config.arc.json` against the verified AgenticCommerce ABI on
   testnet.arcscan.app. The indexed fields must match exactly.
4. **Relay path (works today):** `write: false`, simulate with `--target arc-settings`, then call
   `SQController.submitVerdict(verdict, signature)` with the output.
5. **CRE write path:** set `write: true`, put a funded Arc testnet key in `CRE_ETH_PRIVATE_KEY` in `.env`,
   and add `--broadcast`. In simulation the report goes through Arc's MockKeystoneForwarder; `SQController`
   still checks the verdict signature, so the mock can't inject unsigned verdicts.

For the final phase, replace `submitTxHash` in the payload with the real `AgenticCommerce.submit` tx hash.

## Notes

- **Who can trigger it:** locally, anyone (simulation accepts an empty HTTP trigger config). A deployed
  workflow must list `authorizedKeys` (the coordinator's address) in `http.trigger({...})`.
- **Who can influence the verdict:** only reports signed by the snapshot's report keys count. The verdict
  is signed by `verdictAuthority`, and `SQController` recomputes the digest with its registered
  `policyHash` and `participantSnapshotHash`, so a verdict built against another policy or committee
  fails onchain.
- `reportsHash` is keccak256 of the ABI-encoded report signature hashes in committee order;
  `deficiencyHash` is keccak256 of the scorecard JSON: every rubric row in order plus overall, each judge's score against its own threshold (the seller revises from it).
- The fixture keys in `tools/make-fixtures.ts` are well-known public test keys. Never fund them on a real network.
