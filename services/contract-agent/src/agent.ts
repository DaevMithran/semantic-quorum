import type { Policy } from '../../../cre/src/protocol/types.ts'
import { runWorker } from '../../agent-runtime/src/run.ts'
import type { Config } from '../../seller/src/config.ts'
import { circleSkillContext } from './skills.ts'

const skills = circleSkillContext()

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
	if (/@openzeppelin\/contracts/i.test(text) && !/@openzeppelin\/contracts["']?\s*:\s*["'](?:\^|~)?4\.9\.6["']/i.test(text)) {
		return 'OpenZeppelin imports require a visible package manifest pinned to @openzeppelin/contracts 4.9.6'
	}
	if (!/@circle-fin\/smart-contract-platform/i.test(text) || !/initiateSmartContractPlatformClient/i.test(text) || !/\.deployContract\s*\(/i.test(text)) {
		return 'missing an executable Circle Smart Contract Platform bytecode deployment script'
	}
	if (!/evmVersion["']?\s*:\s*["']paris["']/i.test(text)) return 'missing build configuration with evmVersion set to paris'
	return undefined
}

export const contractProfile = {
	name: 'Contract Agent',
	artifactLabel: 'contract artifact',
	validateArtifact: validateContractArtifact,
	system: (_policy: Policy) => `You are Contract Agent, a narrow contract-project generator running through 0G Private Computer.
Follow the installed Circle and Arc skills below. Default to Arc Testnet. Never deploy, sign, move funds, request a secret, or claim an audit. Target evmVersion paris for Arc compatibility.

The deliverable MUST contain the actual implementation, not merely an approach, a Circle template ID, parameters, a checklist, or instructions to create it elsewhere. For every Solidity request, include at least one complete compile-ready .sol file from pragma through the final closing brace. For this demo, use OpenZeppelin Contracts 4.9.6 consistently when OpenZeppelin is needed; do not mix v4 and v5 APIs. Set evmVersion to paris in Hardhat/Foundry configuration—NEVER write a pragma evmVersion statement, which is invalid Solidity. State exact dependency versions and include every project-owned source file.

Circle integration must be executable, not a prose claim. Include a complete server-side TypeScript deployment file using @circle-fin/smart-contract-platform, initiateSmartContractPlatformClient, and deployContract with compiled ABI/bytecode, ARC-TESTNET, a fresh UUID idempotency key where applicable, environment variables for secrets, and asynchronous status checking. Follow the installed deploy-bytecode reference. Include package.json and the build configuration. Never place placeholder Solidity or duplicate the same source file in the HTML.

Return ONE complete self-contained HTML document with inline CSS and no scripts or external assets. Put filenames and their complete contents in escaped <pre> blocks so they are visible to evaluators. Include a short network/config section and explicit "Deployment requires buyer approval" after the files. Keep commentary compact, but NEVER truncate code to meet a prose limit. No prose outside HTML.

INSTALLED CIRCLE SKILLS:
${skills}`,
}

export const runContractAgent = (cfg: Config, jobId: string, deps: Parameters<typeof runWorker>[3] = {}) => runWorker(contractProfile, cfg, jobId, deps)
