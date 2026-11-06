// make arc-job: one real job on Arc testnet so the CRE workflow can write verdicts through the forwarder.
//   1st run: creates dev wallets in .env.arc (git-ignored), wires them into cre/.env and services/seller/.env,
//            prints the addresses to fund, and stops.
//   next runs: creates an ERC-8183 job (evaluator = SQController), budgets + funds it, registers it with
//            SQController, and puts its policy + committee on the coordinator board.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { type Address, createPublicClient, createWalletClient, defineChain, type Hex, http, keccak256, parseAbi, toBytes } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { namehash } from 'viem/ens'
import { checkPolicy } from '../cre/src/protocol/rules.ts'

const KEYS_FILE = '.env.arc'
const RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.io'
const BOARD = process.env.COORDINATOR_URL ?? 'http://localhost:8787'
const dep = JSON.parse(readFileSync('deployments/arc-testnet.json', 'utf8'))
const CONTROLLER = dep.SQController.address as Address
const KERNEL = dep.SQController.constructorArgs.agenticCommerce as Address
const USDC = dep.SQController.constructorArgs.usdc as Address
const BUDGET = 100_000n // 0.10 USDC (6 decimals)
const FEE = 10_000n // 0.01 USDC per included report

const readEnv = (p: string) =>
	Object.fromEntries(
		(existsSync(p) ? readFileSync(p, 'utf8') : '').split('\n').flatMap((l) => {
			const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
			return m ? [[m[1] as string, m[2] as string]] : []
		}),
	) as Record<string, string>
const setEnv = (p: string, k: string, v: string) => {
	const s = existsSync(p) ? readFileSync(p, 'utf8') : ''
	const re = new RegExp(`^${k}=.*$`, 'm')
	writeFileSync(p, re.test(s) ? s.replace(re, `${k}=${v}`) : `${s.replace(/\n?$/, '\n')}${k}=${v}\n`)
}

// --- wallets ---
const keys = readEnv(KEYS_FILE)
let created = false
for (const k of ['BUYER_KEY', 'SELLER_KEY', 'VERDICT_AUTHORITY_KEY']) {
	if (!keys[k]) {
		keys[k] = generatePrivateKey()
		setEnv(KEYS_FILE, k, keys[k] as string)
		created = true
	}
}
setEnv('cre/.env', 'SQ_VERDICT_AUTHORITY_KEY', keys.VERDICT_AUTHORITY_KEY as string) // CRE signs verdicts with it
setEnv('cre/.env', 'CRE_ETH_PRIVATE_KEY', keys.BUYER_KEY as string) // pays gas for the forwarder write
if (existsSync('services/seller/.env')) setEnv('services/seller/.env', 'SELLER_KEY', keys.SELLER_KEY as string)

const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain, transport: http(RPC) })
const wallet = (k: string) => createWalletClient({ account: privateKeyToAccount(k as Hex), chain, transport: http(RPC) })
const buyer = wallet(keys.BUYER_KEY as string)
const seller = wallet(keys.SELLER_KEY as string)

const [bb, sb] = await Promise.all([pub.getBalance({ address: buyer.account.address }), pub.getBalance({ address: seller.account.address })])
if (created || bb < 10n ** 18n || sb < 10n ** 17n) {
	console.log(`Fund these testnet wallets (https://faucet.circle.com, or: cast send <addr> --value 2ether --account sq-deployer --rpc-url arc_testnet)`)
	console.log(`  buyer  (job budget, judge fees, CRE gas) ${buyer.account.address}  needs ~1 USDC, has ${Number(bb) / 1e18}`)
	console.log(`  seller (setBudget, submit gas)          ${seller.account.address}  needs ~0.1 USDC, has ${Number(sb) / 1e18}`)
	console.log(`Then run make arc-job again.`)
	process.exit(0)
}

if (!(await fetch(`${BOARD}/`).catch(() => null))?.ok) {
	console.log('Coordinator not running: start `make dev-arc` in another terminal first.')
	process.exit(1)
}

// --- committee = the two evaluator processes ---
const ev = readEnv('services/evaluator/.env')
const vela = { ...ev, ...readEnv('services/evaluator/.env.vela') }
const member = (index: number, m: Record<string, string>) => {
	const reportKey = privateKeyToAccount(m.EVALUATOR_REPORT_KEY as Hex).address
	return { index, evaluatorId: m.EVALUATOR_ID as string, profileId: m.EVALUATOR_PROFILE as string, reportKey, feeRecipient: reportKey }
}
const committee = [member(0, ev), member(1, vela)]
// Demo policy (POLICY=path.json to use your own). Its exact JSON text is hashed onchain and served by the board.
const DEMO_POLICY = {"version": "sq-policy-1", "brief": "A playful landing page for a chai stall that shows a price list and accepts UPI payment.", "criteria": [{"id": "c1", "statement": "The page shows a price list.", "must": true}, {"id": "c2", "statement": "The tone of the page is playful.", "must": false}, {"id": "c3", "statement": "The page mentions UPI payment.", "must": true}, {"id": "c4", "statement": "The page shows opening hours.", "must": true}], "profiles": {"0g-laya-teeml-v1": {"criterionPassBps": 7000, "overallAcceptBps": 6000, "overallRejectBps": 800}, "0g-vela-teeml-v1": {"criterionPassBps": 7000, "overallAcceptBps": 6000, "overallRejectBps": 800}}, "revisionLimit": 3}
const policy = process.env.POLICY ? JSON.parse(readFileSync(process.env.POLICY, 'utf8')) : DEMO_POLICY
const problems = checkPolicy(policy)
if (problems.length) throw new Error(`invalid rubric:\n- ${problems.join('\n- ')}`)
const policyText = JSON.stringify(policy)
const snapshotText = JSON.stringify({ version: 'sq-snapshot-1', chainId: 5042002, controller: CONTROLLER, committee })

const KERNEL_ABI = parseAbi([
	'function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256)',
	'function setBudget(uint256 jobId, uint256 amount, bytes optParams)',
	'function fund(uint256 jobId, bytes optParams)',
])
const ERC20_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
const SQ_ABI = parseAbi([
	'struct CommitteeMember { uint256 evaluatorId; address feeRecipient; }',
	'struct RegisterParams { uint256 jobId; bytes32 policyHash; bytes32 participantSnapshotHash; address verdictAuthority; uint8 revisionLimit; uint64 decisionDeadline; uint256 feePerReport; uint256 seedBlock; CommitteeMember[] committee; uint256 maxPlatformFeeBP; uint256 maxEvaluatorFeeBP; }',
	'function registerJob(RegisterParams p)',
])

const send = async (label: string, w: typeof buyer, req: object) => {
	const hash = await w.writeContract(req as never)
	const r = await pub.waitForTransactionReceipt({ hash })
	if (r.status !== 'success') throw new Error(`${label} reverted: ${hash}`)
	console.log(`  ${label.padEnd(22)} ${hash}`)
}

const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600)
const createArgs = [seller.account.address, CONTROLLER, expiredAt, 'Semantic Quorum demo job', '0x0000000000000000000000000000000000000000'] as const
const { result: jobId } = await pub.simulateContract({ address: KERNEL, abi: KERNEL_ABI, functionName: 'createJob', args: createArgs, account: buyer.account })
console.log(`Job ${jobId} on ${KERNEL}, evaluator SQController ${CONTROLLER}`)
await send('createJob', buyer, { address: KERNEL, abi: KERNEL_ABI, functionName: 'createJob', args: createArgs })
await send('setBudget (seller)', seller, { address: KERNEL, abi: KERNEL_ABI, functionName: 'setBudget', args: [jobId, BUDGET, '0x'] })
await send('approve kernel', buyer, { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [KERNEL, BUDGET] })
await send('fund', buyer, { address: KERNEL, abi: KERNEL_ABI, functionName: 'fund', args: [jobId, '0x'] })

const revisionLimit = Number(policy.revisionLimit ?? 2)
const deposit = FEE * BigInt(committee.length) * BigInt(revisionLimit + 1)
await send('approve SQController', buyer, { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [CONTROLLER, deposit] })
await send('registerJob', buyer, {
	address: CONTROLLER,
	abi: SQ_ABI,
	functionName: 'registerJob',
	args: [{
		jobId,
		policyHash: keccak256(toBytes(policyText)),
		participantSnapshotHash: keccak256(toBytes(snapshotText)),
		verdictAuthority: privateKeyToAccount(keys.VERDICT_AUTHORITY_KEY as Hex).address,
		revisionLimit,
		decisionDeadline: expiredAt - 7200n,
		feePerReport: FEE,
		seedBlock: (await pub.getBlockNumber()) - 1n,
		committee: committee.map((m) => ({ evaluatorId: BigInt(namehash(m.evaluatorId)), feeRecipient: m.feeRecipient })),
		maxPlatformFeeBP: 100n,
		maxEvaluatorFeeBP: 0n,
	}],
})

const r = await fetch(`${BOARD}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: jobId.toString(), policy: policyText, snapshot: snapshotText }) })
if (!r.ok) throw new Error(`board rejected job ${jobId}: ${await r.text()}`)
console.log(`\nJob ${jobId} is Funded, registered, and on the board.`)
console.log(`Next: make round-revise JOB=${jobId}`)
