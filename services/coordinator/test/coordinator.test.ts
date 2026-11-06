import { describe, expect, test } from 'bun:test'
import { type Address, type Hex, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { decide, voteFor } from '../../../cre/src/protocol/rules.ts'
import type { EvaluationResult, Policy, Snapshot } from '../../../cre/src/protocol/types.ts'
import { loadConfig as loadEvaluatorConfig } from '../../evaluator/src/config.ts'
import { makeService } from '../../evaluator/src/service.ts'
import { makeApp } from '../src/app.ts'
import { Board } from '../src/board.ts'
import { type CrePayload, type CreResult, normalizeSimulationResult, parseSimulateOutput } from '../src/cre.ts'
import { Events } from '../src/events.ts'
import type { VerdictJson } from '../src/relay.ts'
import { makeRounds } from '../src/rounds.ts'

// Well-known test keys. TEST ONLY.
const LAYA_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const VELA_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex
const CONTROLLER = '0x000000000000000000000000000000000000dEaD' as Address
const LAYA = '0g-laya-teeml-v1'
const VELA = '0g-vela-teeml-v1'
const LAYA_ID = 'laya-2.judges.semanticquorum.eth'
const VELA_ID = 'vela-1.judges.semanticquorum.eth'
const COORD = 'http://coord.local'

const policy: Policy = {
	version: 'sq-policy-1',
	brief: 'A chai stall landing page with prices and UPI payment.',
	criteria: [
		{ id: 'c1', statement: 'The page shows a price list.', must: true },
		{ id: 'c3', statement: 'The page mentions UPI payment.', must: true },
	],
	profiles: {
		[LAYA]: { criterionPassBps: 7000, overallAcceptBps: 6000, overallRejectBps: 2500 },
		[VELA]: { criterionPassBps: 7000, overallAcceptBps: 6000, overallRejectBps: 2500 },
	},
	revisionLimit: 2,
}
const snapshot: Snapshot = {
	version: 'sq-snapshot-1',
	chainId: 5042002,
	controller: CONTROLLER,
	committee: [
		{ index: 0, evaluatorId: LAYA_ID, profileId: LAYA, reportKey: privateKeyToAccount(LAYA_KEY).address, feeRecipient: CONTROLLER },
		{ index: 1, evaluatorId: VELA_ID, profileId: VELA, reportKey: privateKeyToAccount(VELA_KEY).address, feeRecipient: CONTROLLER },
	],
}

const decisionsMock = async (_u: string, init?: RequestInit) => {
	const b = JSON.parse(String(init?.body)) as { state: string; questions: Record<string, { type: string; instructions: string }> }
	const answers: Record<string, unknown> = {}
	for (const [k, q] of Object.entries(b.questions)) {
		if (q.type === 'noul') answers[k] = { type: 'noul', noul: /UPI/.test(q.instructions) ? (/UPI/.test(b.state) ? 0.9 : 0.05) : 0.95 }
		else answers[k] = { type: 'score', score: /UPI/.test(b.state) ? 2.5 : 1.5 }
	}
	return new Response(JSON.stringify({ model: 'jev-1.14.0', answers }), { headers: { 'cf-ray': 'ray-1' } })
}

const evEnv = (key: Hex, id: string, profile: string) => ({
	EVALUATOR_ID: id, EVALUATOR_PROFILE: profile, EVALUATOR_REPORT_KEY: key,
	DECISIONS_PROVIDER: 'jev', DECISIONS_BASE_URL: 'https://api.typesafe.ai', DECISIONS_PATH: '/v1/systemone',
	DECISIONS_API_KEY: 'k', DECISIONS_MODEL_ID: 'jev-1.14.0', REPORT_BOARD_URL: COORD,
	CHAIN_ID: '5042002', SQ_CONTROLLER_ADDRESS: CONTROLLER, TOKEN_BUDGET: '512',
})

/** Wires coordinator <-> evaluators <-> decisions mock in-process. CRE and relay are mocks. */
const setup = (opts: { creResult?: (p: CrePayload, board: Board) => CreResult; velaDown?: boolean } = {}) => {
	const board = new Board()
	board.putJob('1', JSON.stringify(policy), JSON.stringify(snapshot))
	const events = new Events()
	const creCalls: CrePayload[] = []
	const relayed: { v: VerdictJson; sig: Hex }[] = []

	let app: ReturnType<typeof makeApp>
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input)
		if (url.startsWith(COORD)) return app.fetch(new Request(url, init))
		if (url.includes('/v1/systemone')) return decisionsMock(url, init)
		if (url.startsWith('http://laya')) return evaluatorFetch(laya, init)
		if (url.startsWith('http://vela')) {
			if (opts.velaDown) return new Response(JSON.stringify({ error: 'decisions API 503' }), { status: 422 })
			return evaluatorFetch(vela, init)
		}
		return new Response('nf', { status: 404 })
	}) as typeof fetch

	const laya = makeService(loadEvaluatorConfig(evEnv(LAYA_KEY, LAYA_ID, LAYA)), { fetchImpl })
	const vela = makeService(loadEvaluatorConfig(evEnv(VELA_KEY, VELA_ID, VELA)), { fetchImpl })
	const evaluatorFetch = async (svc: ReturnType<typeof makeService>, init?: RequestInit) => {
		try {
			return new Response(JSON.stringify(await svc.handle(JSON.parse(String(init?.body)))))
		} catch (e) {
			return new Response(JSON.stringify({ error: (e as Error).message }), { status: 422 })
		}
	}

	// CRE mock: applies the real rules to whatever reports are on the board.
	const defaultCre = (p: CrePayload, b: Board): CreResult => {
		const bundle = b.bundle(p.jobId, p.round)
		if (!bundle || bundle.reports.length < 2) return { status: 'WAITING' }
		const votes = bundle.reports.map((r) => voteFor(r.evaluatorIndex, JSON.parse(r.result) as EvaluationResult, policy, p.round))
		const d = decide(votes)
		const status = p.phase === 'draft' && d.kind === 'ACCEPT' ? 'PASS' : d.kind
		return {
			status,
			deficiencies: d.deficiencies,
			deliveredVia: 'none (use relay)',
			verdict: { jobId: p.jobId, round: p.round, kind: { ACCEPT: 1, REVISE: 2, REJECT: 3, PASS: 0 }[status], deliverable: `0x${'0'.repeat(64)}`, evidenceHash: p.evidenceHash, reportsHash: `0x${'1'.repeat(64)}`, deficiencyHash: `0x${'2'.repeat(64)}`, includedMask: '3' },
			signature: '0xabcdef',
		}
	}

	const rounds = makeRounds({
		board, events,
		cre: async (p) => { creCalls.push(p); return (opts.creResult ?? defaultCre)(p, board) },
		relay: async (v, sig) => { relayed.push({ v, sig }); return { txHash: `0x${'f'.repeat(64)}` as Hex, status: 'success' } },
		evaluators: { [LAYA_ID]: 'http://laya.local', [VELA_ID]: 'http://vela.local' },
		publicUrl: COORD,
		fetchImpl,
	})
	app = makeApp(board, events, rounds)
	return { app, board, events, creCalls, relayed }
}

const post = (app: ReturnType<typeof makeApp>, path: string, body: unknown) =>
	app.fetch(new Request(`${COORD}${path}`, { method: 'POST', body: JSON.stringify(body) })).then((r) => r.json() as Promise<Record<string, unknown>>)

const ev = (s: string) => keccak256(toBytes(s))
const V1 = '<h1>Chai Corner</h1><p>Masala chai ₹20. Pay by cash.</p>'
const V2 = '<h1>Chai Corner</h1><p>Masala chai ₹20. Pay by cash or UPI.</p>'

describe('CRE output parsing', () => {
	test('never treats CRE simulation\'s zero hash as an onchain settlement', () => {
		const result = normalizeSimulationResult({ status: 'ACCEPT', deliveredVia: 'cre-forwarder', txHash: `0x${'0'.repeat(64)}` })
		expect(result.txHash).toBeUndefined()
		expect(result.deliveredVia).toBe('simulation')
	})
	test('extracts the double-encoded JSON result after the marker', () => {
		const inner = JSON.stringify({ status: 'REVISE', deficiencies: [{ criterionId: 'c3', gapBps: 6500 }] })
		const out = `\x1b[32m✓ Workflow compiled\x1b[0m\n[USER LOG] votes: 0=REVISE\n\n\x1b[32m✓ Workflow Simulation Result:\x1b[0m\n${JSON.stringify(inner)}\n\n`
		expect(parseSimulateOutput(out)).toMatchObject({ status: 'REVISE' })
	})
	test('also accepts a plain JSON object result', () => {
		expect(parseSimulateOutput('Workflow Simulation Result:\n{\n  "status": "PASS"\n}\n').status).toBe('PASS')
	})
	test('throws when there is no result', () => {
		expect(() => parseSimulateOutput('✗ failed to compile')).toThrow('no result')
	})
})

describe('rounds', () => {
	test('v1: both judges report, CRE says REVISE, the verdict is relayed', async () => {
		const { app, board, events, creCalls, relayed } = setup()
		const res = await post(app, '/rounds', { jobId: '1', round: 0, evidenceHash: ev('v1'), html: V1 })
		expect(res.status).toBe('REVISE')
		expect(board.bundle('1', 0)?.reports.map((r) => r.evaluatorIndex).sort()).toEqual([0, 1])
		expect(creCalls[0]).toMatchObject({ jobId: '1', round: 0, phase: 'draft' })
		expect(relayed).toHaveLength(1)
		expect(events.since('1').map((e) => `${e.step}:${e.status}`)).toContain('verdict-onchain:REVISE')
		const page = await app.fetch(new Request(`${COORD}/pages/1/0`))
		expect(await page.text()).toBe(V1)
	})

	test('v2: PASS is not relayed; the final phase ACCEPTs and relays', async () => {
		const { app, creCalls, relayed } = setup()
		const r = await post(app, '/rounds', { jobId: '1', round: 1, evidenceHash: ev('v2'), html: V2 })
		expect(r.status).toBe('PASS')
		expect(relayed).toHaveLength(0)
		const f = await post(app, '/rounds/final', { jobId: '1', round: 1, evidenceHash: ev('v2'), submitTxHash: ev('tx') })
		expect(f.status).toBe('ACCEPT')
		expect(creCalls[1]).toMatchObject({ phase: 'final', submitTxHash: ev('tx') })
		expect(relayed).toHaveLength(1)
	})

	test('a judge failing leaves CRE WAITING and nothing onchain (fail closed)', async () => {
		const { app, events, relayed } = setup({ velaDown: true })
		const r = (await post(app, '/rounds', { jobId: '1', round: 0, evidenceHash: ev('v1'), html: V1 })) as { status: string; evaluators: { ok: boolean }[] }
		expect(r.status).toBe('WAITING')
		expect(r.evaluators.filter((e) => !e.ok)).toHaveLength(1)
		expect(relayed).toHaveLength(0)
		expect(events.since('1').some((e) => e.step === 'judge-1' && e.status === 'failed')).toBe(true)
	})

	test('a verdict CRE already wrote through the forwarder is not relayed again', async () => {
		const { app, relayed } = setup({ creResult: () => ({ status: 'REVISE', deliveredVia: 'cre-forwarder', txHash: '0x01' }) })
		await post(app, '/rounds', { jobId: '1', round: 0, evidenceHash: ev('v1'), html: V1 })
		expect(relayed).toHaveLength(0)
	})

	test('unknown job and bad input are rejected', async () => {
		const { app } = setup()
		const r = await app.fetch(new Request(`${COORD}/rounds`, { method: 'POST', body: JSON.stringify({ jobId: '9', round: 0, evidenceHash: ev('x'), html: 'x' }) }))
		expect(r.status).toBe(500)
		const bad = await app.fetch(new Request(`${COORD}/rounds`, { method: 'POST', body: JSON.stringify({ jobId: '1' }) }))
		expect(bad.status).toBe(400)
	})
})

describe('rubric limits on POST /jobs', () => {
	test('a valid rubric is accepted; an invalid one is refused with the problems listed', async () => {
		const { app } = setup()
		const ok = await app.fetch(new Request(`${COORD}/jobs`, { method: 'POST', body: JSON.stringify({ jobId: '2', policy: JSON.stringify(policy), snapshot: JSON.stringify(snapshot) }) }))
		expect(ok.status).toBe(200)
		const bad = { ...policy, criteria: [...policy.criteria, { id: 'c1', statement: 'dup', must: true }] }
		const res = await app.fetch(new Request(`${COORD}/jobs`, { method: 'POST', body: JSON.stringify({ jobId: '3', policy: JSON.stringify(bad), snapshot: JSON.stringify(snapshot) }) }))
		expect(res.status).toBe(400)
		expect(JSON.stringify(await res.json())).toContain('duplicate criterion id')
	})
})
