// bun run src/main.ts <jobId>
import { makeArcSubmitter } from './arc.ts'
import { loadConfig } from './config.ts'
import { runSeller } from './seller.ts'

const jobId = process.argv[2]
if (!jobId || !/^\d+$/.test(jobId)) throw new Error('usage: bun run src/main.ts <jobId>')
const cfg = loadConfig()
const submit = cfg.submit === 'arc' && cfg.arc.key ? makeArcSubmitter({ ...cfg.arc, key: cfg.arc.key }) : undefined
console.log(JSON.stringify(await runSeller(cfg, jobId, { submit }), null, 2))
