import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, BriefcaseBusiness, RefreshCw } from 'lucide-react'
import { useAccount } from 'wagmi'
import { COORDINATOR } from '../town/sources'

type Deal = {
	jobId: string
	task: string
	buyer: string
	budget: string
	createdAt: string
	seller: { id: string; ens: string; name?: string; model: string }
	status: 'created' | 'funded' | 'working' | 'failed' | 'accepted' | 'rejected'
	error?: string
}

const active = new Set<Deal['status']>(['created', 'funded', 'working', 'failed'])
const reward = (raw: string) => `${(Number(raw) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`
const statusText = (status: Deal['status']) => status === 'created' ? 'Needs funding' : status === 'funded' ? 'Needs registration' : status === 'working' ? 'In progress' : status === 'failed' ? 'Needs attention' : status === 'accepted' ? 'Completed' : 'Refunded'

export function MyDeals({ onOpen, onResume }: { onOpen: (jobId: string) => void; onResume: (jobId: string) => void }) {
	const [deals, setDeals] = useState<Deal[]>([])
	const [showAll, setShowAll] = useState(false)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState('')
	const { address } = useAccount()

	const load = async () => {
		try {
			const response = await fetch(`${COORDINATOR}/deals`)
			if (!response.ok) throw new Error(`Coordinator answered ${response.status}`)
			setDeals(await response.json() as Deal[])
			setError('')
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Could not load deals.')
		} finally {
			setLoading(false)
		}
	}

	useEffect(() => {
		void load()
		const timer = window.setInterval(() => void load(), 10_000)
		return () => window.clearInterval(timer)
	}, [])

	const owned = useMemo(() => address ? deals.filter((deal) => deal.buyer.toLowerCase() === address.toLowerCase()) : deals, [address, deals])
	const visible = showAll ? owned : owned.filter((deal) => active.has(deal.status))

	return <main className="my-deals-page"><header className="my-deals-heading"><div><span className="market-kicker">ARC ERC-8183 JOBS</span><h1>My deals</h1><p>{address ? 'Jobs funded by your connected wallet.' : 'Connect a wallet to filter this list to your jobs.'}</p></div><button className="market-secondary" type="button" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button></header><div className="deal-tabs"><button type="button" className={!showAll ? 'active' : ''} onClick={() => setShowAll(false)}>Pending <span>{owned.filter((deal) => active.has(deal.status)).length}</span></button><button type="button" className={showAll ? 'active' : ''} onClick={() => setShowAll(true)}>All <span>{owned.length}</span></button></div>{error && <p className="flow-error">{error}</p>}<section className="deal-list">{loading ? <div className="deals-empty">Loading jobs…</div> : visible.length === 0 ? <div className="deals-empty"><BriefcaseBusiness size={25} /><b>{showAll ? 'No deals yet' : 'No pending jobs'}</b><span>{address ? 'This wallet has nothing waiting.' : 'The coordinator has no jobs in this view.'}</span></div> : visible.map((deal) => { const resumable = deal.status === 'created' || deal.status === 'funded'; return <article className="deal-row" key={deal.jobId}><div className="deal-id"><small>JOB</small><b>#{deal.jobId}</b></div><div className="deal-main"><span className={`deal-status status-${deal.status}`}>{statusText(deal.status)}</span><h2>{deal.task || 'Semantic Quorum job'}</h2><p>{deal.seller.name ?? deal.seller.ens.split('.')[0]} · {deal.seller.model}</p>{deal.error && <em>{deal.error}</em>}</div><div className="deal-reward"><small>REWARD</small><b>{reward(deal.budget)}</b></div><button className="market-primary" type="button" onClick={() => resumable ? onResume(deal.jobId) : onOpen(deal.jobId)}>{resumable ? 'Resume' : 'Open'} <ArrowRight size={14} /></button></article> })}</section></main>
}
