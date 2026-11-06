// In-memory event log for the jury board / pipeline view. Read-only for the UI; it never drives decisions.

export type Event = {
	seq: number
	at: string
	jobId: string
	round: number
	step: string // delivered | judge-0 | judge-1 | cre | verdict-signed | verdict-onchain | submitted
	status: string
	data?: Record<string, unknown>
}

export class Events {
	private list: Event[] = []

	add(jobId: string, round: number, step: string, status: string, data?: Record<string, unknown>) {
		const e: Event = { seq: this.list.length + 1, at: new Date().toISOString(), jobId, round, step, status, data }
		this.list.push(e)
		return e
	}

	since(jobId: string, after = 0): Event[] {
		return this.list.filter((e) => e.jobId === jobId && e.seq > after)
	}
}
