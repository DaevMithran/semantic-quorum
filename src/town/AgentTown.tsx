// Agent Town: the app shell. Modes: idle (post a job), live (?job=N), replay (?replay).

import { useEffect, useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { ArrowLeft, ChevronLeft, ChevronRight, Clock3, LogOut, Pause, Play, RotateCcw } from 'lucide-react'
import type { Address, Hex } from 'viem'
import { arcTestnet } from 'viem/chains'
import { useAccount, useSendTransaction, useSwitchChain } from 'wagmi'
import { type Detail, DetailCard, judgeDetail, ReceiptTape, Scoreboard } from './Panels'
import replayData from './replay-191223.json'
import { COORDINATOR, useLive, useReplay } from './sources'
import { getTownLayout } from './companies'
import { Viewport } from './Viewport'
import { ErcInside, focusRect, World, type WorldClick } from './World'
import '@fontsource/pixelify-sans/400.css'
import '@fontsource/pixelify-sans/600.css'
import '@fontsource/pixelify-sans/700.css'
import '@fontsource/vt323/400.css'
import '@fontsource/atkinson-hyperlegible/400.css'
import '@fontsource/atkinson-hyperlegible/700.css'
import './town.css'

const ARC_RPC = (import.meta.env.VITE_ARC_RPC_URL as string | undefined) ?? 'https://rpc.testnet.arc.io'

/** Latest Arc testnet block, polled from the public RPC (hidden if the RPC refuses browser requests). */
const useArcHead = () => {
	const [head, setHead] = useState<number>()
	useEffect(() => {
		let stop = false
		const tick = async () => {
			try {
				const r = await fetch(ARC_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })
				const b = (await r.json()) as { result?: string }
				if (b.result) setHead(Number.parseInt(b.result, 16))
			} catch {
				/* RPC unreachable from the browser: keep the label without a number */
			}
			if (!stop) window.setTimeout(tick, 3000)
		}
		tick()
		return () => {
			stop = true
		}
	}, [])
	return head
}

const params = new URLSearchParams(window.location.search)

function AttemptBrowser({ jobId, count, replayRounds }: { jobId?: string; count: number; replayRounds?: { html: string }[] }) {
	const [round, setRound] = useState(Math.max(0, count - 1))
	const previous = () => setRound((current) => Math.max(0, current - 1))
	const next = () => setRound((current) => Math.min(count - 1, current + 1))
	const html = replayRounds?.[round]?.html

	return <div className="attempt-browser"><nav className="attempt-nav" aria-label="Agent work attempts"><button type="button" className="ghost" aria-label="Previous attempt" title="Previous attempt" disabled={round === 0} onClick={previous}><ChevronLeft size={16} /></button><b>Attempt {round + 1} of {count}</b><button type="button" className="ghost" aria-label="Next attempt" title="Next attempt" disabled={round >= count - 1} onClick={next}><ChevronRight size={16} /></button></nav>{html ? <iframe key={round} className="page-frame" title={`Attempt ${round + 1}`} sandbox="" srcDoc={html} /> : <iframe key={round} className="page-frame" title={`Attempt ${round + 1}`} sandbox="" src={`${COORDINATOR}/pages/${jobId}/${round}`} />}</div>
}

type TimeoutStatus = {
	buyer: string
	kernelStatus: string
	decisionDeadline: number
	eligible: boolean
	remainingSeconds: number
	calls: { to: Address; data: Hex; value: string }[]
}

function TimeoutRefund({ jobId }: { jobId: string }) {
	const [status, setStatus] = useState<TimeoutStatus>()
	const [message, setMessage] = useState('')
	const [sending, setSending] = useState(false)
	const [feesReclaimed, setFeesReclaimed] = useState(false)
	const { isConnected, chainId } = useAccount()
	const { switchChainAsync } = useSwitchChain()
	const { sendTransactionAsync } = useSendTransaction()

	const load = async () => {
		try {
			const response = await fetch(`${COORDINATOR}/deals/${jobId}/timeout`)
			if (response.ok) setStatus(await response.json() as TimeoutStatus)
		} catch { /* The live event stream reports coordinator connectivity separately. */ }
	}

	useEffect(() => {
		void load()
		const timer = window.setInterval(() => void load(), 15_000)
		return () => window.clearInterval(timer)
	}, [jobId])

	if (!status || !['Funded', 'Rejected'].includes(status.kernelStatus)) return null
	const unlocks = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(status.decisionDeadline * 1000))
	const submit = async (call: TimeoutStatus['calls'][number], success: string) => {
		if (!call) return
		setSending(true)
		setMessage('')
		try {
			if (chainId !== arcTestnet.id) await switchChainAsync({ chainId: arcTestnet.id })
			const txHash = await sendTransactionAsync({ to: call.to, data: call.data, value: BigInt(call.value || '0'), chainId: arcTestnet.id })
			setMessage(`${success}: ${txHash.slice(0, 10)}…`)
			await fetch(`${COORDINATOR}/deals/wait`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash }) })
			await load()
		} catch (error) {
			setMessage(error instanceof Error ? error.message : 'Refund transaction failed.')
		} finally {
			setSending(false)
		}
	}
	const refund = async () => {
		const call = status.calls[0]
		if (call) await submit(call, 'Timeout refund submitted')
	}
	const reclaimFees = async () => {
		setSending(true)
		setMessage('')
		try {
			const response = await fetch(`${COORDINATOR}/deals/${jobId}/refund-fees-call`, { method: 'POST' })
			if (!response.ok) throw new Error(`Could not prepare fee refund (${response.status}).`)
			const prepared = await response.json() as { calls: TimeoutStatus['calls'] }
			const call = prepared.calls[0]
			if (!call) throw new Error('No fee refund call was returned.')
			if (chainId !== arcTestnet.id) await switchChainAsync({ chainId: arcTestnet.id })
			const txHash = await sendTransactionAsync({ to: call.to, data: call.data, value: BigInt(call.value || '0'), chainId: arcTestnet.id })
			setMessage(`Evaluator deposit reclaimed: ${txHash.slice(0, 10)}…`)
			await fetch(`${COORDINATOR}/deals/wait`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash }) })
			setFeesReclaimed(true)
		} catch (error) {
			setMessage(error instanceof Error ? error.message : 'Fee refund transaction failed.')
		} finally {
			setSending(false)
		}
	}

	const action = status.kernelStatus === 'Funded'
		? status.eligible
			? isConnected
				? <button type="button" className="ghost" disabled={sending} onClick={() => void refund()}>{sending ? 'Submitting…' : 'Refund buyer'}</button>
				: <ConnectKitButton.Custom>{({ show }) => <button type="button" className="ghost" onClick={show}>Connect to refund</button>}</ConnectKitButton.Custom>
			: <span className="timeout-wait">Not available yet</span>
		: feesReclaimed
			? <span className="timeout-wait">Fees reclaimed</span>
			: isConnected
				? <button type="button" className="ghost" disabled={sending} onClick={() => void reclaimFees()}>{sending ? 'Submitting…' : 'Reclaim evaluator deposit'}</button>
				: <ConnectKitButton.Custom>{({ show }) => <button type="button" className="ghost" onClick={show}>Connect to reclaim fees</button>}</ConnectKitButton.Custom>

	return <section className={`card timeout-refund ${status.eligible ? 'ready' : ''}`}><Clock3 size={17} /><div><b>{status.kernelStatus === 'Rejected' ? 'Buyer refunded on Arc' : status.eligible ? 'Timeout refund is ready' : 'Escrow protected until timeout'}</b><small>{status.kernelStatus === 'Rejected' ? 'The reward is back with the buyer. Reclaim the unused evaluator-fee deposit separately.' : `Unlocks ${unlocks}. Anyone may trigger it; funds return to ${status.buyer.slice(0, 8)}…`}</small>{message && <em>{message}</em>}</div>{action}</section>
}

export default function AgentTown() {
	const layoutName = 'classic' as const
	const townLayout = getTownLayout(layoutName)
	const jobId = params.get('job') ?? undefined
	const [replaying, setReplaying] = useState(params.has('replay'))
	const speed = 0.5
	const [paused, setPaused] = useState(false)
	const live = useLive(replaying ? undefined : jobId, speed, paused)
	const replay = useReplay(replaying, speed, paused)
	const s = replaying ? replay.state : live.state
	const head = useArcHead()

	const [detail, setDetail] = useState<Detail>()

	const go = (q: string) => window.history.replaceState(null, '', q ? `?${q}` : window.location.pathname)

	const [follow, setFollow] = useState(true)

	const onWorldClick = (c: WorldClick) => {
		if (c.kind === 'judge') setDetail(judgeDetail(s, c.index))
		else if (c.kind === 'pages') {
			if (!s.pages) return
			setDetail({
				title: 'Agent work',
				body: <AttemptBrowser jobId={s.jobId} count={s.pages} replayRounds={replaying ? (replayData as { rounds: { html: string }[] }).rounds : undefined} />,
			})
		} else if (c.kind === 'escrow') setEscrowOpen(true)
		else {
			const co = townLayout.companies.find((x) => x.id === c.id)
			if (co) setDetail({ title: co.name, body: <p>{co.role}</p> })
		}
	}

	// how much of the screen the floating panels cover, so the camera frames buildings in the open part
	const [inset, setInset] = useState({ left: 0, right: 0 })
	useEffect(() => {
		const f = () => {
			const w = window.innerWidth
			setInset(w > 1100 ? { left: 360 / w, right: 420 / w } : { left: 0, right: 0 })
		}
		f()
		window.addEventListener('resize', f)
		return () => window.removeEventListener('resize', f)
	}, [])
	const [escrowOpen, setEscrowOpen] = useState(false)

	const [boardOpen, setBoardOpen] = useState(true)

	return (
		<div className="app">
			<Viewport target={focusRect(s.focus, layoutName)} follow={follow} onFollowChange={setFollow} inset={inset} label="Agent town: Semantic Quorum HQ, Marketplace, 0G Private Computer, Chainlink and Arc, joined by paths">
				<World s={s} head={head} onClick={onWorldClick} layoutName={layoutName} />
			</Viewport>

			<div className="hud hud-left">
				<header className="card title-card">
					<h1>Semantic Quorum</h1>
					<p className="tag">Agents get paid only when two decision models agree the work meets the brief.</p>
					<nav className="modes" aria-label="Mode">
						{replaying ? (
							<>
								<button type="button" className="ghost mode-icon" aria-label="Replay again" title="Replay again" onClick={() => { setPaused(false); replay.restart() }}>
									<RotateCcw size={17} />
								</button>
								<button type="button" className="ghost mode-icon" aria-label={paused ? 'Resume replay' : 'Pause replay'} title={paused ? 'Resume replay' : 'Pause replay'} aria-pressed={paused} onClick={() => setPaused((value) => !value)}>
									{paused ? <Play size={17} /> : <Pause size={17} />}
								</button>
								<button
									type="button"
									className="ghost mode-icon"
									aria-label="Leave replay"
									title="Leave replay"
									onClick={() => {
										if (jobId) {
											setReplaying(false)
											go(`job=${jobId}`)
										} else window.location.assign(window.location.pathname)
									}}
								>
									<LogOut size={17} />
								</button>
							</>
						) : (
							<button type="button" className="ghost back-icon" aria-label="Back to marketplace" title="Back to marketplace" onClick={() => window.location.assign(window.location.pathname)}>
								<ArrowLeft size={17} />
							</button>
						)}
					</nav>
					{replaying && <p className="footnote">Recorded on Arc testnet (job 191223): real 0G scores and transactions, replayed.</p>}
					{s.pages > 0 && <button type="button" className="work-preview" onClick={() => onWorldClick({ kind: 'pages' })}>Open agent work · attempt {s.pages}</button>}
				</header>
				{live.error && !replaying && jobId && <p className="error card">{live.error}</p>}
				{!replaying && jobId && <TimeoutRefund jobId={jobId} />}
			</div>

			<div className="hud hud-right">
				<Scoreboard s={s} minimized={!boardOpen} onToggle={() => setBoardOpen((open) => !open)} />
			</div>

			<div className="hud hud-bottom">
				<ReceiptTape receipts={s.receipts} />
			</div>

			{escrowOpen && (
				<div className="overlay" role="dialog" aria-modal="true" aria-labelledby="escrow-title" onClick={() => setEscrowOpen(false)}>
					<div className="detail escrow" onClick={(e) => e.stopPropagation()}>
						<div className="ticket-head">
							<h3 id="escrow-title">ERC-8183 escrow on Arc</h3>
							<button type="button" className="ghost" onClick={() => setEscrowOpen(false)}>
								Close
							</button>
						</div>
						<p className="muted">Arc’s AgenticCommerce contract. The job is a crate; only SQController (the job’s evaluator) can move it to completed (pay the agent) or rejected (refund the buyer). A REVISE keeps it parked at funded.</p>
						<svg viewBox="0 0 470 300" className="escrow-svg" role="img" aria-label="ERC-8183 job conveyor">
							<rect x={0} y={0} width={470} height={300} rx={10} fill="#EFF8F5" />
							<ErcInside i={{ x: 10, y: 6, w: 450, h: 288 }} s={s} />
						</svg>
					</div>
				</div>
			)}

			{detail && <DetailCard d={detail} onClose={() => setDetail(undefined)} />}
		</div>
	)
}
