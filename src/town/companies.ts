// The companies on the map. Adding one = add an entry here (a spot on the map + its paths) and drop its logo
// in public/logos/. A company without a custom interior gets the generic one, so no new drawing is needed.

export type CompanyId = 'hq' | 'agents' | 'og' | 'chainlink' | 'arc' | (string & {})

export type Company = {
	id: CompanyId
	name: string
	role: string // shown when you click the building
	color: string // brand colour: walls and sign
	soft: string // floor tint
	logo?: string // path under public/ (the initial is shown until the file exists)
	at: { x: number; y: number; w: number; h: number } // building footprint in world units
}

export const WORLD_W = 2400
export const WORLD_H = 1500

export const COMPANIES: Company[] = [
	{ id: 'hq', name: 'Semantic Quorum HQ', role: 'Creates the ERC-8183 job, binds the selected agent, freezes the rubric and evaluator committee, and coordinates the final verdict.', color: '#E8893A', soft: '#FFF4E8', logo: '/logos/semantic-quorum.svg', at: { x: 170, y: 520, w: 400, h: 270 } },
	{ id: 'agents', name: 'Agent Guild', role: 'Focused agent services do the work: Page Agent, Contract Agent, and 0G Agent. Their models run through 0G Compute.', color: '#D9577A', soft: '#FFF1F4', logo: '/logos/agent-guild.svg', at: { x: 760, y: 150, w: 420, h: 250 } },
	{ id: 'og', name: '0G Private Computer', role: 'Runs the decision models (Laya, Vela) inside TEEs, so the brief and the work stay private while they are judged.', color: '#8E5BEF', soft: '#F6F2FF', logo: '/logos/0g.svg', at: { x: 1540, y: 210, w: 440, h: 280 } },
	{ id: 'chainlink', name: 'Chainlink', role: 'CRE checks both judges’ signatures, applies the voting rules and writes one signed verdict to the job on Arc.', color: '#375BD2', soft: '#F1F5FF', logo: '/logos/chainlink.svg', at: { x: 1700, y: 900, w: 420, h: 270 } },
	{
		id: 'arc',
		name: 'Arc',
		role: 'The chain everything settles on: USDC is its money and gas, validators stamp each block. The job lives in Arc’s ERC-8183 escrow; click the escrow room to watch it.',
		color: '#0E9FB0',
		soft: '#F0FAFB',
		logo: '/logos/arc.svg',
		at: { x: 820, y: 960, w: 520, h: 300 },
	},
]

export const TRIANGLE_COMPANIES: Company[] = [
	{ id: 'agents', name: 'Agent Marketplace', role: 'The marketplace where buyers post funded work and agents pick jobs from the queue.', color: '#D9577A', soft: '#FFF1F4', logo: '/logos/agent-guild.svg', at: { x: 840, y: 70, w: 720, h: 270 } },
	{ id: 'hq', name: 'Semantic Quorum', role: 'The SQController policy layer registered as the ERC-8183 evaluator. It records the rubric, committee, revisions and final verdict.', color: '#E8893A', soft: '#FFF4E8', logo: '/logos/semantic-quorum.svg', at: { x: 230, y: 1080, w: 390, h: 300 } },
	{ id: 'arc', name: 'Arc ERC-8183 Settlement', role: 'Arc AgenticCommerce holds USDC escrow while SQController moves the job through REVISE, ACCEPT or REJECT.', color: '#0E9FB0', soft: '#F0FAFB', logo: '/logos/arc.svg', at: { x: 100, y: 600, w: 650, h: 370 } },
	{ id: 'og', name: '0G Private Computer', role: 'Runs agent and decision-model inference inside TEEs, including Laya and Vela.', color: '#8E5BEF', soft: '#F6F2FF', logo: '/logos/0g.svg', at: { x: 1680, y: 600, w: 500, h: 300 } },
	{ id: 'chainlink', name: 'Chainlink CRE', role: 'Verifies signed evaluator reports, applies the registered policy and produces the quorum verdict.', color: '#375BD2', soft: '#F1F5FF', logo: '/logos/chainlink.svg', at: { x: 1700, y: 1080, w: 470, h: 280 } },
]

/** Every building is linked to one hub in the middle; work travels building → hub → building. */
export const HUB = { x: 1250, y: 690 }
export const TRIANGLE_HUB = { x: 1200, y: 790 }

/** Optional empty plots for future integrations. */
export const FREE_PLOTS: TownLayout['plots'] = []

export type TownLayoutName = 'classic' | 'triangle'
export type TownLayout = { name: TownLayoutName; companies: Company[]; hub: P; plots: { x: number; y: number; w: number; h: number; label: string; status: string }[] }
export const CLASSIC_LAYOUT: TownLayout = { name: 'classic', companies: COMPANIES, hub: HUB, plots: FREE_PLOTS }
export const TRIANGLE_LAYOUT: TownLayout = { name: 'triangle', companies: TRIANGLE_COMPANIES, hub: TRIANGLE_HUB, plots: [] }
export const getTownLayout = (name: TownLayoutName = 'classic') => (name === 'triangle' ? TRIANGLE_LAYOUT : CLASSIC_LAYOUT)

type P = { x: number; y: number }
const center = (id: CompanyId, layout: TownLayout): P => {
	const c = layout.companies.find((x) => x.id === id)
	return c ? { x: c.at.x + c.at.w / 2, y: c.at.y + c.at.h / 2 } : { x: WORLD_W / 2, y: WORLD_H / 2 }
}

/** Point where the line from a building's centre towards `toward` leaves its footprint (plus a small gap). */
const edgePoint = (id: CompanyId, toward: P, layout: TownLayout): P => {
	const c = layout.companies.find((x) => x.id === id)
	const o = center(id, layout)
	if (!c) return o
	const dx = toward.x - o.x
	const dy = toward.y - o.y
	const sx = Math.abs(dx) > 1e-6 ? (c.at.w / 2 + 14) / Math.abs(dx) : Number.POSITIVE_INFINITY
	const sy = Math.abs(dy) > 1e-6 ? (c.at.h / 2 + 14) / Math.abs(dy) : Number.POSITIVE_INFINITY
	const k = Math.min(sx, sy)
	return { x: o.x + dx * k, y: o.y + dy * k }
}

/** Link line for a building: from its edge to the hub. */
export const linkOf = (id: CompanyId, layout: TownLayout = CLASSIC_LAYOUT) => ({ from: edgePoint(id, layout.hub, layout), to: layout.hub })

/** A cart's route: out of `from` to the hub, then into `to`. */
export const routeBetween = (from: CompanyId, to: CompanyId, layout: TownLayout = CLASSIC_LAYOUT): P[] => [edgePoint(from, layout.hub, layout), layout.hub, edgePoint(to, layout.hub, layout)]
