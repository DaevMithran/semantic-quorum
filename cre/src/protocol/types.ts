// Shared Semantic Quorum protocol definitions.
// Pure TypeScript + viem: no CRE SDK imports, so local tools and tests can reuse it.

import { type Address, type Hex, keccak256, toBytes } from 'viem'

// ---------------------------------------------------------------------------
// Policy and participant snapshot (stored by the report board as exact JSON text;
// their keccak256 hashes are what the buyer registered in SQController)
// ---------------------------------------------------------------------------

export type Criterion = {
	id: string
	statement: string // atomic yes/no statement
	must: boolean
	// Phrase prohibitions so that "true" is the good outcome: "The page does not ask for a card number."
}

export type ProfileThresholds = {
	criterionPassBps: number // pass probability needed per criterion (0..10000)
	overallAcceptBps: number // overall expected level needed to vote ACCEPT (0..10000)
	overallRejectBps: number // below this overall level the evaluator votes REJECT
}

export type Policy = {
	version: 'sq-policy-1'
	brief?: string // buyer's brief; used for the overall-quality question
	criteria: Criterion[]
	profiles: Record<string, ProfileThresholds> // keyed by profileId
	revisionLimit: number
}

export type CommitteeMember = {
	index: number // position in SQController's registered committee list (bit in includedMask)
	evaluatorId: string // ENS name, e.g. laya-2.judges.semanticquorum.eth
	profileId: string // e.g. 0g-laya-teeml-v1
	reportKey: Address // EIP-712 report signer
	feeRecipient: Address
}

export type Snapshot = {
	version: 'sq-snapshot-1'
	chainId: number
	controller: Address
	committee: CommitteeMember[]
}

// ---------------------------------------------------------------------------
// Evaluator report
// ---------------------------------------------------------------------------

// The evaluator signs a compact EIP-712 struct; the full result travels as the
// exact JSON string whose keccak256 is `resultHash`.
export type EvaluationResult = {
	profileId: string
	modelVersion: string
	provider?: string // '0g' in production; 'jev' or 'local' marks dev scores
	requestId: string // 0G request ID
	receiptHash: Hex // hash of the raw 0G response/receipt
	teeVerified?: boolean // 0G: router's TEE signature check for this inference
	criteria: { id: string; passBps: number }[]
	overall: { expectedLevelBps: number } // poor..excellent mapped to 0..10000
	spans?: { start: number; end: number; label: string; criterionId?: string }[]
}

export type BoardReport = {
	evaluatorIndex: number
	evidenceHash: Hex
	result: string // exact JSON text of EvaluationResult
	signature: Hex
}

export type BoardBundle = {
	policy: string // exact JSON text of Policy
	snapshot: string // exact JSON text of Snapshot
	reports: BoardReport[]
}

export const reportDomain = (chainId: number, controller: Address) =>
	({
		name: 'SemanticQuorumReport',
		version: '1',
		chainId,
		verifyingContract: controller,
	}) as const

export const reportTypes = {
	EvaluatorReport: [
		{ name: 'jobId', type: 'uint256' },
		{ name: 'round', type: 'uint8' },
		{ name: 'evaluatorIndex', type: 'uint8' },
		{ name: 'evidenceHash', type: 'bytes32' },
		{ name: 'policyHash', type: 'bytes32' },
		{ name: 'resultHash', type: 'bytes32' },
	],
} as const

// ---------------------------------------------------------------------------
// Verdict: must match SQController exactly
//   EIP712("SemanticQuorum", "1"), verifyingContract = SQController
//   Verdict(uint256 jobId,uint8 round,uint8 kind,bytes32 deliverable,bytes32 evidenceHash,
//           bytes32 reportsHash,bytes32 deficiencyHash,uint256 includedMask,
//           bytes32 policyHash,bytes32 participantSnapshotHash)
//   policyHash and participantSnapshotHash are NOT in the calldata struct; the contract
//   fills them from registered storage, so a verdict built against the wrong policy or
//   snapshot simply fails signature verification onchain.
// ---------------------------------------------------------------------------

export const VerdictKind = { None: 0, Accept: 1, Revise: 2, Reject: 3 } as const
export type VerdictKindName = 'ACCEPT' | 'REVISE' | 'REJECT'
export const kindToUint = (k: VerdictKindName): number =>
	k === 'ACCEPT' ? VerdictKind.Accept : k === 'REVISE' ? VerdictKind.Revise : VerdictKind.Reject

export const verdictDomain = (chainId: number, controller: Address) =>
	({
		name: 'SemanticQuorum',
		version: '1',
		chainId,
		verifyingContract: controller,
	}) as const

export const verdictTypes = {
	Verdict: [
		{ name: 'jobId', type: 'uint256' },
		{ name: 'round', type: 'uint8' },
		{ name: 'kind', type: 'uint8' },
		{ name: 'deliverable', type: 'bytes32' },
		{ name: 'evidenceHash', type: 'bytes32' },
		{ name: 'reportsHash', type: 'bytes32' },
		{ name: 'deficiencyHash', type: 'bytes32' },
		{ name: 'includedMask', type: 'uint256' },
		{ name: 'policyHash', type: 'bytes32' },
		{ name: 'participantSnapshotHash', type: 'bytes32' },
	],
} as const

// ABI tuple for SQController.Verdict calldata (onReport payload / submitVerdict arg)
export const verdictTupleAbi = {
	type: 'tuple',
	components: [
		{ name: 'jobId', type: 'uint256' },
		{ name: 'round', type: 'uint8' },
		{ name: 'kind', type: 'uint8' },
		{ name: 'deliverable', type: 'bytes32' },
		{ name: 'evidenceHash', type: 'bytes32' },
		{ name: 'reportsHash', type: 'bytes32' },
		{ name: 'deficiencyHash', type: 'bytes32' },
		{ name: 'includedMask', type: 'uint256' },
	],
} as const

export type VerdictMessage = {
	jobId: bigint
	round: number
	kind: number
	deliverable: Hex
	evidenceHash: Hex
	reportsHash: Hex
	deficiencyHash: Hex
	includedMask: bigint
}

export const ZERO32 = `0x${'0'.repeat(64)}` as Hex

export const hashText = (text: string): Hex => keccak256(toBytes(text))
