import { describe, expect, test } from 'bun:test'
import type { Policy } from '../../../cre/src/protocol/types.ts'
import { makeApp } from '../src/app.ts'
import { Board } from '../src/board.ts'
import { committeeOf, defaultProfiles, loadCatalog, pickSeller } from '../src/catalog.ts'
import { type ArcPort, type ConfigView, decodeCreateJob, type JobView, makeWalletDeals, usdc6 } from '../src/deals.ts'
import { Events } from '../src/events.ts'
import { makeRounds } from '../src/rounds.ts'
import { draftRubric, parseDraft } from '../src/rubric.ts'

const catalog = loadCatalog(`${import.meta.dir}/../agents.json`)
const profiles = defaultProfiles(catalog)
const OG = { baseUrl: 'https://og.local', apiKey: 'k', model: '0GM-1.0-35B-A3B', trustMode: 'private' }

const chat = (contents: string[], seen: RequestInit[] = []) => {
	let i = 0
	return (async (_u: string, init?: RequestInit) => {
		seen.push(init as RequestInit)
		return new Response(JSON.stringify({ id: `req-${i}`, choices: [{ message: { content: contents[Math.min(i++, contents.length - 1)] } }] }))
	}) as unknown as typeof fetch
}

const GOOD = '<think>plan</think>```json\n{"brief":"A playful landing page for a chai stall.","criteria":[{"statement":"The page shows a price list.","must":true},{"statement":"The page mentions UPI payment.","must":true},{"statement":"The tone is playful.","must":false}]}\n```'

describe('catalog', () => {
	test('picks focused workers and rejects unsupported work', () => {
		expect(pickSeller(catalog, 'Build a landing page for my cafe').matched).toContain('landing page')
		expect(pickSeller(catalog, 'Create an ERC-721 smart contract on Arc').seller?.id).toBe('contract-agent')
		expect(pickSeller(catalog, 'Build a streaming chatbot with 0G Compute').seller?.id).toBe('0g-agent')
		expect(pickSeller(catalog, 'Run the refund demo with a stalled agent').seller?.id).toBe('failure-agent')
		expect(pickSeller(catalog, 'Open a pull request on GitHub').seller).toBeNull()
	})
	test('default thresholds for every judge profile', () => {
		expect(Object.keys(profiles).sort()).toEqual(['0g-laya-teeml-v1', '0g-vela-teeml-v1', 'jev-systemone-v1'])
	})
	test('matches 0G by default and permits a one-member JEV committee', () => {
		expect(committeeOf(catalog).map((judge) => judge.profileId)).toEqual(['0g-laya-teeml-v1', '0g-vela-teeml-v1'])
		expect(committeeOf(catalog, ['jev-1.judges.semanticquorum.eth']).map((judge) => judge.profileId)).toEqual(['jev-systemone-v1'])
	})
})

describe('rubric drafting', () => {
	test('parses fenced JSON after thinking text and numbers the criteria', () => {
		const d = parseDraft(GOOD)
		expect(d.criteria.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
		expect(d.criteria[2]?.must).toBe(false)
	})
	test('0G call in private mode returns a valid policy', async () => {
		const seen: RequestInit[] = []
		const { policy, requestIds } = await draftRubric('chai stall page', profiles, { ...OG, fetchImpl: chat([GOOD], seen) })
		expect(policy.criteria).toHaveLength(3)
		expect(policy.revisionLimit).toBe(3)
		expect(requestIds).toEqual(['req-0'])
		expect((seen[0]?.headers as Record<string, string>)['X-0G-Provider-Trust-Mode']).toBe('private')
	})
	test('retries transient 0G upstream failures', async () => {
		let calls = 0
		const fetchImpl = (async () => {
			calls++
			if (calls < 3) return new Response('provider unavailable', { status: 502 })
			return new Response(JSON.stringify({ id: 'req-ok', choices: [{ message: { content: GOOD } }] }))
		}) as unknown as typeof fetch
		const { requestIds } = await draftRubric('chai stall page', profiles, { ...OG, fetchImpl, retryDelayMs: 0 })
		expect(calls).toBe(3)
		expect(requestIds).toEqual(['req-ok'])
	})
	test('route returns a labelled local starter after transient 0G failure', async () => {
		const board = new Board()
		const events = new Events()
		const rounds = makeRounds({ board, events, cre: async () => ({ status: 'WAITING' }), evaluators: {}, publicUrl: 'http://c' })
		const app = makeApp(board, events, rounds, { catalog, draft: async () => { throw new Error('0G chat 502: upstream unavailable') } })
		const r = await app.fetch(new Request('http://c/rubric/draft', { method: 'POST', body: JSON.stringify({ task: 'A landing page with menu and UPI' }) }))
		const body = await r.json() as { draftSource: string; draftWarning: string; policy: Policy }
		expect(r.status).toBe(200)
		expect(body.draftSource).toBe('local-fallback')
		expect(body.draftWarning).toContain('temporarily unavailable')
		expect(body.policy.criteria.map((criterion) => criterion.statement)).toContain('The page mentions UPI as a payment option.')
	})
	test('retries once with the problems when the first draft breaks the limits', async () => {
		const tooMany = JSON.stringify({ brief: 'x', criteria: Array.from({ length: 9 }, (_, i) => ({ statement: `s${i}`, must: true })).concat([{ statement: 'y'.repeat(200), must: true }]) })
		const seen: RequestInit[] = []
		const longOnly = JSON.stringify({ brief: 'x', criteria: [{ statement: 'y'.repeat(200), must: true }] })
		const { policy } = await draftRubric('t', profiles, { ...OG, fetchImpl: chat([longOnly, GOOD], seen) })
		expect(policy.criteria).toHaveLength(3)
		expect(String(seen[1]?.body)).toContain('longer than 160')
		await expect(draftRubric('t', profiles, { ...OG, fetchImpl: chat(['not json']) })).rejects.toThrow('rubric draft invalid')
		expect(tooMany.length).toBeGreaterThan(0)
	})
})

describe('marketplace routes', () => {
	const setup = (withDeals = false) => {
		const board = new Board()
		const events = new Events()
		const rounds = makeRounds({ board, events, cre: async () => ({ status: 'WAITING' }), evaluators: {}, publicUrl: 'http://c' })
		const started: unknown[] = []
		const deals = withDeals
			? ({
					start: async (r: { policy: Policy }) => {
						started.push(r)
						board.putJob('42', JSON.stringify(r.policy), '{}')
						return { jobId: '42', done: Promise.resolve() }
					},
					buyer: '0xb',
					seller: '0xs',
				} as never)
			: undefined
		const app = makeApp(board, events, rounds, { catalog, draft: async (task, p) => draftRubric(task, p, { ...OG, fetchImpl: chat([GOOD]) }), deals })
		const call = (method: string, path: string, body?: unknown) =>
			app.fetch(new Request(`http://c${path}`, { method, body: body ? JSON.stringify(body) : undefined })).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }))
		return { board, events, call, started }
	}

	test('GET /agents lists sellers + judges and the pick for a task', async () => {
		const { call } = setup()
		const r = await call('GET', '/agents?task=a%20landing%20page')
		expect(r.body.sellers).toHaveLength(4)
		expect(r.body.sellers[0].ens).toBe('page.agent.semanticquorum.eth')
		expect(r.body.judges).toHaveLength(3)
		expect(r.body.pick.seller.id).toBe('page-agent')
	})

	test('POST /rubric/draft returns a policy plus the seller pick', async () => {
		const { call } = setup()
		const r = await call('POST', '/rubric/draft', { task: 'A landing page for my chai stall with UPI' })
		expect(r.status).toBe(200)
		expect(r.body.policy.criteria).toHaveLength(3)
		expect(r.body.pick.seller.id).toBe('page-agent')
	})

	test('Failure Agent drafts are locked to the immediate-refund round', async () => {
		const { call } = setup()
		const r = await call('POST', '/rubric/draft', { task: 'Run a failure demo with a stalled agent' })
		expect(r.body.pick.seller.id).toBe('failure-agent')
		expect(r.body.policy.revisionLimit).toBe(0)
	})

	test('POST /deals/prepare: 503 without wallet config; the old server-funded POST /deals is gone', async () => {
		const policy = { version: 'sq-policy-1', brief: 'b', criteria: [{ id: 'c1', statement: 's', must: true }], profiles, revisionLimit: 3 }
		const s = setup()
		expect((await s.call('POST', '/deals/prepare', { policy, budgetUsdc: '0.1', buyer: `0x${'b'.repeat(40)}` })).status).toBe(503)
		expect((await s.call('POST', '/deals', { policy, budgetUsdc: '0.1' })).status).toBe(404)
	})

	test('OPTIONS preflight is allowed for the browser', async () => {
		const { board, events } = setup()
		const app = makeApp(board, events, makeRounds({ board, events, cre: async () => ({ status: 'WAITING' }), evaluators: {}, publicUrl: 'http://c' }))
		const r = await app.fetch(new Request('http://c/deals', { method: 'OPTIONS' }))
		expect(r.status).toBe(204)
		expect(r.headers.get('access-control-allow-headers')).toBe('content-type')
	})

	test('usdc6 parses 6-decimal amounts', () => {
		expect(usdc6('1')).toBe(1_000_000n)
		expect(usdc6('0.01')).toBe(10_000n)
		expect(() => usdc6('1.0000001')).toThrow()
	})
})

describe('outcomes and earnings events', () => {
	test('an onchain REVISE records the outcome and credits the included judges; ACCEPT pays the seller', async () => {
		const board = new Board()
		const events = new Events()
		board.putJob('7', JSON.stringify({ version: 'sq-policy-1', criteria: [{ id: 'c1', statement: 's', must: true }], profiles, revisionLimit: 3 }), JSON.stringify({ committee: [] }))
		board.putDeal({ jobId: '7', task: '', createdAt: 'now', seller: { id: 'page-agent', ens: 'page.agent.semanticquorum.eth', model: 'm', address: '0xs' }, buyer: '0xb', budget: '100000', feePerReport: '10000', revisionLimit: 3, committee: catalog.judges.map((j) => ({ evaluatorId: j.evaluatorId, profileId: j.profileId, feeRecipient: j.feeRecipient })), txs: {}, status: 'working' })
		let next = 'REVISE'
		const rounds = makeRounds({
			board, events, evaluators: {}, publicUrl: 'http://c',
			cre: async () => ({ status: next, scorecard: { rows: [] } as never, deliveredVia: 'cre-forwarder', txHash: '0xtx', verdict: { includedMask: '3' } }),
		})
		await rounds.runRound({ jobId: '7', round: 0, evidenceHash: `0x${'1'.repeat(64)}`, html: '<p>x</p>' })
		const steps = events.since('7').map((e) => e.step)
		expect(steps).toContain('fees-credited')
		expect(steps).toContain('seller-writing')
		expect(board.outcomes('7')[0]?.status).toBe('REVISE')
		next = 'ACCEPT'
		await rounds.runFinal({ jobId: '7', round: 1, evidenceHash: `0x${'2'.repeat(64)}`, submitTxHash: `0x${'3'.repeat(64)}` })
		expect(events.since('7').some((e) => e.step === 'paid')).toBe(true)
		expect(board.deal('7')?.status).toBe('accepted')
	})

	test('REVISE at the registered limit is surfaced as the effective REJECT', async () => {
		const board = new Board()
		const events = new Events()
		board.putJob('8', JSON.stringify({ version: 'sq-policy-1', criteria: [{ id: 'c1', statement: 's', must: true }], profiles, revisionLimit: 0 }), JSON.stringify({ committee: [] }))
		board.putDeal({ jobId: '8', task: '', createdAt: 'now', seller: { id: 'failure-agent', ens: 'failure.agent.semanticquorum.eth', model: 'm', address: '0xs' }, buyer: '0xb', budget: '100000', feePerReport: '10000', revisionLimit: 0, committee: catalog.judges.map((j) => ({ evaluatorId: j.evaluatorId, profileId: j.profileId, feeRecipient: j.feeRecipient })), txs: {}, status: 'working' })
		const rounds = makeRounds({
			board, events, evaluators: {}, publicUrl: 'http://c',
			cre: async () => ({ status: 'REVISE', deliveredVia: 'cre-forwarder', txHash: '0xtx', verdict: { includedMask: '3' } }),
		})
		const result = await rounds.runRound({ jobId: '8', round: 0, evidenceHash: `0x${'1'.repeat(64)}`, html: '<p>no deliverable</p>' })
		expect(result.status).toBe('REJECT')
		expect(board.deal('8')?.status).toBe('rejected')
		expect(events.since('8').find((event) => event.step === 'verdict-onchain')?.status).toBe('REJECT')
	})
})

describe('wallet-funded deal flow', () => {
	const BUYER = '0x00000000000000000000000000000000000000b1' as const
	const OTHER = '0x00000000000000000000000000000000000000e7' as const
	const addr = {
		chainId: 5042002,
		kernel: '0x0747EEf0706327138c69792bF28Cd525089e4583' as const,
		usdc: '0x3600000000000000000000000000000000000000' as const,
		controller: '0x1f772f6a7764c227FCb9467E0E60D133C3CdA168' as const,
		seller: '0x00000000000000000000000000000000000000c5' as const,
		verdictAuthority: '0x00000000000000000000000000000000000000a7' as const,
	}
	const policy = { version: 'sq-policy-1' as const, brief: 'Landing page for a bakery', criteria: [{ id: 'c1', statement: 'The page shows prices.', must: true }], profiles, revisionLimit: 2 }

	/** A fake Arc: the "wallet" executes the prepared calldata against in-memory state. */
	const fakeArc = () => {
		const jobs = new Map<bigint, JobView>()
		const configs = new Map<bigint, ConfigView>()
		const txs = new Map<string, { from: `0x${string}`; ids: bigint[] }>()
		let next = 41n
		const arc: ArcPort = {
			createdJobIds: async (h) => txs.get(h) ?? { from: BUYER, ids: [] },
			getJob: async (id) => {
				const j = jobs.get(id)
				if (!j) throw new Error('no job')
				return j
			},
			setBudget: async (id, amount) => {
				const j = jobs.get(id)!
				jobs.set(id, { ...j, budget: amount })
				return `0x${'5'.repeat(64)}`
			},
			blockNumber: async () => 1000n,
			blockTimestamp: async () => 1_000n,
			isRegistered: async (id) => configs.has(id),
			getConfig: async (id) => configs.get(id)!,
		}
		const wallet = {
			createJob: (data: `0x${string}`, from: `0x${string}` = BUYER) => {
				const a = decodeCreateJob(data)
				const id = ++next
				jobs.set(id, { client: from, provider: a.provider, evaluator: a.evaluator, description: a.description, budget: 0n, expiredAt: a.expiredAt, status: 0 })
				const h = `0x${id.toString(16).padStart(64, '0')}` as const
				txs.set(h, { from, ids: [id] })
				return h
			},
			fund: (id: bigint) => jobs.set(id, { ...jobs.get(id)!, status: 1 }),
			register: (id: bigint, c: Partial<ConfigView>, p: { policyHash: `0x${string}`; snapshotHash: `0x${string}`; feePerReport: string }) =>
				configs.set(id, { buyer: BUYER, verdictAuthority: addr.verdictAuthority, policyHash: p.policyHash, participantSnapshotHash: p.snapshotHash, feePerReport: BigInt(p.feePerReport), revisionLimit: 2, decisionDeadline: 999n, ...c }),
		}
		return { arc, wallet, jobs }
	}

	const setup = () => {
		const board = new Board()
		const events = new Events()
		const f = fakeArc()
		const started: string[] = []
		const deals = makeWalletDeals({ arc: f.arc, addr, catalog, board, events, runSeller: async (sellerId, id) => (started.push(`${sellerId}:${id}`), 0) })
		return { board, events, f, deals, started }
	}

	test('prepare -> wallet createJob -> created (seller sets budget) -> fund -> register-call -> register -> seller starts', async () => {
		const { board, events, f, deals, started } = setup()
		const prep = deals.prepare({ task: 'bakery page', policy, budgetUsdc: '0.25', buyer: BUYER }, catalog.sellers[0]!)
		expect(prep.calls).toHaveLength(1)
		expect(prep.summary.budget).toBe('250000')
		expect(prep.summary.judgeFeeDeposit).toBe(String(10_000 * 2 * 3))

		const tx = f.wallet.createJob(prep.calls[0]!.data)
		const c = await deals.created(prep.prepId, tx)
		expect(c.jobId).toBe('42')
		expect(f.jobs.get(42n)!.budget).toBe(250_000n) // seller agent set the budget
		expect(c.calls.map((x) => x.to)).toEqual([addr.usdc, addr.kernel])
		expect((await deals.created(prep.prepId, tx)).jobId).toBe('42') // idempotent retry

		await expect(deals.registerCall('42')).rejects.toThrow('fund the escrow first')
		f.wallet.fund(42n)
		const r = await deals.registerCall('42')
		expect(r.calls.map((x) => x.to)).toEqual([addr.usdc, addr.controller])

		const p = board.prep(prep.prepId)!
		f.wallet.register(42n, {}, p)
		expect(await deals.registered('42')).toEqual({ jobId: '42', status: 'working' })
		expect(board.job('42')?.policy).toBe(JSON.stringify(policy))
		await Bun.sleep(5)
		expect(started).toEqual(['page-agent:42'])
		expect(events.since('42').map((e) => e.step)).toEqual(['deal-created', 'budget-set', 'job-funded', 'job-registered', 'seller-started', 'seller-exited'])
		expect(board.deal('42')?.funding).toBe('wallet')
		const timeout = await deals.timeoutStatus('42')
		expect(timeout.eligible).toBe(true)
		expect(timeout.calls).toHaveLength(1)
	})

	test('a createJob sent from another wallet is refused', async () => {
		const { f, deals } = setup()
		const prep = deals.prepare({ policy, budgetUsdc: '0.1', buyer: BUYER }, catalog.sellers[0]!)
		const tx = f.wallet.createJob(prep.calls[0]!.data, OTHER)
		await expect(deals.created(prep.prepId, tx)).rejects.toThrow('another wallet')
	})

	test('a registration with a different rubric hash never starts the seller', async () => {
		const { board, f, deals, started } = setup()
		const prep = deals.prepare({ policy, budgetUsdc: '0.1', buyer: BUYER }, catalog.sellers[0]!)
		const c = await deals.created(prep.prepId, f.wallet.createJob(prep.calls[0]!.data))
		f.wallet.fund(BigInt(c.jobId))
		f.wallet.register(BigInt(c.jobId), { policyHash: `0x${'9'.repeat(64)}` }, board.prep(prep.prepId)!)
		await expect(deals.registered(c.jobId)).rejects.toThrow('rubric hash')
		expect(started).toEqual([])
		expect(board.job(c.jobId)).toBeUndefined()
	})

	test('a crashed worker marks the deal failed and triggers failure evaluation', async () => {
		const board = new Board()
		const events = new Events()
		const f = fakeArc()
		const failures: string[] = []
		const deals = makeWalletDeals({
			arc: f.arc,
			addr,
			catalog,
			board,
			events,
			runSeller: async () => 1,
			onWorkerFailure: async (id) => (failures.push(id), { status: 'REJECT' }),
		})
		const prep = deals.prepare({ task: 'bakery landing page', policy, budgetUsdc: '0.1', buyer: BUYER }, catalog.sellers[0]!)
		const created = await deals.created(prep.prepId, f.wallet.createJob(prep.calls[0]!.data))
		f.wallet.fund(BigInt(created.jobId))
		f.wallet.register(BigInt(created.jobId), {}, board.prep(prep.prepId)!)
		await deals.registered(created.jobId)
		await Bun.sleep(5)

		expect(board.deal(created.jobId)?.status).toBe('failed')
		expect(failures).toEqual([created.jobId])
		expect(events.since(created.jobId).map((event) => event.step)).toContain('deal-failed')
		expect(events.since(created.jobId).find((event) => event.step === 'failure-evaluation')?.status).toBe('REJECT')
	})

	test('invalid rubrics are refused at prepare with the problems listed', () => {
		const { deals } = setup()
		try {
			deals.prepare({ policy: { ...policy, criteria: [] }, budgetUsdc: '0.1', buyer: BUYER }, catalog.sellers[0]!)
			throw new Error('should have thrown')
		} catch (e) {
			expect((e as { problems?: string[] }).problems?.join()).toContain('at least one criterion')
		}
	})
})
