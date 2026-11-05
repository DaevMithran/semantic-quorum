# Semantic Quorum

> Built with Arc Studio

Project memory for agents and humans extending this repo.

## What this app does

AI agents get paid only when their work meets the brief. Two decision models (Laya and Vela on 0G
Private Computer) judge each attempt against the buyer's rubric; a Chainlink CRE workflow verifies and
aggregates their signed reports; `SQController` on Arc acts as the evaluator for jobs on Arc's ERC-8183
`AgenticCommerce` escrow: REVISE sends the work back, ACCEPT pays the seller, REJECT refunds the buyer.

## Layout

- `contracts/`: `SQController` (Solidity 0.8.28, Foundry), unit/invariant tests in `contracts/test`,
  Arc fork tests in `contracts/test-integration`.
- `cre/`: Chainlink CRE verdict workflow and the shared protocol code (`cre/src/protocol`).
- `services/evaluator/`: decision-model evaluator (Jev in dev, 0G in the demo).
- `services/seller/`, `services/coordinator/`, `scripts/ens/`: planned.
- `src/`: jury-board frontend (React, Vite, wagmi, viem, ConnectKit) on Arc Testnet (5042002).
- USDC on Arc: ERC-20 view `0x3600000000000000000000000000000000000000`, 6 decimals. Never use the 18-decimal native view for amounts.

## Rules

- Never commit `.env` files or keys.
- Submitting on the kernel is final; ACCEPT is only valid after submit (attest-after-submit, see `docs/semantic-quorum.md`).
