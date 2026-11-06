import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Policy } from '../../../cre/src/protocol/types.ts'

const choose = (policy: Policy) => {
	const task = `${policy.brief ?? ''} ${policy.criteria.map((criterion) => criterion.statement).join(' ')}`.toLowerCase()
	if (/storage|upload|file|merkle/.test(task)) return 'skills/storage/upload-file/SKILL.md'
	if (/contract|solidity|chain/.test(task)) return 'skills/chain/scaffold-project/SKILL.md'
	return 'skills/compute/streaming-chat/SKILL.md'
}

export const ogSkillContext = (policy: Policy) => {
	const root = resolve(import.meta.dir, process.env.OG_SKILLS_DIR ?? '../../../.0g-skills')
	// Put task-specific instructions first so they survive the bounded system-prompt context.
	const files = [choose(policy), 'skills/chain/scaffold-project/SKILL.md', 'patterns/SECURITY.md', 'AGENTS.md']
	const unique = [...new Set(files)].map((file) => resolve(root, file))
	if (unique.some((file) => !existsSync(file))) throw new Error(`official 0G agent skills are missing under ${root}; clone https://github.com/0gfoundation/0g-agent-skills there`)
	return unique.map((file) => readFileSync(file, 'utf8')).join('\n\n').slice(0, 24_000)
}
