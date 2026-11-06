import { makeArcSubmitter } from '../../seller/src/arc.ts'
import { loadConfig } from '../../seller/src/config.ts'
import { runContractAgent } from './agent.ts'

const jobId = process.argv[2]
if (!jobId || !/^\d+$/.test(jobId)) throw new Error('usage: bun run src/main.ts <jobId>')
const config = loadConfig()
const submit = config.submit === 'arc' && config.arc.key ? makeArcSubmitter({ ...config.arc, key: config.arc.key }) : undefined
const result = await runContractAgent(config, jobId, { submit })
console.log(JSON.stringify(result, null, 2))
if (result.status === 'OUT_OF_ROUNDS') process.exitCode = 1
