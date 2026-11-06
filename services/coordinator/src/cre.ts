// Runs the CRE verdict workflow through the CRE CLI and parses its result.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Scorecard } from '../../../cre/src/protocol/rules.ts'

export type CrePayload = {
	jobId: string
	round: number
	phase: 'draft' | 'final'
	evidenceHash: string
	submitTxHash?: string
}

export type CreResult = {
	status: string // ACCEPT | REVISE | REJECT | PASS | WAITING | NO_ACTION
	verdict?: Record<string, unknown>
	signature?: string
	deficiencies?: { criterionId: string; gapBps: number }[]
	scorecard?: Scorecard // full feedback: every rubric row + overall, per judge
	txHash?: string
	deliveredVia?: string
	[k: string]: unknown
}

export type CreRunner = (payload: CrePayload) => Promise<CreResult>

const ANSI = /\x1b\[[0-9;]*m/g

/** Extracts the workflow's return value from `cre workflow simulate` output. */
export const parseSimulateOutput = (stdout: string): CreResult => {
	const text = stdout.replace(ANSI, '')
	const marker = text.lastIndexOf('Workflow Simulation Result:')
	if (marker < 0) throw new Error(`CRE produced no result:\n${text.slice(-1500)}`)
	const rest = text.slice(marker + 'Workflow Simulation Result:'.length).trim()
	// The value is printed as JSON; our workflow returns a JSON *string*, so it may be double-encoded.
	const firstLine = rest.startsWith('"') ? (rest.match(/^"(?:[^"\\]|\\.)*"/)?.[0] ?? rest) : rest
	let v: unknown = JSON.parse(firstLine.startsWith('"') ? firstLine : extractJsonObject(rest))
	if (typeof v === 'string') v = JSON.parse(v)
	return v as CreResult
}

export const normalizeSimulationResult = (result: CreResult): CreResult =>
	/^0x0{64}$/i.test(result.txHash ?? '') ? { ...result, txHash: undefined, deliveredVia: 'simulation' } : result

const extractJsonObject = (s: string): string => {
	let depth = 0
	let inStr = false
	for (let i = 0; i < s.length; i++) {
		const c = s[i]
		if (inStr) {
			if (c === '\\') i++
			else if (c === '"') inStr = false
			continue
		}
		if (c === '"') inStr = true
		else if (c === '{') depth++
		else if (c === '}' && --depth === 0) return s.slice(0, i + 1)
	}
	throw new Error('unterminated JSON in CRE output')
}

export const makeCliRunner = (opts: { bin: string; dir: string; target: string; broadcast: boolean; timeoutMs?: number }): CreRunner =>
	async (payload) => {
		const tmp = mkdtempSync(join(tmpdir(), 'sq-cre-'))
		const file = join(tmp, 'payload.json')
		writeFileSync(file, JSON.stringify(payload))
		try {
			const args = [
				'workflow', 'simulate', './src/workflows/sq-verdict',
				'--target', opts.target,
				'--non-interactive', '--trigger-index', '0',
				'--http-payload', file,
				...(opts.broadcast ? ['--broadcast'] : []),
			]
			const proc = Bun.spawn([opts.bin, ...args], { cwd: resolve(opts.dir), stdout: 'pipe', stderr: 'pipe' })
			const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 180_000)
			const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
			const code = await proc.exited
			clearTimeout(timer)
			if (code !== 0) throw new Error(`cre exited ${code}: ${(err || out).replace(ANSI, '').slice(-1500)}`)
			const result = parseSimulateOutput(`${out}\n${err}`)
			// CRE simulation can describe the forwarder path with an all-zero placeholder hash.
			// Never let that placeholder masquerade as a mined onchain settlement.
			return normalizeSimulationResult(result)
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	}
