// One pure function turns coordinator events into what the town shows.
// Live mode and replay both feed it, so there is no separate demo logic.

import type { CompanyId } from './companies'
import type { BeltStage, Committee, JudgeResult, Policy, Receipt, Scorecard, Station, TownEvent } from './types'

export const EXPLORER = 'https://explorer.testnet.arc.io'
export const txUrl = (h?: unknown) => (typeof h === 'string' && /^0x[0-9a-f]{64}$/i.test(h) ? `${EXPLORER}/tx/${h}` : undefined)
export const short = (h?: unknown) => (typeof h === 'string' ? (h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h) : '')

export type JudgeView = { state: 'idle' | 'running' | 'done' | 'failed'; result?: JudgeResult; requestId?: string }
export type CartKind = 'ticket' | 'page' | 'reports' | 'verdict' | 'scorecard' | 'hash' | 'usdc'
/** A delivery cart driving between two companies (or a hand-off inside one building when from === to). */
export type Capsule = { id: number; kind: CartKind; from: CompanyId; to: CompanyId }

const COMPANY_OF: Record<Station, CompanyId> = { hq: 'hq', workshop: 'agents', chamber: 'og', chainlink: 'chainlink', bank: 'arc' }

export type TownState = {
	jobId?: string
	policy?: Policy
	committee: Committee
	seller: string
	budget?: string // 6-decimal USDC
	feePerReport?: string
	round: number
	screens: Record<'hq' | 'writer' | 'seal' | 'bank', string>
	working: Partial<Record<'writer' | 'seal' | 'arm', boolean>>
	judges: JudgeView[]
	capsule?: Capsule
	focus?: CompanyId // where the action is (the camera follows it)
	pages: number
	belt: BeltStage
	crateTag?: string
	ballot?: string // last stamp
	scorecard?: Scorecard
	receipts: Receipt[]
	chainTxs: { id: number; label: string; txHash?: string }[]
	coins: { judges: number; seller: number; refund: number }
	finished?: 'ACCEPT' | 'REJECT'
	seq: number
}

export const initialState = (): TownState => ({
	committee: [],
	seller: 'page.agent.semanticquorum.eth',
	round: 0,
	screens: { hq: 'Waiting for a job', writer: 'idle', seal: 'idle', bank: 'idle' },
	working: {},
	judges: [{ state: 'idle' }, { state: 'idle' }],
	pages: 0,
	belt: 'open',
	receipts: [],
	chainTxs: [],
	coins: { judges: 0, seller: 0, refund: 0 },
	seq: 0,
})

const usdc = (v?: string) => (v ? `${(Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC` : '')

/** Builds a scorecard from two reports when the event didn't carry one (replay, older coordinators). */
export const scorecardFrom = (policy: Policy, committee: Committee, results: (JudgeResult | undefined)[], round: number, verdict: string): Scorecard => {
	const judges = committee.map((m, i) => ({ m, r: results[i] })).filter((x): x is { m: Committee[number]; r: JudgeResult } => !!x.r)
	const t = (p: string) => policy.profiles[p] ?? { criterionPassBps: 7000, overallAcceptBps: 6000, overallRejectBps: 0 }
	const rows = policy.criteria.map((c) => {
		const scores = judges.map(({ m, r }) => {
			const bps = r.criteria.find((x) => x.id === c.id)?.passBps ?? 0
			const need = t(m.profileId).criterionPassBps
			return { evaluatorIndex: m.index, profileId: m.profileId, bps, needBps: need, pass: bps >= need }
		})
		return { id: c.id, statement: c.statement, must: c.must, scores, pass: scores.every((s) => s.pass) }
	})
	const overall = judges.map(({ m, r }) => {
		const need = t(m.profileId).overallAcceptBps
		return { evaluatorIndex: m.index, profileId: m.profileId, bps: r.overall.expectedLevelBps, needBps: need, pass: r.overall.expectedLevelBps >= need }
	})
	rows.push({ id: 'overall', statement: 'Overall quality against the brief', must: true, scores: overall, pass: overall.every((s) => s.pass) })
	return { round, verdict, rows }
}

const judgeName = (s: TownState, i: number) => s.committee[i]?.evaluatorId.split('.')[0] ?? `judge ${i}`

export const apply = (prev: TownState, e: TownEvent): TownState => {
	const s: TownState = { ...prev, seq: Math.max(prev.seq, e.seq), screens: { ...prev.screens }, working: { ...prev.working } }
	const d = (e.data ?? {}) as Record<string, unknown>
	const receipt = (src: Receipt['src'], text: string, href?: string, tee?: boolean) => {
		s.receipts = [...s.receipts, { id: e.seq, src, text, href, tee }].slice(-60)
	}
	const chain = (label: string, txHash?: unknown) => {
		s.chainTxs = [...s.chainTxs, { id: e.seq, label, txHash: typeof txHash === 'string' ? txHash : undefined }].slice(-12)
	}
	const move = (kind: CartKind, from: Station, to: Station) => {
		s.capsule = { id: e.seq, kind, from: COMPANY_OF[from], to: COMPANY_OF[to] }
	}
	const focus = (c: CompanyId) => {
		s.focus = c
	}
	if (e.round >= 0 && e.step !== 'seller-log') s.round = Math.max(s.round, e.round)

	switch (e.step) {
		case 'deal-created':
			focus('hq')
			s.screens.hq = `Job ${e.jobId} posted`
			if (typeof d.budget === 'string') s.budget = d.budget.includes('.') ? String(Math.round(Number(d.budget) * 1e6)) : d.budget
			if (typeof d.seller === 'string') s.seller = d.seller
			move('ticket', 'hq', 'bank')
			receipt('HQ', `Job ${e.jobId} created · agent ${short(s.seller.split('.')[0])} assigned · rubric + evaluators recorded`)
			chain('createJob', d.txHash)
			break
		case 'job-funded':
			focus('arc')
			s.belt = 'funded'
			s.screens.bank = `Escrow funded`
			receipt('Arc', `Escrow funded ${usdc(s.budget)}`.trim(), txUrl(d.txHash))
			chain('fund', d.txHash)
			break
		case 'job-registered':
			s.screens.bank = 'judges registered'
			receipt('Arc', 'Rubric + judges registered with SQController', txUrl(d.txHash))
			chain('registerJob', d.txHash)
			break
		case 'seller-started':
		case 'seller-writing':
			focus('agents')
			if (e.step === 'seller-started') move('ticket', 'hq', 'workshop')
			s.working.writer = true
			s.screens.writer = `writing v${(e.step === 'seller-writing' ? e.round : 0) + 1}…`
			s.judges = s.judges.map(() => ({ state: 'idle' }))
			if (e.step === 'seller-writing') move('scorecard', 'chainlink', 'workshop')
			break
		case 'seller-log': {
			const line = String(d.line ?? '')
			const m = line.match(/round (\d+): wrote (\d+) chars \(0G ([^)]+)\)/)
			if (m) {
				s.screens.writer = `v${Number(m[1]) + 1} done`
				receipt('0G', `Agent wrote v${Number(m[1]) + 1} in TEE · req ${short(m[3]?.split(',')[0])}`, undefined, true)
			}
			break
		}
		case 'delivered':
			focus('og')
			s.working.writer = false
			s.pages = Math.max(s.pages, e.round + 1)
			s.screens.writer = `v${e.round + 1} → judges`
			s.judges = s.judges.map(() => ({ state: 'idle' }))
			s.ballot = undefined
			move('page', 'workshop', 'chamber')
			break
		case 'judge-0':
		case 'judge-1': {
			const i = Number(e.step.slice(-1))
			const judges = [...s.judges]
			if (e.status === 'running') judges[i] = { state: 'running' }
			else if (e.status === 'done') {
				const result = d.result as JudgeResult | undefined
				judges[i] = { state: 'done', result, requestId: String(d.requestId ?? result?.requestId ?? '') }
				const is0gTee = !s.committee[i]?.profileId.toLowerCase().startsWith('jev')
				receipt(is0gTee ? '0G' : 'Coordinator', `${judgeName(s, i)} scored v${e.round + 1} · req ${short(String(d.requestId ?? '').split(',')[0])}`, undefined, is0gTee && (result?.teeVerified ?? true))
			} else {
				judges[i] = { state: 'failed' }
				receipt('0G', `${judgeName(s, i)} failed: ${String(d.error ?? 'no report')}`)
			}
			s.judges = judges
			break
		}
		case 'cre':
			if (e.status === 'running') {
				focus('chainlink')
				s.working.seal = true
				s.screens.seal = 'checking seals'
				move('reports', 'chamber', 'chainlink')
			} else {
				s.working.seal = false
				s.ballot = e.status
				s.screens.seal = e.status === 'WAITING' ? 'waiting: 1 report' : `verdict ${e.status}`
				const card = d.scorecard as Scorecard | undefined
				if (card?.rows) s.scorecard = { ...card, round: e.round, verdict: e.status }
				else if (s.policy && s.judges.every((j) => j.result)) s.scorecard = scorecardFrom(s.policy, s.committee, s.judges.map((j) => j.result), e.round, e.status)
				receipt('Chainlink', e.status === 'PASS' ? `CRE simulation verified the reports: v${e.round + 1} passed and the agent may submit` : `CRE simulation verified the reports · verdict ${e.status} for v${e.round + 1}`)
			}
			break
		case 'verdict-onchain':
			focus('arc')
			s.working.arm = true
			move('verdict', 'chainlink', 'bank')
			if (e.status === 'REVISE') {
				s.crateTag = `Revise #${e.round + 1}`
				s.screens.bank = `REVISE · try ${e.round + 2}`
			} else if (e.status === 'ACCEPT') {
				s.belt = 'completed'
				s.screens.bank = 'ACCEPT · paid'
				s.finished = 'ACCEPT'
			} else if (e.status === 'REJECT') {
				s.belt = 'rejected'
				s.screens.bank = 'REJECT · refunded'
				s.finished = 'REJECT'
			}
			receipt('Arc', `${e.status} written by CRE forwarder`, txUrl(d.txHash))
			chain(e.status, d.txHash)
			break
		case 'submitted':
			focus('arc')
			s.belt = 'submitted'
			s.crateTag = undefined
			s.screens.bank = 'submitted (final)'
			move('hash', 'workshop', 'bank')
			receipt('Arc', `Agent submitted v${e.round + 1}`, txUrl(d.submitTxHash))
			chain('submit', d.submitTxHash)
			break
		case 'fees-credited':
			s.coins = { ...s.coins, judges: s.coins.judges + 1 }
			receipt('Arc', `Judge fees credited ${s.feePerReport ? `${usdc(s.feePerReport)} each` : ''}`.trim())
			break
		case 'paid':
			focus('agents')
			s.capsule = { id: e.seq, kind: 'usdc', from: 'arc', to: 'agents' }
			s.coins = { ...s.coins, seller: s.coins.seller + 1 }
			s.working.arm = false
			receipt('Arc', `Agent paid ${usdc(typeof d.amount === 'string' ? d.amount : s.budget)}`.trim(), txUrl(d.txHash))
			break
		case 'refunded':
			s.capsule = { id: e.seq, kind: 'usdc', from: 'arc', to: 'hq' }
			s.coins = { ...s.coins, refund: s.coins.refund + 1 }
			s.working.arm = false
			receipt('Arc', `Buyer refunded ${usdc(s.budget)}`.trim(), txUrl(d.txHash))
			break
		case 'deal-failed':
			s.screens.hq = 'Deal failed'
			s.working.arm = false
			receipt('HQ', `Deal failed: ${String(d.error ?? '')}`)
			break
		case 'failure-artifact':
			focus('judges')
			s.crateTag = 'NO DELIVERABLE'
			receipt('Coordinator', 'Worker failure sent to evaluators as a failure artifact')
			break
		case 'failure-evaluation':
			if (e.status === 'failed') receipt('Coordinator', 'Evaluation unavailable · refund unlock shown above')
			break
	}
	return s
}
