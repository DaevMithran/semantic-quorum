// HTTP routes. Kept separate from server.ts so tests can call `app.fetch` directly.

import { z } from 'zod'
import { checkPolicy } from '../../../cre/src/protocol/rules.ts'
import type { BoardReport, Policy } from '../../../cre/src/protocol/types.ts'
import type { Board } from './board.ts'
import { type Catalog, defaultProfiles, pickSeller } from './catalog.ts'
import { DealError, type makeWalletDeals, type PrepareRequest } from './deals.ts'
import type { Events } from './events.ts'
import type { makeRounds } from './rounds.ts'
import { starterRubric } from './rubric.ts'

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const jobId = z.string().regex(/^\d+$/)
const round = z.number().int().min(0).max(255)

const jobSchema = z.object({ jobId, policy: z.string(), snapshot: z.string() })
const reportSchema = z.object({
	jobId,
	round,
	report: z.object({ evaluatorIndex: z.number().int(), evidenceHash: hex32, result: z.string(), signature: z.string() }),
})
const roundSchema = z.object({ jobId, round, evidenceHash: hex32, html: z.string().min(1) })
const finalSchema = z.object({ jobId, round, evidenceHash: hex32, submitTxHash: hex32 })
const draftSchema = z.object({ task: z.string().trim().min(3).max(2000), sellerId: z.string().optional() })
const usdc = z.string().regex(/^\d+(\.\d{1,6})?$/, 'USDC amount like "0.1"')
const prepareSchema = z.object({
	task: z.string().max(2000).optional(),
	policy: z.object({ version: z.literal('sq-policy-1') }).passthrough(),
	budgetUsdc: usdc,
	feeUsdc: usdc.optional(),
	buyer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'buyer wallet address'),
	sellerId: z.string().optional(),
	evaluatorIds: z.array(z.string().min(1)).min(1).max(8).optional(),
})
const txSchema = z.object({ txHash: hex32 })
const optTxSchema = z.object({ txHash: hex32.optional() }).nullable()

/** Optional features; each route answers 503 when its dependency isn't configured. */
export type Extras = {
	catalog?: Catalog
	draft?: (task: string, profiles: Policy['profiles']) => Promise<{ policy: Policy; requestIds: string[]; draftSource?: string; draftWarning?: string }>
	deals?: ReturnType<typeof makeWalletDeals>
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' }

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), {
		status,
		headers: { 'content-type': 'application/json', ...CORS },
	})

export const makeApp = (board: Board, events: Events, rounds: ReturnType<typeof makeRounds>, x: Extras = {}) => ({
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url)
		const p = url.pathname
		if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
		const body = req.method === 'POST' ? await req.json().catch(() => null) : null
		try {
			// --- marketplace: agents, rubric drafting, deals (used by the UI) ---
			if (req.method === 'GET' && p === '/agents') {
				if (!x.catalog) return json({ error: 'no agent catalog configured' }, 503)
				const task = url.searchParams.get('task')
				return json({ ...x.catalog, ...(task ? { pick: pickSeller(x.catalog, task) } : {}) })
			}
			if (req.method === 'POST' && p === '/rubric/draft') {
				if (!x.draft || !x.catalog) return json({ error: 'rubric drafting needs OG_API_KEY or OPENROUTER_API_KEY' }, 503)
				const { task, sellerId } = draftSchema.parse(body)
				const profiles = defaultProfiles(x.catalog)
				const selected = sellerId ? x.catalog.sellers.find((seller) => seller.id === sellerId) : undefined
				if (sellerId && !selected) throw new DealError(`Unknown agent: ${sellerId}`, 400)
				const pick = selected ? { seller: selected, matched: [] } : pickSeller(x.catalog, task)
				const demoPolicy = <T extends { revisionLimit: number }>(policy: T): T => pick.seller?.id === 'failure-agent' ? { ...policy, revisionLimit: 0 } : policy
				try {
					const out = await x.draft(task, profiles)
					return json({ ...out, policy: demoPolicy(out.policy), draftSource: out.draftSource ?? '0g', pick })
				} catch (error) {
					return json({
						policy: demoPolicy(starterRubric(task, profiles)),
						requestIds: [],
						draftSource: 'local-fallback',
						draftWarning: '0G and OpenRouter are temporarily unavailable. This editable starter rubric was created locally; review every criterion before funding.',
						pick,
					})
				}
			}
			// --- deals funded from the buyer's wallet (see services/coordinator/src/deals.ts) ---
			const off = () => json({ error: 'deals need SQ_CONTROLLER_ADDRESS and the seller + verdict keys in .env.arc (run make arc-job once)' }, 503)
			if (req.method === 'POST' && p === '/deals/prepare') {
				if (!x.deals || !x.catalog) return off()
				const r = prepareSchema.parse(body) as unknown as PrepareRequest
				const selected = r.sellerId ? x.catalog.sellers.find((seller) => seller.id === r.sellerId) : undefined
				if (r.sellerId && !selected) throw new DealError(`Unknown agent: ${r.sellerId}`, 400)
				const seller = selected ?? pickSeller(x.catalog, r.task ?? r.policy.brief ?? '').seller
				if (!seller) throw new DealError('Choose an agent before preparing the deal.', 422)
				if (seller.id === 'failure-agent' && r.policy.revisionLimit !== 0) throw new DealError('The Failure Agent safety demo requires 0 allowed revisions so any failed attempt becomes an immediate refund.', 400)
				return json(x.deals.prepare(r, seller))
			}
			const createdM = p.match(/^\/deals\/([0-9a-f-]{8})\/created$/)
			if (req.method === 'POST' && createdM) {
				if (!x.deals) return off()
				return json(await x.deals.created(createdM[1] as string, txSchema.parse(body).txHash as `0x${string}`))
			}
			const regCallM = p.match(/^\/deals\/(\d+)\/register-call$/)
			if (req.method === 'POST' && regCallM) {
				if (!x.deals) return off()
				return json(await x.deals.registerCall(regCallM[1] as string))
			}
			const resumeM = p.match(/^\/deals\/(\d+)\/resume$/)
			if (req.method === 'POST' && resumeM) {
				if (!x.deals) return off()
				return json(await x.deals.resume(resumeM[1] as string))
			}
			const setupM = p.match(/^\/deals\/(\d+)\/setup$/)
			if (req.method === 'GET' && setupM) {
				if (!x.deals) return off()
				return json(await x.deals.setup(setupM[1] as string))
			}
			if (req.method === 'POST' && p === '/deals/wait') {
				if (!x.deals) return off()
				return json(await x.deals.waitForTransaction(txSchema.parse(body).txHash as `0x${string}`))
			}
			const regM = p.match(/^\/deals\/(\d+)\/registered$/)
			if (req.method === 'POST' && regM) {
				if (!x.deals) return off()
				return json(await x.deals.registered(regM[1] as string, optTxSchema.parse(body)?.txHash as `0x${string}` | undefined))
			}
			const retryWorkerM = p.match(/^\/deals\/(\d+)\/retry-worker$/)
			if (req.method === 'POST' && retryWorkerM) {
				if (!x.deals) return off()
				return json(await x.deals.retryWorker(retryWorkerM[1] as string))
			}
			const refundM = p.match(/^\/deals\/(\d+)\/refund-fees-call$/)
			if (req.method === 'POST' && refundM) {
				if (!x.deals) return off()
				return json(x.deals.refundFeesCall(refundM[1] as string))
			}
			const timeoutM = p.match(/^\/deals\/(\d+)\/timeout$/)
			if (req.method === 'GET' && timeoutM) {
				if (!x.deals) return off()
				return json(await x.deals.timeoutStatus(timeoutM[1] as string))
			}
			if (req.method === 'GET' && p === '/deals') return json(board.deals())
			const dealMatch = p.match(/^\/deals\/(\d+)$/)
			if (req.method === 'GET' && dealMatch) {
				const id = dealMatch[1] as string
				const job = board.job(id)
				const deal = board.deal(id)
				if (!job && !deal) return json({ error: 'not found' }, 404)
				return json({
					jobId: id,
					deal: deal ?? null,
					workerActive: deal && x.deals ? x.deals.workerState(id).active : false,
					policy: job ? JSON.parse(job.policy) : null,
					snapshot: job ? JSON.parse(job.snapshot) : null,
					rounds: board.rounds(id).map((round) => ({
						round,
						pageUrl: board.page(id, round) ? `/pages/${id}/${round}` : null,
						reports: board.reports(id, round).map((r) => ({ evaluatorIndex: r.evaluatorIndex, evidenceHash: r.evidenceHash, result: JSON.parse(r.result) })),
						outcomes: board.outcomes(id).filter((o) => o.round === round),
					})),
				})
			}

			// --- report board (read by the CRE workflow and evaluators) ---
			if (req.method === 'GET' && p === '/bundle') {
				const b = board.bundle(url.searchParams.get('jobId') ?? '', Number(url.searchParams.get('round')))
				return b ? json(b) : json({ error: 'not found' }, 404)
			}
			if (req.method === 'POST' && p === '/jobs') {
				const j = jobSchema.parse(body)
				let policy: Policy
				try {
					policy = JSON.parse(j.policy) as Policy
				} catch {
					return json({ error: 'policy is not JSON' }, 400)
				}
				const problems = checkPolicy(policy)
				if (problems.length) return json({ error: 'invalid rubric', problems }, 400)
				board.putJob(j.jobId, j.policy, j.snapshot)
				return json({ ok: true })
			}
			if (req.method === 'POST' && p === '/reports') {
				const r = reportSchema.parse(body)
				board.putReport(r.jobId, r.round, r.report as BoardReport)
				return json({ ok: true })
			}
			const page = p.match(/^\/pages\/(\d+)\/(\d+)$/)
			if (req.method === 'GET' && page) {
				const html = board.page(page[1] as string, Number(page[2]))
				return html ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) : json({ error: 'not found' }, 404)
			}

			// --- rounds ---
			if (req.method === 'POST' && p === '/rounds') return json(await rounds.runRound(roundSchema.parse(body)))
			if (req.method === 'POST' && p === '/rounds/final') return json(await rounds.runFinal(finalSchema.parse(body)))

			// --- event log for the UI ---
			if (req.method === 'GET' && p === '/events') {
				return json(events.since(url.searchParams.get('jobId') ?? '', Number(url.searchParams.get('after') ?? 0)))
			}
			if (req.method === 'GET' && p === '/') {
				return json({ ok: true, routes: ['GET /agents', 'POST /rubric/draft', 'POST /deals/prepare', 'POST /deals/:prepId/created', 'POST /deals/:jobId/register-call', 'POST /deals/:jobId/registered', 'POST /deals/:jobId/retry-worker', 'GET /deals/:jobId/timeout', 'POST /deals/:jobId/refund-fees-call', 'GET /deals', 'GET /deals/:jobId', 'GET /bundle', 'POST /jobs', 'POST /reports', 'GET /pages/:job/:round', 'POST /rounds', 'POST /rounds/final', 'GET /events?jobId='] })
			}
			return json({ error: 'not found' }, 404)
		} catch (e) {
			if (e instanceof z.ZodError) return json({ error: e.issues }, 400)
			if (e instanceof DealError) return json({ error: e.message, ...(e.problems ? { problems: e.problems } : {}) }, e.status)
			return json({ error: e instanceof Error ? e.message : String(e) }, 500)
		}
	},
})
