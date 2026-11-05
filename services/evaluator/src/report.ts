// Signs an evaluator report exactly as the CRE workflow verifies it (cre/src/protocol/types.ts).

import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
	type BoardReport,
	type EvaluationResult,
	hashText,
	reportDomain,
	reportTypes,
} from '../../../cre/src/protocol/types.ts'

export type SignInput = {
	reportKey: Hex
	chainId: number
	controller: Address
	jobId: bigint
	round: number
	evaluatorIndex: number
	evidenceHash: Hex
	policyText: string // exact policy JSON text from the board
	result: EvaluationResult
}

export const signReport = async (i: SignInput): Promise<BoardReport> => {
	const account = privateKeyToAccount(i.reportKey)
	const resultText = JSON.stringify(i.result)
	const signature = await account.signTypedData({
		domain: reportDomain(i.chainId, i.controller),
		types: reportTypes,
		primaryType: 'EvaluatorReport',
		message: {
			jobId: i.jobId,
			round: i.round,
			evaluatorIndex: i.evaluatorIndex,
			evidenceHash: i.evidenceHash,
			policyHash: hashText(i.policyText),
			resultHash: hashText(resultText),
		},
	})
	return { evaluatorIndex: i.evaluatorIndex, evidenceHash: i.evidenceHash, result: resultText, signature }
}
