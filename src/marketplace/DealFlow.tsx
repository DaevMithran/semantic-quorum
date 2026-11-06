import { useEffect, useMemo, useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { ArrowLeft, ArrowRight, Bot, Check, Code2, ExternalLink, MonitorSmartphone, Plus, Sparkles, Trash2, TriangleAlert } from 'lucide-react'
import type { Address, Hex } from 'viem'
import { arcTestnet } from 'viem/chains'
import { useAccount, useDisconnect, useSendTransaction, useSwitchChain } from 'wagmi'
import { lintCriterion, LIMITS } from '../town/lint'
import { COORDINATOR } from '../town/sources'
import type { Criterion, Policy } from '../town/types'

type Call = { label: string; to: Address; data: Hex; value: string }
type Judge = { evaluatorId: string; profileId: string; model: string; provider?: '0g' | 'jev'; name?: string; description?: string; defaultSelected?: boolean; reportKey?: string; feeRecipient?: string }
type Seller = { id: string; ens: string; name: string; model: string; runtime: string; skills: string[] }
type Catalog = { sellers: Seller[]; judges: Judge[] }

const stepNames = ['Agent', 'Describe', 'Rubric', 'Evaluators', 'Review & fund', 'Live deal']

async function jsonPost<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(`${COORDINATOR}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
	const payload = (await response.json()) as T & { error?: string; problems?: string[] }
	if (!response.ok) throw new Error(payload.problems?.join(' ') ?? payload.error ?? `Coordinator answered ${response.status}`)
	return payload
}

export function DealFlow({ initialTask, initialSellerId, resumeJobId, onBack, onOpenLive }: { initialTask: string; initialSellerId?: string; resumeJobId?: string; onBack: () => void; onOpenLive: (jobId: string) => void }) {
	const [step, setStep] = useState(resumeJobId ? 5 : 1)
	const [task, setTask] = useState(initialTask)
	const [sellerId, setSellerId] = useState(initialSellerId ?? '')
	const [policy, setPolicy] = useState<Policy>()
	const [catalog, setCatalog] = useState<Catalog>()
	const [evaluatorIds, setEvaluatorIds] = useState<string[]>([])
	const [budget, setBudget] = useState('0.5')
	const [drafting, setDrafting] = useState(false)
	const [funding, setFunding] = useState(false)
	const [fundEvent, setFundStatus] = useState('')
	const fundStatus = funding ? 'Processing…' : fundEvent
	const [jobId, setJobId] = useState<string>()
	const [error, setError] = useState<string>()
	const [draftNotice, setDraftNotice] = useState<string>()
	const { address, isConnected, chainId, connector } = useAccount()
	const { disconnect } = useDisconnect()
	const { sendTransactionAsync } = useSendTransaction()
	const { switchChainAsync } = useSwitchChain()

	useEffect(() => {
		if (!resumeJobId) return
		void jsonPost<{ stage: 'created' | 'funded' | 'registered'; calls: Call[] }>(`/deals/${resumeJobId}/resume`, {})
			.then(async (next) => {
				if (next.stage === 'registered') {
					// The wallet transaction may have landed even if the browser missed the
					// final callback. Reconcile the coordinator without asking for payment again.
					await jsonPost(`/deals/${resumeJobId}/registered`, {})
					setJobId(resumeJobId)
					setStep(6)
				}
			})
			.catch(() => { /* The explicit resume action shows any setup error. */ })
	}, [resumeJobId])

	useEffect(() => {
		if (catalog) return
		fetch(`${COORDINATOR}/agents`)
			.then(async (response) => {
				if (!response.ok) throw new Error('catalog unavailable')
				const next = (await response.json()) as Catalog
				setCatalog(next)
				setEvaluatorIds((current) => current.length ? current : next.judges.filter((judge) => judge.defaultSelected ?? judge.provider !== 'jev').map((judge) => judge.evaluatorId))
			})
			.catch(() => setCatalog({ sellers: [], judges: [
				{ evaluatorId: 'laya', profileId: '0g-laya-teeml-v1', model: 'laya', provider: '0g', defaultSelected: true },
				{ evaluatorId: 'vela', profileId: '0g-vela-teeml-v1', model: 'vela-2.0-9b', provider: '0g', defaultSelected: true },
			] }))
	}, [catalog])

	useEffect(() => {
		if (!catalog || evaluatorIds.length) return
		setEvaluatorIds(catalog.judges.filter((judge) => judge.defaultSelected ?? judge.provider !== 'jev').map((judge) => judge.evaluatorId))
	}, [catalog, evaluatorIds.length])

	const criteria = policy?.criteria ?? []
	const feeEstimate = useMemo(() => ((policy?.revisionLimit ?? 2) + 1) * evaluatorIds.length * 0.01, [policy?.revisionLimit, evaluatorIds.length])

	const draftRubric = async () => {
		if (task.trim().length < 3) return
		setDrafting(true)
		setError(undefined)
		setDraftNotice(undefined)
		try {
			const result = await jsonPost<{ policy: Policy; draftWarning?: string }>('/rubric/draft', { task: task.trim(), sellerId })
			setPolicy(result.policy)
			setDraftNotice(result.draftWarning)
			setStep(3)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Could not draft the rubric.')
		} finally {
			setDrafting(false)
		}
	}

	const updateCriterion = (index: number, patch: Partial<Criterion>) => setPolicy((current) => current ? { ...current, criteria: current.criteria.map((criterion, i) => i === index ? { ...criterion, ...patch } : criterion) } : current)
	const removeCriterion = (index: number) => setPolicy((current) => current ? { ...current, criteria: current.criteria.filter((_, i) => i !== index) } : current)
	const addCriterion = () => setPolicy((current) => current ? { ...current, criteria: [...current.criteria, { id: `c${current.criteria.length + 1}`, statement: '', must: true }] } : current)

	const normalizedPolicy = (): Policy => {
		if (!policy) throw new Error('Draft the rubric first.')
		return { ...policy, brief: policy.brief?.trim(), criteria: policy.criteria.map((criterion, index) => ({ ...criterion, id: `c${index + 1}`, statement: criterion.statement.trim() })) }
	}

	const sendCalls = async (calls: Call[]) => {
		let lastHash: Hex | undefined
		for (const call of calls) {
			setFundStatus(call.label)
			lastHash = await sendTransactionAsync({ to: call.to, data: call.data, value: BigInt(call.value || '0'), chainId: arcTestnet.id })
			setFundStatus(`Confirming: ${call.label}`)
			await jsonPost('/deals/wait', { txHash: lastHash })
		}
		if (!lastHash) throw new Error('The coordinator returned no wallet call.')
		return lastHash
	}

	const authorizeWalletAccount = async () => {
		if (!address || !connector) throw new Error('Connect the wallet that will fund this job.')
		const provider = await connector.getProvider()
		if (!provider || typeof provider !== 'object' || !('request' in provider)) throw new Error('The connected wallet does not expose an EIP-1193 provider.')
		const accounts = await (provider as { request: (args: { method: string }) => Promise<unknown> }).request({ method: 'eth_requestAccounts' })
		if (!Array.isArray(accounts) || !accounts.some((account) => typeof account === 'string' && account.toLowerCase() === address.toLowerCase())) {
			throw new Error(`Authorize account ${address} in your wallet, then reconnect it.`)
		}
	}

	const fundDeal = async () => {
		if (!address) return
		setFunding(true)
		setError(undefined)
		try {
			setFundStatus('Confirming wallet authorization')
			await authorizeWalletAccount()
			if (chainId !== arcTestnet.id) {
				setFundStatus('Switching to Arc Testnet')
				await switchChainAsync({ chainId: arcTestnet.id })
			}
			const finalPolicy = normalizedPolicy()
			setFundStatus('Preparing the ERC-8183 job')
			const prepared = await jsonPost<{ prepId: string; chainId: number; calls: Call[] }>('/deals/prepare', { task: task.trim(), sellerId, evaluatorIds, policy: finalPolicy, budgetUsdc: budget, buyer: address })
			const createHash = await sendCalls(prepared.calls)
			const created = await jsonPost<{ jobId: string; calls: Call[] }>(`/deals/${prepared.prepId}/created`, { txHash: createHash })
			setJobId(created.jobId)
			await sendCalls(created.calls)
			const registration = await jsonPost<{ calls: Call[] }>(`/deals/${created.jobId}/register-call`, {})
			const registerHash = await sendCalls(registration.calls)
			setFundStatus('Publishing the job to the queue')
			await jsonPost(`/deals/${created.jobId}/registered`, { txHash: registerHash })
			setJobId(created.jobId)
			setStep(6)
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : 'The deal could not be funded.'
			if (/not (?:been )?authorized|account.*authorized|unauthorized|code.?4100/i.test(message)) {
				disconnect()
				setError('Your wallet session no longer authorizes this account. Reconnect the wallet, confirm the same account, and try funding again. No escrow was created and no funds moved.')
			} else setError(message)
		} finally {
			setFunding(false)
		}
	}

	const resumeFunding = async (targetJobId = resumeJobId) => {
		if (!address || !targetJobId) return
		setFunding(true)
		setError(undefined)
		try {
			setFundStatus('Confirming wallet authorization')
			await authorizeWalletAccount()
			if (chainId !== arcTestnet.id) {
				setFundStatus('Switching to Arc Testnet')
				await switchChainAsync({ chainId: arcTestnet.id })
			}
			let next = await jsonPost<{ stage: 'created' | 'funded' | 'registered'; calls: Call[] }>(`/deals/${targetJobId}/resume`, {})
			if (next.stage === 'created') {
				await sendCalls(next.calls)
				next = await jsonPost<{ stage: 'funded' | 'registered'; calls: Call[] }>(`/deals/${targetJobId}/resume`, {})
			}
			let registerHash: Hex | undefined
			if (next.stage === 'funded') registerHash = await sendCalls(next.calls)
			await jsonPost(`/deals/${targetJobId}/registered`, registerHash ? { txHash: registerHash } : {})
			setJobId(targetJobId)
			setStep(6)
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : 'The deal could not resume.'
			if (/not (?:been )?authorized|account.*authorized|unauthorized|code.?4100/i.test(message)) {
				disconnect()
				setError('Your wallet session no longer authorizes this account. Reconnect the wallet and resume this job again.')
			} else setError(message)
		} finally {
			setFunding(false)
		}
	}

	return (
		<main className="deal-flow">
			<header className="flow-heading">
				<div><button type="button" onClick={step === 1 ? onBack : () => setStep((current) => Math.max(1, current - 1))}><ArrowLeft size={15} /> {step === 1 ? 'Marketplace' : 'Back'}</button><span className="market-kicker">NEW VERIFIED DEAL</span><h1>{['Choose an agent', 'Describe the work', 'Build the ideal rubric', 'Select evaluators', 'Review and fund', 'Your deal is live'][step - 1]}</h1></div>
				<span className="draft-state">{funding ? 'Processing deal…' : 'Draft saved locally'}</span>
			</header>

			<ol className="flow-progress" aria-label="Deal creation progress">
				{stepNames.map((name, index) => <li className={index + 1 === step ? 'current' : index + 1 < step ? 'done' : ''} key={name}><span>{index + 1 < step ? <Check size={13} /> : index + 1}</span><b>{name}</b></li>)}
			</ol>

			<div className="flow-layout">
				<section className="flow-panel">
					{step === 1 && <AgentStep sellers={catalog?.sellers ?? []} selected={sellerId} onSelect={setSellerId} />}
					{step === 2 && <DescribeStep task={task} setTask={setTask} budget={budget} setBudget={setBudget} />}
					{step === 3 && policy && <RubricStep policy={policy} notice={draftNotice} setPolicy={setPolicy} updateCriterion={updateCriterion} removeCriterion={removeCriterion} addCriterion={addCriterion} />}
					{step === 4 && <EvaluatorsStep judges={catalog?.judges ?? []} selected={evaluatorIds} onChange={setEvaluatorIds} />}
					{step === 5 && resumeJobId ? <ResumeStep jobId={resumeJobId} /> : step === 5 && policy && <ReviewStep task={task} policy={policy} budget={budget} feeEstimate={feeEstimate} seller={catalog?.sellers.find((seller) => seller.id === sellerId)} judges={(catalog?.judges ?? []).filter((judge) => evaluatorIds.includes(judge.evaluatorId))} />}
					{step === 6 && jobId && <><LiveStep jobId={jobId} onOpen={() => onOpenLive(jobId)} /><DealProofs jobId={jobId} /></>}

					{error && <p className="flow-error" role="alert">{error}</p>}
					{step < 6 && <footer className="flow-actions"><button className="market-secondary" type="button" onClick={resumeJobId ? onBack : step === 1 ? onBack : () => setStep(step - 1)}>Back</button>{resumeJobId ? isConnected ? <button className="market-primary" type="button" disabled={funding} onClick={() => void resumeFunding()}>{funding ? fundStatus : `Resume job #${resumeJobId}`} <ArrowRight size={15} /></button> : <ConnectKitButton.Custom>{({ show }) => <button className="market-primary" type="button" onClick={show}>Connect wallet to resume <ArrowRight size={15} /></button>}</ConnectKitButton.Custom> : step === 1 ? <button className="market-primary" type="button" disabled={!sellerId} onClick={() => setStep(2)}>Describe work <ArrowRight size={15} /></button> : step === 2 ? <button className="market-primary" type="button" disabled={drafting || task.trim().length < 3} onClick={draftRubric}>{drafting ? 'Drafting rubric…' : 'Generate rubric'} <ArrowRight size={15} /></button> : step === 3 ? <button className="market-primary" type="button" disabled={!criteria.length || criteria.some((criterion) => !criterion.statement.trim())} onClick={() => setStep(4)}>Select evaluators <ArrowRight size={15} /></button> : step === 4 ? <button className="market-primary" type="button" disabled={!evaluatorIds.length} onClick={() => setStep(5)}>Review deal <ArrowRight size={15} /></button> : jobId && isConnected ? <button className="market-primary" type="button" disabled={funding} onClick={() => void resumeFunding(jobId)}>{funding ? fundStatus : `Recover job #${jobId}`} <ArrowRight size={15} /></button> : isConnected ? <button className="market-primary" type="button" disabled={funding} onClick={fundDeal}>{funding ? fundStatus : `Fund ${budget} USDC`} <ArrowRight size={15} /></button> : <ConnectKitButton.Custom>{({ show }) => <button className="market-primary" type="button" onClick={show}>Connect wallet to fund <ArrowRight size={15} /></button>}</ConnectKitButton.Custom>}</footer>}
				</section>

				<SetupEvents jobId={resumeJobId ?? jobId} activeStatus={funding ? fundEvent : undefined} />
			</div>
		</main>
	)
}

const agentIcon = (id: string) => id === 'page-agent' ? MonitorSmartphone : id === 'contract-agent' ? Code2 : id === 'failure-agent' ? TriangleAlert : Bot

function AgentStep({ sellers, selected, onSelect }: { sellers: Seller[]; selected: string; onSelect: (id: string) => void }) {
	return <div className="step-content"><header className="step-header"><div><b>Choose who will do the work</b><small>The selected service is committed to the deal before the rubric is created.</small></div><span>{sellers.length} available</span></header><div className="agent-choice-grid">{sellers.map((seller) => { const Icon = agentIcon(seller.id); return <button type="button" className={selected === seller.id ? 'selected' : ''} key={seller.id} onClick={() => onSelect(seller.id)}><i><Icon size={23} /></i><span><b>{seller.name}</b><small>{seller.model}</small><em>{seller.runtime}</em></span>{selected === seller.id && <strong><Check size={13} /> Selected</strong>}</button> })}</div></div>
}

function DescribeStep({ task, setTask, budget, setBudget }: { task: string; setTask: (value: string) => void; budget: string; setBudget: (value: string) => void }) {
	return <div className="step-content describe-step"><label><span>What should the agent deliver?</span><textarea value={task} onChange={(event) => setTask(event.target.value)} placeholder="Describe the outcome, audience and delivery format…" maxLength={2000} /></label><div className="flow-fields"><label><span>Reward</span><div className="suffix-input"><input inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} /><b>USDC</b></div></label><label><span>Marketplace</span><input value="Arc AgenticCommerce · ERC-8183" readOnly /></label></div><div className="assistant-note"><Sparkles size={18} /><p><b>Private rubric assistant</b><span>0G will turn this brief into atomic, testable criteria. You review every line before funding.</span></p></div></div>
}

function RubricStep({ policy, notice, setPolicy, updateCriterion, removeCriterion, addCriterion }: { policy: Policy; notice?: string; setPolicy: (policy: Policy) => void; updateCriterion: (index: number, patch: Partial<Criterion>) => void; removeCriterion: (index: number) => void; addCriterion: () => void }) {
	return <div className="step-content"><header className="step-header"><div><b>{notice ? 'Editable starter rubric' : 'AI-generated rubric'}</b><small>Review and edit before evaluators see it</small></div><span>{policy.criteria.length}/{LIMITS.maxCriteria} criteria</span></header>{notice && <div className="assistant-note"><Sparkles size={18} /><p><b>0G temporarily unavailable</b><span>{notice}</span></p></div>}<div className="rubric-settings"><label className="rubric-brief"><span>Short brief</span><input value={policy.brief ?? ''} maxLength={LIMITS.maxBriefChars} onChange={(event) => setPolicy({ ...policy, brief: event.target.value })} /></label><label className="revision-setting"><span>Allowed revisions</span><select value={policy.revisionLimit} onChange={(event) => setPolicy({ ...policy, revisionLimit: Number(event.target.value) })}><option value={0}>0 · reject immediately</option><option value={1}>1 revision</option><option value={2}>2 revisions</option><option value={3}>3 revisions</option></select><small>Escrow stays funded during REVISE.</small></label></div><div className="rubric-list">{policy.criteria.map((criterion, index) => { const hints = lintCriterion(criterion.statement); return <div className="rubric-item" key={`${criterion.id}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><div><input aria-label={`Criterion ${index + 1}`} value={criterion.statement} maxLength={LIMITS.maxStatementChars} onChange={(event) => updateCriterion(index, { statement: event.target.value })} />{hints.map((hint) => <small key={hint}>{hint}</small>)}</div><label><input type="checkbox" checked={criterion.must} onChange={(event) => updateCriterion(index, { must: event.target.checked })} /> Required</label><button type="button" aria-label={`Remove criterion ${index + 1}`} onClick={() => removeCriterion(index)}><Trash2 size={14} /></button></div> })}</div>{policy.criteria.length < LIMITS.maxCriteria && <button className="add-criterion" type="button" onClick={addCriterion}><Plus size={14} /> Add criterion</button>}</div>
}

function EvaluatorsStep({ judges, selected, onChange }: { judges: Judge[]; selected: string[]; onChange: (ids: string[]) => void }) {
	const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id])
	return <div className="step-content"><header className="match-heading"><span><Sparkles size={18} /></span><div><b>Choose evaluator services</b><small>0G decision models are matched by default; use one or build a mixed committee.</small></div></header><div className="evaluator-list selectable">{judges.map((judge) => { const name = judge.name ?? (judge.provider === 'jev' ? 'JEV' : judge.model.toLowerCase().includes('vela') ? 'Vela' : 'Laya'); const active = selected.includes(judge.evaluatorId); return <article className={active ? 'selected' : ''} key={judge.evaluatorId} onClick={() => toggle(judge.evaluatorId)}><i className={judge.provider === 'jev' ? 'jev' : name === 'Laya' ? 'laya' : 'vela'}>{name[0]}</i><div><b>{name}</b><small>{judge.model} · {judge.provider === 'jev' ? 'Typesafe JEV' : '0G Private Computer'}</small><p>{judge.description ?? 'Criterion-level and overall semantic evaluation'}</p></div><button type="button" aria-pressed={active} onClick={(event) => { event.stopPropagation(); toggle(judge.evaluatorId) }}>{active ? <><Check size={13} /> Selected</> : 'Add'}</button></article> })}</div><p className="evaluator-note">{selected.length || 0} evaluator{selected.length === 1 ? '' : 's'} selected. Each included evaluator earns one report fee per verdict round; the frozen onchain committee controls payout.</p></div>
}

function ReviewStep({ task, policy, budget, feeEstimate, seller, judges }: { task: string; policy: Policy; budget: string; feeEstimate: number; seller?: Seller; judges: Judge[] }) {
	const names = judges.map((judge) => judge.name ?? judge.model).join(' + ')
	const runtimes = [...new Set(judges.map((judge) => judge.provider === 'jev' ? 'JEV' : '0G'))].join(' + ')
	return <div className="step-content"><div className="review-grid"><div><small>AGENT</small><b>{seller?.name ?? 'Selected agent'}</b><span>{seller?.model ?? 'Marketplace service'}</span></div><div><small>WORK</small><b>{policy.brief || task}</b><span>{policy.criteria.length} rubric criteria · {policy.revisionLimit} revisions</span></div><div><small>EVALUATORS</small><b>{names}</b><span>{runtimes} · {judges.length} paid report{judges.length === 1 ? '' : 's'} per round</span></div><div><small>ESCROW</small><b>{budget} USDC</b><span>Arc ERC-8183 · AgenticCommerce</span></div><div><small>FINALIZATION</small><b>Chainlink CRE</b><span>Deterministic signed quorum verdict</span></div></div><div className="review-total"><span><b>Buyer authorizes five transactions</b><small>Create, approve reward, fund, approve fees, register policy</small></span><strong>{budget} USDC <small>+ up to {feeEstimate.toFixed(2)} evaluator fees</small></strong></div></div>
}

function ResumeStep({ jobId }: { jobId: string }) {
	return <div className="step-content"><div className="review-grid"><div><small>RECOVERED ARC JOB</small><b>Job #{jobId}</b><span>The createJob transaction is already confirmed.</span></div><div><small>NEXT STEP</small><b>Resume from on-chain state</b><span>The coordinator will request only the remaining approvals and transactions.</span></div><div><small>SAFETY</small><b>No duplicate job</b><span>Arc status is checked before each wallet call.</span></div><div><small>SETTLEMENT</small><b>ERC-8183 + SQController</b><span>Fund escrow, deposit evaluator fees, then register the policy.</span></div></div></div>
}

type SetupEvent = { id: string; label: string; detail: string; done: boolean }

function SetupEvents({ jobId, activeStatus }: { jobId?: string; activeStatus?: string }) {
	const [events, setEvents] = useState<SetupEvent[]>([])
	useEffect(() => {
		setEvents([])
		if (!jobId) return
		let stopped = false
		const load = async () => {
			try {
				const response = await fetch(`${COORDINATOR}/deals/${jobId}/setup`)
				if (response.ok && !stopped) setEvents(((await response.json()) as { events: SetupEvent[] }).events)
			} catch { /* the resume action still reports actionable errors */ }
		}
		void load()
		const timer = window.setInterval(load, 2000)
		return () => { stopped = true; window.clearInterval(timer) }
	}, [jobId])
	return <aside className="trust-panel setup-events"><span className="market-kicker">EVENTS</span>{activeStatus && <div className="event-active"><i>•••</i><p><b>{activeStatus}</b><small>Waiting for wallet or network confirmation</small></p></div>}{events.map((event, index) => <div key={event.id}><i className={event.done ? 'trust-arc' : ''}>{event.done ? <Check size={13} /> : index + 1}</i><p><b>{event.label}</b><small>{event.detail}</small></p></div>)}</aside>
}

function DealProofs({ jobId }: { jobId: string }) {
	type Outcome = { phase: 'draft' | 'final'; status: string; txHash?: string; deliveredVia?: string; at?: string }
	type ProofState = { submitTx?: string; outcome?: Outcome }
	const [proof, setProof] = useState<ProofState>({})
	useEffect(() => {
		let stopped = false
		const load = async () => {
			try {
				const response = await fetch(`${COORDINATOR}/deals/${jobId}`)
				if (!response.ok || stopped) return
				const snapshot = await response.json() as { deal?: { txs?: Record<string, string> }; rounds?: { outcomes?: Outcome[] }[] }
				const outcomes = snapshot.rounds?.flatMap((round) => round.outcomes ?? []).filter((outcome) => outcome.phase === 'final') ?? []
				setProof({ submitTx: snapshot.deal?.txs?.submit, outcome: outcomes.at(-1) })
			} catch { /* The live status panel reports coordinator connectivity. */ }
		}
		void load()
		const timer = window.setInterval(load, 2000)
		return () => { stopped = true; window.clearInterval(timer) }
	}, [jobId])
	const txLink = (hash?: string) => hash && !/^0x0{64}$/i.test(hash) ? `https://explorer.testnet.arc.io/tx/${hash}` : undefined
	const submitLink = txLink(proof.submitTx)
	const settlementLink = txLink(proof.outcome?.txHash)
	return <section className="deal-proofs"><span>CHAINLINK + ARC PROOFS</span><div className="deal-proof-row"><div><b>Agent submission on Arc</b><small>{submitLink ? 'Deliverable hash submitted to ERC-8183' : 'Appears after the agent submits the passing attempt'}</small></div>{submitLink && <a href={submitLink} target="_blank" rel="noreferrer">Explorer <ExternalLink size={11} /></a>}</div><div className="deal-proof-row"><div><b>Chainlink CRE verdict</b><small>{proof.outcome ? settlementLink ? `${proof.outcome.status} · settled onchain` : `${proof.outcome.status} · simulation proof only, not broadcast` : 'Waiting for signed evaluator reports'}</small></div>{settlementLink && <a href={settlementLink} target="_blank" rel="noreferrer">Explorer <ExternalLink size={11} /></a>}</div></section>
}

function LiveStep({ jobId, onOpen }: { jobId: string; onOpen: () => void }) {
	type LiveState = { status: 'working' | 'failed' | 'accepted' | 'rejected'; workerActive: boolean; evaluators?: string; workUrl?: string; workRound?: number; detail?: string; revision?: { round: number; limit: number; active: boolean; failed: string[] } }
	const [live, setLive] = useState<LiveState>({ status: 'working', workerActive: true })
	const [retrying, setRetrying] = useState(false)
	useEffect(() => {
		let stopped = false
		const load = async () => {
			try {
				const [dealResponse, eventResponse] = await Promise.all([
					fetch(`${COORDINATOR}/deals/${jobId}`),
					fetch(`${COORDINATOR}/events?jobId=${jobId}&after=0`),
				])
				if (!dealResponse.ok || stopped) return
				const snapshot = (await dealResponse.json()) as { deal?: { status?: string; error?: string; revisionLimit?: number; committee?: { evaluatorId: string }[] }; workerActive?: boolean; rounds?: { round: number; pageUrl?: string | null }[] }
				const deal = snapshot.deal
				const events = eventResponse.ok ? await eventResponse.json() as { step: string; status: string; round?: number; data?: Record<string, unknown> }[] : []
				const logs = events.filter((event) => event.step === 'seller-log').map((event) => String(event.data?.line ?? ''))
				const failureEvaluation = events.findLast((event) => event.step === 'failure-evaluation')
				const revisionEvent = events.findLast((event) => event.step === 'seller-writing' && event.data?.reason === 'revise')
				const revisionIndex = revisionEvent ? events.lastIndexOf(revisionEvent) : -1
				const deliveredIndex = events.findLastIndex((event) => event.step === 'delivered')
				const reviseVerdict = events.findLast((event) => event.step === 'cre' && event.status === 'REVISE')
				const rows = (reviseVerdict?.data?.scorecard as { rows?: { statement?: string; pass?: boolean }[] } | undefined)?.rows ?? []
				const failedRows = rows.filter((row) => row.pass === false).map((row) => row.statement ?? 'Unmet rubric point').slice(0, 3)
				const revision = revisionEvent ? { round: revisionEvent.round ?? 1, limit: deal?.revisionLimit ?? 0, active: revisionIndex > deliveredIndex, failed: failedRows } : undefined
				const gateway = logs.some((line) => /\b502\b|gateway|provider unavailable/i.test(line))
				const detail = deal?.status === 'failed'
					? failureEvaluation?.status === 'failed'
						? 'The worker and evaluator path failed. Escrow stays locked until permissionless timeout rejection.'
						: failureEvaluation
							? `Failure artifact evaluated: ${failureEvaluation.status}. Awaiting onchain settlement.`
							: gateway ? '0G returned a gateway error after retries. Creating a failure artifact for evaluators.' : deal.error
					: revision ? `Revision ${revision.round} of ${revision.limit}: the agent received the signed criterion-level scorecard.` : undefined
				const evaluators = deal?.committee?.map((member) => member.evaluatorId.split('.')[0]?.replace(/-\d+$/, '')).map((name) => name ? name[0]?.toUpperCase() + name.slice(1) : '').join(' + ')
				const latestWork = snapshot.rounds?.filter((round) => round.pageUrl).sort((a, b) => b.round - a.round)[0]
				setLive({ status: (deal?.status as LiveState['status']) ?? 'working', workerActive: snapshot.workerActive ?? false, evaluators, workUrl: latestWork?.pageUrl ? `${COORDINATOR}${latestWork.pageUrl}` : undefined, workRound: latestWork?.round, detail, revision })
			} catch { /* Open live deal still exposes coordinator connectivity errors. */ }
		}
		void load()
		const timer = window.setInterval(load, 1200)
		return () => { stopped = true; window.clearInterval(timer) }
	}, [jobId])

	const failed = live.status === 'failed'
	const settled = live.status === 'accepted' || live.status === 'rejected'
	const stalled = live.status === 'working' && !live.workerActive
	const revising = !!live.revision?.active && !failed && !settled
	const statusLabel = live.status === 'accepted' ? 'Paid' : live.status === 'rejected' ? 'Refunded' : failed ? 'Agent failed' : stalled ? 'Agent stopped' : revising ? 'Revising' : 'Working'
	const title = live.status === 'rejected' ? 'REJECT settled on Arc · buyer refunded' : live.status === 'accepted' ? 'ACCEPT settled on Arc · agent paid' : failed ? 'Worker stopped; escrow is still protected' : stalled ? 'No worker is running for this persisted deal' : revising ? `Agent is revising attempt v${(live.revision?.round ?? 0) + 1}` : 'Registered and published to the job queue'
	const retry = async () => {
		setRetrying(true)
		try {
			await jsonPost(`/deals/${jobId}/retry-worker`, {})
			setLive((current) => ({ ...current, status: 'working', workerActive: true, detail: 'Worker restarted. Waiting for its first event.' }))
		} catch (cause) {
			setLive((current) => ({ ...current, detail: cause instanceof Error ? cause.message : 'Could not restart the worker.' }))
		} finally {
			setRetrying(false)
		}
	}

	return <div className={`step-content live-step ${failed || stalled ? 'failed' : settled ? 'settled' : ''}`}><div className="live-status"><span className="live-dot" /><div><small>LIVE DEAL #{jobId}</small><b>{title}</b>{live.detail && <em>{live.detail}</em>}</div><strong>{statusLabel}</strong></div>{live.revision && <div className="revision-callout"><span>REVISE · ROUND {live.revision.round + 1}</span><b>The escrow stays funded while the agent fixes only the failed rubric points.</b>{live.revision.failed.length > 0 && <ul>{live.revision.failed.map((item) => <li key={item}>{item}</li>)}</ul>}</div>}<div className="live-timeline"><div className="done"><i><Check size={13} /></i><b>Funded</b><small>Arc ERC-8183</small></div><span className="done" /><div className={failed || settled ? 'done' : 'active'}><i>{failed || settled ? <Check size={13} /> : 2}</i><b>{failed ? 'Agent failed' : stalled ? 'Agent stopped' : revising ? `Revising v${(live.revision?.round ?? 0) + 1}` : 'Agent working'}</b><small>0G Compute</small></div><span className={settled ? 'done' : ''} /><div className={failed || (!revising && live.revision) ? 'active' : settled ? 'done' : ''}><i>3</i><b>{failed ? 'Failure review' : 'Evaluating'}</b><small>{live.evaluators || 'Selected committee'}</small></div><span className={settled ? 'done' : ''} /><div className={settled ? 'done' : ''}><i>4</i><b>CRE verdict</b><small>Signed quorum</small></div><span className={settled ? 'done' : ''} /><div className={settled ? 'done' : ''}><i>{settled ? <Check size={13} /> : 5}</i><b>{live.status === 'rejected' ? 'Refunded' : 'Settled'}</b><small>{live.status === 'rejected' ? 'Buyer receives USDC' : 'USDC payout'}</small></div></div><div className="live-actions">{(failed || stalled) && <button className="market-secondary" type="button" disabled={retrying} onClick={retry}>{retrying ? 'Restarting…' : 'Retry agent'}</button>}<button className="market-primary" type="button" onClick={onOpen}>Open live deal <ArrowRight size={16} /></button></div></div>
}
