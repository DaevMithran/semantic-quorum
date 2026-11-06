# Semantic Quorum: one entry point for local development.
#   make install   install all dependencies
#   make env       create missing .env files from the examples
#   make test      run every test suite (contracts need Foundry)
#   make dev       coordinator + Laya + Vela + JEV evaluators, logs prefixed, Ctrl-C stops all
#   make round-revise / make round-pass   send a test round to the running stack (JOB=<id>)
#   make dev-arc + make arc-job            same stack on Arc testnet; CRE writes verdicts via the forwarder
#   make deploy    deploy SQController to Arc testnet (Foundry keystore account, default sq-deployer)

SHELL := /bin/bash
EVAL := services/evaluator
COORD := services/coordinator
# prefix each log line and flush immediately so parallel logs stay readable
tag = awk '{ print "[$(1)] " $$0; fflush() }'

.PHONY: install env test dev dev-arc arc-job ui coordinator laya vela jev seller round-revise round-pass contracts-test fork-test deploy

install:
	bun install
	cd cre && bun install
	cd $(EVAL) && bun install
	cd $(COORD) && bun install
	cd services/seller && bun install

env:
	@for f in cre/.env $(EVAL)/.env $(EVAL)/.env.vela $(EVAL)/.env.jev $(COORD)/.env; do \
	  ex=$$( [[ $$f == *.env.vela ]] && echo $(EVAL)/.env.vela.example || ([[ $$f == *.env.jev ]] && echo $(EVAL)/.env.jev.example || echo $$(dirname $$f)/.env.example) ); \
	  if [ ! -f $$f ]; then cp $$ex $$f && echo "created $$f (fill it in)"; else echo "exists  $$f"; fi; \
	done

test:
	bun run contracts:test
	cd cre && bun test tools
	cd $(EVAL) && bun test
	cd $(COORD) && bun test
	cd services/seller && bun test

# Runs the three services in one process group; Ctrl-C stops all of them (macOS bash 3.2 safe).
stack = trap 'trap - INT TERM EXIT; kill 0 2>/dev/null' INT TERM EXIT; \
	$(MAKE) --no-print-directory coordinator & \
	$(MAKE) --no-print-directory laya & \
	$(MAKE) --no-print-directory vela & \
	$(MAKE) --no-print-directory jev & \
	wait

dev:
	@$(stack)

# Same stack against Arc testnet: CRE reads Arc and writes verdicts through the CRE forwarder (no relay).
SQ_CONTROLLER := $(shell jq -r .SQController.address deployments/arc-testnet.json 2>/dev/null)
dev-arc:
	@export SQ_CONTROLLER_ADDRESS=$(SQ_CONTROLLER) CRE_TARGET=arc-settings CRE_BROADCAST=true RELAY_ENABLED=false; $(stack)

# create + fund + register a real job on Arc and put it on the board (needs `make dev-arc` running)
arc-job:
	bun scripts/arc-job.ts

coordinator:
	@cd $(COORD) && bun run start 2>&1 | $(call tag,coord)

# laya reads services/evaluator/.env
laya:
	@cd $(EVAL) && bun run start 2>&1 | $(call tag,laya)

# vela: values from .env.vela take precedence over .env (shell env beats Bun's .env loading)
vela:
	@cd $(EVAL) && env $$(grep -v '^[[:space:]]*#' .env.vela | grep -v '^[[:space:]]*$$' | xargs) bun run start 2>&1 | $(call tag,vela)

# JEV uses the same evaluator binary with the Typesafe provider preset.
jev:
	@cd $(EVAL) && env $$(grep -v '^[[:space:]]*#' .env.jev | grep -v '^[[:space:]]*$$' | xargs) bun run start 2>&1 | $(call tag,jev)

# --- test rounds against a running stack (default job 1 = cre fixtures; JOB=<id> for an Arc job) ---
JOB ?= 1
round-revise:
	@curl -s localhost:8787/rounds -H 'content-type: application/json' -d '{"jobId":"$(JOB)","round":0,"evidenceHash":"0x$(shell printf '%064x' 1)","html":"<h1>Chai Corner ☕</h1><p>Sip, smile, repeat! Masala chai ₹20, ginger chai ₹25 — happiness in a cup. Open 7am–9pm.</p><p>Pay by cash.</p>"}' | jq 'if .error then {error} else {status, evaluators, deficiencies: .cre.deficiencies, txHash: .cre.txHash, deliveredVia: .cre.deliveredVia} end'

round-pass:
	@curl -s localhost:8787/rounds -H 'content-type: application/json' -d '{"jobId":"$(JOB)","round":1,"evidenceHash":"0x$(shell printf '%064x' 2)","html":"<h1>Chai Corner ☕</h1><p>Sip, smile, repeat! Masala chai ₹20, ginger chai ₹25 — happiness in a cup. Open 7am–9pm.</p><p>Pay by cash or UPI — scan and sip!</p>"}' | jq 'if .error then {error} else {status, evaluators, deficiencies: .cre.deficiencies, txHash: .cre.txHash, deliveredVia: .cre.deliveredVia} end'

contracts-test:
	bun run contracts:test

fork-test:
	bun run contracts:test:fork

# --- deploy SQController to Arc testnet ---
# one-time: cast wallet import $(DEPLOYER) --interactive   (fund it at https://faucet.circle.com)
DEPLOYER ?= sq-deployer
deploy:
	forge script contracts/script/DeploySQController.s.sol:DeploySQController \
	  --rpc-url arc_testnet --account $(DEPLOYER) --broadcast

# make seller JOB=1   seller agent: writes the page on 0G, revises, submits on PASS (reads services/seller/.env)
seller:
	cd services/seller && bun run src/main.ts $(JOB)

# Agent Town UI on http://localhost:5173 (talks to the coordinator on :8787). Replay: http://localhost:5173/?replay
ui:
	bun run dev
