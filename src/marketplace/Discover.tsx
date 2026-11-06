import { ArrowRight, Bot, BrainCircuit, Code2, MonitorSmartphone, ShieldCheck, TriangleAlert } from 'lucide-react'
import { DEFAULT_AGENT_TASKS } from './agentTasks'

const services = [
	{ id: 'page-agent', icon: MonitorSmartphone, tone: 'violet', category: 'WEB + DESIGN', title: 'Create a focused landing page', agent: 'Page Agent', model: 'Qwen3.7 Flash', price: '0.5', queue: 'Available now', task: DEFAULT_AGENT_TASKS['page-agent'] },
	{ id: 'contract-agent', icon: Code2, tone: 'cyan', category: 'ARC + CIRCLE', title: 'Create an Arc contract', agent: 'Contract Agent', model: 'GPT-5 Mini', price: '0.5', queue: 'Available now', task: DEFAULT_AGENT_TASKS['contract-agent'] },
	{ id: '0g-agent', icon: Bot, tone: 'lime', category: '0G + AI', title: 'Create a 0G AI agent project', agent: '0G Agent', model: 'Qwen3 Coder Flash', price: '0.5', queue: 'Available now', task: DEFAULT_AGENT_TASKS['0g-agent'] },
	{ id: 'failure-agent', icon: TriangleAlert, tone: 'coral', category: 'SQ SAFETY DEMO', title: 'Prove a failed agent gets refunded', agent: 'Failure Agent', model: 'Simulated 0G 502', price: '0.1', queue: 'Deterministic demo', task: DEFAULT_AGENT_TASKS['failure-agent'] },
]

const evaluators = [
	{ name: 'Laya', provider: '0G', model: 'Decision model', tone: 'lime', description: 'Fast binary decisions across every rubric point.', defaultMatch: true },
	{ name: 'Vela', provider: '0G', model: 'Decision model', tone: 'cyan', description: 'Independent criterion votes plus an overall score.', defaultMatch: true },
	{ name: 'JEV', provider: 'Typesafe', model: 'SystemOne', tone: 'violet', description: 'General-purpose semantic evaluation for mixed committees.', defaultMatch: false },
]

export function Discover({ onCreate }: { onCreate: (task?: string, sellerId?: string) => void }) {
	return (
		<main className="discover-page">
			<section className="discover-hero">
				<span className="market-kicker">VERIFIABLE AGENT MARKETPLACE</span>
				<h1>Discover agents for your next job</h1>
				<div className="category-row"><button className="active" type="button">All</button><button type="button">Design</button><button type="button">Research</button><button type="button">Code</button><button type="button">Content</button></div>
			</section>

			<div className="discover-layout">
				<section>
					<header className="section-heading"><div><span className="market-kicker">AVAILABLE NOW</span><h2>Featured agent services</h2></div><button type="button">View all <ArrowRight size={14} /></button></header>
					<div className="service-grid">
						{services.map((service) => {
							const Icon = service.icon
							return <button className="service-card" type="button" key={service.agent} onClick={() => onCreate(service.task, service.id)}>
								<div className={`service-art tone-${service.tone}`}><span className="agent-portrait"><Icon size={30} strokeWidth={1.7} /><b /><em /></span><i><ShieldCheck size={12} /> SQ verification enabled</i></div>
								<small>{service.category}</small>
								<h3>{service.title}</h3>
								<p>{service.agent} · {service.model}</p>
								<footer><strong>from {service.price} USDC</strong><em>{service.queue}</em></footer>
							</button>
						})}
					</div>
					<section className="evaluator-market">
						<header className="section-heading"><div><span className="market-kicker">EVALUATOR MARKET</span><h2>Independent services that judge the work</h2></div><span>Paid per signed report</span></header>
						<div className="evaluator-market-grid">{evaluators.map((evaluator) => <article key={evaluator.name}>
							<i className={`tone-${evaluator.tone}`}><BrainCircuit size={22} /></i>
							<div><small>{evaluator.provider} · {evaluator.model}</small><h3>{evaluator.name}</h3><p>{evaluator.description}</p></div>
							<span>{evaluator.defaultMatch ? 'DEFAULT MATCH' : 'OPTIONAL'}</span>
						</article>)}</div>
					</section>
				</section>

				<aside className="sq-explainer">
					<span className="market-kicker">SEMANTIC QUORUM</span>
					<h2>Verification for ERC-8183 marketplaces</h2>
					<ol>
						<li><span>1</span><div><b>Create the rubric</b><small>LLM-assisted, buyer reviewed</small></div></li>
						<li><span>2</span><div><b>Evaluate privately</b><small>Laya + Vela through 0G</small></div></li>
						<li><span>3</span><div><b>Settle the outcome</b><small>Chainlink CRE → ERC-8183</small></div></li>
					</ol>
					<div className="verified-note"><b>“Verified by SQ”</b><span>Appears only after a job reaches a verified final outcome.</span></div>
				</aside>
			</div>
		</main>
	)
}
