// Generates signed evaluator-report fixtures, the report board's data file and simulation payloads.
//
//   bun run tools/make-fixtures.ts
//   CONTROLLER=0x... bun run tools/make-fixtures.ts        # bind fixtures to a deployed SQController
//
// TEST KEYS ONLY: the evaluator keys below are well-known public test keys. Never use them for real funds.

import { mkdirSync, writeFileSync } from 'node:fs'
import { type Address, type Hex, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
	type BoardBundle,
	type BoardReport,
	type EvaluationResult,
	hashText,
	type Policy,
	reportDomain,
	reportTypes,
	type Snapshot,
} from '../src/protocol/types.ts'

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 5042002)
const CONTROLLER = (process.env.CONTROLLER ?? '0x000000000000000000000000000000000000dEaD') as Address

// Well-known test keys (anvil accounts 1-4). TEST ONLY.
const LAYA_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const VELA_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex
const LAYA_FEE = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6').address
const VELA_FEE = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a').address
const laya = privateKeyToAccount(LAYA_KEY)
const vela = privateKeyToAccount(VELA_KEY)

const LAYA = '0g-laya-teeml-v1'
const VELA = '0g-vela-teeml-v1'

const policy: Policy = {
	version: 'sq-policy-1',
	criteria: [
		{ id: 'c1', statement: 'The page shows a price list.', must: true },
		{ id: 'c2', statement: 'The tone of the page is playful.', must: false },
		{ id: 'c3', statement: 'The page mentions UPI payment.', must: true },
		{ id: 'p1', statement: 'The page shows opening hours.', must: true, private: true },
	],
	profiles: {
		[LAYA]: { criterionPassBps: 7000, overallAcceptBps: 6000, overallRejectBps: 2500 },
		[VELA]: { criterionPassBps: 7000, overallAcceptBps: 6000, overallRejectBps: 2500 },
	},
	revisionLimit: 2,
}

const snapshot: Snapshot = {
	version: 'sq-snapshot-1',
	chainId: CHAIN_ID,
	controller: CONTROLLER,
	committee: [
		{ index: 0, evaluatorId: 'laya-2.judges.semanticquorum.eth', profileId: LAYA, reportKey: laya.address, feeRecipient: LAYA_FEE },
		{ index: 1, evaluatorId: 'vela-1.judges.semanticquorum.eth', profileId: VELA, reportKey: vela.address, feeRecipient: VELA_FEE },
	],
}

const policyText = JSON.stringify(policy)
const snapshotText = JSON.stringify(snapshot)
const policyHash = hashText(policyText)
const participantSnapshotHash = hashText(snapshotText)

const evidence = (label: string): Hex => keccak256(toBytes(`evidence:${label}`))

const result = (
	profileId: string,
	scores: Record<string, number>,
	overall: number,
	requestId: string,
): EvaluationResult => ({
	profileId,
	modelVersion: profileId === LAYA ? 'laya-421m' : 'vela-2.0-9b',
	requestId,
	receiptHash: keccak256(toBytes(`receipt:${requestId}`)),
	criteria: Object.entries(scores).map(([id, passBps]) => ({ id, passBps })),
	overall: { expectedLevelBps: overall },
})

const sign = async (
	signer: typeof laya,
	jobId: bigint,
	round: number,
	evaluatorIndex: number,
	evidenceHash: Hex,
	res: EvaluationResult,
): Promise<BoardReport> => {
	const resultText = JSON.stringify(res)
	const signature = await signer.signTypedData({
		domain: reportDomain(CHAIN_ID, CONTROLLER),
		types: reportTypes,
		primaryType: 'EvaluatorReport',
		message: { jobId, round, evaluatorIndex, evidenceHash, policyHash, resultHash: hashText(resultText) },
	})
	return { evaluatorIndex, evidenceHash, result: resultText, signature }
}

type Scenario = {
	name: string
	jobId: bigint
	round: number
	phase: 'draft' | 'final'
	ev: Hex
	reports: () => Promise<BoardReport[]>
	expect: string
}

const good = { c1: 9300, c2: 8100, c3: 9000, p1: 8800 }
const noUpi = { c1: 9200, c2: 7800, c3: 1100, p1: 8500 }
const ev1r0 = evidence('job1-v1')
const ev1r1 = evidence('job1-v2')
const ev2 = evidence('job2-v1')
const ev3 = evidence('job3-v1')
const ev4 = evidence('job4-v1')
const ev5 = evidence('job5-v1')

const scenarios: Scenario[] = [
	{
		name: 'revise', jobId: 1n, round: 0, phase: 'draft', ev: ev1r0, expect: 'REVISE (both flag c3)',
		reports: async () => [
			await sign(laya, 1n, 0, 0, ev1r0, result(LAYA, noUpi, 5500, 'req-laya-1-0')),
			await sign(vela, 1n, 0, 1, ev1r0, result(VELA, { ...noUpi, c2: 4600 }, 5000, 'req-vela-1-0')),
		],
	},
	{
		name: 'pass', jobId: 1n, round: 1, phase: 'draft', ev: ev1r1, expect: 'PASS (seller may submit)',
		reports: async () => [
			await sign(laya, 1n, 1, 0, ev1r1, result(LAYA, good, 8200, 'req-laya-1-1')),
			await sign(vela, 1n, 1, 1, ev1r1, result(VELA, good, 7900, 'req-vela-1-1')),
		],
	},
	{
		name: 'accept-final', jobId: 1n, round: 1, phase: 'final', ev: ev1r1, expect: 'ACCEPT over the submitted deliverable',
		reports: async () => [], // reuses the round-1 reports above
	},
	{
		name: 'disagree', jobId: 2n, round: 0, phase: 'draft', ev: ev2, expect: 'REVISE (Laya accepts, Vela flags c2)',
		reports: async () => [
			await sign(laya, 2n, 0, 0, ev2, result(LAYA, good, 8000, 'req-laya-2-0')),
			await sign(vela, 2n, 0, 1, ev2, result(VELA, { ...good, c2: 3000 }, 6200, 'req-vela-2-0')),
		],
	},
	{
		name: 'missing', jobId: 3n, round: 0, phase: 'draft', ev: ev3, expect: 'WAITING (only one report)',
		reports: async () => [await sign(laya, 3n, 0, 0, ev3, result(LAYA, good, 8000, 'req-laya-3-0'))],
	},
	{
		name: 'reject', jobId: 4n, round: 1, phase: 'draft', ev: ev4, expect: 'REJECT (both overall below reject threshold)',
		reports: async () => [
			await sign(laya, 4n, 1, 0, ev4, result(LAYA, { c1: 1000, c2: 900, c3: 500, p1: 800 }, 1200, 'req-laya-4-1')),
			await sign(vela, 4n, 1, 1, ev4, result(VELA, { c1: 800, c2: 1500, c3: 400, p1: 700 }, 1000, 'req-vela-4-1')),
		],
	},
	{
		name: 'forged', jobId: 5n, round: 0, phase: 'draft', ev: ev5, expect: 'WAITING (Vela report signed by the wrong key)',
		reports: async () => [
			await sign(laya, 5n, 0, 0, ev5, result(LAYA, good, 8000, 'req-laya-5-0')),
			await sign(laya, 5n, 0, 1, ev5, result(VELA, good, 8000, 'req-vela-5-0')), // Laya's key, Vela's slot
		],
	},
]

const board: Record<string, BoardBundle> = {}
mkdirSync('fixtures', { recursive: true })
mkdirSync('payloads', { recursive: true })

for (const s of scenarios) {
	const key = `${s.jobId}:${s.round}`
	const reports = await s.reports()
	if (reports.length > 0 || !board[key]) board[key] = { policy: policyText, snapshot: snapshotText, reports }
	const payload: Record<string, unknown> = { jobId: s.jobId.toString(), round: s.round, phase: s.phase, evidenceHash: s.ev }
	// Offline (chainChecks=false) the final phase treats the evidence hash as submitted.
	// On Arc, replace with the real AgenticCommerce.submit transaction hash.
	if (s.phase === 'final') payload.submitTxHash = `0x${'11'.repeat(32)}`
	writeFileSync(`payloads/${s.name}.json`, `${JSON.stringify(payload, null, 2)}\n`)
	console.log(`payloads/${s.name}.json  ->  expect ${s.expect}`)
}

writeFileSync('fixtures/board.json', `${JSON.stringify(board, null, 2)}\n`)
writeFileSync(
	'fixtures/registration.json',
	`${JSON.stringify({ chainId: CHAIN_ID, controller: CONTROLLER, policyHash, participantSnapshotHash, committee: snapshot.committee.map((m) => ({ evaluatorId: m.evaluatorId, feeRecipient: m.feeRecipient })) }, null, 2)}\n`,
)
console.log('\nfixtures/board.json written')
console.log(`policyHash               ${policyHash}`)
console.log(`participantSnapshotHash  ${participantSnapshotHash}`)
console.log('(register these on SQController for the verdict signatures to verify onchain)')
