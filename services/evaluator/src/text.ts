// Turns a deliverable (HTML) into the `state` the decision model reads, and enforces the token budget.

/** Visible text of an HTML page plus a short structural summary. Scripts, styles and hidden text are dropped. */
export const htmlToState = (html: string): string => {
	const noScripts = html
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
		// Hidden elements are not part of what a visitor sees; they're a classic injection channel.
		.replace(/<([a-z0-9]+)\b[^>]*(hidden|display\s*:\s*none|visibility\s*:\s*hidden|aria-hidden\s*=\s*"true")[^>]*>[\s\S]*?<\/\1>/gi, ' ')

	const headings = [...noScripts.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
		.map((m) => clean(m[1] ?? ''))
		.filter(Boolean)
		.slice(0, 8)

	const text = clean(
		noScripts
			.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)[^>]*>/gi, '\n')
			.replace(/<[^>]+>/g, ' '),
	)

	const structure = headings.length ? `Sections: ${headings.join(' | ')}\n\n` : ''
	return `${structure}${text}`.trim()
}

const clean = (s: string) =>
	decodeEntities(s)
		.replace(/[ \t\f\v]+/g, ' ')
		.replace(/\s*\n\s*/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()

const decodeEntities = (s: string) =>
	s
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))

/**
 * Conservative token estimate. Laya uses a ModernBERT tokenizer (~4 chars/token for English);
 * we assume 3 chars/token so we under-fill rather than get silently truncated.
 */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3)
