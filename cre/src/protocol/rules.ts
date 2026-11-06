// Deterministic Semantic Quorum decision rules. Pure functions, integers only.

import type { EvaluationResult, Policy, VerdictKindName } from './types.ts'

export const OVERALL_ID = 'overall'

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
 *  - A low overall score is reported as the deficiency 'overall', so the seller knows.
 */
export const voteFor = (
	evaluatorIndex: number,
	result: EvaluationResult,
	policy: Policy,
	_round: number, // kept for callers; the rules don't depend on the round
): ReportVote => {
	const t = policy.profiles[result.profileId]
	if (!t) throw new Error(`no thresholds for profile ${result.profileId}`)

	const byId = new Map(result.criteria.map((c) => [c.id, c.passBps]))
	const failed: Deficiency[] = []
	let mustFailed = false

	for (const c of policy.criteria) {
		const p = byId.get(c.id)
		if (p === undefined) throw new Error(`report missing criterion ${c.id}`)
		assertBps(p, `criterion ${c.id}`)
		if (p < t.criterionPassBps) {
			failed.push({ criterionId: c.id, gapBps: t.criterionPassBps - p })
			if (c.must) mustFailed = true
		}
	}

	const overall = result.overall.expectedLevelBps
	assertBps(overall, 'overall')

	if (overall < t.overallAcceptBps) failed.push({ criterionId: OVERALL_ID, gapBps: t.overallAcceptBps - overall })

	let vote: VerdictKindName
	if (overall < t.overallRejectBps) vote = 'REJECT'
	else if (!mustFailed && overall >= t.overallAcceptBps) vote = 'ACCEPT'
	else vote = 'REVISE'

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

// ---------------------------------------------------------------------------
// Scorecard: the feedback the seller revises from. Every rubric row in rubric order, then overall,
// with each judge's own score against its own threshold. Its hash is the verdict's deficiencyHash.
// ---------------------------------------------------------------------------

export type JudgeScore = { evaluatorIndex: number; profileId: string; bps: number; needBps: number; pass: boolean }

export type ScoreRow = {
	id: string // criterion id, or 'overall'
	statement: string
	must: boolean
	scores: JudgeScore[]
	pass: boolean // every judge passes this row
}

export type Scorecard = { version: 'sq-scorecard-1'; round: number; verdict: VerdictKindName; rows: ScoreRow[] }

export const scorecard = (
	policy: Policy,
	reports: { evaluatorIndex: number; result: EvaluationResult }[],
	round: number,
	verdict: VerdictKindName,
): Scorecard => {
	const row = (id: string, statement: string, must: boolean, pick: (r: EvaluationResult) => { bps: number; need: number }): ScoreRow => {
		const scores = reports.map(({ evaluatorIndex, result }) => {
			const { bps, need } = pick(result)
			return { evaluatorIndex, profileId: result.profileId, bps, needBps: need, pass: bps >= need }
		})
		return { id, statement, must, scores, pass: scores.every((x) => x.pass) }
	}
	const thresholds = (r: EvaluationResult) => {
		const t = policy.profiles[r.profileId]
		if (!t) throw new Error(`no thresholds for profile ${r.profileId}`)
		return t
	}
	const rows = policy.criteria.map((c) =>
		row(c.id, c.statement, c.must, (r) => ({
			bps: r.criteria.find((x) => x.id === c.id)?.passBps ?? 0,
			need: thresholds(r).criterionPassBps,
		})),
	)
	rows.push(
		row(OVERALL_ID, policy.brief ? `Overall quality against the brief: ${policy.brief}` : 'Overall quality', true, (r) => ({
			bps: r.overall.expectedLevelBps,
			need: thresholds(r).overallAcceptBps,
		})),
	)
	return { version: 'sq-scorecard-1', round, verdict, rows }
}

// ---------------------------------------------------------------------------
// Rubric limits. Laya reads ~512 tokens and every criterion's text is part of the request,
// so rubrics stay small and each criterion is one short, checkable yes/no statement.
// ---------------------------------------------------------------------------

export const RUBRIC_LIMITS = { maxCriteria: 6, maxStatementChars: 160, maxBriefChars: 300 } as const

/** Returns a list of problems; empty means the policy is valid. */
export const checkPolicy = (p: Policy): string[] => {
	const errs: string[] = []
	const L = RUBRIC_LIMITS
	if (p.version !== 'sq-policy-1') errs.push('version must be sq-policy-1')
	if (!Array.isArray(p.criteria) || p.criteria.length === 0) errs.push('at least one criterion is required')
	else if (p.criteria.length > L.maxCriteria) errs.push(`at most ${L.maxCriteria} criteria`)
	if (p.brief && p.brief.length > L.maxBriefChars) errs.push(`brief longer than ${L.maxBriefChars} characters`)
	const ids = new Set<string>()
	for (const c of p.criteria ?? []) {
		if (!/^[a-z0-9_-]{1,16}$/i.test(c.id ?? '')) errs.push(`criterion id "${c.id}" must be 1-16 letters, digits, _ or -`)
		if (c.id === OVERALL_ID) errs.push(`criterion id "${OVERALL_ID}" is reserved`)
		if (ids.has(c.id)) errs.push(`duplicate criterion id "${c.id}"`)
		ids.add(c.id)
		const st = (c.statement ?? '').trim()
		if (!st) errs.push(`criterion ${c.id}: statement is empty`)
		if (st.length > L.maxStatementChars) errs.push(`criterion ${c.id}: statement longer than ${L.maxStatementChars} characters`)
		if (typeof c.must !== 'boolean') errs.push(`criterion ${c.id}: must is required (true/false)`)
	}
	if (!Number.isInteger(p.revisionLimit) || p.revisionLimit < 0 || p.revisionLimit > 10) errs.push('revisionLimit must be 0..10')
	for (const [id, t] of Object.entries(p.profiles ?? {})) {
		const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 10_000
		if (!ok(t.criterionPassBps) || !ok(t.overallAcceptBps) || !ok(t.overallRejectBps)) errs.push(`profile ${id}: thresholds must be integer bps 0..10000`)
		else if (t.overallRejectBps >= t.overallAcceptBps) errs.push(`profile ${id}: overallRejectBps must be below overallAcceptBps`)
	}
	if (!p.profiles || Object.keys(p.profiles).length === 0) errs.push('profiles (per-model thresholds) are required')
	return errs
}
