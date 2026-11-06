// One evaluation request end to end: board -> page -> decisions API -> signed report -> board.

import { type Hex, isAddressEqual } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'
import type { BoardBundle, BoardReport, Policy, Snapshot } from '../../../cre/src/protocol/types.ts'
import type { Config } from './config.ts'
import { DecisionsClient } from './decisions.ts'
import { evaluate } from './evaluate.ts'
import { signReport } from './report.ts'
import { htmlToState } from './text.ts'

export const evaluateRequestSchema = z
	.object({
		jobId: z.string().regex(/^\d+$/),
		round: z.number().int().min(0).max(255),
		evaluatorIndex: z.number().int().min(0).max(255),
		evidenceHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
		pageUrl: z.string().url().optional(),
		html: z.string().optional(),
	})
	.refine((r) => r.pageUrl || r.html, 'pageUrl or html is required')

export type EvaluateRequest = z.infer<typeof evaluateRequestSchema>

export type ServiceDeps = { fetchImpl?: typeof fetch; client?: DecisionsClient }

export const makeService = (cfg: Config, deps: ServiceDeps = {}) => {
	const f = deps.fetchImpl ?? fetch
	const client =
		deps.client ??
		new DecisionsClient({
			baseUrl: cfg.baseUrl,
			path: cfg.path,
			apiKey: cfg.apiKey,
			fetchImpl: deps.fetchImpl,
			extraHeaders: cfg.extraHeaders,
			extraBody: cfg.extraBody,
		})
	const me = privateKeyToAccount(cfg.reportKey).address
	const isVela = cfg.profileId.includes('vela')

	const handle = async (req: EvaluateRequest) => {
		// 1. Policy + committee from the board
		const bundleRes = await f(`${cfg.boardUrl}/bundle?jobId=${req.jobId}&round=${req.round}`)
		if (!bundleRes.ok) throw new Error(`board: job ${req.jobId} round ${req.round} not found`)
		const bundle = (await bundleRes.json()) as BoardBundle
		const policy = JSON.parse(bundle.policy) as Policy
		const snapshot = JSON.parse(bundle.snapshot) as Snapshot

		// 2. Am I the committee member at this index, for this chain and controller?
		if (snapshot.chainId !== cfg.chainId || !isAddressEqual(snapshot.controller, cfg.controller)) {
			throw new Error('snapshot is for another chain or controller')
		}
		const member = snapshot.committee.find((m) => m.index === req.evaluatorIndex)
		if (!member) throw new Error(`no committee member at index ${req.evaluatorIndex}`)
		if (member.evaluatorId !== cfg.evaluatorId) throw new Error(`index ${req.evaluatorIndex} is ${member.evaluatorId}, not me`)
		if (member.profileId !== cfg.profileId) throw new Error(`profile mismatch: ${member.profileId} vs ${cfg.profileId}`)
		if (!isAddressEqual(member.reportKey, me)) throw new Error('my report key is not the registered one')

		// 3. The work
		let html = req.html
		if (!html && req.pageUrl) {
			const page = await f(req.pageUrl)
			if (!page.ok) throw new Error(`page fetch failed: ${page.status}`)
			html = await page.text()
		}
		const state = htmlToState(html ?? '')
		if (!state) throw new Error('empty deliverable')

		// 4. Score it
		const { result, call } = await evaluate(client, {
			state,
			policy,
			profileId: cfg.profileId,
			modelId: cfg.modelId,
			provider: cfg.provider,
			tokenBudget: cfg.tokenBudget,
			enableSpans: cfg.enableSpans && isVela,
		})

		if (cfg.requireTee && call.teeVerified !== true) {
			throw new Error(`TEE_NOT_VERIFIED: provider returned tee_verified=${String(call.teeVerified)}`)
		}

		// 5. Sign and publish
		const report: BoardReport = await signReport({
			reportKey: cfg.reportKey,
			chainId: cfg.chainId,
			controller: cfg.controller,
			jobId: BigInt(req.jobId),
			round: req.round,
			evaluatorIndex: req.evaluatorIndex,
			evidenceHash: req.evidenceHash.toLowerCase() as Hex,
			policyText: bundle.policy,
			result,
		})
		const post = await f(`${cfg.boardUrl}/reports`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jobId: req.jobId, round: req.round, report }),
		})
		if (!post.ok) throw new Error(`board rejected report: ${post.status}`)

		return {
			evaluatorId: cfg.evaluatorId,
			provider: cfg.provider,
			requestId: call.requestId,
			attestation: call.attestation ?? null,
			teeVerified: call.teeVerified ?? null,
			latencyMs: call.latencyMs,
			result,
			signature: report.signature,
		}
	}

	return { handle, address: me }
}
