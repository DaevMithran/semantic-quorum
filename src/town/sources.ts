// Where events come from: the live coordinator, or a recorded deal replayed on a timer.
// Both go through the same pacing queue so animations never pile up.

import { useCallback, useEffect, useRef, useState } from 'react'
import replayData from './replay-191223.json'
import { apply, initialState, type TownState } from './state'
import type { Committee, JudgeResult, Policy, TownEvent } from './types'

export const COORDINATOR: string = (import.meta.env.VITE_COORDINATOR_URL as string | undefined) ?? 'http://127.0.0.1:8787'

type Replay = {
	jobId: string
	policy: Policy
	snapshot: { committee: Committee }
	deal: { seller: string; budget: string; feePerReport: string }
	rounds: { round: number; reports: { evaluatorIndex: number; model: string; requestId: string; teeVerified?: boolean; criteria: { id: string; passBps: number }[]; overallBps: number }[] }[]
	submitTxHash: string
}

/** The recorded deal (Arc job 191223) as the event stream the coordinator would have produced. */
export const replayEvents = (): { events: TownEvent[]; seed: Partial<TownState> } => {
	const r = replayData as unknown as Replay
	const ev: TownEvent[] = []
	const add = (round: number, step: string, status: string, data?: Record<string, unknown>) =>
		ev.push({ seq: ev.length + 1, jobId: r.jobId, round, step, status, data })
	add(0, 'deal-created', 'ok', { seller: r.deal.seller, budget: r.deal.budget })
	add(0, 'job-funded', 'ok')
	add(0, 'job-registered', 'ok')
	add(0, 'seller-started', 'ok')
	const last = r.rounds.length - 1
	r.rounds.forEach((rd, i) => {
		if (i > 0) add(rd.round, 'seller-writing', 'running')
		add(rd.round, 'seller-log', 'info', { line: `round ${rd.round}: wrote ${1700 + rd.round * 190} chars (0G recorded)` })
		add(rd.round, 'delivered', 'ok')
		add(rd.round, 'judge-0', 'running')
		add(rd.round, 'judge-1', 'running')
		for (const rep of [...rd.reports].sort((a, b) => a.evaluatorIndex - b.evaluatorIndex)) {
			const result: JudgeResult = { modelVersion: rep.model, requestId: rep.requestId, teeVerified: rep.teeVerified, criteria: rep.criteria, overall: { expectedLevelBps: rep.overallBps } }
			add(rd.round, `judge-${rep.evaluatorIndex}`, 'done', { requestId: rep.requestId, result })
		}
		add(rd.round, 'cre', 'running')
		if (i < last) {
			add(rd.round, 'cre', 'REVISE')
			add(rd.round, 'verdict-onchain', 'REVISE')
			add(rd.round, 'fees-credited', 'ok')
		} else {
			add(rd.round, 'cre', 'PASS')
			add(rd.round, 'submitted', 'ok', { submitTxHash: r.submitTxHash })
			add(rd.round, 'cre', 'running')
			add(rd.round, 'cre', 'ACCEPT')
			add(rd.round, 'verdict-onchain', 'ACCEPT')
			add(rd.round, 'fees-credited', 'ok')
			add(rd.round, 'paid', 'ok', { amount: r.deal.budget })
		}
	})
	return { events: ev, seed: { jobId: r.jobId, policy: r.policy, committee: r.snapshot.committee, seller: r.deal.seller, budget: r.deal.budget, feePerReport: r.deal.feePerReport } }
}

/** Slower steps get more stage time so the eye can follow them. */
const holdFor = (e: TownEvent) =>
	e.step === 'seller-log' ? 200 : e.step.startsWith('judge') && e.status === 'running' ? 500 : ['delivered', 'verdict-onchain', 'submitted', 'deal-created', 'seller-writing'].includes(e.step) || (e.step === 'cre' && e.status === 'running') ? 2200 : 1300

/** Plays queued events one at a time through `apply`. */
const usePlayer = (seed: () => TownState, speed: number, paused: boolean) => {
	const [state, setState] = useState<TownState>(seed)
	const queue = useRef<TownEvent[]>([])
	const busy = useRef(false)
	const speedRef = useRef(speed)
	const pausedRef = useRef(paused)
	const pumpRef = useRef<() => void>(() => undefined)
	const pump = useCallback(() => {
		if (busy.current || pausedRef.current) return
		const next = queue.current.shift()
		if (!next) return
		busy.current = true
		setState((s) => apply(s, next))
		window.setTimeout(() => {
			busy.current = false
			pumpRef.current()
		}, holdFor(next) / speedRef.current)
	}, [])
	useEffect(() => {
		speedRef.current = speed
	}, [speed])
	useEffect(() => {
		pumpRef.current = pump
	}, [pump])
	useEffect(() => {
		pausedRef.current = paused
		if (!paused) pump()
	}, [paused, pump])
	const push = (evs: TownEvent[]) => {
		queue.current.push(...evs)
		pump()
	}
	const applyNow = (evs: TownEvent[]) => {
		if (!evs.length) return
		setState((current) => evs.reduce(apply, current))
	}
	const reset = (s: TownState) => {
		queue.current = []
		setState(s)
	}
	return { state, setState, push, applyNow, reset }
}

export const useReplay = (enabled: boolean, speed: number, paused = false) => {
	const { state, push, reset } = usePlayer(initialState, speed, paused)
	const [run, setRun] = useState(0)
	useEffect(() => {
		if (!enabled) return
		const { events, seed } = replayEvents()
		reset({ ...initialState(), ...seed })
		push(events)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, run])
	return { state, restart: () => setRun((x) => x + 1) }
}

type DealSnapshot = {
	jobId: string
	deal: { seller: { ens: string }; budget: string; feePerReport: string; status: string } | null
	policy: Policy | null
	snapshot: { committee: Committee } | null
	rounds: { round: number; pageUrl?: string | null; reports: { evaluatorIndex: number; result: JudgeResult }[]; outcomes?: { phase: string; status: string; scorecard?: TownState['scorecard'] }[] }[]
}

/** Follows a job on the coordinator: polls events and the deal snapshot (for scores). */
export const useLive = (jobId: string | undefined, speed: number, paused = false) => {
	const { state, setState, push, applyNow, reset } = usePlayer(initialState, speed, paused)
	const snap = useRef<DealSnapshot | null>(null)
	const [error, setError] = useState<string>()
	useEffect(() => {
		if (!jobId) return
		reset({ ...initialState(), jobId })
		snap.current = null
		let after = 0
		let stop = false
		const loadSnapshot = async () => {
			const r = await fetch(`${COORDINATOR}/deals/${jobId}`)
			if (!r.ok) return
			const s = (await r.json()) as DealSnapshot
			snap.current = s
			const latest = [...s.rounds].sort((a, b) => b.round - a.round)[0]
			const latestOutcome = latest?.outcomes?.find((outcome) => outcome.phase === 'final') ?? latest?.outcomes?.find((outcome) => outcome.phase === 'draft')
			const pages = s.rounds.filter((item) => item.pageUrl).reduce((highest, item) => Math.max(highest, item.round + 1), 0)
			const terminal = s.deal?.status === 'accepted' ? 'ACCEPT' : s.deal?.status === 'rejected' ? 'REJECT' : undefined
			setState((st) => ({
				...st,
				policy: s.policy ?? st.policy,
				committee: s.snapshot?.committee ?? st.committee,
				seller: s.deal?.seller.ens ?? st.seller,
				budget: s.deal?.budget ?? st.budget,
				feePerReport: s.deal?.feePerReport ?? st.feePerReport,
				round: latest?.round ?? st.round,
				pages: Math.max(st.pages, pages),
				judges: latest?.reports?.length ? (s.snapshot?.committee ?? []).map((member) => {
					const report = latest.reports.find((item) => item.evaluatorIndex === member.index)
					return report ? { state: 'done' as const, result: report.result, requestId: report.result.requestId } : { state: 'idle' as const }
				}) : st.judges,
				scorecard: latestOutcome?.scorecard ?? st.scorecard,
				finished: terminal ?? st.finished,
				belt: terminal === 'ACCEPT' ? 'completed' : terminal === 'REJECT' ? 'rejected' : st.belt,
			}))
		}
		const enrich = (e: TownEvent): TownEvent => {
			if (!/^judge-\d$/.test(e.step) || e.status !== 'done') return e
			const rep = snap.current?.rounds.find((r) => r.round === e.round)?.reports.find((x) => x.evaluatorIndex === Number(e.step.slice(-1)))
			return rep ? { ...e, data: { ...e.data, result: rep.result } } : e
		}
		const tick = async () => {
			try {
				const openingHistory = after === 0
				if (!snap.current) await loadSnapshot()
				const r = await fetch(`${COORDINATOR}/events?jobId=${jobId}&after=${after}`)
				const evs = (await r.json()) as TownEvent[]
				if (evs.length) {
					if (evs.some((e) => e.step.startsWith('judge') || e.step === 'job-registered') || !snap.current) await loadSnapshot()
					after = evs[evs.length - 1]?.seq ?? after
					// Opening a persisted deal is a history view, not a replay. Hydrate all
					// existing events immediately; only genuinely new events are animated.
					if (openingHistory) applyNow(evs.map(enrich))
					else push(evs.map(enrich))
				} else if (!snap.current) await loadSnapshot()
				setError(undefined)
			} catch {
				setError(`Can't reach the coordinator at ${COORDINATOR}`)
			}
			if (!stop) window.setTimeout(tick, 1000)
		}
		tick()
		return () => {
			stop = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [jobId])
	return { state, error }
}
