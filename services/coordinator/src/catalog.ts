// Agent catalog: the sellers the coordinator can assign and the judges it draws the committee from.
// The catalog contains both worker services and evaluator services. A deal freezes
// only the evaluator committee selected by its buyer.

import { readFileSync } from 'node:fs'
import type { Address } from 'viem'
import { z } from 'zod'
import type { Policy, ProfileThresholds } from '../../../cre/src/protocol/types.ts'

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const schema = z.object({
	sellers: z.array(z.object({ id: z.string(), ens: z.string(), name: z.string(), model: z.string(), runtime: z.string(), skills: z.array(z.string()) })).min(1),
	judges: z.array(z.object({
		evaluatorId: z.string(),
		profileId: z.string(),
		model: z.string(),
		provider: z.enum(['0g', 'jev']).default('0g'),
		name: z.string().optional(),
		description: z.string().optional(),
		defaultSelected: z.boolean().default(false),
		reportKey: addr,
		feeRecipient: addr,
	})).min(1),
	defaultThresholds: z.object({ criterionPassBps: z.number().int(), overallAcceptBps: z.number().int(), overallRejectBps: z.number().int() }),
})

export type Catalog = z.infer<typeof schema>
export type Seller = Catalog['sellers'][number]

export const loadCatalog = (file: string): Catalog => schema.parse(JSON.parse(readFileSync(file, 'utf8')))

export type SellerPick = { seller: Seller | null; matched: string[] }

/** Best seller for a task by skill keywords. Unsupported work is rejected, never sent to a random worker. */
export const pickSeller = (c: Catalog, task: string): SellerPick => {
	const t = task.toLowerCase()
	let best: SellerPick = { seller: null, matched: [] }
	for (const s of c.sellers) {
		const matched = s.skills.filter((k) => t.includes(k))
		if (matched.length > best.matched.length) best = { seller: s, matched }
	}
	return best
}

export const requireSeller = (c: Catalog, task: string): { seller: Seller; matched: string[] } => {
	const pick = pickSeller(c, task)
	if (!pick.seller) throw new Error('No agent currently supports this task. Try a landing page, an Arc/Circle contract, or a 0G agent project.')
	return { seller: pick.seller, matched: pick.matched }
}

/** Per-model thresholds for every judge profile in the committee. */
export const defaultProfiles = (c: Catalog): Policy['profiles'] =>
	Object.fromEntries(c.judges.map((j) => [j.profileId, { ...c.defaultThresholds } as ProfileThresholds]))

export const committeeOf = (c: Catalog, evaluatorIds?: string[]) => {
	const requested = evaluatorIds?.length ? evaluatorIds : c.judges.filter((judge) => judge.defaultSelected).map((judge) => judge.evaluatorId)
	const ids = requested.length ? requested : c.judges.filter((judge) => judge.provider === '0g').map((judge) => judge.evaluatorId)
	if (!ids.length || new Set(ids).size !== ids.length) throw new Error('select at least one unique evaluator')
	const judges = ids.map((id) => {
		const judge = c.judges.find((candidate) => candidate.evaluatorId === id)
		if (!judge) throw new Error(`unknown evaluator: ${id}`)
		return judge
	})
	return judges.map((j, index) => ({ index, evaluatorId: j.evaluatorId, profileId: j.profileId, reportKey: j.reportKey as Address, feeRecipient: j.feeRecipient as Address }))
}
