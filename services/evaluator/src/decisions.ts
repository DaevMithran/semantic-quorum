// Client for the decisions API (TypeSafe Jev "System One" request shape).
// The same code talks to hosted Jev, a local laya-server, or 0G Private Computer:
// only baseUrl, path, apiKey and modelId change.

import { type Hex, keccak256, toBytes } from 'viem'

export type NoulQuestion = { type: 'noul'; instructions: string }
export type ScoreQuestion = { type: 'score'; instructions: string; criteria: string[] }
export type SpanQuestion = { type: 'span'; instructions: string }
export type Question = NoulQuestion | ScoreQuestion | SpanQuestion

export type DecisionsRequest = { model: string; state: string; questions: Record<string, Question> }

export type NoulAnswer = { type: 'noul'; noul: number; confidence?: number }
export type ScoreAnswer = { type: 'score'; score: number; probabilities?: Record<string, number>; confidence?: number }
export type SpanAnswer = { type: 'span'; spans?: { start: number; end: number; label?: string }[] }
export type Answer = NoulAnswer | ScoreAnswer | SpanAnswer | { type: string; [k: string]: unknown }

export type DecisionsReply = {
	answers: Record<string, Answer>
	model?: string
	usage?: { input_tokens?: number; output_tokens?: number }
}

export type DecisionsResult = {
	reply: DecisionsReply
	requestId: string // provider request ID (header or body); 'unknown:<receiptHash>' if none
	receiptHash: Hex // keccak256 of the raw response body
	attestation?: string // TEE signature / attestation if the provider returns one
	teeVerified?: boolean // 0G: `tee_verified` from the response (requested with verify_tee)
	latencyMs: number
}

export type ClientOptions = {
	baseUrl: string
	path: string
	apiKey: string
	timeoutMs?: number
	fetchImpl?: typeof fetch
	extraHeaders?: Record<string, string> // e.g. 0G: X-0G-Provider-Trust-Mode: private
	extraBody?: Record<string, unknown> // e.g. 0G: verify_tee: true
}

const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'x-0g-request-id', 'openai-request-id', 'cf-ray']
const ATTESTATION_HEADERS = ['x-0g-signature', 'x-tee-signature', 'x-attestation', 'x-signature']

export class DecisionsClient {
	constructor(private readonly opts: ClientOptions) {}

	async decide(req: DecisionsRequest): Promise<DecisionsResult> {
		const f = this.opts.fetchImpl ?? fetch
		const started = Date.now()
		const res = await f(`${this.opts.baseUrl}${this.opts.path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
				...(this.opts.extraHeaders ?? {}),
			},
			body: JSON.stringify({ ...req, ...(this.opts.extraBody ?? {}) }),
			signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
		})
		const raw = await res.text()
		const latencyMs = Date.now() - started
		if (!res.ok) throw new Error(`decisions API ${res.status}: ${raw.slice(0, 300)}`)

		let reply: DecisionsReply
		try {
			reply = JSON.parse(raw) as DecisionsReply
		} catch {
			throw new Error('decisions API returned non-JSON')
		}
		if (!reply || typeof reply.answers !== 'object') throw new Error('decisions API reply has no answers')

		const receiptHash = keccak256(toBytes(raw))
		const body = reply as unknown as Record<string, unknown>
		const headerId = REQUEST_ID_HEADERS.map((h) => res.headers.get(h)).find(Boolean)
		const bodyId = [body.id, body.request_id, body.requestId].find((v) => typeof v === 'string') as string | undefined
		const attestation =
			ATTESTATION_HEADERS.map((h) => res.headers.get(h)).find(Boolean) ??
			([body.signature, body.attestation].find((v) => typeof v === 'string') as string | undefined)

		const tee = findKey(body, 'tee_verified')
		return {
			reply,
			requestId: headerId ?? bodyId ?? `unknown:${receiptHash.slice(2, 18)}`,
			receiptHash,
			attestation,
			teeVerified: typeof tee === 'boolean' ? tee : undefined,
			latencyMs,
		}
	}
}

/** Depth-first search for a key anywhere in a JSON value (0G nests TEE info in a trace object). */
const findKey = (v: unknown, key: string, depth = 0): unknown => {
	if (!v || typeof v !== 'object' || depth > 5) return undefined
	if (key in (v as Record<string, unknown>)) return (v as Record<string, unknown>)[key]
	for (const child of Object.values(v as Record<string, unknown>)) {
		const found = findKey(child, key, depth + 1)
		if (found !== undefined) return found
	}
	return undefined
}
