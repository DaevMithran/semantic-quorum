# Development and testing

This guide contains the operational instructions intentionally kept out of the project overview.

## Prerequisites

- [Bun](https://bun.sh)
- [Foundry](https://book.getfoundry.sh)
- [Chainlink CRE CLI](https://docs.chain.link/cre) with `cre login`
- [Arc Foundry](https://docs.arc.io/arc/tutorials/install-arc-foundry) (`arc-forge`) for fork tests

Clone with the `forge-std` submodule:

```bash
git clone --recursive <repo-url>
# Existing clone:
git submodule update --init
```

## Makefile workflow

```bash
make install        # install all dependencies
make env            # create missing .env files; fill them before running services
make test           # run every test suite (contracts require Foundry)
make dev            # coordinator :8787 + Laya :8801 + Vela :8802
make round-revise   # offline fixture should return REVISE
make round-pass     # revised offline fixture should return PASS
```

For a real Arc testnet job:

```bash
make dev-arc
make arc-job                 # first run creates test wallets; fund them before rerunning
make round-revise JOB=N
make seller JOB=N
```

## Run components individually

```bash
# Contracts: unit and invariant tests; fork tests are skipped by default
bun install
bun run contracts:test
bun run contracts:test:fork

# CRE workflow and report-board fixtures
cd cre
bun install
bun test tools
bun run fixtures
bun run board

# Evaluator
cd services/evaluator
bun install
cp .env.example .env
bun test
bun run start

# Coordinator
cd services/coordinator
bun install
cp .env.example .env
bun test
bun run start
```

## Evaluator providers

Set `DECISIONS_PROVIDER=0g` or `jev` in `services/evaluator/.env`. The hackathon demo uses 0G; JEV is an
optional development fallback. Provider keys and model names remain in the environment file.

Each service directory that needs secrets includes an `.env.example`. Real `.env` files are ignored by
Git and must never be committed.

For API routes and transaction sequencing, see [Frontend integration](frontend-integration.md).
