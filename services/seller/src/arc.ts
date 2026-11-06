// AgenticCommerce.submit(jobId, deliverable, optParams) on Arc. Submitting is final: only call it on PASS.

import { type Address, createPublicClient, createWalletClient, defineChain, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Submitter } from './seller.ts'

const SUBMIT_ABI = [
	{ type: 'function', name: 'submit', stateMutability: 'nonpayable', inputs: [{ name: 'jobId', type: 'uint256' }, { name: 'deliverable', type: 'bytes32' }, { name: 'optParams', type: 'bytes' }], outputs: [] },
] as const

export const makeArcSubmitter = (o: { rpcUrl: string; chainId: number; kernel: Address; key: Hex }): Submitter => {
	const chain = defineChain({ id: o.chainId, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } })
	const account = privateKeyToAccount(o.key)
	const pub = createPublicClient({ chain, transport: http(o.rpcUrl) })
	const wallet = createWalletClient({ account, chain, transport: http(o.rpcUrl) })
	return async (jobId, evidenceHash) => {
		const args = [BigInt(jobId), evidenceHash, '0x'] as const
		await pub.simulateContract({ address: o.kernel, abi: SUBMIT_ABI, functionName: 'submit', args, account })
		const hash = await wallet.writeContract({ address: o.kernel, abi: SUBMIT_ABI, functionName: 'submit', args })
		const r = await pub.waitForTransactionReceipt({ hash })
		if (r.status !== 'success') throw new Error(`submit reverted: ${hash}`)
		return hash
	}
}
