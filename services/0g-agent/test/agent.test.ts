import { describe, expect, test } from 'bun:test'
import { ogProfile } from '../src/agent.ts'

describe('0G Agent', () => {
	test('loads official 0G guardrails', () => {
		const system = ogProfile.system({ brief: 'Build a 0G chatbot', criteria: [] } as never)
		expect(system).toContain('processResponse')
		expect(system).toContain('ethers 6.13.1')
		expect(system).toContain('Network actions require buyer approval')
	})
})
