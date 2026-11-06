import type { Policy } from '../../../cre/src/protocol/types.ts'
import { runWorker } from '../../agent-runtime/src/run.ts'
import type { Config } from '../../seller/src/config.ts'

const visibleText = (html: string) => html
	.replace(/<style[\s\S]*?<\/style>/gi, '')
	.replace(/<[^>]+>/g, ' ')
	.replace(/&lt;/gi, '<')
	.replace(/&gt;/gi, '>')
	.replace(/&amp;/gi, '&')
	.replace(/&quot;/gi, '"')
	.replace(/&#39;|&apos;/gi, "'")

/** Stops template metadata or deployment prose from being treated as a contract deliverable. */
export const validateContractArtifact = (html: string): string | undefined => {
	const text = visibleText(html)
	if (!/pragma\s+solidity\s+[\^~<>=\d.]+\s*;/i.test(text)) return 'missing a Solidity source file with a pragma directive'
	if (!/\b(?:abstract\s+)?contract\s+[A-Za-z_$][\w$]*\b/.test(text)) return 'missing a Solidity contract declaration'
	if (!/\{[\s\S]*\}/.test(text)) return 'Solidity source is incomplete'
	if (/pragma\s+evmVersion/i.test(text)) return 'evmVersion is a build-tool setting, not a valid Solidity pragma'
	return undefined
}

export const contractProfile = {
	name: 'Contract Agent',
	artifactLabel: 'contract artifact',
	validateArtifact: validateContractArtifact,
	system: (_policy: Policy) => `You are Contract Agent, a narrow Solidity generator running through the 0G Router.
Write the requested contract for Arc Testnet. Never deploy, sign, move funds, request a secret, or claim an audit.

The deliverable MUST contain one complete Solidity source file from its pragma through the final closing brace. Do not substitute a template ID, checklist, deployment script, instructions, placeholder code, or prose. For ERC standards, use OpenZeppelin Contracts 4.9.6 imports and APIs consistently. Use Solidity syntax compatible with the Paris EVM; NEVER write a pragma evmVersion statement.

Return ONE small self-contained HTML document with no scripts or external assets. Show the filename and put the complete escaped Solidity source in a <pre> block so evaluators can read it. Add only a one-sentence note that deployment requires buyer approval. No prose outside HTML.`,
}

export const runContractAgent = (cfg: Config, jobId: string, deps: Parameters<typeof runWorker>[3] = {}) => runWorker(contractProfile, cfg, jobId, deps)
