import { describe, expect, test } from 'bun:test'
import { contractProfile, validateContractArtifact } from '../src/agent.ts'

describe('Contract Agent', () => {
	test('loads the focused Solidity guardrails', () => {
		const system = contractProfile.system({} as never)
		expect(system).toContain('Arc Testnet')
		expect(system).toContain('one complete Solidity source file')
		expect(system).toContain('OpenZeppelin Contracts 4.9.6')
		expect(system).toContain('deployment requires buyer approval')
	})

	test('rejects template metadata without Solidity source', () => {
		const artifact = '<html><body><pre>{ &quot;templateId&quot;: &quot;abc&quot; }</pre><p>Deploy this ERC-721 template.</p></body></html>'
		expect(validateContractArtifact(artifact)).toContain('pragma')
	})

	test('accepts a complete escaped Solidity source file', () => {
		const artifact = `<html><body>
		<pre>pragma solidity ^0.8.20; import "@openzeppelin/contracts/token/ERC721/ERC721.sol"; contract MyNFT is ERC721 { constructor() ERC721("MyNFT", "MNFT") {} }</pre>
		</body></html>`
		expect(validateContractArtifact(artifact)).toBeUndefined()
	})

	test('rejects invalid EVM pragmas', () => {
		const artifact = '<html><body><pre>pragma solidity ^0.8.20; pragma evmVersion paris; contract MyNFT {}</pre><p>Compatible with the Circle ecosystem.</p></body></html>'
		expect(validateContractArtifact(artifact)).toContain('not a valid Solidity pragma')
	})

	test('does not discard an otherwise complete artifact just because source is repeated for presentation', () => {
		const source = 'pragma solidity ^0.8.20; contract MyNFT {}'
		const artifact = `<html><body><pre>${source}</pre><pre>${source}</pre></body></html>`
		expect(validateContractArtifact(artifact)).toBeUndefined()
	})
})
