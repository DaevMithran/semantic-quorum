// Minimal report board for local testing (stand-in for the coordinator's board).
//
//   bun run tools/report-board.ts            # serves fixtures/board.json on :8787
//
// GET  /bundle?jobId=1&round=0  -> { policy, snapshot, reports }  (what the CRE workflow reads)
// POST /reports  { jobId, round, report: { evaluatorIndex, evidenceHash, result, signature } }
// POST /jobs     { jobId, round, policy, snapshot }   (exact JSON text; hashes must match registration)

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { BoardBundle, BoardReport } from '../src/protocol/types.ts'

const FILE = process.env.BOARD_FILE ?? 'fixtures/board.json'
const PORT = Number(process.env.PORT ?? 8787)
const board: Record<string, BoardBundle> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
const save = () => writeFileSync(FILE, `${JSON.stringify(board, null, 2)}\n`)
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url)
		if (req.method === 'GET' && url.pathname === '/bundle') {
			const b = board[`${url.searchParams.get('jobId')}:${url.searchParams.get('round')}`]
			return b ? json(b) : json({ error: 'not found' }, 404)
		}
		if (req.method === 'POST' && url.pathname === '/jobs') {
			const { jobId, round, policy, snapshot } = (await req.json()) as {
				jobId: string; round: number; policy: string; snapshot: string
			}
			board[`${jobId}:${round}`] = { policy, snapshot, reports: board[`${jobId}:${round}`]?.reports ?? [] }
			save()
			return json({ ok: true })
		}
		if (req.method === 'POST' && url.pathname === '/reports') {
			const { jobId, round, report } = (await req.json()) as { jobId: string; round: number; report: BoardReport }
			const b = board[`${jobId}:${round}`]
			if (!b) return json({ error: 'job/round not registered on board' }, 404)
			b.reports = b.reports.filter((r) => r.evaluatorIndex !== report.evaluatorIndex).concat(report)
			save()
			return json({ ok: true })
		}
		return json({ ok: true, routes: ['GET /bundle', 'POST /jobs', 'POST /reports'] })
	},
})
console.log(`report board on http://localhost:${PORT} (data: ${FILE})`)
