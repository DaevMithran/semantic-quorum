import { useMemo, useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { BriefcaseBusiness, Compass, Gavel, LayoutGrid } from 'lucide-react'
import AgentTown from '../town/AgentTown'
import { DealFlow } from './DealFlow'
import { Discover } from './Discover'
import { MyDeals } from './MyDeals'
import { Plaza } from './Plaza'
import './marketplace.css'

type View = 'plaza' | 'discover' | 'create' | 'deals'

const currentParams = () => new URLSearchParams(window.location.search)

export default function MarketplaceApp() {
	const params = useMemo(() => currentParams(), [])
	const isDeal = params.has('job') || params.has('replay')
	const resumeJobId = params.get('resume') ?? undefined
	const [view, setView] = useState<View>('plaza')
	const [task, setTask] = useState('')
	const [sellerId, setSellerId] = useState<string>()
	const themeClass = 'market-app theme-town'

	if (isDeal) return <AgentTown />
	if (resumeJobId) return <div className={themeClass}><DealFlow initialTask="" resumeJobId={resumeJobId} onBack={() => window.location.assign(window.location.pathname)} onOpenLive={openLive} /></div>

	const startDeal = (suggestion = '', selectedSellerId?: string) => {
		setTask(suggestion)
		setSellerId(selectedSellerId)
		setView('create')
	}

	function openLive(jobId?: string) {
		window.location.assign(jobId ? `?job=${encodeURIComponent(jobId)}` : '?replay')
	}

	return (
		<div className={themeClass}>
			<header className="market-nav">
				<button className="market-brand" type="button" onClick={() => setView('plaza')}>
					<span className="brand-mark">SQ</span>
					<span>Semantic Quorum</span>
				</button>
				<nav aria-label="Primary navigation">
					<button type="button" className={view === 'plaza' ? 'active' : ''} onClick={() => setView('plaza')}>
						<LayoutGrid size={15} /> Plaza
					</button>
					<button type="button" className={view === 'discover' ? 'active' : ''} onClick={() => setView('discover')}>
						<Compass size={15} /> Discover
					</button>
					<button type="button" onClick={() => openLive()}>
						<Gavel size={15} /> Live demo
					</button>
					<button type="button" className={view === 'deals' ? 'active' : ''} onClick={() => setView('deals')}>
						<BriefcaseBusiness size={15} /> My deals
					</button>
				</nav>
				<div className="nav-actions">
					<ConnectKitButton.Custom>
						{({ isConnected, truncatedAddress, show }) => (
							<button className="wallet-button" type="button" onClick={show}>
								{isConnected ? truncatedAddress : 'Connect wallet'}
							</button>
						)}
					</ConnectKitButton.Custom>
				</div>
			</header>

			{view === 'plaza' && <Plaza onCreate={startDeal} onDiscover={() => setView('discover')} onLive={() => openLive()} />}
			{view === 'discover' && <Discover onCreate={startDeal} />}
			{view === 'deals' && <MyDeals onOpen={openLive} onResume={(jobId) => window.location.assign(`?resume=${encodeURIComponent(jobId)}`)} />}
			{view === 'create' && <DealFlow initialTask={task} initialSellerId={sellerId} onBack={() => setView('plaza')} onOpenLive={openLive} />}
		</div>
	)
}
