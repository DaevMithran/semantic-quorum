import type { Address, Hex } from 'viem'
import { z } from 'zod'

const schema = z.object({
	EVALUATOR_ID: z.string().min(1),
	EVALUATOR_PROFILE: z.string().min(1),
	EVALUATOR_REPORT_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'EVALUATOR_REPORT_KEY must be a 32-byte hex key'),
	DECISIONS_PROVIDER: z.enum(['jev', '0g', 'local']),
	DECISIONS_BASE_URL: z.string().url(),
	DECISIONS_PATH: z.string().startsWith('/'),
	DECISIONS_API_KEY: z.string().default(''),
	DECISIONS_MODEL_ID: z.string().min(1, 'DECISIONS_MODEL_ID is required (see GET /v1/models)'),
	ENABLE_SPANS: z.enum(['true', 'false']).default('false'),
	TOKEN_BUDGET: z.coerce.number().int().positive().default(512),
	REPORT_BOARD_URL: z.string().url(),
	CHAIN_ID: z.coerce.number().int().positive(),
	SQ_CONTROLLER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
	PORT: z.coerce.number().int().positive().default(8801),
})

export type Config = {
	evaluatorId: string
	profileId: string
	reportKey: Hex
	provider: 'jev' | '0g' | 'local'
	baseUrl: string
	path: string
	apiKey: string
	modelId: string
	enableSpans: boolean
	tokenBudget: number
	boardUrl: string
	chainId: number
	controller: Address
	port: number
}

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
	const e = schema.parse(env)
	return {
		evaluatorId: e.EVALUATOR_ID,
		profileId: e.EVALUATOR_PROFILE,
		reportKey: e.EVALUATOR_REPORT_KEY as Hex,
		provider: e.DECISIONS_PROVIDER,
		baseUrl: e.DECISIONS_BASE_URL.replace(/\/$/, ''),
		path: e.DECISIONS_PATH,
		apiKey: e.DECISIONS_API_KEY,
		modelId: e.DECISIONS_MODEL_ID,
		enableSpans: e.ENABLE_SPANS === 'true',
		tokenBudget: e.TOKEN_BUDGET,
		boardUrl: e.REPORT_BOARD_URL.replace(/\/$/, ''),
		chainId: e.CHAIN_ID,
		controller: e.SQ_CONTROLLER_ADDRESS as Address,
		port: e.PORT,
	}
}
