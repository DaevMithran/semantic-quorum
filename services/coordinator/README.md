# Coordinator (planned)

Ties a round together:

- **Report board**: stores each job's policy, committee snapshot and signed evaluator reports
  (a stand-in currently lives in `cre/tools/report-board.ts`).
- Asks the seller for an attempt and the two drawn evaluators to score it.
- Triggers the CRE workflow (`cre/`) each round: `draft` phase while the job is Funded, `final` phase
  after the seller's `submit`, with the submit tx hash.
- Watches Arc (`JobRegistered`, `JobSubmitted`, verdict events) and serves an event log for the jury board.
- **Relay fallback**: submits the signed verdict with `SQController.submitVerdict` if CRE can't write
  through the forwarder.
