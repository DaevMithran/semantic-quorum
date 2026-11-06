// Everything around the town: scoreboard, receipt tape, job ticket, detail card.

import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { lintCriterion, LIMITS } from './lint'
import { COORDINATOR } from './sources'
import { short, type TownState } from './state'
import type { Criterion, Policy, Receipt } from './types'

const pct = (bps: number) => `${Math.round(bps / 100)}%`

export const Scoreboard = ({ s, minimized, onToggle }: { s: TownState; minimized?: boolean; onToggle?: () => void }) => {
	const card = s.scorecard
	const names = s.committee.length ? s.committee.map((m) => m.evaluatorId.split('-')[0]) : ['laya', 'vela']
	const rows = card?.rows ?? (s.policy ? [...s.policy.criteria.map((c) => ({ id: c.id, statement: c.statement, must: c.must, scores: [], pass: false })), { id: 'overall', statement: 'Overall quality against the brief', must: true, scores: [], pass: false }] : [])
	const maxRounds = (s.policy?.revisionLimit ?? 2) + 1
	return (
		<section className={`board ${minimized ? 'minimized' : ''}`} aria-label="Rubric and evaluator scores">
			<header className="board-head">
				<div className="board-title">
					<small>LIVE RUBRIC · {s.policy?.criteria.length ?? 0} CRITERIA</small>
					<h2>{s.policy?.brief ?? 'Post a job to light up the board'}</h2>
				</div>
				{onToggle && <button type="button" className="board-toggle" aria-label={minimized ? 'Expand rubric' : 'Minimize rubric'} title={minimized ? 'Expand rubric' : 'Minimize rubric'} aria-expanded={!minimized} onClick={onToggle}>{minimized ? <Maximize2 size={15} /> : <Minimize2 size={15} />}</button>}
				{!minimized && <div className="board-meta">
					{s.jobId && <span>Job {s.jobId}</span>}
					{s.policy && <span>Now on attempt {Math.min(s.round + 1, maxRounds)} of {maxRounds}</span>}
					{card && (
						<span className={`verdict v-${card.verdict.toLowerCase()}`}>
							Attempt {card.round + 1}: {card.verdict}
						</span>
					)}
				</div>}
			</header>
			{!minimized && rows.length > 0 && (
				<table>
					<thead>
						<tr>
							<th scope="col">Check</th>
							{names.map((n) => (
								<th key={n} scope="col" className="judge-col">
									{n[0]?.toUpperCase()}
									{n.slice(1)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={r.id} className={r.id === 'overall' ? 'overall' : undefined}>
								<th scope="row">
									{r.statement}
									{!r.must && <span className="nice"> nice to have</span>}
								</th>
								{names.map((n, i) => {
									const sc = r.scores.find((x) => x.evaluatorIndex === i)
									return (
										<td key={n} className={sc ? (sc.pass ? 'pass' : 'fail') : 'empty'}>
											{sc ? (
												<motion.span key={`${card?.round}-${sc.bps}`} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.15 }}>
													{pct(sc.bps)}
													<small> / {pct(sc.needBps)}</small>
												</motion.span>
											) : (
												'—'
											)}
										</td>
									)
								})}
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	)
}

export const ReceiptTape = ({ receipts }: { receipts: Receipt[] }) => {
	const ref = useRef<HTMLOListElement>(null)
	useEffect(() => {
		ref.current?.scrollTo({ left: ref.current.scrollWidth, behavior: 'smooth' })
	}, [receipts.length])
	return (
		<ol className="tape" ref={ref} aria-label="Receipts" aria-live="polite">
			{receipts.length === 0 && <li className="receipt empty">Receipts print here: every 0G call, Chainlink check and Arc transaction.</li>}
			{receipts.map((r) => (
				<motion.li key={r.id} className={`receipt src-${r.src.toLowerCase()}`} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }}>
					<b>{r.src}</b>
					<span>{r.text}</span>
					{r.tee && <em title="0G router verified the TEE signature">TEE ✓</em>}
					{r.href && (
						<a href={r.href} target="_blank" rel="noreferrer">
							View tx
						</a>
					)}
				</motion.li>
			))}
		</ol>
	)
}

/** HQ's door: one line in, a job ticket out. */
export const HqDoor = ({ onTicket, busy }: { onTicket: (task: string) => void; busy: boolean }) => {
	const [task, setTask] = useState('')
	return (
		<form
			className="door"
			onSubmit={(e) => {
				e.preventDefault()
				if (task.trim().length >= 3) onTicket(task.trim())
			}}
		>
			<label htmlFor="task">What do you need done?</label>
			<div className="door-row">
				<input id="task" value={task} onChange={(e) => setTask(e.target.value)} placeholder="A landing page for my bakery: prices, opening hours, and that we deliver" maxLength={2000} />
				<button type="submit" disabled={busy || task.trim().length < 3}>
					{busy ? 'Printing ticket…' : 'Print job ticket'}
				</button>
			</div>
		</form>
	)
}

export type TicketDraft = { task: string; policy: Policy; pick?: string }

export const Ticket = ({ draft, onClose, onFunded }: { draft: TicketDraft; onClose: () => void; onFunded: (jobId: string) => void }) => {
	const [brief, setBrief] = useState(draft.policy.brief ?? '')
	const [crit, setCrit] = useState<Criterion[]>(draft.policy.criteria)
	const [budget, setBudget] = useState('0.1')
	const [limit, setLimit] = useState(draft.policy.revisionLimit ?? 3)
	const [state, setState] = useState<'edit' | 'stamping' | 'error'>('edit')
	const [problems, setProblems] = useState<string[]>([])
	const fee = 0.01 * 2 * (limit + 1)
	const update = (i: number, c: Partial<Criterion>) => setCrit((xs) => xs.map((x, k) => (k === i ? { ...x, ...c } : x)))

	const stamp = async () => {
		setState('stamping')
		setProblems([])
		const policy: Policy = { ...draft.policy, brief: brief.trim(), criteria: crit.map((c, i) => ({ id: `c${i + 1}`, statement: c.statement.trim(), must: c.must })), revisionLimit: limit }
		try {
			const r = await fetch(`${COORDINATOR}/deals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: draft.task, policy, budgetUsdc: budget }) })
			const body = (await r.json()) as { jobId?: string; error?: string; problems?: string[] }
			if (!r.ok || !body.jobId) {
				setProblems(body.problems ?? [typeof body.error === 'string' ? body.error : `Coordinator answered ${r.status}`])
				setState('error')
				return
			}
			onFunded(body.jobId)
		} catch {
			setProblems([`Can't reach the coordinator at ${COORDINATOR}`])
			setState('error')
		}
	}

	return (
		<div className="overlay" role="dialog" aria-modal="true" aria-labelledby="ticket-title">
			<motion.div className="ticket" initial={{ y: 40, opacity: 0, rotate: -1.5 }} animate={{ y: 0, opacity: 1, rotate: -0.5 }}>
				<div className="ticket-head">
					<h3 id="ticket-title">Job ticket</h3>
					<button type="button" className="ghost" onClick={onClose}>
						Close
					</button>
				</div>
				{draft.pick && <p className="ticket-note">Assigned to {draft.pick}. Judged by Laya and Vela on 0G.</p>}
				<label className="field">
					<span>Brief</span>
					<textarea value={brief} maxLength={LIMITS.maxBriefChars} onChange={(e) => setBrief(e.target.value)} rows={2} />
				</label>
				<fieldset className="crit">
					<legend>
						Checks the judges score ({crit.length} of {LIMITS.maxCriteria})
					</legend>
					{crit.map((c, i) => {
						const hints = lintCriterion(c.statement)
						return (
							<div key={i} className="crit-row">
								<input aria-label={`Check ${i + 1}`} value={c.statement} onChange={(e) => update(i, { statement: e.target.value })} />
								<label className="must">
									<input type="checkbox" checked={c.must} onChange={(e) => update(i, { must: e.target.checked })} /> Required
								</label>
								<button type="button" className="ghost" aria-label={`Remove check ${i + 1}`} onClick={() => setCrit((xs) => xs.filter((_, k) => k !== i))}>
									Remove
								</button>
								{hints.map((h) => (
									<p key={h} className="hint">
										{h}
									</p>
								))}
							</div>
						)
					})}
					{crit.length < LIMITS.maxCriteria && (
						<button type="button" className="ghost add" onClick={() => setCrit((xs) => [...xs, { id: '', statement: '', must: true }])}>
							Add a check
						</button>
					)}
				</fieldset>
				<div className="terms">
					<label className="field">
						<span>Reward (USDC)</span>
						<input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
					</label>
					<label className="field">
						<span>Revisions allowed</span>
						<select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
							{[1, 2, 3, 4, 5].map((n) => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
						</select>
					</label>
					<p className="fee">Judge fees up to {fee.toFixed(2)} USDC (0.01 per report, unused fees come back).</p>
				</div>
				{problems.length > 0 && (
					<ul className="problems">
						{problems.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ul>
				)}
				<button type="button" className="stamp" disabled={state === 'stamping' || crit.length === 0 || !brief.trim()} onClick={stamp}>
					{state === 'stamping' ? 'Creating the job on Arc…' : 'Stamp & fund'}
				</button>
				<p className="ticket-foot">Stamping freezes the checks: their hash is registered on Arc with the job.</p>
			</motion.div>
		</div>
	)
}

export type Detail = { title: string; body: React.ReactNode }

export const DetailCard = ({ d, onClose }: { d: Detail; onClose: () => void }) => (
	<div className="overlay" role="dialog" aria-modal="true" aria-labelledby="detail-title" onClick={onClose}>
		<motion.div className="detail" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} onClick={(e) => e.stopPropagation()}>
			<div className="ticket-head">
				<h3 id="detail-title">{d.title}</h3>
				<button type="button" className="ghost" onClick={onClose}>
					Close
				</button>
			</div>
			{d.body}
		</motion.div>
	</div>
)

export const judgeDetail = (s: TownState, i: number): Detail => {
	const j = s.judges[i]
	const m = s.committee[i]
	const name = m?.evaluatorId ?? `judge ${i}`
	if (!j?.result) return { title: name, body: <p className="muted">{j?.state === 'running' ? 'Judging inside 0G’s TEE…' : 'No report for this attempt yet.'}</p> }
	const r = j.result
	return {
		title: name,
		body: (
			<div className="judge-detail">
				<p>
					Model <b>{r.modelVersion ?? '?'}</b> on 0G Private Computer. Request {short(j.requestId?.split(',')[0])}. {r.teeVerified !== false ? 'TEE signature verified by the 0G router.' : 'TEE not verified.'}
				</p>
				<ul>
					{(s.policy?.criteria ?? []).map((c) => (
						<li key={c.id}>
							<span>{c.statement}</span>
							<b>{pct(r.criteria.find((x) => x.id === c.id)?.passBps ?? 0)}</b>
						</li>
					))}
					<li>
						<span>Overall quality</span>
						<b>{pct(r.overall.expectedLevelBps)}</b>
					</li>
				</ul>
				<p className="muted">Signed by this judge’s report key; Chainlink CRE only counts reports signed by the two registered judges.</p>
			</div>
		),
	}
}
