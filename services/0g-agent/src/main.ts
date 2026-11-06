import { makeArcSubmitter } from '../../seller/src/arc.ts'
import { loadConfig } from '../../seller/src/config.ts'
import { run0gAgent } from './agent.ts'

const jobId = process.argv[2]
if (!jobId || !/^\d+$/.test(jobId)) throw new Error('usage: bun run src/main.ts <jobId>')
const config = loadConfig()
const submit = config.submit === 'arc' && config.arc.key ? makeArcSubmitter({ ...config.arc, key: config.arc.key }) : undefined
console.log(JSON.stringify(await run0gAgent(config, jobId, { submit }), null, 2))
