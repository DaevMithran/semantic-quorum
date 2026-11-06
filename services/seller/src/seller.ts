// The seller agent: brief -> page (0G) -> round -> revise on deficiencies -> submit on PASS.

import { type Hex, keccak256, toBytes } from 'viem'
import type { Scorecard } from '../../../cre/src/protocol/rules.ts'
import type { BoardBundle, Policy } from '../../../cre/src/protocol/types.ts'
import type { Config } from './config.ts'
import { type Generation, generate } from './llm.ts'

export type Submitter = (jobId: string, evidenceHash: Hex) => Promise<Hex>
type RoundResult = { status: string; cre?: { scorecard?: Scorecard; reason?: string } }

const SYSTEM =
	'You are a web developer. Reply with ONE complete, self-contained HTML document (inline CSS, no scripts, no external assets). ' +
	'Keep it short: under 300 words of visible text. Put every requirement in visible text. No explanations outside the HTML.'

const pct = (bps: number) => `${Math.round(bps / 100)}%`

/** The judges' scorecard as plain text: every check in rubric order, each judge's score vs. what it needs. */
export const scorecardText = (card: Scorecard) =>
	card.rows
		.map((r) => {
			const tag = r.pass ? 'PASS' : r.must ? 'FAIL (required)' : 'FAIL (nice to have)'
			const judges = r.scores.map((x) => `judge ${x.evaluatorIndex}: ${pct(x.bps)} (needs ${pct(x.needBps)})`).join(', ')
			return `- [${tag}] ${r.statement} | ${judges}`
		})
		.join('\n')

export const promptFor = (policy: Policy, prev?: { html: string; card?: Scorecard }) => {
	const reqs = policy.criteria.map((c) => `- ${c.statement}${c.must ? '' : ' (nice to have)'}`)
	let p = `Brief: ${policy.brief ?? '(none)'}\n\nRequirements:\n${reqs.join('\n')}`
	if (prev) {
		p += prev.card
			? `\n\nThe judges scored your previous version. Fix every FAIL and keep every PASS:\n${scorecardText(prev.card)}`
			: '\n\nYour previous version was not accepted. Improve it against the brief and every requirement.'
		p += `\n\nPrevious version:\n${prev.html}`
	}
	return p
}

/** Binds the page to how it was made: the hash the evaluators score and the seller submits on Arc. */
export const evidenceHashOf = (jobId: string, round: number, g: Generation): Hex =>
	keccak256(toBytes(JSON.stringify({ v: 'sq-evidence-1', jobId, round, htmlHash: keccak256(toBytes(g.html)), model: g.model, requestId: g.requestId, receiptHash: g.receiptHash })))

export const runSeller = async (cfg: Config, jobId: string, deps: { fetchImpl?: typeof fetch; submit?: Submitter; log?: (m: string) => void } = {}) => {
	const f = deps.fetchImpl ?? fetch
	const log = deps.log ?? console.log
	const post = async (path: string, body: unknown) => {
		const r = await f(`${cfg.coordinatorUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
		const out = (await r.json()) as RoundResult & { error?: unknown }
		if (!r.ok) throw new Error(`coordinator ${path}: ${JSON.stringify(out.error ?? out)}`)
		return out
	}

	const b = await f(`${cfg.coordinatorUrl}/bundle?jobId=${jobId}&round=0`)
	if (!b.ok) throw new Error(`job ${jobId} is not on the board`)
	const policy = JSON.parse(((await b.json()) as BoardBundle).policy) as Policy
	const rounds = Math.min(cfg.maxRounds, policy.revisionLimit + 1)

	let prev: { html: string; card?: Scorecard } | undefined
	for (let round = 0; round < rounds; round++) {
		const g = await generate({ ...cfg.llm, fetchImpl: deps.fetchImpl }, SYSTEM, promptFor(policy, prev))
		const evidenceHash = evidenceHashOf(jobId, round, g)
		log(`round ${round}: wrote ${g.html.length} chars (0G ${g.requestId}), evidence ${evidenceHash}`)

		const res = await post('/rounds', { jobId, round, evidenceHash, html: g.html })
		log(`round ${round}: ${res.status}`)

		if (res.status === 'PASS') {
			if (cfg.submit === 'off' || !deps.submit) return { status: 'PASS', round, evidenceHash }
			const submitTxHash = await deps.submit(jobId, evidenceHash)
			log(`submitted on Arc: ${submitTxHash}`)
			const fin = await post('/rounds/final', { jobId, round, evidenceHash, submitTxHash })
			log(`final: ${fin.status}`)
			return { status: fin.status, round, evidenceHash, submitTxHash }
		}
		if (res.status !== 'REVISE') return { status: res.status, round, evidenceHash, reason: res.cre?.reason }

		prev = { html: g.html, card: res.cre?.scorecard }
	}
	return { status: 'OUT_OF_ROUNDS' }
}
