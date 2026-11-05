// Deterministic Semantic Quorum decision rules. Pure functions, integers only.

import type { EvaluationResult, Policy, VerdictKindName } from './types.ts'

export type Deficiency = { criterionId: string; gapBps: number }

export type ReportVote = {
	evaluatorIndex: number
	vote: VerdictKindName
	failed: Deficiency[]
}

export type CommitteeDecision = {
	kind: VerdictKindName
	deficiencies: Deficiency[] // union of failed criteria, ranked by largest gap first
	votes: ReportVote[]
}

/**
 * One evaluator's vote, from that evaluator's own profile thresholds.
 * Probabilities from different models are never mixed.
 *  - ACCEPT: every `must` criterion passes and overall >= accept threshold
 *  - REJECT: overall < reject threshold
 *  - otherwise REVISE
 *  - The overall score can block ACCEPT but never rescues a failed `must`.
 *  - In round 0, a failed private check can only produce REVISE (never REJECT).
 */
export const voteFor = (
	evaluatorIndex: number,
	result: EvaluationResult,
	policy: Policy,
	round: number,
): ReportVote => {
	const t = policy.profiles[result.profileId]
	if (!t) throw new Error(`no thresholds for profile ${result.profileId}`)

	const byId = new Map(result.criteria.map((c) => [c.id, c.passBps]))
	const failed: Deficiency[] = []
	let mustFailed = false
	let privateFailed = false

	for (const c of policy.criteria) {
		const p = byId.get(c.id)
		if (p === undefined) throw new Error(`report missing criterion ${c.id}`)
		assertBps(p, `criterion ${c.id}`)
		if (p < t.criterionPassBps) {
			failed.push({ criterionId: c.id, gapBps: t.criterionPassBps - p })
			if (c.must) mustFailed = true
			if (c.private) privateFailed = true
		}
	}

	const overall = result.overall.expectedLevelBps
	assertBps(overall, 'overall')

	let vote: VerdictKindName
	if (overall < t.overallRejectBps) vote = 'REJECT'
	else if (!mustFailed && overall >= t.overallAcceptBps) vote = 'ACCEPT'
	else vote = 'REVISE'

	if (vote === 'REJECT' && round === 0 && privateFailed) vote = 'REVISE'

	return { evaluatorIndex, vote, failed }
}

/**
 * Committee rule (MVP: 2 evaluators, Laya + Vela):
 *  - ACCEPT only if every report votes ACCEPT
 *  - REJECT if every report votes REJECT
 *  - otherwise REVISE, with the union of failed criteria ranked by largest gap
 * The revision limit is enforced onchain: REVISE at the limit becomes REJECT there.
 */
export const decide = (votes: ReportVote[]): CommitteeDecision => {
	if (votes.length === 0) throw new Error('no votes')
	const all = (k: VerdictKindName) => votes.every((v) => v.vote === k)
	const kind: VerdictKindName = all('ACCEPT') ? 'ACCEPT' : all('REJECT') ? 'REJECT' : 'REVISE'

	const worst = new Map<string, number>()
	for (const v of votes) {
		for (const f of v.failed) worst.set(f.criterionId, Math.max(worst.get(f.criterionId) ?? 0, f.gapBps))
	}
	const deficiencies = [...worst.entries()]
		.map(([criterionId, gapBps]) => ({ criterionId, gapBps }))
		.sort((a, b) => b.gapBps - a.gapBps || a.criterionId.localeCompare(b.criterionId))

	return { kind, deficiencies, votes }
}

const assertBps = (n: number, what: string) => {
	if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new Error(`${what}: not integer bps 0..10000`)
}
