import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const compact = (text: string) => {
	const quick = text.match(/## Quick Reference[\s\S]*?(?=## Core Concepts|## Implementation Patterns|## Rules)/)?.[0] ?? ''
	const rules = text.match(/## Rules[\s\S]*?(?=## Next Steps|## Reference Links|---\s*$)/)?.[0] ?? ''
	return `${quick}\n${rules}`.slice(0, 14_000)
}

export const circleSkillContext = () => {
	const root = resolve(import.meta.dir, process.env.CIRCLE_SKILLS_DIR ?? '../../../.agents/skills')
	const files = [
		{ path: 'use-smart-contract-platform/SKILL.md', compact: true },
		{ path: 'use-smart-contract-platform/references/deploy-bytecode.md', compact: false },
		{ path: 'use-arc/SKILL.md', compact: true },
	]
	const loaded = files
		.map((file) => ({ ...file, resolved: resolve(root, file.path) }))
		.filter((file) => existsSync(file.resolved))
		.map((file) => file.compact ? compact(readFileSync(file.resolved, 'utf8')) : readFileSync(file.resolved, 'utf8').slice(0, 14_000))
	if (loaded.length !== files.length) throw new Error(`Circle skills are missing under ${root}; run circle skill install --tool codex`)
	return loaded.join('\n\n')
}
