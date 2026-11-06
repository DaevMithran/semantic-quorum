// Runs one round: page -> both evaluators -> CRE -> (relay) -> result. And the final round after submit.

import type { Hex } from 'viem'
import type { Snapshot } from '../../../cre/src/protocol/types.ts'
import type { Board } from './board.ts'
import type { CreResult, CreRunner } from './cre.ts'
import type { Events } from './events.ts'
import type { Relay, VerdictJson } from './relay.ts'

export type RoundDeps = {
	board: Board
	events: Events
	cre: CreRunner
	relay?: Relay
	evaluators: Record<string, string>
	publicUrl: string
	fetchImpl?: typeof fetch
}

export type RoundInput = { jobId: string; round: number; evidenceHash: string; html: string }
export type FinalInput = { jobId: string; round: number; evidenceHash: string; submitTxHash: string }

export type EvaluatorOutcome = { index: number; evaluatorId: string; ok: boolean; requestId?: string; error?: string }

const ONCHAIN = new Set(['ACCEPT', 'REVISE', 'REJECT'])

export const makeRounds = (d: RoundDeps) => {
	const f = d.fetchImpl ?? fetch

	const deliver = async (jobId: string, round: number, res: CreResult) => {
		if (!ONCHAIN.has(res.status)) return res
		// SQController turns REVISE at the registered limit into an effective REJECT.
		// Keep the signed verdict untouched, but report the state transition the contract executed.
		const limit = d.board.deal(jobId)?.revisionLimit
		const effectiveStatus = res.status === 'REVISE' && limit !== undefined && round >= limit ? 'REJECT' : res.status
		const delivered = () => effectiveStatus === res.status ? res : { ...res, status: effectiveStatus }
		if (res.deliveredVia === 'cre-forwarder') {
			d.events.add(jobId, round, 'verdict-onchain', effectiveStatus, { txHash: res.txHash, via: 'cre-forwarder', signedStatus: res.status })
			return delivered()
		}
		if (!d.relay) {
			d.events.add(jobId, round, 'verdict-signed', res.status, { note: 'relay disabled; not submitted onchain' })
			return res
		}
		const r = await d.relay(res.verdict as unknown as VerdictJson, res.signature as Hex)
		d.events.add(jobId, round, 'verdict-onchain', effectiveStatus, { txHash: r.txHash, via: 'relay', signedStatus: res.status })
		return { ...delivered(), txHash: r.txHash, deliveredVia: 'relay' }
	}

	/** Persist the outcome and, once a verdict is onchain, record what the judges and seller earned. */
	const record = (jobId: string, round: number, phase: 'draft' | 'final', res: CreResult) => {
		d.board.putOutcome(jobId, { round, phase, status: res.status, scorecard: res.scorecard, txHash: res.txHash, deliveredVia: res.deliveredVia, at: new Date().toISOString() })
		const deal = d.board.deal(jobId)
		if (!res.txHash || !ONCHAIN.has(res.status)) return
		const mask = BigInt(String((res.verdict as { includedMask?: unknown } | undefined)?.includedMask ?? 0))
		const judges = (deal?.committee ?? []).filter((_, i) => (mask >> BigInt(i)) & 1n).map((j) => j.evaluatorId)
		if (deal && judges.length) d.events.add(jobId, round, 'fees-credited', 'ok', { judges, feePerReport: deal.feePerReport })
		if (res.status === 'ACCEPT') d.events.add(jobId, round, 'paid', 'ok', { to: deal?.seller.ens ?? 'seller', amount: deal?.budget, txHash: res.txHash })
		if (res.status === 'REJECT') d.events.add(jobId, round, 'refunded', 'ok', { to: 'buyer', amount: deal?.budget, txHash: res.txHash })
	}

	/** Draft phase: evaluate an attempt while the job is Funded. */
	const runRound = async (i: RoundInput) => {
		const job = d.board.job(i.jobId)
		if (!job) throw new Error(`job ${i.jobId} not registered on the board`)
		const snapshot = JSON.parse(job.snapshot) as Snapshot

		d.board.putPage(i.jobId, i.round, i.html)
		const pageUrl = `${d.publicUrl}/pages/${i.jobId}/${i.round}`
		d.events.add(i.jobId, i.round, 'delivered', 'ok', { evidenceHash: i.evidenceHash, pageUrl })

		const evaluators: EvaluatorOutcome[] = await Promise.all(
			snapshot.committee.map(async (m) => {
				const url = d.evaluators[m.evaluatorId]
				if (!url) return { index: m.index, evaluatorId: m.evaluatorId, ok: false, error: 'no URL configured' }
				d.events.add(i.jobId, i.round, `judge-${m.index}`, 'running', { evaluatorId: m.evaluatorId })
				try {
					const res = await f(`${url}/evaluate`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ jobId: i.jobId, round: i.round, evaluatorIndex: m.index, evidenceHash: i.evidenceHash, pageUrl }),
					})
					const body = (await res.json()) as { requestId?: string; error?: string }
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
					d.events.add(i.jobId, i.round, `judge-${m.index}`, 'done', { evaluatorId: m.evaluatorId, requestId: body.requestId })
					return { index: m.index, evaluatorId: m.evaluatorId, ok: true, requestId: body.requestId }
				} catch (e) {
					const error = e instanceof Error ? e.message : String(e)
					d.events.add(i.jobId, i.round, `judge-${m.index}`, 'failed', { evaluatorId: m.evaluatorId, error })
					return { index: m.index, evaluatorId: m.evaluatorId, ok: false, error }
				}
			}),
		)

		d.events.add(i.jobId, i.round, 'cre', 'running', { phase: 'draft' })
		const cre = await d.cre({ jobId: i.jobId, round: i.round, phase: 'draft', evidenceHash: i.evidenceHash })
		d.events.add(i.jobId, i.round, 'cre', cre.status, { phase: 'draft', deficiencies: cre.deficiencies, scorecard: cre.scorecard })
		const delivered = await deliver(i.jobId, i.round, cre)
		record(i.jobId, i.round, 'draft', delivered)
		if (delivered.status === 'REVISE') d.events.add(i.jobId, i.round + 1, 'seller-writing', 'running', { reason: 'revise' })
		return { status: delivered.status, evaluators, cre: delivered }
	}

	/** Final phase: after the seller submitted the passing version on Arc. */
	const runFinal = async (i: FinalInput) => {
		const deal = d.board.deal(i.jobId)
		if (deal) d.board.putDeal({ ...deal, txs: { ...deal.txs, submit: i.submitTxHash } })
		d.events.add(i.jobId, i.round, 'submitted', 'ok', { submitTxHash: i.submitTxHash })
		d.events.add(i.jobId, i.round, 'cre', 'running', { phase: 'final' })
		const cre = await d.cre({ jobId: i.jobId, round: i.round, phase: 'final', evidenceHash: i.evidenceHash, submitTxHash: i.submitTxHash })
		d.events.add(i.jobId, i.round, 'cre', cre.status, { phase: 'final', scorecard: cre.scorecard })
		const delivered = await deliver(i.jobId, i.round, cre)
		record(i.jobId, i.round, 'final', delivered)
		return { status: delivered.status, cre: delivered }
	}

	return { runRound, runFinal }
}
