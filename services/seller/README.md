# Seller agent

Writes the deliverable with `0GM-1.0-35B-A3B` on 0G Private Computer (TEE providers only), sends it to the
coordinator as a round, revises from the judges' scorecard (every check, each judge's score against what it needs), and on `PASS` submits it on Arc
(`AgenticCommerce.submit`), then triggers the final round.

```bash
cp .env.example .env   # fill SELLER_LLM_API_KEY (and SELLER_KEY + SUBMIT=arc for Arc)
bun install
bun run src/main.ts <jobId>
```

The evidence hash binds the page to the 0G request that wrote it (html hash, model, request ID, receipt hash).
`SELLER_MAX_ROUNDS` caps model calls per job.
