// Coordinator: report board + round runner + relay + event log.
//   cp .env.example .env && bun run start

import { Board } from './board.ts'
import { loadConfig } from './config.ts'
import { makeCliRunner } from './cre.ts'
import { makeApp } from './app.ts'
import { loadCatalog } from './catalog.ts'
import { makeArcPort, makeSellerRunner, makeWalletDeals } from './deals.ts'
import { privateKeyToAccount } from 'viem/accounts'
import { keccak256, toBytes } from 'viem'
import { draftRubric } from './rubric.ts'
import { Events } from './events.ts'
import { makeRelay } from './relay.ts'
import { makeRounds } from './rounds.ts'

const cfg = loadConfig()
const board = new Board(cfg.dataFile, cfg.seedFile)
const events = new Events()
const relay =
	cfg.relay.enabled && cfg.relay.controller && cfg.relay.key
		? makeRelay({ rpcUrl: cfg.relay.rpcUrl, controller: cfg.relay.controller, key: cfg.relay.key })
		: undefined
const rounds = makeRounds({ board, events, cre: makeCliRunner(cfg.cre), relay, evaluators: cfg.evaluators, publicUrl: cfg.publicUrl })
const catalog = loadCatalog(cfg.agentsFile)
const rubricCfg = cfg.rubric
const fallbackCfg = cfg.rubricFallback
const draft = rubricCfg || fallbackCfg ? async (task: string, profiles: Parameters<typeof draftRubric>[1]) => {
	if (fallbackCfg) {
		try {
			return { ...(await draftRubric(task, profiles, fallbackCfg)), draftSource: 'openrouter' }
		} catch (primaryError) {
			if (!rubricCfg) throw primaryError
			try {
				return {
					...(await draftRubric(task, profiles, rubricCfg)),
					draftSource: '0g-fallback',
				}
			} catch (secondaryError) {
				throw new Error(`Rubric providers unavailable. OpenRouter: ${String(primaryError)} 0G: ${String(secondaryError)}`)
			}
		}
	}
	return { ...(await draftRubric(task, profiles, rubricCfg!)), draftSource: '0g' }
} : undefined
const dc = cfg.deals
const deals = dc
	? makeWalletDeals({
			arc: makeArcPort({ rpcUrl: dc.rpcUrl, chainId: dc.chainId, kernel: dc.kernel, controller: dc.controller, sellerKey: dc.sellerKey }),
			addr: { chainId: dc.chainId, kernel: dc.kernel, usdc: dc.usdc, controller: dc.controller, seller: privateKeyToAccount(dc.sellerKey).address, verdictAuthority: dc.verdictAuthority },
			catalog,
			board,
			events,
			onWorkerFailure: async (jobId) => {
				const round = Math.max(-1, ...board.outcomes(jobId).filter((outcome) => outcome.phase === 'draft').map((outcome) => outcome.round)) + 1
				const failure = { version: 'sq-worker-failure-1', jobId, round, reason: 'WORKER_EXECUTION_FAILED' }
				const evidenceHash = keccak256(toBytes(JSON.stringify(failure)))
				const html = '<!doctype html><html><body><h1>No deliverable produced</h1><p>The assigned worker failed after its retry limit. No requested work was delivered.</p><p>Failure code: WORKER_EXECUTION_FAILED</p></body></html>'
				events.add(jobId, round, 'failure-artifact', 'ok', { evidenceHash, reason: failure.reason })
				return rounds.runRound({ jobId, round, evidenceHash, html })
			},
			runSeller: makeSellerRunner(cfg.sellerDirs, {
				SELLER_LLM_API_KEY: cfg.rubric?.apiKey,
				SELLER_LLM_BASE_URL: cfg.rubric?.baseUrl,
				SELLER_MODEL: cfg.rubric?.model,
				SELLER_TRUST_MODE: cfg.rubric?.trustMode,
				SELLER_KEY: dc.sellerKey,
				COORDINATOR_URL: cfg.publicUrl,
			}, Object.fromEntries(catalog.sellers.map((seller) => [seller.id, seller.model]))),
		})
	: undefined
const app = makeApp(board, events, rounds, { catalog, draft, deals })

Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: app.fetch, idleTimeout: 255 })

console.log(`coordinator on http://${cfg.host}:${cfg.port}`)
console.log(`  evaluators: ${Object.keys(cfg.evaluators).join(', ') || '(none)'}`)
console.log(`  CRE: ${cfg.cre.bin} --target ${cfg.cre.target}${cfg.cre.broadcast ? ' --broadcast' : ''} (${cfg.cre.dir})`)
console.log(`  relay: ${relay ? `on -> ${cfg.relay.controller}` : 'off'}`)
console.log(`  agents: ${catalog.sellers.map((s) => s.ens).join(', ')} | judges: ${catalog.judges.map((j) => j.evaluatorId).join(', ')}`)
console.log(`  rubric drafting: ${draft ? `on (${fallbackCfg?.model ?? 'disabled'} on OpenRouter${rubricCfg ? ` -> ${rubricCfg.model} on 0G fallback` : ''})` : 'off (set OPENROUTER_API_KEY or OG_API_KEY)'}`)
console.log(`  deals: ${dc ? `on, funded from the buyer's wallet (seller agent ${privateKeyToAccount(dc.sellerKey).address})` : 'off (needs SQ_CONTROLLER_ADDRESS plus seller and verdict authority keys)'}`)
