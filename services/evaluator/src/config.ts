import type { Address, Hex } from 'viem'
import { z } from 'zod'

const schema = z.object({
	EVALUATOR_ID: z.string().min(1),
	EVALUATOR_PROFILE: z.string().min(1),
	EVALUATOR_REPORT_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'EVALUATOR_REPORT_KEY must be a 32-byte hex key'),
	// Switch: 0g | jev | local. Each provider has its own key/model; DECISIONS_* overrides the preset.
	DECISIONS_PROVIDER: z.enum(['jev', '0g', 'local']),
	OG_API_KEY: z.string().default(''),
	OG_MODEL: z.string().default('laya'),
	JEV_API_KEY: z.string().default(''),
	JEV_MODEL: z.string().default('jev-1.14.0'),
	DECISIONS_BASE_URL: z.string().url().optional(),
	DECISIONS_PATH: z.string().startsWith('/').optional(),
	DECISIONS_API_KEY: z.string().optional(),
	DECISIONS_MODEL_ID: z.string().optional(),
	ENABLE_SPANS: z.enum(['true', 'false']).default('false'),
	// 0G only: pin TEE providers and ask the router to verify the TEE signature
	OG_TRUST_MODE: z.string().default('private'),
	OG_VERIFY_TEE: z.enum(['true', 'false']).default('true'),
	// Refuse to report unless the response says tee_verified: true (turn on once the field is confirmed)
	REQUIRE_TEE: z.enum(['true', 'false']).default('false'),
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
	extraHeaders: Record<string, string>
	extraBody: Record<string, unknown>
	requireTee: boolean
	tokenBudget: number
	boardUrl: string
	chainId: number
	controller: Address
	port: number
}

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
	const e = schema.parse(env)
	const preset = {
		'0g': { baseUrl: 'https://router-api.0g.ai', path: '/v1/decisions', apiKey: e.OG_API_KEY, model: e.OG_MODEL },
		jev: { baseUrl: 'https://api.typesafe.ai', path: '/v1/systemone', apiKey: e.JEV_API_KEY, model: e.JEV_MODEL },
		local: { baseUrl: 'http://127.0.0.1:8000', path: '/v1/systemone', apiKey: '', model: e.OG_MODEL },
	}[e.DECISIONS_PROVIDER]
	const modelId = e.DECISIONS_MODEL_ID || preset.model
	return {
		evaluatorId: e.EVALUATOR_ID,
		profileId: e.EVALUATOR_PROFILE,
		reportKey: e.EVALUATOR_REPORT_KEY as Hex,
		provider: e.DECISIONS_PROVIDER,
		baseUrl: (e.DECISIONS_BASE_URL || preset.baseUrl).replace(/\/$/, ''),
		path: e.DECISIONS_PATH || preset.path,
		apiKey: e.DECISIONS_API_KEY || preset.apiKey,
		modelId,
		enableSpans: e.ENABLE_SPANS === 'true',
		extraHeaders: e.DECISIONS_PROVIDER === '0g' && e.OG_TRUST_MODE ? { 'X-0G-Provider-Trust-Mode': e.OG_TRUST_MODE } : {},
		extraBody: e.DECISIONS_PROVIDER === '0g' && e.OG_VERIFY_TEE === 'true' ? { verify_tee: true } : {},
		requireTee: e.REQUIRE_TEE === 'true',
		tokenBudget: e.TOKEN_BUDGET,
		boardUrl: e.REPORT_BOARD_URL.replace(/\/$/, ''),
		chainId: e.CHAIN_ID,
		controller: e.SQ_CONTROLLER_ADDRESS as Address,
		port: e.PORT,
	}
}
