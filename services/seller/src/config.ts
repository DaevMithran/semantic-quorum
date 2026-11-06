import type { Address, Hex } from 'viem'
import { z } from 'zod'

const schema = z.object({
	// 0G Private Computer (OpenAI-compatible chat)
	SELLER_LLM_BASE_URL: z.string().url().default('https://router-api.0g.ai'),
	SELLER_LLM_API_KEY: z.string().min(1, 'SELLER_LLM_API_KEY (your 0G key) is required'),
	SELLER_MODEL: z.string().default('0GM-1.0-35B-A3B'),
	SELLER_TRUST_MODE: z.string().default('private'), // coordinator passes empty for standard Router models
	SELLER_MAX_TOKENS: z.coerce.number().int().positive().default(6000),
	SELLER_MAX_ROUNDS: z.coerce.number().int().positive().default(4), // initial attempt + up to 3 revisions
	COORDINATOR_URL: z.string().url().default('http://localhost:8787'),
	// Arc: where the seller submits the passing version. SUBMIT=off stops at PASS (local runs).
	SUBMIT: z.enum(['arc', 'off']).default('arc'),
	ARC_RPC_URL: z.string().url().default('https://rpc.testnet.arc.io'),
	ARC_CHAIN_ID: z.coerce.number().int().positive().default(5042002),
	AGENTIC_COMMERCE_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default('0x0747EEf0706327138c69792bF28Cd525089e4583'),
	SELLER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
})

export type Config = {
	llm: { baseUrl: string; apiKey: string; model: string; trustMode: string; maxTokens: number }
	maxRounds: number
	coordinatorUrl: string
	submit: 'arc' | 'off'
	arc: { rpcUrl: string; chainId: number; kernel: Address; key?: Hex }
}

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
	const e = schema.parse(env)
	if (e.SUBMIT === 'arc' && !e.SELLER_KEY) throw new Error('SELLER_KEY is required when SUBMIT=arc')
	return {
		llm: {
			baseUrl: e.SELLER_LLM_BASE_URL.replace(/\/$/, ''),
			apiKey: e.SELLER_LLM_API_KEY,
			model: e.SELLER_MODEL,
			trustMode: e.SELLER_TRUST_MODE,
			maxTokens: e.SELLER_MAX_TOKENS,
		},
		maxRounds: e.SELLER_MAX_ROUNDS,
		coordinatorUrl: e.COORDINATOR_URL.replace(/\/$/, ''),
		submit: e.SUBMIT,
		arc: { rpcUrl: e.ARC_RPC_URL, chainId: e.ARC_CHAIN_ID, kernel: e.AGENTIC_COMMERCE_ADDRESS as Address, key: e.SELLER_KEY as Hex | undefined },
	}
}
