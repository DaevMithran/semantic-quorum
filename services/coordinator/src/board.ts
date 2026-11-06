// Report board: per-job policy + snapshot (exact JSON text), per-round signed reports, hosted pages.
// Persisted to a JSON file so a restart doesn't lose reports.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { BoardBundle, BoardReport } from '../../../cre/src/protocol/types.ts'

type JobEntry = { policy: string; snapshot: string }

/** A deal started from the UI, funded from the buyer's wallet. */
export type DealRecord = {
	jobId: string
	prepId?: string
	funding?: 'wallet'
	task: string
	createdAt: string
	seller: { id: string; ens: string; model: string; address: string }
	buyer: string
	budget: string // USDC, 6 decimals
	feePerReport: string
	revisionLimit: number
	committee: { evaluatorId: string; profileId: string; feeRecipient: string }[]
	txs: Record<string, string>
	status: 'created' | 'funded' | 'working' | 'failed' | 'accepted' | 'rejected'
	error?: string
}

/** A deal being set up from the buyer's wallet: the exact rubric + committee text and terms, frozen at prepare. */
export type Prep = {
	prepId: string
	createdAt: number
	task: string
	buyer: string
	seller: { id: string; ens: string; model: string }
	policyText: string
	snapshotText: string
	policyHash: `0x${string}`
	snapshotHash: `0x${string}`
	budget: string // 6 decimals
	feePerReport: string
	deposit: string
	revisionLimit: number
	expiredAt: string
	decisionDeadline: string
	jobId?: string
	txs?: Record<string, string>
}

/** What CRE decided for one round/phase, kept so the UI can rebuild a deal after a reload. */
export type Outcome = {
	round: number
	phase: 'draft' | 'final'
	status: string
	scorecard?: unknown
	txHash?: string
	deliveredVia?: string
	at: string
}

type State = {
	jobs: Record<string, JobEntry>
	reports: Record<string, BoardReport[]> // key `${jobId}:${round}`
	pages: Record<string, string> // key `${jobId}:${round}` -> html
	deals: Record<string, DealRecord>
	outcomes: Record<string, Outcome[]> // key jobId
	preps: Record<string, Prep>
}

export class Board {
	private s: State = { jobs: {}, reports: {}, pages: {}, deals: {}, outcomes: {}, preps: {} }

	constructor(private readonly dataFile?: string, seedFile?: string) {
		if (dataFile && existsSync(dataFile)) {
			this.s = { deals: {}, outcomes: {}, preps: {}, ...(JSON.parse(readFileSync(dataFile, 'utf8')) as Partial<State>) } as State
			let repaired = false
			for (const [jobId, outcomes] of Object.entries(this.s.outcomes)) {
				for (const outcome of outcomes) {
					if (/^0x0{64}$/i.test(outcome.txHash ?? '')) {
						delete outcome.txHash
						outcome.deliveredVia = 'simulation'
						repaired = true
					}
				}
				const deal = this.s.deals[jobId]
				const hasMinedTerminal = outcomes.some((outcome) => !!outcome.txHash && (outcome.status === 'ACCEPT' || outcome.status === 'REJECT'))
				if (deal && (deal.status === 'accepted' || deal.status === 'rejected') && !hasMinedTerminal) {
					deal.status = 'working'
					repaired = true
				}
			}
			if (repaired) this.save()
		} else if (seedFile && existsSync(seedFile)) {
			// cre/fixtures/board.json format: { "jobId:round": { policy, snapshot, reports } }
			const seed = JSON.parse(readFileSync(seedFile, 'utf8')) as Record<string, BoardBundle>
			for (const [key, b] of Object.entries(seed)) {
				const jobId = key.split(':')[0] as string
				this.s.jobs[jobId] = { policy: b.policy, snapshot: b.snapshot }
				this.s.reports[key] = b.reports
			}
			this.save()
		}
	}

	private save() {
		if (this.dataFile) writeFileSync(this.dataFile, JSON.stringify(this.s, null, 2))
	}

	putJob(jobId: string, policy: string, snapshot: string) {
		JSON.parse(policy)
		JSON.parse(snapshot)
		this.s.jobs[jobId] = { policy, snapshot }
		this.save()
	}

	job(jobId: string): JobEntry | undefined {
		return this.s.jobs[jobId]
	}

	bundle(jobId: string, round: number): BoardBundle | undefined {
		const j = this.s.jobs[jobId]
		if (!j) return undefined
		return { policy: j.policy, snapshot: j.snapshot, reports: this.s.reports[`${jobId}:${round}`] ?? [] }
	}

	putReport(jobId: string, round: number, report: BoardReport) {
		const key = `${jobId}:${round}`
		const list = (this.s.reports[key] ?? []).filter((r) => r.evaluatorIndex !== report.evaluatorIndex)
		this.s.reports[key] = [...list, report]
		this.save()
	}

	putPage(jobId: string, round: number, html: string) {
		this.s.pages[`${jobId}:${round}`] = html
		this.save()
	}

	page(jobId: string, round: number): string | undefined {
		return this.s.pages[`${jobId}:${round}`]
	}

	putDeal(d: DealRecord) {
		this.s.deals[d.jobId] = d
		this.save()
	}

	deal(jobId: string): DealRecord | undefined {
		return this.s.deals[jobId]
	}

	deals(): DealRecord[] {
		return Object.values(this.s.deals).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
	}

	putPrep(p: Prep) {
		this.s.preps[p.prepId] = p
		this.save()
	}

	prep(prepId: string): Prep | undefined {
		return this.s.preps[prepId]
	}

	putOutcome(jobId: string, o: Outcome) {
		this.s.outcomes[jobId] = [...(this.s.outcomes[jobId] ?? []).filter((x) => !(x.round === o.round && x.phase === o.phase)), o]
		const d = this.s.deals[jobId]
		if (d && o.txHash && (o.status === 'ACCEPT' || o.status === 'REJECT')) d.status = o.status === 'ACCEPT' ? 'accepted' : 'rejected'
		this.save()
	}

	outcomes(jobId: string): Outcome[] {
		return this.s.outcomes[jobId] ?? []
	}

	/** Every round we have a page or reports for. */
	rounds(jobId: string): number[] {
		const keys = [...Object.keys(this.s.pages), ...Object.keys(this.s.reports)].filter((k) => k.startsWith(`${jobId}:`))
		return [...new Set(keys.map((k) => Number(k.split(':')[1])))].sort((a, b) => a - b)
	}

	reports(jobId: string, round: number): BoardReport[] {
		return this.s.reports[`${jobId}:${round}`] ?? []
	}
}
