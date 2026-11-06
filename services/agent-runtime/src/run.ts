import { type Hex, keccak256, toBytes } from 'viem'
import type { Scorecard } from '../../../cre/src/protocol/rules.ts'
import type { BoardBundle, Policy } from '../../../cre/src/protocol/types.ts'
import type { Config } from '../../seller/src/config.ts'
import { type Generation, generate } from '../../seller/src/llm.ts'

export type Submitter = (jobId: string, evidenceHash: Hex) => Promise<Hex>
type RoundResult = { status: string; cre?: { scorecard?: Scorecard; reason?: string } }
type DealSnapshot = {
	rounds?: { round: number; pageUrl?: string | null; outcomes?: { phase?: string; status?: string; scorecard?: Scorecard }[] }[]
}

export type WorkerProfile = {
	name: string
	system: (policy: Policy) => string
	artifactLabel: string
	validateArtifact?: (html: string) => string | undefined
}

const pct = (bps: number) => `${Math.round(bps / 100)}%`
const scorecardText = (card: Scorecard) => card.rows.map((row) => {
	const tag = row.pass ? 'PASS' : row.must ? 'FAIL (required)' : 'FAIL (nice to have)'
	const judges = row.scores.map((score) => `judge ${score.evaluatorIndex}: ${pct(score.bps)} (needs ${pct(score.needBps)})`).join(', ')
	return `- [${tag}] ${row.statement} | ${judges}`
}).join('\n')

export const promptForArtifact = (policy: Policy, previous?: { html: string; card?: Scorecard }) => {
	const requirements = policy.criteria.map((criterion) => `- ${criterion.statement}${criterion.must ? '' : ' (nice to have)'}`).join('\n')
	let prompt = `Brief: ${policy.brief ?? '(none)'}\n\nRequirements:\n${requirements}`
	if (previous) {
		prompt += previous.card
			? `\n\nFix every FAIL and retain every PASS:\n${scorecardText(previous.card)}`
			: '\n\nThe previous artifact was not accepted. Improve it against every requirement.'
		prompt += `\n\nPrevious artifact:\n${previous.html}`
	}
	return prompt
}

export const evidenceHashOf = (jobId: string, round: number, generation: Generation): Hex => keccak256(toBytes(JSON.stringify({
	v: 'sq-evidence-1',
	jobId,
	round,
	artifactHash: keccak256(toBytes(generation.html)),
	model: generation.model,
	requestId: generation.requestId,
	receiptHash: generation.receiptHash,
})))

export const runWorker = async (
	profile: WorkerProfile,
	cfg: Config,
	jobId: string,
	deps: { fetchImpl?: typeof fetch; submit?: Submitter; log?: (message: string) => void } = {},
) => {
	const fetchImpl = deps.fetchImpl ?? fetch
	const log = deps.log ?? console.log
	const post = async (path: string, body: unknown) => {
		const response = await fetchImpl(`${cfg.coordinatorUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
		const output = (await response.json()) as RoundResult & { error?: unknown }
		if (!response.ok) throw new Error(`coordinator ${path}: ${JSON.stringify(output.error ?? output)}`)
		return output
	}

	const bundleResponse = await fetchImpl(`${cfg.coordinatorUrl}/bundle?jobId=${jobId}&round=0`)
	if (!bundleResponse.ok) throw new Error(`job ${jobId} is not on the board`)
	const policy = JSON.parse(((await bundleResponse.json()) as BoardBundle).policy) as Policy
	const rounds = Math.min(cfg.maxRounds, policy.revisionLimit + 1)
	let previous: { html: string; card?: Scorecard } | undefined
	let startRound = 0

	// A retry must continue the frozen deal instead of overwriting round 0. Only a
	// REVISE outcome is resumable; the next unused round receives its scorecard.
	const dealResponse = await fetchImpl(`${cfg.coordinatorUrl}/deals/${jobId}`)
	if (dealResponse.ok) {
		const snapshot = (await dealResponse.json()) as DealSnapshot
		const latest = [...(snapshot.rounds ?? [])]
			.sort((a, b) => b.round - a.round)
			.find((candidate) => candidate.outcomes?.some((outcome) => outcome.phase === 'draft'))
		const outcome = latest?.outcomes?.find((candidate) => candidate.phase === 'draft')
		if (latest && outcome?.status === 'REVISE' && latest.pageUrl) {
			const pageResponse = await fetchImpl(new URL(latest.pageUrl, `${cfg.coordinatorUrl}/`).toString())
			if (pageResponse.ok) {
				previous = { html: await pageResponse.text(), card: outcome.scorecard }
				startRound = latest.round + 1
				log(`resuming after REVISE at round ${startRound}`)
			}
		}
	}

	for (let round = startRound; round < rounds; round++) {
		let generation = await generate({ ...cfg.llm, fetchImpl: deps.fetchImpl }, profile.system(policy), promptForArtifact(policy, previous))
		const validationError = profile.validateArtifact?.(generation.html)
		if (validationError) {
			log(`round ${round}: local artifact validation failed (${validationError}); requesting one repair before evaluation`)
			generation = await generate(
				{ ...cfg.llm, fetchImpl: deps.fetchImpl },
				profile.system(policy),
				`${promptForArtifact(policy, previous)}\n\nLOCAL VALIDATION FAILURE: ${validationError}\nReturn a corrected artifact. Do not return a plan, checklist-only response, template ID, or deployment instructions in place of the requested files.`,
			)
			const repairError = profile.validateArtifact?.(generation.html)
			if (repairError) throw new Error(`agent returned an incomplete ${profile.artifactLabel} after repair: ${repairError}`)
		}
		const evidenceHash = evidenceHashOf(jobId, round, generation)
		log(`round ${round}: ${profile.artifactLabel} ${generation.html.length} chars (0G ${generation.requestId}), evidence ${evidenceHash}`)
		const result = await post('/rounds', { jobId, round, evidenceHash, html: generation.html })
		log(`round ${round}: ${result.status}`)

		if (result.status === 'PASS') {
			if (cfg.submit === 'off' || !deps.submit) return { status: 'PASS', round, evidenceHash }
			const submitTxHash = await deps.submit(jobId, evidenceHash)
			log(`submitted on Arc: ${submitTxHash}`)
			const final = await post('/rounds/final', { jobId, round, evidenceHash, submitTxHash })
			log(`final: ${final.status}`)
			return { status: final.status, round, evidenceHash, submitTxHash }
		}
		if (result.status !== 'REVISE') return { status: result.status, round, evidenceHash, reason: result.cre?.reason }
		previous = { html: generation.html, card: result.cre?.scorecard }
	}
	return { status: 'OUT_OF_ROUNDS' }
}
