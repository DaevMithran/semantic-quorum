import { describe, expect, test } from 'bun:test'
import { contractProfile, validateContractArtifact } from '../src/agent.ts'

describe('Contract Agent', () => {
	test('loads Circle guardrails', () => {
		const system = contractProfile.system({} as never)
		expect(system).toContain('Arc Testnet')
		expect(system).toContain('Deployment requires buyer approval')
		expect(system).toContain('NEVER hardcode')
		expect(system).toContain('actual implementation')
		expect(system).toContain('complete compile-ready .sol file')
	})

	test('rejects template metadata without Solidity source', () => {
		const artifact = '<html><body><pre>{ &quot;templateId&quot;: &quot;abc&quot; }</pre><p>Deploy this ERC-721 template.</p></body></html>'
		expect(validateContractArtifact(artifact)).toContain('pragma')
	})

	test('accepts a complete escaped Solidity source file', () => {
		const artifact = `<html><body>
		<pre>{ "dependencies": { "@circle-fin/smart-contract-platform": "10.8.1" }, "devDependencies": { "@openzeppelin/contracts": "4.9.6" } }</pre>
		<pre>pragma solidity ^0.8.20; import "@openzeppelin/contracts/token/ERC721/ERC721.sol"; contract MyNFT is ERC721 { constructor() ERC721("MyNFT", "MNFT") {} }</pre>
		<pre>export default { solidity: { version: "0.8.20", settings: { evmVersion: "paris" } } }</pre>
		<pre>import { initiateSmartContractPlatformClient } from "@circle-fin/smart-contract-platform"; const client = initiateSmartContractPlatformClient({ apiKey: process.env.CIRCLE_API_KEY!, entitySecret: process.env.ENTITY_SECRET! }); await client.deployContract({ blockchain: "ARC-TESTNET", abiJson, bytecode });</pre>
		</body></html>`
		expect(validateContractArtifact(artifact)).toBeUndefined()
	})

	test('rejects invalid EVM pragmas and prose-only Circle integration', () => {
		const artifact = '<html><body><pre>pragma solidity ^0.8.20; pragma evmVersion paris; contract MyNFT {}</pre><p>Compatible with the Circle ecosystem.</p></body></html>'
		expect(validateContractArtifact(artifact)).toContain('not a valid Solidity pragma')
	})

	test('does not discard an otherwise complete artifact just because source is repeated for presentation', () => {
		const source = 'pragma solidity ^0.8.20; contract MyNFT {}'
		const artifact = `<html><body><pre>{ "dependencies": { "@circle-fin/smart-contract-platform": "10.8.1" } }</pre><pre>${source}</pre><pre>${source}</pre><pre>export default { solidity: { settings: { evmVersion: "paris" } } }</pre><pre>import { initiateSmartContractPlatformClient } from "@circle-fin/smart-contract-platform"; const client = initiateSmartContractPlatformClient({}); client.deployContract({ blockchain: "ARC-TESTNET" });</pre></body></html>`
		expect(validateContractArtifact(artifact)).toBeUndefined()
	})
})
