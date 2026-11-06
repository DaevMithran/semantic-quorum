// The map: a white canvas with each company as a roofless building (machines inside), each linked to one hub
// in the middle. Work travels building → hub → building as a small labelled cart. Plain SVG in world units.

import { motion, useReducedMotion } from 'framer-motion'
import { type ReactNode, useEffect, useState } from 'react'
import { type Company, type CompanyId, COMPANIES, getTownLayout, linkOf, routeBetween, type TownLayout, type TownLayoutName, WORLD_H, WORLD_W } from './companies'
import type { Capsule, CartKind, TownState } from './state'

const INK = '#2D3446'
const C = {
	grass: '#CFE6B8',
	grassDot: '#BBDBA3',
	road: '#DCE0E8',
	walk: '#F4F5F8',
	line: '#FFFFFF',
	tree: '#7DBB6A',
	treeHi: '#9AD186',
	screen: '#1E2A38',
	screenText: '#7CF5C4',
	machine: '#E3E7EE',
	pass: '#2FBF71',
	fail: '#E35D5D',
	idle: '#C9CED9',
	lamp: '#FFC24B',
	paper: '#FFFFFF',
}
const color = (id: CompanyId) => COMPANIES.find((c) => c.id === id)?.color ?? INK

const Rect = (p: { x: number; y: number; w: number; h: number; f: string; r?: number; o?: number; s?: string; sw?: number }) => (
	<rect x={p.x} y={p.y} width={p.w} height={p.h} rx={p.r} fill={p.f} opacity={p.o} stroke={p.s} strokeWidth={p.sw} />
)
const Txt = ({ x, y, size = 12, fill = INK, children, anchor = 'start', mono, bold }: { x: number; y: number; size?: number; fill?: string; children: ReactNode; anchor?: 'start' | 'middle' | 'end'; mono?: boolean; bold?: boolean }) => (
	<text x={x} y={y} fontSize={size} fill={fill} textAnchor={anchor} fontFamily={mono ? 'VT323, monospace' : "'Pixelify Sans', system-ui"} fontWeight={bold ? 700 : 400}>
		{children}
	</text>
)

/** A machine seen from above: outlined body, optional screen line, status light. */
const Machine = ({ x, y, w, h, body = C.machine, screen, light, label, blink }: { x: number; y: number; w: number; h: number; body?: string; screen?: string; light?: string; label?: string; blink?: boolean }) => {
	const still = useReducedMotion()
	return (
		<g>
			<Rect x={x + 3} y={y + 3} w={w} h={h} f="#000" o={0.12} r={4} />
			<Rect x={x} y={y} w={w} h={h} f={body} s={INK} sw={3} r={4} />
			{screen !== undefined && (
				<g>
					<Rect x={x + 6} y={y + 6} w={w - 12} h={20} f={C.screen} r={2} />
					<Txt x={x + 10} y={y + 21} size={16} fill={C.screenText} mono>
						{screen.length > Math.floor((w - 16) / 7) ? `${screen.slice(0, Math.floor((w - 16) / 7) - 1)}…` : screen}
					</Txt>
				</g>
			)}
			{light && <motion.circle cx={x + w - 9} cy={y + h - 9} r={4} fill={light} animate={blink && !still ? { opacity: [1, 0.3, 1] } : { opacity: 1 }} transition={{ repeat: Infinity, duration: 0.9 }} />}
			{label && (
				<Txt x={x + w / 2} y={y + h + 16} size={12} anchor="middle" fill="#4B5566">
					{label}
				</Txt>
			)}
		</g>
	)
}

const Tree = ({ x, y, r = 14 }: { x: number; y: number; r?: number }) => (
	<g>
		<circle cx={x + 3} cy={y + 4} r={r} fill="#000" opacity={0.1} />
		<circle cx={x} cy={y} r={r} fill={C.tree} />
		<circle cx={x - r * 0.3} cy={y - r * 0.3} r={r * 0.55} fill={C.treeHi} />
	</g>
)

/** Logo in a round badge; falls back to the company initial until the logo file exists. */
const useLogo = (src?: string) => {
	const [ok, setOk] = useState(false)
	useEffect(() => {
		if (!src) return
		const img = new Image()
		img.onload = () => setOk(true)
		img.onerror = () => setOk(false)
		img.src = src
	}, [src])
	return ok
}
const Logo = ({ c, x, y, r }: { c: Company; x: number; y: number; r: number }) => {
	const ok = useLogo(c.logo)
	return (
		<g>
			<circle cx={x} cy={y} r={r} fill="#fff" stroke={INK} strokeWidth={2.5} />
			{ok && c.logo ? (
				<image href={c.logo} x={x - r * 0.7} y={y - r * 0.7} width={r * 1.4} height={r * 1.4} preserveAspectRatio="xMidYMid meet" />
			) : (
				<Txt x={x} y={y + r * 0.4} size={r * 1.1} anchor="middle" bold fill={c.color}>
					{c.name.replace(/^Semantic Quorum /, 'SQ')[0]}
				</Txt>
			)}
		</g>
	)
}


// ---------------------------------------------------------------------------------------------
// Land: grass, paths, trees, pond, free plots
// ---------------------------------------------------------------------------------------------

/** Plain white ground, one line from each building to the hub, and empty plots for later. */
const Land = ({ busy, layout }: { busy?: CompanyId[]; layout: TownLayout }) => (
	<g>
		<rect x={-3000} y={-3000} width={WORLD_W + 6000} height={WORLD_H + 6000} fill="#F4F1EA" />
		{layout.name === 'triangle' && (
			<g>
				<Rect x={50} y={530} w={750} h={880} f="#FFFFFF" o={0.42} s="#D8D2C5" sw={3} r={26} />
				<Txt x={85} y={575} size={22} fill="#A75627" bold>ARC SETTLEMENT DISTRICT · ERC-8183 + SQ</Txt>
				<Rect x={1630} y={530} w={590} h={880} f="#FFFFFF" o={0.38} s="#D8D2C5" sw={3} r={26} />
				<Txt x={1665} y={575} size={22} fill="#5B49B4" bold>PRIVATE VERIFICATION NETWORK</Txt>
			</g>
		)}
		{(layout.name === 'triangle' ? layout.companies.filter((c) => ['agents', 'arc', 'og'].includes(c.id)) : layout.companies).map((c) => {
			const l = linkOf(c.id, layout)
			const groupBusy = layout.name === 'triangle'
				? c.id === 'arc' ? busy?.some((id) => id === 'arc' || id === 'hq') : c.id === 'og' ? busy?.some((id) => id === 'og' || id === 'chainlink') : busy?.includes(c.id)
				: busy?.includes(c.id)
			return <line key={c.id} x1={l.from.x} y1={l.from.y} x2={l.to.x} y2={l.to.y} stroke={groupBusy ? c.color : '#C6CDD8'} strokeWidth={groupBusy ? 6 : 4} strokeLinecap="round" />
		})}
		{layout.name === 'triangle' && (
			<g>
				{/* Internal district links do not touch the central marketplace hub. */}
				<line x1={425} y1={970} x2={425} y2={1080} stroke="#C99468" strokeWidth={5} strokeLinecap="round" />
				<line x1={1930} y1={900} x2={1935} y2={1080} stroke="#7B76CF" strokeWidth={5} strokeLinecap="round" />
			</g>
		)}
		<circle cx={layout.hub.x} cy={layout.hub.y} r={30} fill="#FFFFFF" stroke={INK} strokeWidth={4} />
		<circle cx={layout.hub.x} cy={layout.hub.y} r={12} fill={INK} />
		{layout.plots.map((r) => (
			<g key={`${r.x}-${r.y}`}>
				<Rect x={r.x} y={r.y} w={r.w} h={r.h} f="#FFFFFF" s="#C6CDD8" sw={3} r={8} />
				<Txt x={r.x + r.w / 2} y={r.y + r.h / 2 - 4} anchor="middle" size={18} fill="#56616E" bold>
					{r.label}
				</Txt>
				<Txt x={r.x + r.w / 2} y={r.y + r.h / 2 + 24} anchor="middle" size={15} fill="#8A97A5">
					{r.status}
				</Txt>
			</g>
		))}
	</g>
)

/** Building: walls, tiled floor, sign with logo above. Interior is drawn by children in inner coordinates. */
const Building = ({ c, onClick, children }: { c: Company; onClick: () => void; children: (inner: { x: number; y: number; w: number; h: number }) => ReactNode }) => {
	const { x: bx, y: by, w: bw, h: bh } = c.at
	const wall = 10
	const inner = { x: bx + wall, y: by + wall, w: bw - 2 * wall, h: bh - 2 * wall }
	const signW = Math.max(c.name.length * 10.5 + 70, 160)
	return (
		<g>
			<g onClick={onClick} style={{ cursor: 'pointer' }} role="button" aria-label={c.name}>
				<Rect x={bx + 8} y={by + 8} w={bw} h={bh} f="#000" o={0.12} r={8} />
				<Rect x={bx} y={by} w={bw} h={bh} f={c.color} s={INK} sw={4} r={8} />
				<Rect x={inner.x} y={inner.y} w={inner.w} h={inner.h} f={c.soft} s={INK} sw={2} r={3} />
				<defs>
					<pattern id={`tile-${c.id}`} width="32" height="32" patternUnits="userSpaceOnUse" x={inner.x} y={inner.y}>
						<rect width="16" height="16" fill={c.color} opacity="0.06" />
						<rect x="16" y="16" width="16" height="16" fill={c.color} opacity="0.06" />
					</pattern>
				</defs>
				<rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} fill={`url(#tile-${c.id})`} />
			</g>
			<g onClick={onClick} style={{ cursor: 'pointer' }}>
				<Rect x={bx + bw / 2 - signW / 2} y={by - 46} w={signW} h={36} f={c.color} s={INK} sw={3} r={6} />
				<Logo c={c} x={bx + bw / 2 - signW / 2 + 21} y={by - 28} r={13} />
				<Txt x={bx + bw / 2 - signW / 2 + 42} y={by - 21} size={18} fill="#fff" bold>
					{c.name}
				</Txt>
			</g>
			{children(inner)}
		</g>
	)
}

// ---------------------------------------------------------------------------------------------
// Interiors
// ---------------------------------------------------------------------------------------------

type In = { x: number; y: number; w: number; h: number }
const pct = (bps: number) => `${Math.round(bps / 100)}%`

const HqInside = ({ i, s }: { i: In; s: TownState }) => (
	<g>
		<Rect x={i.x + 20} y={i.y + 18} w={150} h={22} f="#F6C38D" s={INK} sw={3} r={3} />
		<Txt x={i.x + 95} y={i.y + 34} size={13} anchor="middle">
			deal coordinator
		</Txt>
		<Machine x={i.x + 34} y={i.y + 78} w={70} h={64} screen={s.jobId ? 'ticket ✓' : 'ready'} light={s.jobId ? C.pass : C.idle} label="ticket printer" />
		{s.jobId && <motion.rect x={i.x + 48} width={42} height={18} fill={C.paper} stroke={INK} strokeWidth={2} initial={{ attrY: i.y + 80 }} animate={{ attrY: i.y + 62 }} />}
		{/* roster + judge pool board */}
		<Rect x={i.x + i.w - 190} y={i.y + 18} w={170} h={124} f="#2F4A3A" s={INK} sw={3} r={4} />
		<Txt x={i.x + i.w - 176} y={i.y + 40} size={13} fill="#fff">
			assigned agent
		</Txt>
		<Rect x={i.x + i.w - 176} y={i.y + 48} w={14} h={14} f={s.jobId ? '#E8893A' : '#5B7266'} />
		<Txt x={i.x + i.w - 154} y={i.y + 60} size={16} fill="#fff" mono>
			{s.seller.split('.')[0]}
		</Txt>
		<Txt x={i.x + i.w - 176} y={i.y + 88} size={13} fill="#fff">
			evaluator committee
		</Txt>
		{['laya-1', 'laya-2', 'laya-3', 'vela-1', 'vela-2', 'vela-3'].map((n, k) => {
			const on = !!s.jobId && s.committee.some((m) => m.evaluatorId.startsWith(`${n}.`))
			return (
				<g key={n}>
					<Rect x={i.x + i.w - 176 + (k % 3) * 52} y={i.y + 96 + Math.floor(k / 3) * 20} w={46} h={14} f={on ? (n.startsWith('laya') ? '#8E5BEF' : '#0E9FB0') : '#5B7266'} r={2} />
					<Txt x={i.x + i.w - 153 + (k % 3) * 52} y={i.y + 107 + Math.floor(k / 3) * 20} size={10} anchor="middle" fill="#fff">
						{n}
					</Txt>
				</g>
			)
		})}
		<Rect x={i.x + 20} y={i.y + 158} w={i.w - 40} h={78} f="#FFF8F1" s="#D59B69" sw={3} r={5} />
		<Txt x={i.x + 32} y={i.y + 177} size={12} fill="#8B4A20" bold>SEMANTIC QUORUM COORDINATES THE DEAL</Txt>
		<Txt x={i.x + 32} y={i.y + 194} size={11} fill="#2D3446">1 · Create the ERC-8183 job</Txt>
		<Txt x={i.x + 208} y={i.y + 194} size={11} fill="#2D3446">2 · Bind the selected agent</Txt>
		<Txt x={i.x + 32} y={i.y + 213} size={11} fill="#2D3446">3 · Freeze rubric + evaluators</Txt>
		<Txt x={i.x + 208} y={i.y + 213} size={11} fill="#2D3446">4 · Coordinate final verdict</Txt>
		<Tree x={i.x + 20} y={i.y + i.h - 20} r={10} />
		<Tree x={i.x + i.w - 20} y={i.y + i.h - 20} r={10} />
	</g>
)

/** Triangle concept: make the contract's responsibility explicit instead of showing the HQ ticket desk. */
const SqControllerInside = ({ i, s }: { i: In; s: TownState }) => (
	<g>
		<Txt x={i.x + 16} y={i.y + 28} size={15} fill="#A75627" bold>SQController · ERC-8183 evaluator</Txt>
		<Machine x={i.x + 18} y={i.y + 48} w={150} h={62} body="#F7D7BC" screen={s.jobId ? `job ${s.jobId}` : 'waiting'} label="registered policy" />
		<Machine x={i.x + 188} y={i.y + 48} w={150} h={62} body="#F7D7BC" screen={s.committee.length ? 'Laya + Vela' : 'committee'} label="evaluator snapshot" />
		<Rect x={i.x + 18} y={i.y + 146} w={320} h={86} f="#FFF8F1" s="#D59B69" sw={3} r={6} />
		<Txt x={i.x + 34} y={i.y + 170} size={13} fill="#8B4A20">What this contract enforces</Txt>
		<Txt x={i.x + 34} y={i.y + 194} size={15} fill="#2D3446" bold>{s.ballot ?? 'REVISE · ACCEPT · REJECT'}</Txt>
		<Txt x={i.x + 34} y={i.y + 216} size={12} fill="#6B7280">Only the registered verdict authority can settle the escrow</Txt>
	</g>
)

const AgentsInside = ({ i, s, onPages }: { i: In; s: TownState; onPages: () => void }) => {
	const still = useReducedMotion()
	return (
		<g>
			<Txt x={i.x + 14} y={i.y + 24} size={13} fill="#B03A5B">
				agent services
			</Txt>
			{/* the active seller */}
			<Machine x={i.x + 14} y={i.y + 36} w={170} h={78} body="#F8D7E0" screen={s.screens.writer} light={s.working.writer ? C.lamp : C.idle} blink={!!s.working.writer} label={`${s.seller.split('.')[0]} · model on 0G`} />
			{s.working.writer && !still && (
				<motion.g animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2.4, ease: 'linear' }} style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
					<circle cx={i.x + 36} cy={i.y + 92} r={9} fill="#F1A9BD" stroke={INK} strokeWidth={2} strokeDasharray="3 2" />
				</motion.g>
			)}
			{/* idle bays for future sellers */}
			{[0, 1].map((k) => (
				<g key={k}>
					<Rect x={i.x + 210 + k * 92} y={i.y + 36} w={80} h={78} f="none" s="#D9A5B4" sw={2.5} r={4} />
					<Txt x={i.x + 250 + k * 92} y={i.y + 80} size={12} anchor="middle" fill="#B98494">
						open bay
					</Txt>
				</g>
			))}
			{/* finished pages */}
			<g onClick={onPages} style={{ cursor: s.pages ? 'pointer' : 'default' }} role="button" aria-label="Open the latest attempt">
				<Rect x={i.x + 14} y={i.y + 146} w={200} h={46} f="#E9D9B8" s={INK} sw={3} r={3} />
				{Array.from({ length: Math.min(s.pages, 6) }, (_, k) => (
					<g key={k}>
						<Rect x={i.x + 22 + k * 30} y={i.y + 151} w={24} h={34} f={C.paper} s={INK} sw={1.5} />
						<Txt x={i.x + 34 + k * 30} y={i.y + 173} size={13} anchor="middle" mono>
							v{k + 1}
						</Txt>
					</g>
				))}
				{!s.pages && (
					<Txt x={i.x + 114} y={i.y + 174} size={12} anchor="middle" fill="#8A6E3F">
						finished work lands here
					</Txt>
				)}
			</g>
			<Machine x={i.x + 240} y={i.y + 146} w={140} h={46} body="#F8D7E0" screen={s.coins.seller ? `earned ${(Number(s.budget ?? 0) / 1e6).toString()} USDC` : 'earned 0'} label="wallet" />
		</g>
	)
}

const OgInside = ({ i, s, onJudge }: { i: In; s: TownState; onJudge: (k: number) => void }) => {
	const still = useReducedMotion()
	const crit = s.policy?.criteria ?? []
	return (
		<g>
			<rect x={i.x + 4} y={i.y + 4} width={i.w - 8} height={i.h - 8} fill="none" stroke="#B9A2F4" strokeWidth={2} strokeDasharray="6 6" />
			<Txt x={i.x + 14} y={i.y + 24} size={13} fill="#6B3FD6">
				decision models · sealed in TEEs
			</Txt>
			{[0, 1].map((k) => {
				const j = s.judges[k] ?? { state: 'idle' }
				const m = s.committee[k]
				const name = (m?.evaluatorId.split('-')[0] ?? (k ? 'vela' : 'laya')).replace(/^./, (c) => c.toUpperCase())
				const t = s.policy?.profiles[m?.profileId ?? ''] ?? { criterionPassBps: 7000, overallAcceptBps: 6000 }
				const x = i.x + 18 + k * 186
				const overall = j.result?.overall.expectedLevelBps ?? 0
				const lights = j.result
					? [...crit.map((c) => (j.result?.criteria.find((q) => q.id === c.id)?.passBps ?? 0) >= t.criterionPassBps), overall >= t.overallAcceptBps]
					: Array.from({ length: crit.length + 1 || 5 }, () => null)
				return (
					<g key={k} onClick={() => onJudge(k)} style={{ cursor: 'pointer' }} role="button" aria-label={`${name} judge`}>
						{/* glass booth */}
						<Rect x={x - 6} y={i.y + 34} w={180} h={124} f="#EEE6FF" s="#B9A2F4" sw={3} r={8} />
						<Machine
							x={x + 4}
							y={i.y + 42}
							w={160}
							h={96}
							body="#E2D8FA"
							screen={j.state === 'done' ? `${name} ${pct(overall)}${j.result?.teeVerified !== false ? ' TEE✓' : ''}` : j.state === 'running' ? `${name} judging…` : j.state === 'failed' ? `${name}: no report` : `${name} idle`}
						/>
						{lights.map((ok, q) => (
							<motion.rect
								key={q}
								x={x + 14 + q * 21}
								y={i.y + 82}
								width={16}
								height={16}
								rx={3}
								fill={ok === null ? (j.state === 'running' ? C.lamp : C.idle) : ok ? C.pass : C.fail}
								stroke={INK}
								strokeWidth={1.5}
								animate={j.state === 'running' && !still ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
								transition={{ repeat: Infinity, duration: 0.9, delay: q * 0.12 }}
							/>
						))}
						<Rect x={x + 14} y={i.y + 110} w={140} h={10} f={C.idle} r={3} />
						<motion.rect x={x + 14} y={i.y + 110} height={10} rx={3} fill={overall >= t.overallAcceptBps ? C.pass : C.fail} initial={false} animate={{ width: (140 * overall) / 10000 }} />
						<Txt x={x + 84} y={i.y + 176} size={13} anchor="middle" fill="#6B3FD6">
							{m?.evaluatorId.split('.')[0] ?? name.toLowerCase()} · {j.result?.modelVersion ?? (k ? 'vela-2.0-9b' : 'laya')}
						</Txt>
					</g>
				)
			})}
			{/* TEE racks */}
			{Array.from({ length: 13 }, (_, k) => (
				<g key={k}>
					<Rect x={i.x + 14 + k * 28} y={i.y + i.h - 36} w={22} h={26} f="#C8C0E6" s={INK} sw={2} r={2} />
					<motion.rect x={i.x + 18 + k * 28} y={i.y + i.h - 30} width={5} height={3} fill={C.pass} animate={!still ? { opacity: [1, 0.2, 1] } : {}} transition={{ repeat: Infinity, duration: 1.2 + (k % 3) * 0.4 }} />
					<Rect x={i.x + 18 + k * 28} y={i.y + i.h - 22} w={13} h={2} f="#8E7FC4" />
				</g>
			))}
		</g>
	)
}

const ChainlinkInside = ({ i, s }: { i: In; s: TownState }) => {
	const cx = i.x + 120
	const cy = i.y + i.h / 2 + 4
	const R = 76
	return (
		<g>
			<circle cx={cx} cy={cy} r={R} fill="none" stroke="#9DB2EE" strokeWidth={2} strokeDasharray="6 6" />
			{Array.from({ length: 6 }, (_, k) => {
				const a = (k * Math.PI) / 3
				return <Machine key={k} x={cx + R * Math.cos(a) - 16} y={cy + R * Math.sin(a) - 16} w={32} h={32} body="#D6E0FA" light={C.pass} blink={!!s.working.seal} />
			})}
			<Machine x={cx - 54} y={cy - 22} w={108} h={44} body="#C7D4F7" screen={s.screens.seal} />
			<Txt x={cx} y={i.y + i.h - 6} size={12} anchor="middle" fill="#2C4BB0">
				CRE workflow on the oracle network
			</Txt>
			<Machine x={i.x + i.w - 132} y={i.y + 30} w={106} h={70} body="#E9D9B8" label="ballot box" />
			<Rect x={i.x + i.w - 105} y={i.y + 40} w={52} h={6} f={INK} />
			{s.ballot && (
				<motion.g key={`${s.ballot}-${s.round}`} initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 14 }}>
					<Rect x={i.x + i.w - 130} y={i.y + 126} w={102} h={30} f={s.ballot === 'ACCEPT' || s.ballot === 'PASS' ? C.pass : s.ballot === 'WAITING' ? C.lamp : s.ballot === 'REVISE' ? '#FFD36B' : C.fail} s={INK} sw={3} r={3} />
					<Txt x={i.x + i.w - 79} y={i.y + 147} size={16} anchor="middle" bold>
						{s.ballot}
					</Txt>
				</motion.g>
			)}
		</g>
	)
}

const STAGES = ['open', 'funded', 'submitted', 'completed'] as const
/** ERC-8183: the job crate on a conveyor, moved only by SQController. */
export const ErcInside = ({ i, s }: { i: In; s: TownState }) => {
	const still = useReducedMotion()
	const beltX = i.x + 16
	const beltW = i.w - 32
	const beltY = i.y + 120
	const stageIdx = s.belt === 'rejected' ? 3 : STAGES.indexOf(s.belt as (typeof STAGES)[number])
	const step = (beltW - 64) / 3
	const crateX = beltX + 12 + stageIdx * step
	const usdc = s.budget ? `${(Number(s.budget) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC` : '—'
	return (
		<g>
			<Machine x={i.x + 14} y={i.y + 14} w={150} h={50} body="#D5EEE6" screen={`escrow ${usdc}`} label="AgenticCommerce" />
			<Machine x={i.x + 180} y={i.y + 14} w={110} h={50} body="#D5EEE6" screen={`fees ${s.coins.judges}`} label="judge fees" />
			<Machine x={i.x + 306} y={i.y + 14} w={86} h={50} body="#D5EEE6" screen={s.crateTag ?? (s.finished ? s.finished : s.jobId ? 'live' : 'idle')} label="status" />
			{/* stage pads under the belt */}
			{STAGES.map((st, k) => (
				<g key={st}>
					<Rect x={beltX + k * step} y={beltY - 8} w={64} h={62} f={k <= stageIdx && s.jobId ? '#CDEBE1' : '#EEF3F1'} s="#9CC9BA" sw={2} r={4} />
					<Txt x={beltX + 32 + k * step} y={beltY + 72} size={13} anchor="middle" fill={k === stageIdx && s.jobId ? '#1E6152' : '#7C9A91'} bold={k === stageIdx && !!s.jobId}>
						{s.belt === 'rejected' && k === 3 ? 'rejected' : st}
					</Txt>
				</g>
			))}
			{/* belt */}
			<Rect x={beltX} y={beltY + 8} w={beltW} h={30} f="#AEB8C2" s={INK} sw={3} r={3} />
			{Array.from({ length: Math.floor(beltW / 10) }, (_, k) => (
				<Rect key={k} x={beltX + 4 + k * 10} y={beltY + 11} w={3} h={24} f="#8C97A3" />
			))}
			{/* payout + refund chutes */}
			<Rect x={i.x + i.w - 70} y={i.y + i.h - 40} w={56} h={28} f={s.finished === 'ACCEPT' ? C.pass : '#E2E8EC'} s={INK} sw={2} r={3} />
			<Txt x={i.x + i.w - 42} y={i.y + i.h - 21} size={11} anchor="middle">
				to agent
			</Txt>
			<Rect x={i.x + i.w - 136} y={i.y + i.h - 40} w={56} h={28} f={s.finished === 'REJECT' ? C.fail : '#E2E8EC'} s={INK} sw={2} r={3} />
			<Txt x={i.x + i.w - 108} y={i.y + i.h - 21} size={11} anchor="middle">
				refund
			</Txt>
			{/* SQController arm */}
			<motion.g initial={false} animate={{ x: crateX - (beltX + 12) }} transition={{ type: 'spring', stiffness: 70, damping: 14 }}>
				<circle cx={beltX + 32} cy={i.y + 86} r={13} fill={INK} />
				<circle cx={beltX + 32} cy={i.y + 86} r={9} fill="#6CC3AE" />
				<motion.rect x={beltX + 29} y={i.y + 94} width={6} fill="#2E7D6B" initial={false} animate={{ height: s.working.arm && !still ? [14, 26, 14] : 14 }} transition={{ duration: 0.9 }} />
				<Txt x={beltX + 50} y={i.y + 90} size={12} fill="#1E6152">
					SQController
				</Txt>
			</motion.g>
			{s.jobId && (
				<motion.g initial={false} animate={{ x: crateX - (beltX + 12), opacity: s.finished ? 0.4 : 1 }} transition={{ type: 'spring', stiffness: 60, damping: 12 }}>
					<Rect x={beltX + 12} y={beltY + 2} w={40} h={40} f="#C98B3F" s={INK} sw={3} r={3} />
					<Rect x={beltX + 14} y={beltY + 21} w={36} h={2} f="#8A5A20" />
					<Txt x={beltX + 32} y={beltY + 17} size={13} anchor="middle" mono fill="#fff">
						#{s.jobId.slice(-4)}
					</Txt>
				</motion.g>
			)}
		</g>
	)
}


/** Arc: validators and USDC on the left; the ERC-8183 escrow room on the right (click to open it). */
const ArcInside = ({ i, s, head, onEscrow }: { i: In; s: TownState; head?: number; onEscrow: () => void }) => {
	const still = useReducedMotion()
	const cx = i.x + 92
	const cy = i.y + 118
	const roomX = i.x + 250
	const roomW = i.w - 262
	const stageIdx = s.belt === 'rejected' ? 3 : STAGES.indexOf(s.belt as (typeof STAGES)[number])
	return (
		<g>
			<Txt x={i.x + 14} y={i.y + 24} size={13} fill="#087A87">
				validators
			</Txt>
			<circle cx={cx} cy={cy} r={58} fill="none" stroke="#9ED6DD" strokeWidth={2} strokeDasharray="6 6" />
			{Array.from({ length: 4 }, (_, k) => {
				const a = (k * Math.PI) / 2 + Math.PI / 4
				return <Machine key={k} x={cx + 58 * Math.cos(a) - 17} y={cy + 58 * Math.sin(a) - 17} w={34} h={34} body="#CDEDF1" light={C.pass} blink />
			})}
			<Machine x={cx - 30} y={cy - 22} w={60} h={44} body="#B9E3E8" />
			<motion.rect x={cx - 12} y={cy - 10} width={24} height={20} rx={3} fill="#0E9FB0" stroke={INK} strokeWidth={2} animate={!still ? { scale: [1, 0.85, 1] } : {}} transition={{ repeat: Infinity, duration: 1 }} style={{ transformBox: 'fill-box', transformOrigin: 'center' }} />
			<Machine x={i.x + 14} y={i.y + i.h - 54} w={150} h={34} body="#D2EEF1" screen={head ? `#${head.toLocaleString()}` : 'block …'} />
			<circle cx={i.x + 205} cy={i.y + i.h - 40} r={26} fill={INK} />
			<circle cx={i.x + 205} cy={i.y + i.h - 40} r={22} fill="#fff" stroke="#0E9FB0" strokeWidth={4} />
			<Txt x={i.x + 205} y={i.y + i.h - 35} size={12} anchor="middle" bold fill="#0E9FB0">
				USDC
			</Txt>
			{/* ERC-8183 escrow room */}
			<g onClick={(e) => (e.stopPropagation(), onEscrow())} style={{ cursor: 'pointer' }} role="button" aria-label="Open the ERC-8183 escrow">
				<Rect x={roomX} y={i.y + 8} w={roomW} h={i.h - 16} f="#EFF8F5" s="#2E7D6B" sw={3} r={6} />
				<Txt x={roomX + 12} y={i.y + 30} size={14} fill="#1E6152" bold>
					ERC-8183 escrow
				</Txt>
				<Txt x={roomX + 12} y={i.y + 48} size={12} fill="#1E6152">
					{s.budget ? `${(Number(s.budget) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC held` : 'no job yet'}
				</Txt>
				{STAGES.map((st, k) => (
					<g key={st}>
						<Rect x={roomX + 12} y={i.y + 62 + k * 36} w={roomW - 24} h={30} f={k === stageIdx && s.jobId ? '#CDEBE1' : '#FFFFFF'} s={k === stageIdx && s.jobId ? '#2E7D6B' : '#B9D9CE'} sw={2} r={4} />
						<Txt x={roomX + 24} y={i.y + 82 + k * 36} size={13} fill={k <= stageIdx && s.jobId ? '#1E6152' : '#8AA59D'} bold={k === stageIdx && !!s.jobId}>
							{s.belt === 'rejected' && k === 3 ? 'rejected' : st}
						</Txt>
						{k === stageIdx && s.jobId && (
							<g>
								<Rect x={roomX + roomW - 52} y={i.y + 66 + k * 36} w={26} h={22} f="#C98B3F" s={INK} sw={2} r={2} />
								{s.crateTag && (
									<Txt x={roomX + roomW - 60} y={i.y + 82 + k * 36} size={11} anchor="end" fill="#8A5A20">
										{s.crateTag}
									</Txt>
								)}
							</g>
						)}
					</g>
				))}
				<Txt x={roomX + roomW / 2} y={i.y + i.h - 16} size={12} anchor="middle" fill="#2E7D6B">
					click to open
				</Txt>
			</g>
		</g>
	)
}

/** The Arc chain: a row of blocks along the bottom of the Arc building. Our transactions light up. */
const ArcChain = ({ s, layout }: { s: TownState; layout: TownLayout }) => {
	const arc = layout.companies.find((c) => c.id === 'arc')
	if (!arc) return null
	const size = 30
	const n = Math.floor((arc.at.w + 80) / size)
	const x0 = arc.at.x - 40
	const y = arc.at.y + arc.at.h + 22
	const ours = s.chainTxs.slice(-n)
	const GLYPH: Record<string, string> = { createJob: 'N', fund: '$', registerJob: 'J', REVISE: 'R', submit: 'S', ACCEPT: 'A', REJECT: 'X' }
	return (
		<g>
			<Txt x={x0} y={y + 44} size={13} fill="#087A87">
				Arc chain: this deal’s transactions light up
			</Txt>
			{Array.from({ length: n }, (_, k) => {
				const tx = ours[ours.length - (n - k)]
				const x = x0 + k * size
				const body = (
					<g>
						<Rect x={x} y={y} w={size - 6} h={24} f={tx ? '#0E9FB0' : '#C7DDE2'} s={INK} sw={2} r={3} />
						{k < n - 1 && <Rect x={x + size - 6} y={y + 10} w={6} h={4} f="#8FB4BC" />}
						{tx && (
							<Txt x={x + (size - 6) / 2} y={y + 17} size={14} anchor="middle" fill="#fff" bold>
								{GLYPH[tx.label] ?? tx.label[0]}
							</Txt>
						)}
						<title>{tx ? `${tx.label}${tx.txHash ? ` · ${tx.txHash}` : ''}` : 'Arc block'}</title>
					</g>
				)
				return tx?.txHash ? (
					<a key={k} href={`https://explorer.testnet.arc.io/tx/${tx.txHash}`} target="_blank" rel="noreferrer">
						{body}
					</a>
				) : (
					<g key={k}>{body}</g>
				)
			})}
		</g>
	)
}

const GenericInside = ({ i, c }: { i: In; c: Company }) => (
	<g>
		{[0, 1, 2].map((k) => (
			<Machine key={k} x={i.x + 30 + k * 90} y={i.y + 40} w={60} h={60} light={c.color} />
		))}
		<Machine x={i.x + 30} y={i.y + 130} w={240} h={34} screen="idle" />
	</g>
)


// ---------------------------------------------------------------------------------------------
// Carts along the paths
// ---------------------------------------------------------------------------------------------

const CART_COLOR: Record<CartKind, string> = { ticket: '#E8893A', page: '#FFFFFF', reports: '#8E5BEF', verdict: '#375BD2', scorecard: '#F2B544', hash: '#2E7D6B', usdc: '#0E9FB0' }
const CART_LABEL: Record<CartKind, string> = { ticket: 'job', page: 'page', reports: '2 sig', verdict: 'verdict', scorecard: 'scores', hash: 'submit', usdc: 'USDC' }

const Cart = ({ c, layout }: { c: Capsule; layout: TownLayout }) => {
	const still = useReducedMotion()
	if (c.from === c.to || still) return null
	const pts = routeBetween(c.from, c.to, layout)
	const seg = pts.slice(1).map((p, k) => Math.hypot(p.x - pts[k]!.x, p.y - pts[k]!.y))
	const total = seg.reduce((a, b) => a + b, 0) || 1
	const times = [0, seg[0]! / total, 1]
	const ang = (a: { x: number; y: number }, b: { x: number; y: number }) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
	const r1 = ang(pts[0]!, pts[1]!)
	const r2 = ang(pts[1]!, pts[2]!)
	return (
		<motion.g
			key={c.id}
			initial={{ x: pts[0]!.x, y: pts[0]!.y, rotate: r1, opacity: 1 }}
			animate={{ x: pts.map((p) => p.x), y: pts.map((p) => p.y), rotate: [r1, r2, r2], opacity: [1, 1, 0] }}
			transition={{ duration: Math.max(1.8, total / 480), times, ease: 'easeInOut' }}
		>
			<rect x={-24} y={-14} width={48} height={28} rx={8} fill={INK} />
			<rect x={-21} y={-11} width={42} height={22} rx={6} fill={CART_COLOR[c.kind]} />
			<text x={0} y={4} fontSize={11} textAnchor="middle" fill={c.kind === 'page' ? INK : '#fff'} fontFamily="'Pixelify Sans', system-ui">
				{CART_LABEL[c.kind]}
			</text>
		</motion.g>
	)
}

// ---------------------------------------------------------------------------------------------

export type WorldClick = { kind: 'company'; id: CompanyId } | { kind: 'judge'; index: number } | { kind: 'pages' } | { kind: 'escrow' }

export const World = ({ s, head, onClick, layoutName = 'classic' }: { s: TownState; head?: number; onClick: (c: WorldClick) => void; layoutName?: TownLayoutName }) => {
	const layout = getTownLayout(layoutName)
	return <g>
		<Land busy={s.capsule ? [s.capsule.from, s.capsule.to] : undefined} layout={layout} />
		{layout.companies.map((c) => (
			<Building key={c.id} c={c} onClick={() => onClick({ kind: 'company', id: c.id })}>
				{(i) =>
					c.id === 'hq' ? (
						layoutName === 'triangle' ? <SqControllerInside i={i} s={s} /> : <HqInside i={i} s={s} />
					) : c.id === 'agents' ? (
						<AgentsInside i={i} s={s} onPages={() => onClick({ kind: 'pages' })} />
					) : c.id === 'og' ? (
						<OgInside i={i} s={s} onJudge={(k) => onClick({ kind: 'judge', index: k })} />
					) : c.id === 'chainlink' ? (
						<ChainlinkInside i={i} s={s} />
					) : c.id === 'arc' ? (
						<ArcInside i={i} s={s} head={head} onEscrow={() => onClick({ kind: 'escrow' })} />
					) : (
						<GenericInside i={i} c={c} />
					)
				}
			</Building>
		))}
		<ArcChain s={s} layout={layout} />
		{s.capsule && <Cart key={s.capsule.id} c={s.capsule} layout={layout} />}
	</g>
}

/** Camera target for a company (its building plus the sign and some margin). */
export const focusRect = (id?: CompanyId, layoutName: TownLayoutName = 'classic') => {
	const c = getTownLayout(layoutName).companies.find((x) => x.id === id)
	if (!c) return undefined
	const pad = 260
	return { x: c.at.x - pad, y: c.at.y - pad - 30, w: c.at.w + 2 * pad, h: c.at.h + 2 * pad + 60 }
}
export { WORLD_H, WORLD_W, color }
