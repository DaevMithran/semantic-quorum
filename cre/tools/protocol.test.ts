import { describe, expect, test } from 'bun:test'
import { type Address, encodeAbiParameters, type Hex, hashTypedData, keccak256, toBytes } from 'viem'
import { decide, voteFor } from '../src/protocol/rules.ts'
import { type EvaluationResult, type Policy, verdictDomain, verdictTypes } from '../src/protocol/types.ts'

const LAYA = '0g-laya-teeml-v1'
const VELA = '0g-vela-teeml-v1'
const t = { criterionPassBps: 7000, overallAcceptBps: 6000, overallRejectBps: 2500 }
const policy: Policy = {
	version: 'sq-policy-1',
	criteria: [
		{ id: 'c1', statement: 'price list', must: true },
		{ id: 'c2', statement: 'playful', must: false },
		{ id: 'p1', statement: 'opening hours', must: true, private: true },
	],
	profiles: { [LAYA]: t, [VELA]: t },
	revisionLimit: 2,
}
const r = (profileId: string, c1: number, c2: number, p1: number, overall: number): EvaluationResult => ({
	profileId, modelVersion: 'x', requestId: 'r', receiptHash: `0x${'0'.repeat(64)}`,
	criteria: [{ id: 'c1', passBps: c1 }, { id: 'c2', passBps: c2 }, { id: 'p1', passBps: p1 }],
	overall: { expectedLevelBps: overall },
})

describe('vote', () => {
	test('all pass + good overall -> ACCEPT', () => {
		expect(voteFor(0, r(LAYA, 9000, 9000, 9000, 8000), policy, 0).vote).toBe('ACCEPT')
	})
	test('failed must blocks ACCEPT even with a high overall', () => {
		expect(voteFor(0, r(LAYA, 1000, 9000, 9000, 9500), policy, 1).vote).toBe('REVISE')
	})
	test('failed nice-to-have does not block ACCEPT', () => {
		expect(voteFor(0, r(LAYA, 9000, 1000, 9000, 8000), policy, 1).vote).toBe('ACCEPT')
	})
	test('overall below accept threshold blocks ACCEPT', () => {
		expect(voteFor(0, r(LAYA, 9000, 9000, 9000, 5000), policy, 1).vote).toBe('REVISE')
	})
	test('overall below reject threshold -> REJECT', () => {
		expect(voteFor(0, r(LAYA, 9000, 9000, 9000, 2000), policy, 1).vote).toBe('REJECT')
	})
	test('private-check failure in round 0 never REJECTs', () => {
		expect(voteFor(0, r(LAYA, 9000, 9000, 1000, 2000), policy, 0).vote).toBe('REVISE')
		expect(voteFor(0, r(LAYA, 9000, 9000, 1000, 2000), policy, 1).vote).toBe('REJECT')
	})
	test('rejects non-integer or out-of-range bps', () => {
		expect(() => voteFor(0, r(LAYA, 9000.5, 9000, 9000, 8000), policy, 0)).toThrow()
		expect(() => voteFor(0, r(LAYA, 9000, 9000, 9000, 10001), policy, 0)).toThrow()
	})
})

describe('committee', () => {
	const v = (i: number, p: string, ...s: [number, number, number, number]) => voteFor(i, r(p, ...s), policy, 1)
	test('both ACCEPT -> ACCEPT', () => {
		expect(decide([v(0, LAYA, 9000, 9000, 9000, 8000), v(1, VELA, 9000, 9000, 9000, 8000)]).kind).toBe('ACCEPT')
	})
	test('disagreement -> REVISE', () => {
		expect(decide([v(0, LAYA, 9000, 9000, 9000, 8000), v(1, VELA, 3000, 9000, 9000, 8000)]).kind).toBe('REVISE')
	})
	test('both REJECT -> REJECT', () => {
		expect(decide([v(0, LAYA, 9000, 9000, 9000, 1000), v(1, VELA, 9000, 9000, 9000, 1000)]).kind).toBe('REJECT')
	})
	test('deficiencies are the union ranked by largest gap', () => {
		const d = decide([v(0, LAYA, 6000, 2000, 9000, 5000), v(1, VELA, 1000, 6500, 9000, 5000)])
		expect(d.deficiencies).toEqual([
			{ criterionId: 'c1', gapBps: 6000 },
			{ criterionId: 'c2', gapBps: 5000 },
		])
	})
})

describe('verdict EIP-712 matches SQController', () => {
	test('digest equals the Solidity encoding of SQVerdict.VERDICT_TYPEHASH', () => {
		const controller = '0x000000000000000000000000000000000000dEaD' as Address
		const m = {
			jobId: 7n, round: 1, kind: 1,
			deliverable: keccak256(toBytes('d')), evidenceHash: keccak256(toBytes('e')),
			reportsHash: keccak256(toBytes('r')), deficiencyHash: keccak256(toBytes('f')),
			includedMask: 3n, policyHash: keccak256(toBytes('p')), participantSnapshotHash: keccak256(toBytes('s')),
		}
		const viemDigest = hashTypedData({
			domain: verdictDomain(5042002, controller), types: verdictTypes, primaryType: 'Verdict', message: m,
		})
		// Manual re-implementation of SQController: _hashTypedDataV4(SQVerdict.hash(...))
		const TYPE = 'Verdict(uint256 jobId,uint8 round,uint8 kind,bytes32 deliverable,bytes32 evidenceHash,bytes32 reportsHash,bytes32 deficiencyHash,uint256 includedMask,bytes32 policyHash,bytes32 participantSnapshotHash)'
		const structHash = keccak256(encodeAbiParameters(
			[{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' },
				{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }],
			[keccak256(toBytes(TYPE)), m.jobId, m.round, m.kind, m.deliverable, m.evidenceHash, m.reportsHash,
				m.deficiencyHash, m.includedMask, m.policyHash, m.participantSnapshotHash],
		))
		const domainHash = keccak256(encodeAbiParameters(
			[{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
			[keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
				keccak256(toBytes('SemanticQuorum')), keccak256(toBytes('1')), 5042002n, controller],
		))
		const manual = keccak256(`0x1901${domainHash.slice(2)}${structHash.slice(2)}` as Hex)
		expect(viemDigest).toBe(manual)
	})
})
