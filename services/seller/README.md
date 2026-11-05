# Seller agent (planned)

0G seller agent. Writes the deliverable (one self-contained HTML page) from the buyer's brief using a
Private TEE chat model on 0G, and repairs it on REVISE using the failed criteria (ranked by gap), the
revealed private check and any Vela spans.

- Builds the evidence bundle and its hash: brief, rubric, HTML and visible-text hashes, attempt number,
  and its own 0G request IDs and receipt hashes.
- **Submits on Arc only after CRE returns PASS for that exact evidence hash. Submitting is final.**
- Enforces a per-job cap on 0G calls.

See `../../docs/` and the 0G integration plan.
