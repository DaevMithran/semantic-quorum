import { describe, expect, test } from 'bun:test'
import { privateKeyToAccount } from 'viem/accounts'
import { loadConfig } from '../src/config.ts'

const SELLER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const VERDICT_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
const CONTROLLER = '0x000000000000000000000000000000000000dEaD'

describe('coordinator config', () => {
	test('enables hosted deals from direct environment keys without .env.arc', () => {
		const cfg = loadConfig({
			SELLER_KEY,
			VERDICT_AUTHORITY_KEY: VERDICT_KEY,
			SQ_CONTROLLER_ADDRESS: CONTROLLER,
			RELAY_ENABLED: 'true',
			ARC_KEYS_FILE: '/file/that/does/not/exist',
		})

		expect(cfg.deals?.sellerKey).toBe(SELLER_KEY)
		expect(cfg.deals?.verdictAuthority).toBe(privateKeyToAccount(VERDICT_KEY).address)
		expect(cfg.relay.key).toBe(SELLER_KEY)
	})
})
