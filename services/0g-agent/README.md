# 0G Agent

Generates a compact 0G project scaffold with `0GM-1.0-35B-A3B` on 0G Private Computer. It loads the official `0gfoundation/0g-agent-skills` checkout and selects the relevant scaffold, Compute, Storage, or Chain guidance for the job.

The service creates reviewable source only. It never funds accounts, acknowledges providers, deploys, or uses buyer credentials.

```bash
git clone --depth 1 https://github.com/0gfoundation/0g-agent-skills.git ../../.0g-skills
cp .env.example .env
bun install
bun run src/main.ts <jobId>
```
