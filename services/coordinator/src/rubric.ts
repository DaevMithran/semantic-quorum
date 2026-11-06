// Drafts a rubric from a plain-language task with an OpenAI-compatible chat model.
// The buyer reviews and edits it; decision models (not this LLM) do all the judging.

import { checkPolicy, RUBRIC_LIMITS } from '../../../cre/src/protocol/rules.ts'
import type { Policy } from '../../../cre/src/protocol/types.ts'

export type DraftOpts = { baseUrl: string; apiKey: string; model: string; trustMode: string; providerName?: string; fetchImpl?: typeof fetch; retryDelayMs?: number; requestTimeoutMs?: number }
export type Draft = { brief: string; criteria: { id: string; statement: string; must: boolean }[] }

const SYSTEM = `You turn a buyer's task into a rubric that small yes/no judging models can score.
Reply with ONLY a JSON object: {"brief": string, "criteria": [{"statement": string, "must": boolean}]}.
Rules:
- brief: one sentence, at most ${RUBRIC_LIMITS.maxBriefChars} characters, describing the deliverable.
- 2 to ${RUBRIC_LIMITS.maxCriteria} criteria. Each is ONE checkable fact about the deliverable, phrased as a statement
  that is true when the work is good, e.g. "The page shows a price list." Never two checks in one statement.
- No vague quality words (good, nice, professional, modern, high quality); the overall quality is judged separately.
- Prohibitions are phrased so true is good: "The page does not ask for a card number."
- must = true for what the buyer explicitly requires, false for nice-to-haves.
- Each statement at most ${RUBRIC_LIMITS.maxStatementChars} characters.`

export const parseDraft = (content: string): Draft => {
	const t = content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '')
	const json = t.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)
	const raw = JSON.parse(json) as { brief?: unknown; criteria?: { statement?: unknown; must?: unknown }[] }
	const criteria = (raw.criteria ?? [])
		.filter((c) => typeof c.statement === 'string' && c.statement.trim())
		.slice(0, RUBRIC_LIMITS.maxCriteria)
		.map((c, i) => ({ id: `c${i + 1}`, statement: String(c.statement).trim(), must: c.must !== false }))
	return { brief: String(raw.brief ?? '').trim(), criteria }
}

export const toPolicy = (d: Draft, profiles: Policy['profiles'], revisionLimit = 3): Policy => ({
	version: 'sq-policy-1',
	brief: d.brief,
	criteria: d.criteria,
	profiles,
	revisionLimit,
})

/** Editable local starter used only when the 0G router exhausts transient retries. */
export const starterRubric = (task: string, profiles: Policy['profiles']): Policy => {
	const lower = task.toLowerCase()
	const statements = [
		/(landing page|website|web page)/.test(lower) && 'The deliverable includes the requested web page.',
		/(menu|price list|pricing)/.test(lower) && 'The page shows the requested menu or price list.',
		/upi/.test(lower) && 'The page mentions UPI as a payment option.',
		/(responsive|mobile)/.test(lower) && 'The page adapts to mobile screen sizes.',
		/(source|source files|code)/.test(lower) && 'The deliverable includes the requested source files.',
		/(deploy|deployment)/.test(lower) && 'The deliverable includes deployment instructions.',
		/(research|report)/.test(lower) && 'The deliverable contains the requested research or report.',
		/(source|citation|sourced)/.test(lower) && 'Claims include identifiable sources.',
	].filter((statement): statement is string => Boolean(statement))
	if (statements.length < 2) statements.push('The deliverable addresses the buyer’s stated objective.')
	if (statements.length < 2) statements.push('The deliverable includes every explicitly requested component.')
	return toPolicy({
		brief: task.trim().replace(/\s+/g, ' ').slice(0, RUBRIC_LIMITS.maxBriefChars),
		criteria: statements.slice(0, RUBRIC_LIMITS.maxCriteria).map((statement, index) => ({ id: `c${index + 1}`, statement, must: true })),
	}, profiles)
}

export const isTransient0gError = (error: unknown) => /(?:0G chat (?:429|502|503|504)|fetch|timed?\s*out|network)/i.test(error instanceof Error ? error.message : String(error))

/** One 0G call, validated with checkPolicy; retries once with the problems if the draft is invalid. */
export const draftRubric = async (task: string, profiles: Policy['profiles'], o: DraftOpts): Promise<{ policy: Policy; requestIds: string[] }> => {
	const f = o.fetchImpl ?? fetch
	const provider = o.providerName ?? '0G'
	const ask = async (messages: { role: string; content: string }[]) => {
		const retryable = new Set([429, 502, 503, 504])
		for (let attempt = 0; attempt < 3; attempt++) {
			let res: Response
			try {
				res = await f(`${o.baseUrl}/v1/chat/completions`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}`, ...(o.trustMode ? { 'X-0G-Provider-Trust-Mode': o.trustMode } : {}) },
					body: JSON.stringify({ model: o.model, max_tokens: 800, temperature: 0, messages }),
					signal: AbortSignal.timeout(o.requestTimeoutMs ?? 25_000),
				})
			} catch (error) {
				if (attempt === 2) throw error
				await Bun.sleep((o.retryDelayMs ?? 600) * (attempt + 1))
				continue
			}
			const raw = await res.text()
			if (!res.ok) {
				if (attempt < 2 && retryable.has(res.status)) {
					await Bun.sleep((o.retryDelayMs ?? 600) * (attempt + 1))
					continue
				}
				throw new Error(`${provider} chat ${res.status}: ${raw.slice(0, 300)}`)
			}
			const body = JSON.parse(raw) as { id?: string; choices?: { message?: { content?: string } }[] }
			return { content: body.choices?.[0]?.message?.content ?? '', id: res.headers.get('x-request-id') ?? body.id ?? 'unknown' }
		}
		throw new Error(`${provider} chat failed after retries`)
	}
	const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Task: ${task}` }]
	const ids: string[] = []
	let problems: string[] = []
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await ask(messages)
		ids.push(r.id)
		try {
			const policy = toPolicy(parseDraft(r.content), profiles)
			problems = checkPolicy(policy)
			if (!problems.length) return { policy, requestIds: ids }
		} catch (e) {
			problems = [`not valid JSON: ${(e as Error).message}`]
		}
		messages.push({ role: 'assistant', content: r.content }, { role: 'user', content: `Fix these problems and reply with the JSON only:\n- ${problems.join('\n- ')}` })
	}
	throw new Error(`rubric draft invalid: ${problems.join('; ')}`)
}
