# DAG reliability stabilization plan

Date: 7 October 2026. Status: proposed implementation plan; not a reliability certification.

## 1. Objective and assessment

The orchestrator must carry accepted work through implementation, rejection, repair, verification, publication and restart without repeatedly requiring the operator to reconstruct the incident. Bad work must remain rejected. Useful failures must produce bounded corrective action and preserved evidence.

The current analytics deployment has not demonstrated reliable unattended operation. Passing component tests, frozen contracts and separate reviewers provide useful controls, but the observed manual interventions show that their composition is incomplete. No comparative benchmark against other orchestration tools has been run; a claim of superior reliability is unsupported.

At inspection, analytics run `run_b3a47590` had 60 completed tasks, one running and 103 pending. Its retained event log contained 31 run-start events, 21 task-failure events affecting 12 distinct tasks, 11 interruption events, and 101 deduplicated rejected work attempts across 40 tasks. Event counts are not independent incident counts or a failure-rate estimate. Deduplication used the existing rejection parser, which is itself a migration target.

Verified recent incidents include:

| Failure | Mechanism | Prevention needed |
| --- | --- | --- |
| Python execution-output guard | Worker cwd was treated as output authority despite separate execution roots | Typed producer/consumer contracts and a real composed positive test |
| Browser verification timeout | Completed tests retained inherited output pipes | Owned-process cleanup and verification completion checks |
| Viewer digest mismatch | Consumer expected evidence details omitted by an accepted producer | Downstream contract probes and registered repair ownership |
| Two-hour unsuccessful coordinator loop | Diagnosis identified the viewer, but authorized scope omitted it | Missing-owner requests, typed repair routing and no-progress handling |
| Shutdown/worktree failure | Interrupted processes and partially prepared worktrees needed recovery | Restart testing of the installed supervisor and durable stage receipts |
| Model usage limit | A provider boundary prevented work | Resource-specific suspension and preserved attempt budgets |

The first four have targeted repairs. They still require integration into a consistently tested lifecycle. The prior audit of 104 unfinished units checked structural owner resolution; it did not prove that every producer satisfies its consumer's behavioral expectations.

## 2. Design constraints

- Preserve completed tasks, historical failures, analytical requirements and independently enforced evidence checks.
- Keep the analytics repository separate. Put reusable execution/recovery mechanisms in lightweight DAG and analytics-specific contracts in its adapter.
- Retain the authorized model ladder: Luna xhigh, Sol 6.1 medium, Sol 6.1 xhigh; no Astra. Preserve configured attempt counts and distinguish attempts from extra retries explicitly.
- A plan, diagnosis, model success message or repair publication cannot mark a task accepted.
- Quota waits, environment repair and process restart cannot silently consume or replenish semantic implementation attempts.
- Changes to a running graph require a stopped controller, preserved work, an explicit amendment and supported recovery commands.
- Keep deterministic enforcement small. Extract shared code when the existing analytics consumer exercises it; avoid introducing a new general workflow platform.

## 3. Implement in this order

### R1 — Prove the installed recovery lifecycle

**Owns:** shared recovery kernel, analytics supervisor/adapter, real-process integration fixtures.

Create one test driver that uses the installed CLI, real isolated Git worktrees, actual verifier processes, publication and supported requeue. Use deterministic substitute model responses to inject failure; model nondeterminism must not decide controller correctness. Do not substitute the entire controller with a callback that merely returns "recovered."

Replay the actual incidents: missing upstream viewer owner; output-root mismatch; verifier that finishes assertions but retains an inherited pipe; machine interruption during preparation, verification, publication and requeue. Also cover quota, unavailable model, unresolved contract, duplicate controller and an unrelated task killed by the operator.

**Acceptance:** each repairable incident reaches a fresh, independently checked task completion or a precisely typed suspension without manual file/state edits. Unsafe or unauthorized repairs never publish. Restart never loses newer accepted work, repeats a completed publication or launches duplicate workers. Assert actual command/model identities and persisted evidence at every transition.

This is the first release gate. Unit test totals alone cannot replace it.

### R2 — Make recovery a durable shared controller

**Depends on:** R1's executable fixtures.

Consolidate the lifecycle currently spread across the main runner, shared diagnostic scripts, analytics `agent.mjs`, local `diagnostics.mjs`, escalation policy and supervisor. The project retains ownership, analytical context and check adapters. It must stop independently implementing attempt accounting, diagnostic identity and recovery transitions already owned by the shared kernel.

Persist an incident state such as `detected -> classified -> authorized -> repairing -> verifying -> reviewing -> publishing -> published -> requeued -> resolved`, plus explicit `suspended` and `exhausted` outcomes. These are incident states; do not rename canonical task or analytical evidence states.

Resume interrupted pre-publication work by reconciling its worktree, stage receipt, contract revision and remaining budget. If safety cannot be established, stop with the exact missing prerequisite. Do not silently replay a blocked incident or label it recovered. Use a durable run controller lease, monotonic incident revisions, atomic records and publication receipts.

Persist cumulative run budgets across supervisor restarts. Record worker and reviewer profiles on each attempt; review uses the actual diagnostic-selected worker tier. Perform process cleanup using verified ownership identity, not an old PID alone.

**Acceptance:** R1 fixtures still pass through the installed adapter; duplicate legacy policies are removed or thin delegating wrappers. No worker/reviewer profile mismatch, double publication, stale restoration or restart-created budget exists in the regression fixtures.

### R3 — Give failures machine-readable dispositions

**Depends on:** R2's incident/attempt contract.

Record stage, attempt, failure code, test identity, requirement reference, evidence refs, producer/consumer owner, exit outcome and actual model profile. Define controller actions:

| Disposition | Action |
| --- | --- |
| Implementation defect | Focused repair; normal independent acceptance |
| Upstream implementation defect | Resolve registered owner; isolate affected descendants; repair producer contract |
| Missing/ambiguous accepted requirement | Preserve evidence and request the exact decision that changes product meaning |
| Environment/process fault | Repair or restart that prerequisite; recheck readiness |
| Provider quota/authentication | Suspend affected provider work with a reason; resume only when supported evidence establishes availability |
| Review dispute | Adjudicate against the accepted requirement and reproduction |
| Unresolved cause | Bounded fresh diagnosis; no speculative rewrite |
| Authorized budget exhausted | Preserve work and expose the exact exhausted budget |

Substring searches in long test transcripts must not decide provider quota, availability or failure authority. Keep typed infrastructure outcomes separate from semantic rejection counts. Retain a compatibility parser only for historical events and record its uncertainty.

**Acceptance:** a test whose description contains "quota" or "unavailable" is not classified as a provider failure; a real provider-limit response suspends without escalation. Every supported failure has exactly one disposition and routed action.

### R4 — Validate the graph's behavioral contracts before dispatch

**Depends on:** R3's ownership/disposition contract.

Extend preflight from acyclic dependencies and file ownership to achievable acceptance. For each unit record its real production entry point, write set, consumed interface, required producer evidence, focused checks and review boundary. Add a cheap integration probe for interfaces used by multiple features, particularly viewer projections, Python staging and publication.

Reject a task whose current acceptance needs a future producer or an unresolved contract. Route a failing consumer probe to its registered producer. Give the controller explicit implementation, test, frozen-contract and generated-artifact roles; filename filters remain a conservative migration safeguard, not the final ownership model.

Audit every unfinished unit for combined independent behaviors. Split only where interfaces and executable checks establish independently achievable boundaries; indiscriminately shrinking tasks would add coordination cost. Validate conflict-free or serialized write sets at dispatch, not only Git merge time.

**Acceptance:** the original viewer and output-root contract mismatches are found before their dependent implementation worker launches. All remaining units have one review boundary and achievable checks. Frozen requirements and accepted coverage remain unchanged.

### R5 — Require evidence for retry and review decisions

**Depends on:** R3 and R4.

Fingerprint failures using normalized test/requirement identity, responsible owner, failure code and contract revision. Record substantive changes to the relevant source, diagnostic evidence, environment or scope between attempts. Different stdout, documentation churn or unrelated edits are not proof of progress.

A repeated failure with unchanged causal inputs triggers route/owner reassessment before spending another implementation attempt. Preserve the user's retry allowance: repairable narrow implementation failures retain retries and the authorized escalation ladder. A resolved prerequisite starts a new explicitly authorized cycle with old failures retained.

Require a blocking reviewer finding to cite an accepted requirement/invariant and a reproducible failing behavior or concrete violated code path. Separate blockers, unresolved evidence, and improvement suggestions. Generalization defects can be valid blockers when established with a runnable counterexample inside the supported contract. Follow-up review targets the previous findings and changed causal paths; new blockers must meet the same evidence standard.

**Acceptance:** an unchanged missing-owner rejection cannot consume a two-hour model ladder. Real implementation defects remain rejected. Unsupported review suggestions do not force scope expansion. The reviewer can reject an apparently green patch with a concrete counterexample.

### R6 — Control verification and resource demand

**Depends on:** R2 and R4.

Assign process ownership and separate preparation, focused test, integration, agent and cleanup deadlines. Count actual progress and phase output; MCP reconnect noise is not implementation progress. Every timeout records the stage and tears down its owned process tree and pipes.

Workers use focused checks; the deterministic controller owns required full-suite execution. Reuse verification evidence only when bound to the exact code/artifact revision, contract, environment, command and fixture inputs. No stale pass can authorize changed work. Keep full feature/convergence checks at their owning boundaries.

Schedule scarce resources such as browser sessions, dependency preparation and heavy Python runs with explicit capacity reservations. Start conservatively and raise concurrency using observed resource contention and accepted throughput. Independent implementation tasks can continue when another dependency cone is suspended, while shared integration publication stays serialized.

**Acceptance:** transient browser/environment faults do not become semantic rejection escalation; simultaneous tasks cannot overbook declared resources. Verifier completion is observed without inherited-pipe hangs. A relevant change invalidates reused check evidence.

### R7 — Measure reliability and promote proven lessons

**Depends on:** R1 through R6.

Expose one operator view: current lifecycle stage, elapsed time, actual model, last meaningful progress, failure fingerprint, owner, next automatic action and remaining budgets. Separate checking failures from unattended controller stops.

Track first-attempt acceptance, accepted tasks per worker-hour, unique failures, repeated unchanged failures, automatic recovery completion, manual interventions, review reversals and available usage/cost telemetry. Mark unavailable cost explicitly. Deduplicate events into attempts/incidents before computing rates.

Use the failure ledger to add regression checks and scoped planning lessons. Promote a reusable skill only after its mechanism and corrective behavior are demonstrated with controls; a diagnosis alone cannot install permanent guidance. Apply the existing decomposition and failure-learning skills rather than creating a large always-loaded memory file.

**Acceptance:** every repeated incident has a stored fingerprint and a regression/preflight owner or a documented external limit. Dashboard status agrees with live processes and receipts. Historical rejected findings remain distinguishable from accepted evidence.

## 4. Rollout and success criteria

Implement and verify the reliability changes on an isolated branch, using the current incident fixtures first. Migrate the active run at a safe stopped checkpoint, with backups and preserved work. Run three representative real units initially, then a monitored window of ten consecutive units before widening concurrency. This small window is a rollout check, not statistical proof of universal reliability.

The initial release gate requires:

1. Every supported injected lifecycle fault has the expected recovery or honest suspension, with zero false task approvals.
2. Zero duplicate controllers, stale restored artifacts, repeated publications or orphaned owned test processes in the recovery fixtures.
3. Zero unchanged known-prerequisite retries; model budgets remain exact across crash and restart.
4. The representative live window needs no manual code/state repair for the covered failure classes. Any intervention creates an incident and resets this gate after its repair.
5. Full required product acceptance remains green on the exact integrated revision.

Provider limits, genuinely unresolved product decisions and exhausted authorized budgets can still require the operator. These must be explicit suspensions with preserved evidence, not indistinguishable build failures. Product analytical null/conflicting outcomes remain valid evidence and never enter software retry-to-success logic.

## 5. First deliverable

Build R1's installed lifecycle replay suite and use it to drive R2 consolidation. This proves that the existing mechanisms compose before another large unattended build is treated as a reliability test. R3–R6 then remove the measured recurring causes. R7 supplies the evidence for a future reliability claim.

No runtime/graph change was made while preparing this proposal. Implementation and deployment have their own verification gates.
