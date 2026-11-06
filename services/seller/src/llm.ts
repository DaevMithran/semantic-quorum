// Writes an artifact with a 0G Router chat model (OpenAI-compatible).

import { type Hex, keccak256, toBytes } from 'viem'

export type Generation = { html: string; requestId: string; receiptHash: Hex; model: string }

export type ChatOpts = { baseUrl: string; apiKey: string; model: string; trustMode: string; maxTokens: number; fetchImpl?: typeof fetch }

export const generate = async (o: ChatOpts, system: string, user: string): Promise<Generation> => {
	const f = o.fetchImpl ?? fetch
	let res: Response | undefined
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			res = await f(`${o.baseUrl}/v1/chat/completions`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${o.apiKey}`,
					...(o.trustMode ? { 'X-0G-Provider-Trust-Mode': o.trustMode } : {}),
				},
				body: JSON.stringify({
					model: o.model,
					max_tokens: o.maxTokens,
					messages: [
						{ role: 'system', content: system },
						{ role: 'user', content: user },
					],
				}),
				signal: AbortSignal.timeout(300_000),
			})
			if (res.ok || ![429, 502, 503, 504].includes(res.status) || attempt === 3) break
			await res.body?.cancel()
		} catch (error) {
			if (attempt === 3) throw error
		}
		await Bun.sleep(250 * attempt)
	}
	if (!res) throw new Error('0G chat returned no response')
	const raw = await res.text()
	if (!res.ok) throw new Error(`0G chat ${res.status}: ${raw.slice(0, 500)}`)
	const body = JSON.parse(raw) as { id?: string; model?: string; choices?: { message?: { content?: string } }[] }
	const content = body.choices?.[0]?.message?.content ?? ''
	const html = extractHtml(content)
	if (!html) throw new Error('model returned no HTML')
	const receiptHash = keccak256(toBytes(raw))
	return {
		html,
		requestId: res.headers.get('x-request-id') ?? body.id ?? `unknown:${receiptHash.slice(2, 18)}`,
		receiptHash,
		model: body.model ?? o.model,
	}
}

/** Drops thinking text and code fences; returns the HTML document, or '' if there is none. */
export const extractHtml = (text: string): string => {
	const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '')
	const fenced = t.match(/```(?:html)?\s*([\s\S]*?)```/i)?.[1] ?? t
	const start = fenced.search(/<!doctype html|<html/i)
	if (start < 0) return ''
	const end = fenced.toLowerCase().lastIndexOf('</html>')
	return (end > start ? fenced.slice(start, end + 7) : fenced.slice(start)).trim()
}
