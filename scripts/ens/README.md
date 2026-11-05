# ENSv2 scripts (planned)

On Sepolia: register `semanticquorum.eth`, create the seller and judge-pool subnames
(`laya-1..3`, `vela-1..3.judges.semanticquorum.eth`), set text records (`sq.settlement`,
`sq.reportKey`, `sq.profile`, `sq.endpoint`, `sq.chain`), and resolve them when a job is registered.
Settlement never reads ENS live; the resolved committee is frozen into the participant snapshot.
