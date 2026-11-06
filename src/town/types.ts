// Shapes the town needs. They mirror the coordinator's API; nothing here is specific to one task.

export type Criterion = { id: string; statement: string; must: boolean }
export type Thresholds = { criterionPassBps: number; overallAcceptBps: number; overallRejectBps: number }
export type Policy = {
	version: 'sq-policy-1'
	brief?: string
	criteria: Criterion[]
	profiles: Record<string, Thresholds>
	revisionLimit: number
}

export type JudgeResult = {
	profileId?: string
	modelVersion?: string
	provider?: string
	requestId?: string
	teeVerified?: boolean
	criteria: { id: string; passBps: number }[]
	overall: { expectedLevelBps: number }
}

export type ScoreRow = {
	id: string
	statement: string
	must: boolean
	scores: { evaluatorIndex: number; profileId: string; bps: number; needBps: number; pass: boolean }[]
	pass: boolean
}
export type Scorecard = { round: number; verdict: string; rows: ScoreRow[] }

/** Coordinator event (GET /events). */
export type TownEvent = {
	seq: number
	at?: string
	jobId: string
	round: number
	step: string
	status: string
	data?: Record<string, unknown>
}

export type Committee = { index: number; evaluatorId: string; profileId: string }[]

export type Station = 'hq' | 'workshop' | 'chamber' | 'chainlink' | 'bank'
export type BeltStage = 'open' | 'funded' | 'submitted' | 'completed' | 'rejected'

export type Receipt = { id: number; src: '0G' | 'Chainlink' | 'Arc' | 'HQ' | 'Coordinator'; text: string; href?: string; tee?: boolean }
