// A deterministic chaos-test worker for the live demo. It intentionally makes no
// model request, so proving the refund path never burns the team's 0G credits.

export {}

const jobId = process.argv[2]
if (!jobId || !/^\d+$/.test(jobId)) throw new Error('usage: bun run src/main.ts <jobId>')

console.log(`job ${jobId}: Failure Agent accepted the queued work`)
await new Promise((resolve) => setTimeout(resolve, 900))
console.error('0G upstream returned 502 Bad Gateway (intentional Semantic Quorum failure demo)')
await new Promise((resolve) => setTimeout(resolve, 400))
process.exit(42)
