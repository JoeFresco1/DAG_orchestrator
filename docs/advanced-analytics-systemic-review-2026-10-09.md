# Advanced Analytics DAG: systemic execution review

Reviewed October 9, 2026. Run `run_b3a47590`.

## Conclusion

The chronic stops have several causes, but the strongest current evidence points to defective task handoffs and recovery control flow. The tasks were divided into smaller checklist assignments without consistently establishing independently executable interfaces. The controller can expand file access, but cannot resolve a missing future capability or contradictory task instructions. Several recoverable conditions then become terminal contract suspensions.

There are also real implementation defects and some oversized integration assignments. The history does not support treating every failure as a limitation of Luna or solving this by increasing retries or escalating models.

The previous fixes addressed real defects. They did not establish sustained unattended operation, and claiming the overall reliability problem was solved from a single successful task transition was premature.

## Observed state and scope of this review

- 68 of 164 tasks completed; 1 failed; 95 pending. The controller reports idle/suspended, with no active stage.
- Current failure: `task_426aeb0f`, `003-scope-t005`, incident `incident_f2befbed996b`.
- Current stop: `Invalid or exhausted scope revision request`, classified as `contract` at recovery.
- 47 of the 68 completed tasks have more than one recorded engine attempt; those 68 tasks total 206 engine attempts. These are mixed historical counters, including explicitly excluded historical attempts, restarts, and infrastructure problems. They are **not** a model-quality failure rate. Repair invocations are also recorded separately.
- Reviewed the full execution graph's metadata, current controller and adapter source, controller event history, retained incident records, earlier handoff evidence, and the current/next feature's tasks and actual interfaces. This is not an implementation audit of every remaining feature.
- No new worker was launched, no graph was amended, and no production repair was applied during this review. Accepted work and the stopped incident remain intact.

## 1. The current task lacks a settled production handoff

T005 owns the public `analytics ask`, `answer show`, and `trace` CLI. It must invoke the controller, return an inquiry ID, and consume completed upstream APIs without implementing later tasks.

The accepted controller currently exposes `orientInquiryV1`. That function requires an already constructed interpretation, Plan, trusted services, identity/access setup, and worker context. It is not a ready public question-to-answer execution entry point. The worker contract module likewise provides typed contexts and proposal validation, not the missing production runtime composition.

T006 owns the subsequent authoritative execution integration. T007 owns its production CLI integration fixtures. The executable graph groups T006 and T007 together **after T005**. The original checklist instead lists T005 and T006 both after T004, with T007 after both. Serializing the grouped unit made the interface handoff problem worse.

The observed sequence was:

1. Normal work returned incomplete, citing the unavailable controller runtime.
2. The first repair requested `controller.ts`; access was granted.
3. The next repair requested `worker.ts`; access was granted.
4. The next repair requested `controller.ts` again, which was already authorized.
5. The controller hit the two-expansion budget and suspended.

All three repair outputs described the same unresolved runtime boundary. They consumed approximately 13.9 minutes combined. Expanding writable paths did not amend the instruction forbidding future checklist work or define the missing invocation contract.

This is not proof that no possible T005 implementation exists. A specifically defined injected service interface could support isolated CLI acceptance. **That interface and the permitted intermediate behavior are not specified well enough in the current handoff.** Leaving the worker to invent them while forbidding future work is the defect.

### Required correction

Choose and record the production runtime interface before another implementation attempt. It must identify who supplies identity/grants, fixture/source resolution, question interpretation, Plan construction, worker invocation, durable inquiry lookup, and viewer routing.

Then separate the executor work from its later CLI integration tests. Build the necessary execution capability before production CLI binding, and run the T007 integration cases after both. Split the T006 work further where admission, execution/lineage, and report/check bindings can each pass against explicit interfaces. Preserve all T005–T007 requirements and final integration coverage; do not add a stub that masquerades as a working inquiry.

## 2. Dependency preflight is almost empty

The controller supports executable consumed-input probes. Only **one of 164 task registrations** currently has one: the matrix CLI probe added following an earlier failure. T005 has `inputs: []`.

The existing preflight establishes registration integrity and graph relationships. Without probes or explicit interface manifests, it does not establish that a dependency produced the entry point, signature, service setup, or behavior its consumer needs.

This pattern predates T005: the earlier matrix producer passed local checks while its documented executable command returned no scenario output. A consumer discovered the missing behavior much later.

### Required correction

For production integration boundaries, declare concrete consumed exports/commands, their producer, and a small deterministic readiness check against the accepted source. Missing prerequisites should route to their owning task or a recorded graph correction before a coding worker starts. Do not add generic probes to every trivial task merely to satisfy a count.

Every task handoff should distinguish existing APIs it consumes from APIs it creates, provide relevant signatures/examples, state permitted intermediate limitations, and identify the later acceptance owner. The work adapter should carry this information directly rather than requiring repeated architectural discovery.

## 3. Expanded repair scope selects future tasks' checks

This is a separate controller defect found during this review, not yet encountered by the current incident because it stopped before verification.

In `scripts/reliability/controller.mjs`, verification identifies additional owners by finding **all** registered tasks with implementation files in the expanded repair scope. It does not restrict that owner set to accepted ancestors.

Replaying that selection against the current ledger selects seven other owners for `controller.ts` and `worker.ts`:

- Two completed ancestors: extension foundation and T004.
- Five pending non-ancestors: T006/T007, T008, T009, T010, T011/T012.

Their adapter checks require their assigned checklist IDs to be complete. A valid T005 repair would therefore be asked to pass future task checks that it is expressly forbidden to implement.

### Required correction

Bind expanded-scope regression obligations to accepted producer contracts and the consumer's actual boundary. Exclude unfinished descendants from intermediate verification. If a shared file also serves completed non-ancestor work, retain that accepted regression coverage or reject the expansion until its ownership is explicitly resolved; blindly filtering away all other owners is insufficient.

Regression: a repair of a shared file must run the accepted producer's checks and the consumer's checks, preserve already accepted behavior, and never require an unfinished descendant's checkbox or tests.

## 4. Recovery confuses planning, protocol, implementation, and authority failures

The outer recovery handler maps ordinary untyped exceptions to `contract`, which suspends the task. That is appropriate for some actual authority/integrity violations, but not a useful universal classification.

The recent failures demonstrate the distinction:

- Added test helpers violated the test guard; that was a correctable implementation issue. The earlier plain exception stopped recovery. This case was repaired in the preceding fix.
- A valid review finding used a requirement display label that the parser rejected. That formatting problem became an adjudication stop. The exact display-label case was repaired earlier.
- The current duplicate/exhausted scope request receives a generic contract error. There is no structured route from repeated scope requests to a task-handoff diagnosis.

The current scope requests also return the literal prompt example reason, `reproduced ownership gap`. Useful narrative appears outside the machine-readable packet. The controller authorizes paths but records no capability owner, dependency explanation, or explicit resolution of the future-work restriction. Each repair launches a fresh worker, and `lastFailure` remains null for these scope expansions.

### Required correction

Give each failure category an explicit bounded response:

| Condition | Response |
| --- | --- |
| Reproduced implementation defect | Repair with current evidence; use the authorized model ladder. |
| Malformed worker/reviewer packet | Bounded packet correction; do not treat invalid output as approval or invent a verdict. |
| Request for an already authorized file | Return exact current scope and previous request disposition; do not consume another expansion. Repeated no-progress requests trigger dependency diagnosis. |
| Missing future capability or conflicting assignments | Record a planning/dependency incident and resolve the owner/interface/graph; more file access is not the remedy. |
| Frozen requirement change, unauthorized write, source identity mismatch | Preserve the hard stop and evidence; do not bypass the guard. |
| Provider/environment failure | Separate bounded infrastructure recovery; no semantic model escalation charge. |
| Genuine ambiguous product requirement | Explicit decision required; do not fabricate authority to proceed. |

Fresh diagnostic workers need the original worker's concise blocker, relevant command failures, current scope, previously denied/granted requests, and retained source references. The current compact incident carries the validator's `Assigned task incomplete` result but omits the normal worker's final explanation. That loses the more useful causal evidence.

## 5. Some remaining assignments are broad; others are too disconnected

The next T006/T007 unit combines proposal admission, pinned execution, transformation/denominator lineage, Python prediction, four integrity checks, report binding, production CLI integration, and eight fixture families. That is substantial integration work despite occupying only two checklist IDs.

Conversely, T005 is small by file count but not independent of the runtime composition. Further splitting solely by checkbox or file count would repeat the mistake.

The shared acceptance file and append-only test guard also impose a nonstandard development constraint: new top-level helpers/imports are forbidden. The previous fix now tells workers how to nest helpers and dynamic imports. Longer term, explicitly owned per-unit test/support modules would reduce accidental guard violations and enormous shared fixtures, while retaining immutable baseline tests and full feature acceptance.

The worker adapter invokes the general Spec Kit implementation skill, which includes whole-feature context loading, setup-file maintenance, and interactive checklist guidance. The adapter narrows that instruction, but workers still have to reconcile competing workflow expectations and rediscover the local skill path. Retained repairs show repeated broad document reads and failed guessed skill paths. Provide the exact local skill path and a bounded task execution procedure; apply standing approval once at the coordinator, rather than sending each worker back through a general interactive planning workflow.

## 6. Unnecessary work amplifies every failure

Two mechanisms are directly visible in source/configuration:

1. Policy concurrency is three, but every task reserves one `acceptance` resource and its capacity is one. The scheduler reserves it for the task, so all admissions are serialized. This contributes to low throughput; it does not itself cause incorrect output. Shared-file ownership also legitimately limits this particular chain.
2. A repaired implementation goes through checks and independent review, is published, then the controller requeues the task for a fresh normal coding invocation plus checks/review. Revalidating the published tree is necessary; reopening implementation by default duplicates effort and can introduce new changes.

The controller history also contains the already-fixed 10,000-probe loop. Recorded preflight stages total about 3.45 hours inside that loop, before surrounding overhead and waiting. It is not evidence that the model spent those hours struggling with code.

### Required correction

After publication, execute a deterministic verification transition bound to the exact accepted commit, contract revision, and environment. Preserve the receipt and complete through the engine's supported state transition only after it passes. Any source/contract/environment change invalidates reuse and requires fresh applicable verification. Do not hand-mark completion.

Reserve scarce acceptance/browser resources at the stage that actually uses them when the engine can enforce that safely. Keep conflicting writers serialized; only parallelize truly independent units. Raising concurrency on the current shared-file chain will not repair the dependency problem.

## What is established versus uncertain

**Established:** the task-handoff gap, current repeated scope-request sequence, absent readiness probes, future-owner verification selection, serialized resource policy, duplicate coding after publication, and earlier controller failures.

**Also established:** previous independent reviews found real semantic defects, including incorrect optional-module error handling, missing worker context fields, and mutable supposedly fixed registries. Keep those checks and the model escalation policy.

**Not established:** that Luna is categorically incapable of this project, that every reported failure has one cause, or that all remaining 96 units are otherwise executable. An explicit readiness review of the remaining boundaries is still required.

The current worker also reported a read-only worktree. The retained repair event files do not show a decisive denied edit, while builds ran and a later verification report was written. Treat this as an unresolved harness/permission observation, not a confirmed explanation. Before resuming, record effective permissions and prove an agent can create and remove an authorized scratch file through its actual tool path. A host-side filesystem test alone does not establish agent permissions.

## Recommended implementation order

1. Preserve the stopped run and current evidence. Keep all 68 accepted tasks, original product requirements, historical counters, and the durable budget.
2. Fix and regression-test future-owner check selection and structured scope-request handling in the shared engine. Test both valid recovery and forbidden expansion.
3. Resolve the 003 production runtime interface and amend the remaining 003 units/dependencies together with scope, reviewers, digests, coverage maps, and frozen tooling registration. Separate T006 implementation from T007 integration. Audit the remaining graph for the same consumer-before-provider pattern before admission.
4. Add concrete interface readiness probes and concise handoff packets at the affected boundaries. Validate worker permissions and exact local skill/runtime paths once per relevant environment.
5. Replace the redundant post-publication coding attempt with receipt-bound verification. Tune resource reservations after correctness is established.
6. Resume using Luna xhigh, with the existing 3 Luna / 3 Sol 6.1 medium / 4 Sol 6.1 xhigh attempt policy. No Astra or Terra. Planning and infrastructure failures must not be mistaken for semantic model failure.

## Evidence needed before calling it unattended

Use several consecutive real task transitions, not one recovered task, as the initial operational test. A practical first target is five accepted units spanning a producer, consumer, and integration boundary without manual intervention; that target is a local engineering acceptance criterion, not a statistical reliability guarantee.

Automated controller tests must additionally cover:

- Missing consumed API detected before an implementation worker launches.
- Repeated scope request returns actionable feedback and remains bounded.
- Shared-file repair verifies accepted owners without requiring future work.
- Genuine forbidden scope remains blocked.
- Worker/check/reviewer failure preserves evidence and reaches its correct bounded response.
- Published repair is revalidated without another coding invocation; changed source invalidates the receipt.
- Process interruption resumes from durable state without losing accepted work or resetting counters.

Record accepted units per worker hour, first-attempt acceptance with infrastructure exclusions explicit, time in each stage and operator hold, repeated failure fingerprints, and worker/reviewer usage when available. Do not label an actively running PID or a passing isolated regression as proof of sustained autonomy.

## Evidence locations

- Analytics run state: `C:/Users/Fresc/advanced-analytics-dag/dag.run.json` plus `dag.run.d/state.json`, loaded together through the engine store.
- Current controller history: `C:/Users/Fresc/advanced-analytics-dag/dag.run.d/reliability/controller.json` and `events.jsonl`.
- Current repair outputs: `C:/Users/Fresc/advanced-analytics-dag/dag.run.d/reliability/incident_f2befbed996b/.dag-build/reliability-adapter/`.
- Original tasks and generated units: `C:/Users/Fresc/advanced-analytics-dag/specs/003-delegated-inquiry/tasks.md`, its `execution.json`, and `docs/build/execution-graph.json`.
- Runtime policy/probes: `C:/Users/Fresc/advanced-analytics-dag/docs/build/reliability.json`.
- Worker/check/review adapter: `C:/Users/Fresc/advanced-analytics-dag/scripts/build/reliability-adapter.mjs`.
- Recovery and owner selection: `C:/Users/Fresc/lightweight-dag/scripts/reliability/controller.mjs`.
- Preflight and resource selection: `C:/Users/Fresc/lightweight-dag/scripts/reliability/contracts.mjs`.
- Normal task checks/review: `C:/Users/Fresc/lightweight-dag/scripts/reliability/engine-adapter.mjs`.
- Historical repairs and exclusions: `docs/advanced-analytics-handoff-2026-10-09.md`, `docs/advanced-analytics-recovery-2026-10-09.md`, and the analytics `.dag-build/escalation-policy.json`.
