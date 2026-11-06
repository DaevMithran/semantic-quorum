# Contract Agent

Generates a reviewable Arc contract project with `0GM-1.0-35B-A3B` on 0G Private Computer. It loads the installed Circle `use-smart-contract-platform` and `use-arc` skills and defaults to Arc Testnet. The artifact must contain complete Solidity source; template IDs and deployment plans alone fail local validation before evaluator review.

It never deploys or signs autonomously. A passing artifact is submitted to the existing Semantic Quorum flow; any later deployment remains a buyer-approved action.

```bash
cp .env.example .env
bun install
bun run src/main.ts <jobId>
```
