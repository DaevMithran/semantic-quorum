// Deals funded from the buyer's own wallet (browser extension). The coordinator never holds buyer funds:
// it prepares ready-to-sign calls, signs only the seller's setBudget, and checks the chain before each step.
//
//   1. POST /deals/prepare              -> createJob call
//   2. POST /deals/:prepId/created      -> verifies the job, seller sets the budget -> approve + fund calls
//   3. POST /deals/:jobId/register-call -> verifies Funded -> approve fee deposit + registerJob calls (fresh seed block)
//   4. POST /deals/:jobId/registered    -> verifies registration -> board + seller agent start

import { randomUUID } from 'node:crypto'
import { type Address, createPublicClient, createWalletClient, decodeFunctionData, defineChain, encodeFunctionData, type Hex, http, isAddressEqual, keccak256, parseAbi, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { namehash } from 'viem/ens'
import { checkPolicy } from '../../../cre/src/protocol/rules.ts'
import type { Policy } from '../../../cre/src/protocol/types.ts'
import type { Board, DealRecord, Prep } from './board.ts'
import { type Catalog, committeeOf, type Seller } from './catalog.ts'
import type { Events } from './events.ts'

export const KERNEL_ABI = parseAbi([
	'function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256)',
	'function setBudget(uint256 jobId, uint256 amount, bytes optParams)',
	'function fund(uint256 jobId, bytes optParams)',
	'function getJob(uint256 jobId) view returns ((uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook))',
])
export const ERC20_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)'])
export const SQ_ABI = parseAbi([
	'struct CommitteeMember { uint256 evaluatorId; address feeRecipient; }',
	'struct RegisterParams { uint256 jobId; bytes32 policyHash; bytes32 participantSnapshotHash; address verdictAuthority; uint8 revisionLimit; uint64 decisionDeadline; uint256 feePerReport; uint256 seedBlock; CommitteeMember[] committee; uint256 maxPlatformFeeBP; uint256 maxEvaluatorFeeBP; }',
	'struct JobConfig { address buyer; address verdictAuthority; uint8 revisionLimit; uint8 committeeSize; uint64 decisionDeadline; uint256 feePerReport; uint256 seedBlock; bytes32 selectionSeed; bytes32 policyHash; bytes32 participantSnapshotHash; uint256 deposited; uint256 maxPlatformFeeBP; uint256 maxEvaluatorFeeBP; }',
	'function registerJob(RegisterParams p)',
	'function isRegistered(uint256 jobId) view returns (bool)',
	'function getConfig(uint256 jobId) view returns (JobConfig)',
	'function rejectOnTimeout(uint256 jobId)',
	'function refundFees(uint256 jobId) returns (uint256)',
])

export const JOB_STATUS = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'] as const
const PREP_TTL_MS = 30 * 60 * 1000
const MAX_PLATFORM_FEE_BP = 100n
const MAX_EVALUATOR_FEE_BP = 0n

/** "1.5" -> 1_500_000n (USDC ERC-20 view, 6 decimals). */
export const usdc6 = (v: string): bigint => {
	if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error(`bad USDC amount: ${v}`)
	const [i, f = ''] = v.split('.')
	return BigInt(i as string) * 1_000_000n + BigInt((f + '000000').slice(0, 6))
}

export type Call = { label: string; to: Address; data: Hex; value: '0' }

/** Decodes a prepared createJob call (tests, debugging). */
export const decodeCreateJob = (data: Hex) => {
	const { args } = decodeFunctionData({ abi: KERNEL_ABI, data })
	const [provider, evaluator, expiredAt, description] = args as unknown as [Address, Address, bigint, string]
	return { provider, evaluator, expiredAt, description }
}

export type JobView = { client: Address; provider: Address; evaluator: Address; description: string; budget: bigint; expiredAt: bigint; status: number }
export type ConfigView = { buyer: Address; verdictAuthority: Address; policyHash: Hex; participantSnapshotHash: Hex; feePerReport: bigint; revisionLimit: number; decisionDeadline: bigint }

/** What the deal flow needs from Arc. The viem implementation is below; tests pass a fake. */
export type ArcPort = {
	/** Kernel log topic[1] values in a tx (job id candidates) and the tx sender. */
	createdJobIds: (txHash: Hex) => Promise<{ from: Address; ids: bigint[] }>
	getJob: (jobId: bigint) => Promise<JobView>
	setBudget: (jobId: bigint, amount: bigint) => Promise<Hex> // signed by the seller agent's wallet
	blockNumber: () => Promise<bigint>
	blockTimestamp: () => Promise<bigint>
	isRegistered: (jobId: bigint) => Promise<boolean>
	getConfig: (jobId: bigint) => Promise<ConfigView>
	allowance?: (owner: Address, spender: Address) => Promise<bigint>
	waitForTransaction?: (txHash: Hex) => Promise<void>
}

export type Addresses = { chainId: number; kernel: Address; usdc: Address; controller: Address; seller: Address; verdictAuthority: Address }

export const makeArcPort = (o: { rpcUrl: string; chainId: number; kernel: Address; controller: Address; sellerKey: Hex }): ArcPort => {
	const chain = defineChain({ id: o.chainId, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } })
	const pub = createPublicClient({ chain, transport: http(o.rpcUrl) })
	const seller = createWalletClient({ account: privateKeyToAccount(o.sellerKey), chain, transport: http(o.rpcUrl) })
	let queue: Promise<unknown> = Promise.resolve() // one seller tx at a time (nonces)
	return {
		createdJobIds: async (hash) => {
			const r = await pub.waitForTransactionReceipt({ hash })
			if (r.status !== 'success') throw new Error(`createJob tx failed: ${hash}`)
			const ids = r.logs.filter((l) => isAddressEqual(l.address, o.kernel) && l.topics[1]).map((l) => BigInt(l.topics[1] as Hex))
			return { from: r.from, ids }
		},
		getJob: async (jobId) => {
			const j = await pub.readContract({ address: o.kernel, abi: KERNEL_ABI, functionName: 'getJob', args: [jobId] })
			return { client: j.client, provider: j.provider, evaluator: j.evaluator, description: j.description, budget: j.budget, expiredAt: j.expiredAt, status: j.status }
		},
		setBudget: (jobId, amount) => {
			const run = queue.then(async () => {
				const hash = await seller.writeContract({ address: o.kernel, abi: KERNEL_ABI, functionName: 'setBudget', args: [jobId, amount, '0x'] })
				const r = await pub.waitForTransactionReceipt({ hash })
				if (r.status !== 'success') throw new Error(`setBudget reverted: ${hash}`)
				return hash
			})
			queue = run.catch(() => undefined)
			return run
		},
		blockNumber: () => pub.getBlockNumber(),
		blockTimestamp: async () => (await pub.getBlock()).timestamp,
		isRegistered: (jobId) => pub.readContract({ address: o.controller, abi: SQ_ABI, functionName: 'isRegistered', args: [jobId] }),
		getConfig: async (jobId) => {
			const c = await pub.readContract({ address: o.controller, abi: SQ_ABI, functionName: 'getConfig', args: [jobId] })
			return { buyer: c.buyer, verdictAuthority: c.verdictAuthority, policyHash: c.policyHash, participantSnapshotHash: c.participantSnapshotHash, feePerReport: c.feePerReport, revisionLimit: c.revisionLimit, decisionDeadline: c.decisionDeadline }
		},
		allowance: (owner, spender) => pub.readContract({ address: '0x3600000000000000000000000000000000000000', abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] }),
		waitForTransaction: async (txHash) => {
			const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
			if (receipt.status !== 'success') throw new DealError(`transaction reverted: ${txHash}`, 409)
		},
	}
}

export type SellerRunner = (sellerId: string, jobId: string, onLine: (line: string) => void) => Promise<number>

/** Runs the matched worker as a child process and streams its log lines. */
export const makeSellerRunner = (
	sellerDirs: Record<string, string>,
	env: Record<string, string | undefined> = {},
	sellerModels: Record<string, string> = {},
): SellerRunner => async (sellerId, jobId, onLine) => {
	const cwd = sellerDirs[sellerId]
	if (!cwd) throw new DealError(`no worker service configured for ${sellerId}`, 503)
	const proc = Bun.spawn(['bun', 'run', 'src/main.ts', jobId], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
			...(sellerModels[sellerId] ? { SELLER_MODEL: sellerModels[sellerId] } : {}),
		},
	})
	const pump = async (s: ReadableStream<Uint8Array>) => {
		let buf = ''
		for await (const chunk of s) {
			buf += new TextDecoder().decode(chunk)
			const lines = buf.split('\n')
			buf = lines.pop() ?? ''
			for (const l of lines) if (l.trim()) onLine(l)
		}
		if (buf.trim()) onLine(buf)
	}
	await Promise.all([pump(proc.stdout), pump(proc.stderr)])
	return proc.exited
}

export class DealError extends Error {
	constructor(
		message: string,
		readonly status = 400,
		readonly problems?: string[],
	) {
		super(message)
	}
}

export type PrepareRequest = { task?: string; sellerId?: string; evaluatorIds?: string[]; policy: Policy; budgetUsdc: string; feeUsdc?: string; buyer: Address; hours?: number }

export type WalletDealDeps = {
	arc: ArcPort
	addr: Addresses
	catalog: Catalog
	board: Board
	events: Events
	runSeller?: SellerRunner
	onWorkerFailure?: (jobId: string, error: string) => Promise<unknown>
	now?: () => number
}

export const makeWalletDeals = (d: WalletDealDeps) => {
	const now = d.now ?? Date.now
	const a = d.addr
	const activeWorkers = new Set<string>()
	const call = (label: string, to: Address, data: Hex): Call => ({ label, to, data, value: '0' })
	const marker = (prepId: string) => `[sq:${prepId}]`

	const prep = (prepId: string): Prep => {
		const p = d.board.prep(prepId)
		if (!p) throw new DealError('unknown or expired preparation; start again', 404)
		if (now() - p.createdAt > PREP_TTL_MS && !p.jobId) throw new DealError('preparation expired; start again', 410)
		return p
	}
	const dealFor = (jobId: string) => {
		const deal = d.board.deal(jobId)
		const p = deal?.prepId ? d.board.prep(deal.prepId) : undefined
		if (!deal || !p) throw new DealError(`job ${jobId} was not started here`, 404)
		return { deal, p }
	}

	/** 1. Validate and freeze the rubric + committee; return the createJob call. */
	const prepare = (req: PrepareRequest, pick: Seller) => {
		const problems = checkPolicy(req.policy)
		if (problems.length) throw new DealError('invalid rubric', 400, problems)
		const committee = committeeOf(d.catalog, req.evaluatorIds)
		for (const m of committee) if (!req.policy.profiles[m.profileId]) throw new DealError(`rubric has no thresholds for judge profile ${m.profileId}`)
		const budget = usdc6(req.budgetUsdc)
		const fee = usdc6(req.feeUsdc ?? '0.01')
		if (budget <= 0n) throw new DealError('reward must be more than 0')
		const policyText = JSON.stringify(req.policy)
		const snapshotText = JSON.stringify({ version: 'sq-snapshot-1', chainId: a.chainId, controller: a.controller, committee })
		const expiredAt = BigInt(Math.floor(now() / 1000) + (req.hours ?? 24) * 3600)
		const prepId = randomUUID().slice(0, 8)
		const p: Prep = {
			prepId,
			createdAt: now(),
			task: req.task ?? '',
			buyer: req.buyer,
			seller: { id: pick.id, ens: pick.ens, model: pick.model },
			policyText,
			snapshotText,
			policyHash: keccak256(toBytes(policyText)),
			snapshotHash: keccak256(toBytes(snapshotText)),
			budget: budget.toString(),
			feePerReport: fee.toString(),
			deposit: (fee * BigInt(committee.length) * BigInt(req.policy.revisionLimit + 1)).toString(),
			revisionLimit: req.policy.revisionLimit,
			expiredAt: expiredAt.toString(),
			decisionDeadline: (expiredAt - 7200n).toString(),
		}
		d.board.putPrep(p)
		const description = `${(req.policy.brief ?? 'Semantic Quorum job').slice(0, 200)} ${marker(prepId)}`
		return {
			prepId,
			chainId: a.chainId,
			summary: { buyer: p.buyer, seller: a.seller, sellerEns: pick.ens, budget: p.budget, feePerReport: p.feePerReport, judgeFeeDeposit: p.deposit, policyHash: p.policyHash, snapshotHash: p.snapshotHash, signatures: 5 },
			calls: [call('Create the job on Arc', a.kernel, encodeFunctionData({ abi: KERNEL_ABI, functionName: 'createJob', args: [a.seller, a.controller, expiredAt, description, '0x0000000000000000000000000000000000000000'] }))],
		}
	}

	/** 2. The buyer's createJob landed: check it, have the seller set the budget, return approve + fund. */
	const created = async (prepId: string, txHash: Hex) => {
		const p = prep(prepId)
		if (p.jobId) return { jobId: p.jobId, ...fundCalls(p) } // idempotent
		const { from, ids } = await d.arc.createdJobIds(txHash)
		if (!isAddressEqual(from, p.buyer as Address)) throw new DealError('that transaction was sent from another wallet', 403)
		let found: { id: bigint; job: JobView } | undefined
		for (const id of ids) {
			const job = await d.arc.getJob(id).catch(() => undefined)
			if (job?.description.includes(marker(prepId))) found = { id, job }
		}
		if (!found) throw new DealError('no job from this preparation in that transaction')
		const { id, job } = found
		if (!isAddressEqual(job.client, p.buyer as Address)) throw new DealError('job client is not the buyer', 403)
		if (!isAddressEqual(job.provider, a.seller)) throw new DealError('job provider is not our seller agent')
		if (!isAddressEqual(job.evaluator, a.controller)) throw new DealError('job evaluator is not SQController')
		if (job.expiredAt !== BigInt(p.expiredAt)) throw new DealError('job expiry differs from the preparation')
		if (JOB_STATUS[job.status] !== 'Open') throw new DealError(`job is ${JOB_STATUS[job.status]}, expected Open`)
		const jobId = id.toString()
		p.jobId = jobId
		p.txs = { createJob: txHash }
		d.board.putPrep(p)
		const record: DealRecord = {
			jobId,
			prepId,
			funding: 'wallet',
			task: p.task,
			createdAt: new Date(now()).toISOString(),
			seller: { ...p.seller, address: a.seller },
			buyer: p.buyer,
			budget: p.budget,
			feePerReport: p.feePerReport,
			revisionLimit: p.revisionLimit,
			committee: (JSON.parse(p.snapshotText) as { committee: ReturnType<typeof committeeOf> }).committee.map((m) => ({ evaluatorId: m.evaluatorId, profileId: m.profileId, feeRecipient: m.feeRecipient })),
			txs: { createJob: txHash },
			status: 'created',
		}
		d.board.putDeal(record)
		d.events.add(jobId, 0, 'deal-created', 'ok', { seller: p.seller.ens, budget: p.budget, buyer: p.buyer, txHash, committee: record.committee })
		const budgetTx = await d.arc.setBudget(id, BigInt(p.budget))
		p.txs.setBudget = budgetTx
		d.board.putPrep(p)
		d.board.putDeal({ ...record, txs: { ...record.txs, setBudget: budgetTx } })
		d.events.add(jobId, 0, 'budget-set', 'ok', { budget: p.budget, txHash: budgetTx })
		return { jobId, ...fundCalls(p) }
	}

	const fundCalls = (p: Prep) => ({
		calls: [
			call('Allow the escrow to take the reward', a.usdc, encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [a.kernel, BigInt(p.budget)] })),
			call('Fund the escrow', a.kernel, encodeFunctionData({ abi: KERNEL_ABI, functionName: 'fund', args: [BigInt(p.jobId as string), '0x'] })),
		],
	})
	const remainingFundCalls = async (p: Prep) => {
		const allowance = d.arc.allowance ? await d.arc.allowance(p.buyer as Address, a.kernel) : 0n
		const all = fundCalls(p).calls
		return { calls: allowance >= BigInt(p.budget) ? all.slice(1) : all }
	}

	/** 3. Escrow is funded: return the fee-deposit approval + registerJob (built now, with a fresh seed block). */
	const registerCall = async (jobId: string) => {
		const { deal, p } = dealFor(jobId)
		const job = await d.arc.getJob(BigInt(jobId))
		if (JOB_STATUS[job.status] !== 'Funded') throw new DealError(`fund the escrow first (job is ${JOB_STATUS[job.status]})`, 409)
		if (deal.status === 'created') {
			d.events.add(jobId, 0, 'job-funded', 'ok', { budget: p.budget, buyer: p.buyer })
			d.board.putDeal({ ...deal, status: 'funded' })
		}
		const head = await d.arc.blockNumber()
		const committee = (JSON.parse(p.snapshotText) as { committee: ReturnType<typeof committeeOf> }).committee
		const params = {
			jobId: BigInt(jobId),
			policyHash: p.policyHash,
			participantSnapshotHash: p.snapshotHash,
			verdictAuthority: a.verdictAuthority,
			revisionLimit: p.revisionLimit,
			decisionDeadline: BigInt(p.decisionDeadline),
			feePerReport: BigInt(p.feePerReport),
			seedBlock: head - 1n,
			committee: committee.map((m) => ({ evaluatorId: BigInt(namehash(m.evaluatorId)), feeRecipient: m.feeRecipient })),
			maxPlatformFeeBP: MAX_PLATFORM_FEE_BP,
			maxEvaluatorFeeBP: MAX_EVALUATOR_FEE_BP,
		}
		return {
			jobId,
			note: 'Sign both within a few minutes: registerJob only accepts a recent seed block. If it reverts, ask for fresh calls.',
			calls: [
				call('Allow SQController to take the judge-fee deposit', a.usdc, encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [a.controller, BigInt(p.deposit)] })),
				call('Register the rubric and judges', a.controller, encodeFunctionData({ abi: SQ_ABI, functionName: 'registerJob', args: [params] })),
			],
		}
	}

	/** Rebuild the next buyer calls from verified on-chain state after a reload or interrupted wallet sequence. */
	const resume = async (jobId: string) => {
		const { deal, p } = dealFor(jobId)
		if (deal.status === 'working' || deal.status === 'accepted' || deal.status === 'rejected' || (await d.arc.isRegistered(BigInt(jobId)))) {
			return { jobId, stage: 'registered' as const, calls: [] as Call[] }
		}
		const job = await d.arc.getJob(BigInt(jobId))
		if (JOB_STATUS[job.status] === 'Open') {
			if (job.budget !== BigInt(p.budget)) throw new DealError('seller budget setup is not complete yet; retry in a moment', 409)
			return { jobId, stage: 'created' as const, ...(await remainingFundCalls(p)) }
		}
		if (JOB_STATUS[job.status] === 'Funded') return { stage: 'funded' as const, ...(await registerCall(jobId)) }
		throw new DealError(`job is ${JOB_STATUS[job.status]} and cannot resume funding`, 409)
	}

	const setup = async (jobId: string) => {
		const { p } = dealFor(jobId)
		const job = await d.arc.getJob(BigInt(jobId))
		const registered = await d.arc.isRegistered(BigInt(jobId))
		const allowance = d.arc.allowance ? await d.arc.allowance(p.buyer as Address, a.kernel) : 0n
		return {
			jobId,
			events: [
				{ id: 'created', label: 'Arc job created', detail: `Job #${jobId}`, done: true },
				{ id: 'budget', label: 'Seller budget configured', detail: `${p.budget} base units`, done: job.budget === BigInt(p.budget) },
				{ id: 'approved', label: 'Reward transfer approved', detail: 'USDC → AgenticCommerce', done: allowance >= BigInt(p.budget) || job.status >= 1 },
				{ id: 'funded', label: 'ERC-8183 escrow funded', detail: 'Reward locked on Arc', done: job.status >= 1 },
				{ id: 'registered', label: 'SQ policy registered', detail: 'Rubric + evaluators frozen', done: registered },
			],
		}
	}

	const waitForTransaction = async (txHash: Hex) => {
		if (d.arc.waitForTransaction) await d.arc.waitForTransaction(txHash)
		return { txHash, confirmed: true }
	}

	/** 4. Registration landed: check it matches what we prepared, then publish to the board and start the seller. */
	const registered = async (jobId: string, txHash?: Hex) => {
		const { deal, p } = dealFor(jobId)
		if (deal.status === 'working' || deal.status === 'accepted' || deal.status === 'rejected') return { jobId, status: deal.status }
		if (!(await d.arc.isRegistered(BigInt(jobId)))) throw new DealError('not registered yet', 409)
		const c = await d.arc.getConfig(BigInt(jobId))
		const bad: string[] = []
		if (!isAddressEqual(c.buyer, p.buyer as Address)) bad.push('buyer')
		if (!isAddressEqual(c.verdictAuthority, a.verdictAuthority)) bad.push('verdict authority')
		if (c.policyHash !== p.policyHash) bad.push('rubric hash')
		if (c.participantSnapshotHash !== p.snapshotHash) bad.push('committee hash')
		if (c.feePerReport !== BigInt(p.feePerReport)) bad.push('fee per report')
		if (bad.length) throw new DealError(`registration does not match the prepared deal: ${bad.join(', ')}`, 409)
		const job = await d.arc.getJob(BigInt(jobId))
		if (JOB_STATUS[job.status] !== 'Funded') throw new DealError(`job is ${JOB_STATUS[job.status]}, expected Funded`, 409)

		d.board.putJob(jobId, p.policyText, p.snapshotText)
		d.board.putDeal({ ...deal, status: 'working', txs: { ...deal.txs, ...(txHash ? { registerJob: txHash } : {}) } })
		d.events.add(jobId, 0, 'job-registered', 'ok', { feeDeposit: p.deposit, txHash })
		startWorker(jobId, p)
		return { jobId, status: 'working' }
	}

	/** A crashed worker is explicit and triggers a rubric-scored failure artifact; never leave the deal "working". */
	async function failWorker(jobId: string, error: string) {
		const current = d.board.deal(jobId)
		if (!current || current.status === 'accepted' || current.status === 'rejected') return
		d.board.putDeal({ ...current, status: 'failed', error })
		d.events.add(jobId, -1, 'deal-failed', 'failed', { error, recovery: d.onWorkerFailure ? 'evaluating-failure' : 'timeout' })
		if (!d.onWorkerFailure) return
		try {
			const result = await d.onWorkerFailure(jobId, error) as { status?: string } | undefined
			d.events.add(jobId, -1, 'failure-evaluation', result?.status ?? 'submitted', { reason: 'no deliverable' })
		} catch (cause) {
			d.events.add(jobId, -1, 'failure-evaluation', 'failed', { error: cause instanceof Error ? cause.message : String(cause), recovery: 'rejectOnTimeout' })
		}
	}

	function startWorker(jobId: string, p: Prep) {
		if (!d.runSeller || activeWorkers.has(jobId)) return
		activeWorkers.add(jobId)
		const run = d.runSeller
		let lastError = ''
		d.events.add(jobId, 0, 'seller-started', 'ok', { seller: p.seller.ens })
		void run(p.seller.id, jobId, (line) => {
			if (/\berror:/i.test(line)) lastError = line.trim().slice(0, 500)
			d.events.add(jobId, -1, 'seller-log', 'info', { line })
		})
			.then(
				async (code) => {
					d.events.add(jobId, -1, 'seller-exited', code === 0 ? 'ok' : 'failed', { code })
					if (code !== 0) await failWorker(jobId, `worker exited with code ${code}${lastError ? `: ${lastError.replace(/^error:\s*/i, '')}` : ''}`)
				},
				async (error) => {
					d.events.add(jobId, -1, 'seller-exited', 'failed', { error: String(error) })
					await failWorker(jobId, String(error))
				},
			)
			.finally(() => activeWorkers.delete(jobId))
	}

	const retryWorker = async (jobId: string) => {
		if (!d.runSeller) throw new DealError('worker runner is not configured', 503)
		const { deal, p } = dealFor(jobId)
		if (deal.status === 'accepted' || deal.status === 'rejected') throw new DealError(`job is already ${deal.status}`, 409)
		if (activeWorkers.has(jobId)) throw new DealError('worker is already running', 409)
		if (!(await d.arc.isRegistered(BigInt(jobId)))) throw new DealError('job is not registered', 409)
		d.board.putDeal({ ...deal, status: 'working', error: undefined })
		d.events.add(jobId, -1, 'seller-retry', 'running', { seller: p.seller.ens })
		startWorker(jobId, p)
		return { jobId, status: 'working', workerActive: activeWorkers.has(jobId) }
	}

	const workerState = (jobId: string) => {
		dealFor(jobId)
		return { active: activeWorkers.has(jobId) }
	}

	/** After the job is over: the buyer reclaims unused judge fees. */
	const timeoutStatus = async (jobId: string) => {
		const { deal } = dealFor(jobId)
		const [registered, config, job, chainTime] = await Promise.all([
			d.arc.isRegistered(BigInt(jobId)),
			d.arc.getConfig(BigInt(jobId)),
			d.arc.getJob(BigInt(jobId)),
			d.arc.blockTimestamp(),
		])
		const funded = JOB_STATUS[job.status] === 'Funded'
		const eligible = registered && funded && chainTime > BigInt(config.decisionDeadline)
		return {
			jobId,
			buyer: deal.buyer,
			kernelStatus: JOB_STATUS[job.status],
			decisionDeadline: Number(config.decisionDeadline),
			chainTime: Number(chainTime),
			eligible,
			remainingSeconds: eligible ? 0 : Math.max(0, Number(BigInt(config.decisionDeadline) - chainTime + 1n)),
			calls: eligible ? [call('Reject timed-out job and refund the buyer', a.controller, encodeFunctionData({ abi: SQ_ABI, functionName: 'rejectOnTimeout', args: [BigInt(jobId)] }))] : [],
		}
	}

	/** After the job is over: the buyer reclaims unused judge fees. */
	const refundFeesCall = (jobId: string) => {
		dealFor(jobId)
		return { jobId, calls: [call('Reclaim unused judge fees', a.controller, encodeFunctionData({ abi: SQ_ABI, functionName: 'refundFees', args: [BigInt(jobId)] }))] }
	}

	return { prepare, created, resume, setup, waitForTransaction, registerCall, registered, retryWorker, workerState, timeoutStatus, refundFeesCall }
}
