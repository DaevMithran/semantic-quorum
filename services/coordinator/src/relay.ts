// Relay fallback: submits CRE's signed verdict to SQController.submitVerdict on Arc testnet.
// The relay key only pays gas; SQController checks the verdict authority's signature.

import { type Address, createPublicClient, createWalletClient, defineChain, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const arcTestnet = defineChain({
	id: 5042002,
	name: 'Arc Testnet',
	nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
	rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
})

const SUBMIT_VERDICT_ABI = [
	{
		type: 'function',
		name: 'submitVerdict',
		stateMutability: 'nonpayable',
		inputs: [
			{
				name: 'v',
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
			},
			{ name: 'signature', type: 'bytes' },
		],
		outputs: [],
	},
] as const

export type VerdictJson = {
	jobId: string | number
	round: number
	kind: number
	deliverable: Hex
	evidenceHash: Hex
	reportsHash: Hex
	deficiencyHash: Hex
	includedMask: string | number
}

export type Relay = (verdict: VerdictJson, signature: Hex) => Promise<{ txHash: Hex; status: string }>

export const makeRelay = (opts: { rpcUrl: string; controller: Address; key: Hex }): Relay => {
	const account = privateKeyToAccount(opts.key)
	const transport = http(opts.rpcUrl)
	const wallet = createWalletClient({ account, chain: arcTestnet, transport })
	const pub = createPublicClient({ chain: arcTestnet, transport })
	return async (v, signature) => {
		const args = [
			{
				jobId: BigInt(v.jobId),
				round: v.round,
				kind: v.kind,
				deliverable: v.deliverable,
				evidenceHash: v.evidenceHash,
				reportsHash: v.reportsHash,
				deficiencyHash: v.deficiencyHash,
				includedMask: BigInt(v.includedMask),
			},
			signature,
		] as const
		// Simulate first so a revert surfaces with its reason instead of burning gas.
		await pub.simulateContract({ address: opts.controller, abi: SUBMIT_VERDICT_ABI, functionName: 'submitVerdict', args, account })
		const txHash = await wallet.writeContract({ address: opts.controller, abi: SUBMIT_VERDICT_ABI, functionName: 'submitVerdict', args })
		const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
		return { txHash, status: receipt.status }
	}
}
