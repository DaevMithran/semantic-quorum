// Scores one deliverable against a policy with one decision model, and returns an EvaluationResult.
//
// Token budget (MVP): if the work doesn't fit the model's window, we FAIL CLOSED rather than chunk.
// Every report needs an overall-quality score over the whole work, which a chunked call can't give,
// and a silently truncated input would let a seller hide content past the window. Keep demo pages short
// (Laya EN reads ~512 tokens); Vela reads 16k.

import type { EvaluationResult, Policy } from '../../../cre/src/protocol/types.ts'
import type { DecisionsClient, DecisionsResult, Question } from './decisions.ts'
import { estimateTokens } from './text.ts'

export const SCORE_LEVELS = ['Poor', 'Fair', 'Good', 'Excellent']
const OVERALL = 'overall'
const SPANS = 'spans'
const QUESTION_RESERVE_TOKENS = 160

export type EvaluateInput = {
	state: string
	policy: Policy
	profileId: string
	modelId: string
	provider: string
	tokenBudget: number
	enableSpans: boolean
}

export type Evaluation = { result: EvaluationResult; call: DecisionsResult }

export const buildQuestions = (policy: Policy, spans: boolean): Record<string, Question> => {
	const q: Record<string, Question> = {}
	for (const c of policy.criteria) q[c.id] = { type: 'noul', instructions: c.statement }
	q[OVERALL] = {
		type: 'score',
		instructions: policy.brief
			? `How well does this work meet the brief: ${policy.brief}`
			: 'How well does this work meet the brief?',
		criteria: SCORE_LEVELS,
	}
	if (spans) q[SPANS] = { type: 'span', instructions: 'Mark text that contradicts or fails the brief.' }
	return q
}

export const probToBps = (p: unknown, what: string): number => {
	if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`${what}: probability out of range`)
	return Math.round(p * 10_000)
}

/** Expected level 0..(n-1) mapped to 0..10000. */
export const levelToBps = (score: unknown, levels = SCORE_LEVELS.length): number => {
	if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > levels - 1) {
		throw new Error('overall: score out of range')
	}
	return Math.round((score / (levels - 1)) * 10_000)
}

export const evaluate = async (client: DecisionsClient, input: EvaluateInput): Promise<Evaluation> => {
	const { policy } = input
	const tokens = estimateTokens(input.state) + QUESTION_RESERVE_TOKENS
	if (tokens > input.tokenBudget) {
		throw new Error(`INPUT_OVER_BUDGET: ~${tokens} tokens > ${input.tokenBudget} for ${input.profileId}`)
	}

	const call = await client.decide({
		model: input.modelId,
		state: input.state,
		questions: buildQuestions(policy, input.enableSpans),
	})
	const a = call.reply.answers

	const criteria = policy.criteria.map((c) => {
		const ans = a[c.id] as { type?: string; noul?: unknown } | undefined
		if (!ans || ans.type !== 'noul') throw new Error(`answer for ${c.id} missing or not noul`)
		return { id: c.id, passBps: probToBps(ans.noul, c.id) }
	})

	const o = a[OVERALL] as { type?: string; score?: unknown } | undefined
	if (!o || o.type !== 'score') throw new Error('overall answer missing or not score')
	const overallBps = levelToBps(o.score)

	let spans: EvaluationResult['spans']
	if (input.enableSpans) {
		const s = a[SPANS] as { spans?: { start: number; end: number; label?: string }[] } | undefined
		spans = (s?.spans ?? []).map((x) => ({ start: x.start, end: x.end, label: x.label ?? 'issue' }))
	}

	const result: EvaluationResult = {
		profileId: input.profileId,
		modelVersion: call.reply.model ?? input.modelId,
		provider: input.provider,
		requestId: call.requestId,
		receiptHash: call.receiptHash,
		criteria,
		overall: { expectedLevelBps: overallBps },
		...(spans && spans.length ? { spans } : {}),
	}
	return { result, call }
}
