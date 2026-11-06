// Plain rules (no model) that help a buyer write criteria a yes/no judge can score.
// Limits match cre/src/protocol/rules.ts (RUBRIC_LIMITS); the coordinator re-checks on submit.

export const LIMITS = { maxCriteria: 6, maxStatementChars: 160, maxBriefChars: 300 }

const VAGUE = ['good', 'nice', 'great', 'professional', 'modern', 'high quality', 'high-quality', 'beautiful', 'clean', 'appealing', 'engaging', 'best']

export const lintCriterion = (statement: string): string[] => {
	const s = statement.trim()
	const out: string[] = []
	if (!s) return ['Write one checkable fact, e.g. "The page shows a price list."']
	if (s.length > LIMITS.maxStatementChars) out.push(`Shorten to ${LIMITS.maxStatementChars} characters or fewer.`)
	const lower = s.toLowerCase()
	const vague = VAGUE.find((w) => new RegExp(`\\b${w}\\b`).test(lower))
	if (vague) out.push(`"${vague}" is hard to check. Say what makes it ${vague}; overall quality is judged separately.`)
	if (/\b(and|as well as)\b/.test(lower)) out.push('Looks like two checks in one. Split it so each can pass or fail on its own.')
	if (/^(it |the page |the work )?(should not|must not|shouldn't|doesn't|does not|never)\b/.test(lower) && !/\bdoes not\b/.test(lower))
		out.push('Phrase it so "yes" is good: "The page does not …".')
	return out
}
