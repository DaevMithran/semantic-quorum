import { expect, test } from 'bun:test'
import { loadConfig } from '../src/config.ts'

const base = {
	EVALUATOR_ID: 'vela-1', EVALUATOR_PROFILE: '0g-vela-teeml-v1', EVALUATOR_REPORT_KEY: `0x${'11'.repeat(32)}`,
	OG_API_KEY: 'og', OG_MODEL: 'vela-2.0-9b', JEV_API_KEY: 'jev',
	REPORT_BOARD_URL: 'http://localhost:8787', CHAIN_ID: '5042002', SQ_CONTROLLER_ADDRESS: `0x${'00'.repeat(19)}01`,
}

test('DECISIONS_PROVIDER switches endpoint, key, model and 0G-only TEE flags', () => {
	const og = loadConfig({ ...base, DECISIONS_PROVIDER: '0g' })
	expect([og.baseUrl, og.path, og.apiKey, og.modelId]).toEqual(['https://router-api.0g.ai', '/v1/decisions', 'og', 'vela-2.0-9b'])
	expect(og.extraHeaders).toEqual({ 'X-0G-Provider-Trust-Mode': 'private' })
	expect(og.extraBody).toEqual({ verify_tee: true })
	const jev = loadConfig({ ...base, DECISIONS_PROVIDER: 'jev' })
	expect([jev.baseUrl, jev.path, jev.apiKey, jev.modelId]).toEqual(['https://api.typesafe.ai', '/v1/systemone', 'jev', 'jev-1.14.0'])
	expect(jev.extraHeaders).toEqual({})
	expect(jev.extraBody).toEqual({})
})
