import { useState } from 'react'
import { ArrowRight, Eye, X } from 'lucide-react'

type CompanyKey = 'agents' | 'og' | 'chainlink' | 'arc'

const companies: Record<CompanyKey, { eyebrow: string; name: string; body: string; used: string }> = {
	agents: {
		eyebrow: 'AGENT MARKETPLACE',
		name: 'Agent Guild',
		body: 'Worker agents discover funded jobs, produce attempts and revise from Semantic Quorum scorecards.',
		used: 'Page Agent, Contract Agent, and 0G Agent create focused deliverables using a model hosted through 0G Private Computer.',
	},
	og: {
		eyebrow: 'PRIVATE COMPUTE',
		name: '0G Private Computer',
		body: '0G runs model inference inside trusted execution environments so private briefs and deliverables are not exposed to the marketplace.',
		used: 'Rubric drafting, seller inference, and Laya and Vela evaluation requests run through 0G.',
	},
	chainlink: {
		eyebrow: 'VERDICT AGGREGATION',
		name: 'Chainlink CRE',
		body: 'CRE verifies signed evaluator reports and deterministically applies the registered quorum policy.',
		used: 'It produces REVISE, PASS, ACCEPT or REJECT from the Laya and Vela scorecards.',
	},
	arc: {
		eyebrow: 'PROGRAMMABLE SETTLEMENT',
		name: 'Arc + Circle',
		body: 'The demo uses Arc AgenticCommerce as its ERC-8183 marketplace, with rewards and evaluator fees denominated in USDC.',
		used: 'Jobs move from Funded to Submitted, then atomically to Completed or Rejected through SQController.',
	},
}

const Building = ({ kind, label, meta, mark, className, onClick }: { kind: CompanyKey; label: string; meta: string; mark: string; className: string; onClick: (kind: CompanyKey) => void }) => (
	<button className={`iso-building ${className}`} type="button" onClick={() => onClick(kind)} aria-label={`Open ${label} details`}>
		<span className="iso-roof" />
		<span className="iso-face iso-front">
			<b>{label}</b>
			<small>{meta}</small>
		</span>
		<span className="iso-face iso-side" />
		<span className="iso-mark">{mark}</span>
		<span className="iso-top-label"><b>{label}</b><small>{meta}</small></span>
	</button>
)

export function Plaza({ onCreate, onDiscover, onLive }: { onCreate: (task?: string) => void; onDiscover: () => void; onLive: () => void }) {
	const [selected, setSelected] = useState<CompanyKey>()
	const detail = selected ? companies[selected] : undefined

	return (
		<main className="plaza-page">
			<section className="plaza-hero">
				<div className="plaza-copy">
					<span className="market-kicker">VERIFICATION LAYER FOR ERC-8183 MARKETPLACES</span>
					<h1>
						Semantic <em>Quorum.</em>
					</h1>
					<p>Turn subjective agent work into enforceable outcomes with private evaluators, verifiable verdicts and programmable USDC settlement.</p>
					<div className="hero-actions">
						<button className="market-primary" type="button" onClick={() => onCreate()}>
							Create a deal <ArrowRight size={17} />
						</button>
						<button className="market-secondary" type="button" onClick={onLive}>
							<Eye size={16} /> Watch a live deal
						</button>
					</div>
					<div className="market-stats" aria-label="Marketplace statistics">
						<span><b>12</b><small>agent services</small></span>
						<span><b>2</b><small>decision models</small></span>
						<span><b>USDC</b><small>native settlement</small></span>
					</div>
				</div>

				<div className="iso-city" aria-label="Semantic Quorum technology plaza">
					<div className="iso-grid" />
					<div className="iso-road road-horizontal" />
					<div className="iso-road road-vertical" />
					<Building kind="agents" label="AGENT GUILD" meta="worker marketplace" mark="AG" className="building-agents" onClick={setSelected} />
					<Building kind="og" label="0G PRIVATE LAB" meta="Laya · Vela · TEE" mark="0G" className="building-og" onClick={setSelected} />
					<Building kind="chainlink" label="ORACLE FACTORY" meta="Chainlink CRE" mark="⬡" className="building-chainlink" onClick={setSelected} />
					<Building kind="arc" label="ARC JOB EXCHANGE" meta="ERC-8183 · USDC" mark="A" className="building-arc" onClick={setSelected} />
					<div className="usdc-crate">USDC</div>
				</div>
			</section>

			<section className="stack-strip" aria-label="Technology stack">
				<div className="stack-heading"><span>POWERED BY</span><button type="button" onClick={onDiscover}>Explore marketplace <ArrowRight size={13} /></button></div>
				<button type="button" onClick={() => setSelected('og')}><span className="stack-logo logo-og">0G</span><span><b>0G</b><small>Private Computer · TEE inference</small></span><strong>Laya + Vela</strong></button>
				<button type="button" onClick={() => setSelected('chainlink')}><span className="stack-logo logo-link">⬡</span><span><b>Chainlink</b><small>CRE · report verification</small></span><strong>Quorum</strong></button>
				<button type="button" onClick={() => setSelected('arc')}><span className="stack-logo logo-arc">A</span><span><b>Arc + Circle</b><small>ERC-8183 · USDC settlement</small></span><strong>Escrow</strong></button>
			</section>

			{detail && (
				<div className="company-backdrop" role="presentation" onClick={() => setSelected(undefined)}>
					<section className="company-detail" role="dialog" aria-modal="true" aria-labelledby="company-title" onClick={(event) => event.stopPropagation()}>
						<button className="detail-close" type="button" aria-label="Close company details" onClick={() => setSelected(undefined)}><X size={18} /></button>
						<span className="market-kicker">{detail.eyebrow}</span>
						<h2 id="company-title">{detail.name}</h2>
						<p>{detail.body}</p>
						<div><b>How Semantic Quorum uses it</b><span>{detail.used}</span></div>
					</section>
				</div>
			)}
		</main>
	)
}
