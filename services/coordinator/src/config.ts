import { existsSync, readFileSync } from 'node:fs'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true')

const schema = z.object({
	HOST: z.string().default('127.0.0.1'),
	PORT: z.coerce.number().int().positive().default(8787),
	PUBLIC_URL: z.string().url().default('http://localhost:8787'),
	BOARD_SEED_FILE: z.string().optional(),
	BOARD_DATA_FILE: z.string().default('./board-data.json'),
	EVALUATORS: z.string().default('{}'),
	CRE_BIN: z.string().default('cre'),
	CRE_DIR: z.string().default('../../cre'),
	CRE_TARGET: z.string().default('local-settings'),
	CRE_BROADCAST: bool,
	RELAY_ENABLED: bool,
	ARC_RPC_URL: z.string().url().default('https://rpc.testnet.arc.io'),
	SQ_CONTROLLER_ADDRESS: z.string().default(''),
	RELAY_PRIVATE_KEY: z.string().default(''),
	// Marketplace (UI): agent catalog, rubric drafting on 0G, deals on Arc
	AGENTS_FILE: z.string().default('./agents.json'),
	OG_API_KEY: z.string().default(''),
	OG_STANDARD_API_KEY: z.string().default(''),
	OG_BASE_URL: z.string().url().default('https://router-api.0g.ai'),
	RUBRIC_MODEL: z.string().default('qwen3.7-flash'),
	OPENROUTER_API_KEY: z.string().default(''),
	OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api'),
	OPENROUTER_MODEL: z.string().default('openai/gpt-4.1-nano'),
	ARC_KEYS_FILE: z.string().default('../../.env.arc'), // SELLER_KEY (hosted seller agent) + VERDICT_AUTHORITY_KEY (make arc-job)
	ARC_CHAIN_ID: z.coerce.number().int().default(5042002),
	AGENTIC_COMMERCE_ADDRESS: z.string().default('0x0747EEf0706327138c69792bF28Cd525089e4583'),
	USDC_ADDRESS: z.string().default('0x3600000000000000000000000000000000000000'),
	SELLER_DIR: z.string().default('../seller'),
	SELLER_DIRS: z.string().default('{}'),
})

const readEnvFile = (p: string): Record<string, string> =>
	existsSync(p)
		? Object.fromEntries(
				readFileSync(p, 'utf8').split('\n').flatMap((l) => {
					const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
					return m ? [[m[1] as string, m[2] as string]] : []
				}),
			)
		: {}
const isKey = (k?: string): k is Hex => !!k && /^0x[0-9a-fA-F]{64}$/.test(k)

export type Config = {
	host: string
	port: number
	publicUrl: string
	seedFile?: string
	dataFile: string
	evaluators: Record<string, string> // ENS id -> base URL
	cre: { bin: string; dir: string; target: string; broadcast: boolean }
	relay: { enabled: boolean; rpcUrl: string; controller?: Address; key?: Hex }
	agentsFile: string
	rubric?: { baseUrl: string; apiKey: string; model: string; trustMode: string }
	rubricFallback?: { baseUrl: string; apiKey: string; model: string; trustMode: string; providerName: string }
	deals?: { rpcUrl: string; chainId: number; kernel: Address; usdc: Address; controller: Address; sellerKey: Hex; verdictAuthority: Address }
	sellerDir: string
	sellerDirs: Record<string, string>
}

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
	const e = schema.parse(env)
	const routerKey = e.OG_STANDARD_API_KEY || e.OG_API_KEY
	const evaluators = z.record(z.string().url()).parse(JSON.parse(e.EVALUATORS))
	const configuredSellerDirs = z.record(z.string().min(1)).parse(JSON.parse(e.SELLER_DIRS))
	const k = readEnvFile(e.ARC_KEYS_FILE)
	const relayKey = e.RELAY_PRIVATE_KEY || k.SELLER_KEY
	if (e.RELAY_ENABLED && (!/^0x[0-9a-fA-F]{40}$/.test(e.SQ_CONTROLLER_ADDRESS) || !/^0x[0-9a-fA-F]{64}$/.test(relayKey ?? ''))) {
		throw new Error('RELAY_ENABLED needs SQ_CONTROLLER_ADDRESS and a relay payer key (RELAY_PRIVATE_KEY or ARC_KEYS_FILE SELLER_KEY)')
	}
	return {
		host: e.HOST,
		port: e.PORT,
		publicUrl: e.PUBLIC_URL.replace(/\/$/, ''),
		seedFile: e.BOARD_SEED_FILE || undefined,
		dataFile: e.BOARD_DATA_FILE,
		evaluators,
		cre: { bin: e.CRE_BIN, dir: e.CRE_DIR, target: e.CRE_TARGET, broadcast: e.CRE_BROADCAST },
		relay: {
			enabled: e.RELAY_ENABLED,
			rpcUrl: e.ARC_RPC_URL,
			controller: e.SQ_CONTROLLER_ADDRESS ? (e.SQ_CONTROLLER_ADDRESS as Address) : undefined,
			key: relayKey && isKey(relayKey) ? relayKey : undefined,
		},
		agentsFile: e.AGENTS_FILE,
		rubric: routerKey ? { baseUrl: e.OG_BASE_URL.replace(/\/$/, ''), apiKey: routerKey, model: e.RUBRIC_MODEL, trustMode: e.OG_STANDARD_API_KEY ? '' : 'private' } : undefined,
		rubricFallback: e.OPENROUTER_API_KEY ? { baseUrl: e.OPENROUTER_BASE_URL.replace(/\/$/, ''), apiKey: e.OPENROUTER_API_KEY, model: e.OPENROUTER_MODEL, trustMode: '', providerName: 'OpenRouter' } : undefined,
		deals:
			isKey(k.SELLER_KEY) && isKey(k.VERDICT_AUTHORITY_KEY) && /^0x[0-9a-fA-F]{40}$/.test(e.SQ_CONTROLLER_ADDRESS)
				? {
						rpcUrl: e.ARC_RPC_URL,
						chainId: e.ARC_CHAIN_ID,
						kernel: e.AGENTIC_COMMERCE_ADDRESS as Address,
						usdc: e.USDC_ADDRESS as Address,
						controller: e.SQ_CONTROLLER_ADDRESS as Address,
						sellerKey: k.SELLER_KEY,
						verdictAuthority: privateKeyToAccount(k.VERDICT_AUTHORITY_KEY).address,
					}
				: undefined,
		sellerDir: e.SELLER_DIR,
		sellerDirs: {
			'page-agent': e.SELLER_DIR,
			'contract-agent': '../contract-agent',
			'0g-agent': '../0g-agent',
			'failure-agent': '../failure-agent',
			...configuredSellerDirs,
		},
	}
}
