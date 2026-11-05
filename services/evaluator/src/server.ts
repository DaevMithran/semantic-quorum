// Evaluator service: one process per pool member.
//   cp .env.example .env   # fill in
//   bun run start
//
// POST /evaluate { jobId, round, evaluatorIndex, evidenceHash, pageUrl | html }
// GET  /         identity and provider

import { loadConfig } from './config.ts'
import { evaluateRequestSchema, makeService } from './service.ts'

const cfg = loadConfig()
const svc = makeService(cfg)

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

Bun.serve({
	port: cfg.port,
	async fetch(req) {
		const url = new URL(req.url)
		if (req.method === 'GET' && url.pathname === '/') {
			return json({
				evaluatorId: cfg.evaluatorId,
				profileId: cfg.profileId,
				reportKey: svc.address,
				provider: cfg.provider,
				model: cfg.modelId,
			})
		}
		if (req.method === 'POST' && url.pathname === '/evaluate') {
			const parsed = evaluateRequestSchema.safeParse(await req.json().catch(() => null))
			if (!parsed.success) return json({ error: parsed.error.issues }, 400)
			try {
				const out = await svc.handle(parsed.data)
				console.log(`[${cfg.evaluatorId}] job ${parsed.data.jobId} r${parsed.data.round}: ${out.requestId} ${out.latencyMs}ms`)
				return json(out)
			} catch (e) {
				// Fail closed: no report is published.
				const msg = e instanceof Error ? e.message : String(e)
				console.error(`[${cfg.evaluatorId}] no report: ${msg}`)
				return json({ error: msg, reported: false }, 422)
			}
		}
		return json({ error: 'not found' }, 404)
	},
})

console.log(`evaluator ${cfg.evaluatorId} (${cfg.profileId}) on :${cfg.port}, provider ${cfg.provider} ${cfg.baseUrl}${cfg.path}, model ${cfg.modelId}, report key ${svc.address}`)
