import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { loadConfig } from '../src/config.ts'
import { extractHtml } from '../src/llm.ts'
import { promptFor, runSeller } from '../src/seller.ts'

const policy = {
	version: 'sq-policy-1',
	brief: 'A chai stall page',
	criteria: [
		{ id: 'c1', statement: 'Shows a price list.', must: true },
		{ id: 'p1', statement: 'Shows opening hours.', must: true },
	],
	profiles: {},
	revisionLimit: 2,
}

describe('seller', () => {
	test('extractHtml strips thinking and fences', () => {
		const t = '<think>plan...</think>Here:\n```html\n<!DOCTYPE html><html><body>hi</body></html>\n```\nDone'
		expect(extractHtml(t)).toBe('<!DOCTYPE html><html><body>hi</body></html>')
		expect(extractHtml('no html here')).toBe('')
	})

	test('revision prompt carries the whole scorecard: fix FAILs, keep PASSes', () => {
		expect(promptFor(policy as never)).toContain('Shows opening hours.')
		const card = { version: 'sq-scorecard-1', round: 0, verdict: 'REVISE', rows: [
			{ id: 'c1', statement: 'Shows a price list.', must: true, pass: true, scores: [{ evaluatorIndex: 0, profileId: 'l', bps: 9900, needBps: 7000, pass: true }] },
			{ id: 'p1', statement: 'Shows opening hours.', must: true, pass: false, scores: [{ evaluatorIndex: 0, profileId: 'l', bps: 600, needBps: 7000, pass: false }] },
		] } as never
		const p = promptFor(policy as never, { html: '<html></html>', card })
		expect(p).toContain('[FAIL (required)] Shows opening hours. | judge 0: 6% (needs 70%)')
		expect(p).toContain('[PASS] Shows a price list.')
	})

	test('REVISE -> rewrite with feedback -> PASS -> submit -> ACCEPT', async () => {
		const seen: { path: string; body: any; headers?: any }[] = []
		let roundCalls = 0
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			const path = new URL(url).pathname
			const body = init?.body ? JSON.parse(init.body as string) : null
			seen.push({ path, body, headers: init?.headers })
			const j = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'x-request-id': `req-${seen.length}` } })
			if (path === '/bundle') return j({ policy: JSON.stringify(policy), snapshot: '{}', reports: [] })
			if (path === '/v1/chat/completions') return j({ model: '0GM-1.0-35B-A3B', choices: [{ message: { content: '<think>x</think><!doctype html><html>v</html>' } }] })
			if (path === '/rounds') return j(roundCalls++ === 0 ? { status: 'REVISE', cre: { scorecard: { version: 'sq-scorecard-1', round: 0, verdict: 'REVISE', rows: [{ id: 'p1', statement: 'Shows opening hours.', must: true, pass: false, scores: [{ evaluatorIndex: 0, profileId: 'l', bps: 3000, needBps: 7000, pass: false }] }] } } } : { status: 'PASS' })
			if (path === '/rounds/final') return j({ status: 'ACCEPT' })
			return new Response('{}', { status: 404 })
		}) as typeof fetch
		const cfg = loadConfig({ SELLER_LLM_API_KEY: 'k', SUBMIT: 'arc', SELLER_KEY: `0x${'11'.repeat(32)}` })
		const submitted: Hex[] = []
		const out = await runSeller(cfg, '7', { fetchImpl, submit: async (_j, ev) => (submitted.push(ev), `0x${'ab'.repeat(32)}` as Hex), log: () => {} })

		expect(out.status).toBe('ACCEPT')
		expect(out.round).toBe(1)
		expect(submitted).toEqual([out.evidenceHash as Hex])
		const chats = seen.filter((s) => s.path === '/v1/chat/completions')
		expect(chats).toHaveLength(2)
		expect(chats[0]?.headers['X-0G-Provider-Trust-Mode']).toBe('private')
		expect(chats[1]?.body.messages[1].content).toContain('Shows opening hours.')
		const rounds = seen.filter((s) => s.path === '/rounds')
		expect(rounds[0]?.body.evidenceHash).not.toBe(rounds[1]?.body.evidenceHash)
		expect(seen.at(-1)?.body.submitTxHash).toBe(`0x${'ab'.repeat(32)}`)
	})
})
