// Semantic Quorum: CRE verdict workflow
//
// Triggered over HTTP by the coordinator, once per evaluation round:
//   1. fetch the policy, participant snapshot and signed evaluator reports from the report board
//   2. verify every report (EIP-712 signature by the snapshot's report key, evidence + policy binding)
//   3. apply the deterministic vote and committee rules
//   4. read the job's kernel status on Arc; in the final phase, independently read the seller's
//      submit transaction receipt and decode JobSubmitted to get the submitted deliverable
//   5. build and sign the Verdict as the verdict authority
//   6. write it to SQController through the CRE forwarder (onReport), or return it so the relay
//      can call SQController.submitVerdict
//
// Draft phase (job Funded):  committee ACCEPT -> PASS (no onchain write; seller may now submit)
//                            REVISE / REJECT  -> write verdict
// Final phase (job Submitted): ACCEPT only if committee ACCEPTs AND the submitted deliverable equals
//                              the evaluated evidence hash; otherwise REJECT (a submitted job can't REVISE)

import {
	bytesToHex,
	consensusIdenticalAggregation,
	EVMClient,
	encodeCallMsg,
	getNetwork,
	HTTPCapability,
	HTTPClient,
	type HTTPPayload,
	type HTTPSendRequester,
	handler,
	hexToBase64,
	LATEST_BLOCK_NUMBER,
	ok,
	prepareReportRequest,
	Runner,
	type Runtime,
	TxStatus,
	text,
} from '@chainlink/cre-sdk'
import {
	type Address,
	decodeEventLog,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	type Hex,
	isAddressEqual,
	keccak256,
	parseAbiItem,
	recoverTypedDataAddress,
	zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'
import { checkPolicy, decide, scorecard, voteFor } from '../../protocol/rules.ts'
import {
	type BoardBundle,
	type EvaluationResult,
	hashText,
	kindToUint,
	type Policy,
	reportDomain,
	reportTypes,
	type Snapshot,
	type VerdictMessage,
	verdictDomain,
	verdictTupleAbi,
	verdictTypes,
	ZERO32,
} from '../../protocol/types.ts'

// ---------------------------------------------------------------------------
// Config and trigger payload
// ---------------------------------------------------------------------------

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

const configSchema = z.object({
	boardUrl: z.string(), // e.g. http://localhost:8787
	chainSelectorName: z.string(), // arc-testnet
	chainId: z.number(), // 5042002
	agenticCommerce: address,
	sqController: address,
	gasLimit: z.string(),
	write: z.boolean(), // true: deliver via forwarder (needs SQController.onReport); false: return for relay
	chainChecks: z.boolean(), // false: skip Arc reads (offline testing with fixtures only)
	jobSubmittedEvent: z.string(), // human-readable ABI; verify against the explorer ABI
})
type Config = z.infer<typeof configSchema>

const payloadSchema = z.object({
	jobId: z.string(), // decimal string (uint256)
	round: z.number().int().min(0).max(255),
	phase: z.enum(['draft', 'final']),
	evidenceHash: hex32, // the evaluated attempt's evidence bundle hash
	submitTxHash: hex32.optional(), // final phase: the seller's AgenticCommerce.submit tx
})
type Payload = z.infer<typeof payloadSchema>

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const AGENTIC_COMMERCE_ABI = [
	{
		type: 'function',
		name: 'getJob',
		stateMutability: 'view',
		inputs: [{ name: 'jobId', type: 'uint256' }],
		outputs: [
			{
				name: '',
				type: 'tuple',
				components: [
					{ name: 'id', type: 'uint256' },
					{ name: 'client', type: 'address' },
					{ name: 'provider', type: 'address' },
					{ name: 'evaluator', type: 'address' },
					{ name: 'description', type: 'string' },
					{ name: 'budget', type: 'uint256' },
					{ name: 'expiredAt', type: 'uint256' },
					{ name: 'status', type: 'uint8' },
					{ name: 'hook', type: 'address' },
				],
			},
		],
	},
] as const

// IAgenticCommerce.JobStatus
const JOB_STATUS = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fetchBundle = (sendRequester: HTTPSendRequester, url: string): string => {
	const response = sendRequester.sendRequest({ url, method: 'GET' }).result()
	if (!ok(response)) throw new Error(`report board request failed: ${response.statusCode}`)
	return text(response)
}

const toJson = (value: unknown) =>
	JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

type Outcome = Record<string, unknown> & { status: string }

const readJobStatus = (runtime: Runtime<Config>, evm: EVMClient, jobId: bigint) => {
	const reply = evm
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: runtime.config.agenticCommerce as Address,
				data: encodeFunctionData({ abi: AGENTIC_COMMERCE_ABI, functionName: 'getJob', args: [jobId] }),
			}),
			blockNumber: LATEST_BLOCK_NUMBER,
		})
		.result()
	const job = decodeFunctionResult({
		abi: AGENTIC_COMMERCE_ABI,
		functionName: 'getJob',
		data: bytesToHex(reply.data),
	})
	if (!isAddressEqual(job.evaluator, runtime.config.sqController as Address)) {
		throw new Error(`job ${jobId} evaluator is ${job.evaluator}, not SQController`)
	}
	return JOB_STATUS[job.status] ?? `Unknown(${job.status})`
}

/** Reads the seller's submit tx receipt and returns the deliverable from JobSubmitted for this job. */
const readSubmittedDeliverable = (
	runtime: Runtime<Config>,
	evm: EVMClient,
	jobId: bigint,
	txHash: Hex,
): Hex => {
	const reply = evm.getTransactionReceipt(runtime, { hash: hexToBase64(txHash) }).result()
	const receipt = reply.receipt
	if (!receipt || receipt.status !== 1n) throw new Error(`submit tx ${txHash} not found or failed`)

	const event = parseAbiItem(runtime.config.jobSubmittedEvent)
	if (event.type !== 'event') throw new Error('jobSubmittedEvent is not an event signature')

	for (const log of receipt.logs) {
		if (!isAddressEqual(bytesToHex(log.address), runtime.config.agenticCommerce as Address)) continue
		try {
			const decoded = decodeEventLog({
				abi: [event],
				data: bytesToHex(log.data),
				topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
			})
			const args = decoded.args as Record<string, unknown>
			if (BigInt(String(args.jobId)) !== jobId) continue
			const deliverable = String(args.deliverable) as Hex
			// The deployed kernel uses bytes32; tolerate a 32-byte `bytes` encoding too.
			if (/^0x[0-9a-fA-F]{64}$/.test(deliverable)) return deliverable.toLowerCase() as Hex
			throw new Error(`deliverable is not 32 bytes: ${deliverable}`)
		} catch (e) {
			if (e instanceof Error && e.message.startsWith('deliverable')) throw e
		}
	}
	throw new Error(`no JobSubmitted for job ${jobId} in tx ${txHash}`)
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const onTrigger = async (runtime: Runtime<Config>, trigger: HTTPPayload): Promise<string> => {
	const cfg = runtime.config
	const input: Payload = payloadSchema.parse(JSON.parse(new TextDecoder().decode(trigger.input)))
	const jobId = BigInt(input.jobId)
	const evidenceHash = input.evidenceHash.toLowerCase() as Hex

	// 1. Fetch policy, snapshot and reports from the report board
	const url = `${cfg.boardUrl}/bundle?jobId=${input.jobId}&round=${input.round}`
	const body = new HTTPClient().sendRequest(runtime, fetchBundle, consensusIdenticalAggregation())(url).result()
	const bundle = JSON.parse(body) as BoardBundle
	const policy = JSON.parse(bundle.policy) as Policy
	const policyErrors = checkPolicy(policy)
	if (policyErrors.length) throw new Error(`invalid policy: ${policyErrors.join('; ')}`)
	const snapshot = JSON.parse(bundle.snapshot) as Snapshot
	const policyHash = hashText(bundle.policy)
	const participantSnapshotHash = hashText(bundle.snapshot)

	if (snapshot.chainId !== cfg.chainId || !isAddressEqual(snapshot.controller, cfg.sqController as Address)) {
		throw new Error('snapshot is bound to a different chain or controller')
	}

	// 2. Verify reports
	const valid: { index: number; digestHash: Hex; result: EvaluationResult }[] = []
	const rejected: string[] = []
	const seen = new Set<number>()
	for (const r of bundle.reports) {
		const member = snapshot.committee.find((m) => m.index === r.evaluatorIndex)
		if (!member) { rejected.push(`index ${r.evaluatorIndex}: not in committee`); continue }
		if (seen.has(r.evaluatorIndex)) { rejected.push(`index ${r.evaluatorIndex}: duplicate`); continue }
		if (r.evidenceHash.toLowerCase() !== evidenceHash) { rejected.push(`index ${r.evaluatorIndex}: other evidence`); continue }
		const resultHash = hashText(r.result)
		const message = {
			jobId,
			round: input.round,
			evaluatorIndex: r.evaluatorIndex,
			evidenceHash,
			policyHash,
			resultHash,
		}
		const signer = await recoverTypedDataAddress({
			domain: reportDomain(cfg.chainId, cfg.sqController as Address),
			types: reportTypes,
			primaryType: 'EvaluatorReport',
			message,
			signature: r.signature,
		})
		if (!isAddressEqual(signer, member.reportKey)) { rejected.push(`index ${r.evaluatorIndex}: bad signature`); continue }
		const result = JSON.parse(r.result) as EvaluationResult
		if (result.profileId !== member.profileId) { rejected.push(`index ${r.evaluatorIndex}: wrong profile`); continue }
		seen.add(r.evaluatorIndex)
		valid.push({ index: r.evaluatorIndex, digestHash: keccak256(r.signature), result })
	}
	runtime.log(`reports: ${valid.length} valid, ${rejected.length} rejected ${rejected.join('; ')}`)

	// Fail closed: every committee member must have a valid report
	if (valid.length !== snapshot.committee.length) {
		return toJson({
			status: 'WAITING',
			reason: `have ${valid.length}/${snapshot.committee.length} valid reports`,
			rejected,
		} satisfies Outcome)
	}
	valid.sort((a, b) => a.index - b.index)

	// 3. Rules
	const votes = valid.map((v) => voteFor(v.index, v.result, policy, input.round))
	const decision = decide(votes)
	runtime.log(`votes: ${votes.map((v) => `${v.evaluatorIndex}=${v.vote}`).join(', ')} -> ${decision.kind}`)

	// 4. Chain checks
	let kind = decision.kind
	let deliverable: Hex = ZERO32
	let network: ReturnType<typeof getNetwork> | undefined
	let evm: EVMClient | undefined
	if (cfg.chainChecks || cfg.write) {
		network = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.chainSelectorName, isTestnet: true })
		if (!network) throw new Error(`unknown chain ${cfg.chainSelectorName}`)
		evm = new EVMClient(network.chainSelector.selector)
	}

	if (input.phase === 'draft') {
		if (cfg.chainChecks && evm) {
			const status = readJobStatus(runtime, evm, jobId)
			if (status !== 'Funded') return toJson({ status: 'NO_ACTION', reason: `draft phase but job is ${status}` })
		}
		if (kind === 'ACCEPT') {
			// ACCEPT is only valid onchain once the job is Submitted. Tell the seller it may submit.
			return toJson({
				status: 'PASS',
				instruction: 'seller may now submit this evidenceHash; then trigger the final phase with submitTxHash',
				evidenceHash,
				deficiencies: decision.deficiencies,
				scorecard: scorecard(policy, valid.map((v) => ({ evaluatorIndex: v.index, result: v.result })), input.round, 'ACCEPT'),
				votes,
			})
		}
	} else {
		if (!input.submitTxHash) throw new Error('final phase needs submitTxHash')
		if (cfg.chainChecks && evm) {
			const status = readJobStatus(runtime, evm, jobId)
			if (status !== 'Submitted') return toJson({ status: 'NO_ACTION', reason: `final phase but job is ${status}` })
			deliverable = readSubmittedDeliverable(runtime, evm, jobId, input.submitTxHash as Hex)
		} else {
			deliverable = evidenceHash // offline testing only
		}
		const matches = deliverable === evidenceHash
		// A submitted job can only be ACCEPTed or REJECTed
		kind = decision.kind === 'ACCEPT' && matches ? 'ACCEPT' : 'REJECT'
		if (!matches) runtime.log(`submitted ${deliverable} != evaluated ${evidenceHash}: REJECT`)
	}

	// 5. Build and sign the verdict
	const reportsHash = keccak256(
		encodeAbiParameters([{ type: 'bytes32[]' }], [valid.map((v) => v.digestHash)]),
	)
	// The verdict commits to the full scorecard the seller revises from (field name kept for the contract).
	const card = scorecard(policy, valid.map((v) => ({ evaluatorIndex: v.index, result: v.result })), input.round, kind)
	const deficiencyHash = hashText(JSON.stringify(card))
	const includedMask = valid.reduce((m, v) => m | (1n << BigInt(v.index)), 0n)

	const verdict: VerdictMessage = {
		jobId,
		round: input.round,
		kind: kindToUint(kind),
		deliverable,
		evidenceHash,
		reportsHash,
		deficiencyHash,
		includedMask,
	}

	const key = runtime.getSecret({ id: 'VERDICT_AUTHORITY_KEY' }).result().value as Hex
	const authority = privateKeyToAccount(key)
	const signature = await authority.signTypedData({
		domain: verdictDomain(cfg.chainId, cfg.sqController as Address),
		types: verdictTypes,
		primaryType: 'Verdict',
		message: { ...verdict, policyHash, participantSnapshotHash },
	})

	const reportPayload = encodeAbiParameters([verdictTupleAbi, { type: 'bytes' }], [verdict, signature])

	const out: Outcome = {
		status: kind,
		verdict,
		signature,
		verdictAuthority: authority.address,
		policyHash,
		participantSnapshotHash,
		deficiencies: decision.deficiencies,
		scorecard: card,
		votes,
		relay: 'call SQController.submitVerdict(verdict, signature) if not written by CRE',
	}

	// 6. Deliver through the CRE forwarder
	if (cfg.write && evm) {
		const report = runtime.report(prepareReportRequest(reportPayload)).result()
		const resp = evm
			.writeReport(runtime, {
				receiver: cfg.sqController,
				report,
				gasConfig: { gasLimit: cfg.gasLimit },
			})
			.result()
		if (resp.txStatus !== TxStatus.SUCCESS) {
			throw new Error(`writeReport failed: ${resp.errorMessage || resp.txStatus}`)
		}
		out.txHash = bytesToHex(resp.txHash || new Uint8Array(32))
		out.deliveredVia = 'cre-forwarder'
	} else {
		out.deliveredVia = 'none (use relay)'
	}

	return toJson(out)
}

const initWorkflow = (_config: Config) => {
	const http = new HTTPCapability()
	// authorizedKeys: required for deployed workflows (the coordinator's signing address);
	// local simulation accepts an empty config.
	return [handler(http.trigger({}), onTrigger)]
}

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}
