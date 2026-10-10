# Lightweight DAG autonomy and Advanced Analytics build handoff

Prepared October 10, 2026. Latest inspected snapshot: approximately **8:36 AM Eastern**. This document is self-contained for discussion in ChatGPT on the web. Local paths identify evidence for a future coding agent; the web conversation cannot access them unless supplied separately.

## 1. Why this handoff exists

We have been building an Advanced Analytics product through a local DAG orchestrator. Progress has been painfully slow: repeated failures, manual intervention, restarts, expensive diagnostics, and uncertainty about whether the process is actually running. The user wants to set the run going and let it progress autonomously within explicit model and resource limits.

The strongest conclusion from this chat is that several different failure mechanisms were being conflated:

1. Incorrect task dependencies and tasks that could not pass before future work existed.
2. Real implementation defects that independent review correctly caught.
3. Recovery/controller defects that turned repairable problems into operator suspensions.
4. Harness, environment, process-lifecycle and generated-build-artifact problems.
5. Excessive repeated work and context consumption.

Making tasks smaller helped, but it did not automatically make their dependencies correct. More retries or a stronger model cannot repair a fundamentally impossible assignment. Conversely, a legitimate code defect should normally enter a bounded repair cycle rather than halt the entire workflow.

This is a record of the documented failure mechanisms, not a claim to enumerate every historical failed attempt. Some early events are user reports; later events have retained logs, source, commits and regression evidence.

## 2. Product and execution context

There are two repositories:

- **lightweight-dag**: the orchestration engine and shared reliability controller, at `C:/Users/Fresc/lightweight-dag`.
- **advanced-analytics-dag**: the separately forked analytics product, at `C:/Users/Fresc/advanced-analytics-dag`.

The user explicitly chose a separate analytics repository to reduce software-factory assumptions in agent context. The analytics system should support exploration, prediction, inference/hypothesis testing and question answering, with durable results, claims, provenance, review, reusable source skills and retrieval of prior analytical work.

Execution success records what ran; evidence determines what it supports. Negative/null/inconclusive analytical outcomes are valid results. Software repair retries must never become analytical reruns until a favorable result appears.

The proposal became 23 Spec Kit feature/milestone specifications and initially 164 execution units. The active run is `run_b3a47590`. Accepted source lives on `dag/run_b3a47590`; the user's main checkout is separate. The viewer has been at `http://localhost:8792/r/run_b3a47590`.

The controller performs roughly:

`diagnose → prepare → repair → verify → review → commit → publish → requeue → fresh execution → resolve`

It uses task worktrees, exact writable scope, protected baseline tests, frozen contract hashes, durable ledgers, process leases and bounded retries. Those mechanisms are useful, but their interactions have repeatedly exposed defects.

## 3. Standing user constraints

- Workers: **Luna xhigh, 3 total attempts → Sol 6.1 medium, 3 total attempts → Sol 6.1 xhigh, 4 total attempts**.
- Fresh diagnostic workers use Luna xhigh.
- **No Astra or Terra fallback.** Earlier suggestions were explicitly superseded.
- Infrastructure failures must not consume semantic model-escalation attempts.
- Preserve accepted work, rejection evidence, historical attempt exclusions, counters and product requirements.
- Do not weaken tests, hand-mark tasks completed or rerun unchanged broken assignments indefinitely.
- Run one controller for this project; do not revive the older supervisor alongside it.
- Skills/lessons must not automatically encode unproven or nongeneralizable conclusions.
- The user is moving the reasoning discussion to the web interface to conserve coding-agent usage. Producing this handoff does not authorize additional implementation of the proposed improvements.

The current durable wall deadline is **October 10, 2026, 9:31:22 AM Eastern**. Ordinary resume does not extend it. The recent fixes preserved it.

## 4. Failure history and what was done

### A. Duplicate/unclear runs and interrupted processes

Early conversation reports include simultaneous runs using OpenCode/DeepSeek and Codex/Luna, lengthy runs with no apparent progress, hitting usage limits and a computer shutdown. These reports explain the user's distrust, but this chat did not independently reconstruct every early process incident.

The workflow moved to one bounded reliability controller with durable state and PID/birth ownership checks. Restarts verify a lease/process identity before reporting that a controller is active. Old supervisors should remain inactive. There is no chat heartbeat or background chat monitor installed.

### B. Consumer blocked by an upstream CLI that did not actually work

Feature 002's acceptance-report task repeatedly depended on a matrix CLI producer. The producer exposed APIs/parser code, but the actual documented CLI exited zero with empty stdout. A consumer identified the needed patch but could not edit the ancestor producer within its ordinary task scope. Earlier diagnostics did not close that loop.

A scoped ancestor repair was accepted at analytics commit `8dc97628f1e8cbc692341036903d9b3848d8c045`. Earlier handoff evidence records 617 TypeScript tests, 24 Python tests, 17 matrix CLI scenarios and 17 real Edge browser scenarios, plus independent review. These are historical verification results, not a fresh full-suite run performed for this handoff.

Lesson: an exported symbol and a passing parser test do not prove that the consumer's actual entry point works.

### C. Published repair lacked generated build outputs; preflight loop repeated thousands of times

Repair source was published, but the integration checkout lacked the ignored `dist/` generated in the repair worktree. A probe attempted to invoke a missing built CLI. Recovery at the requeued phase made no useful transition, leading to a 10,000-probe loop and a misleading settled/waiting message. The later review measured roughly 3.45 hours in recorded preflight stages, with additional surrounding overhead.

Earlier engine commit `312c2e2` prepared/built the integration caller before probing, bounded failed post-publication recovery, preserved accepted publication receipts and made exhaustion explicit. A regression verified that a failed probe did not loop indefinitely.

Lesson: source publication does not transfer ignored dependencies/build artifacts. Each caller's environment must be prepared, and a failure must cause a bounded state transition.

### D. Diagnostics assumed an integration worktree still existed after cleanup

The engine removed its integration checkout after a batch. Diagnostics then failed with `Diagnostic integration checkout missing` because they assumed the startup checkout remained available.

Earlier commit `4c92a4a` recreated the accepted integration checkout before diagnosis/input probes, persisted diagnostic receipts, added bounded infrastructure retries and preserved rejected owned source in checkpoints.

Lesson: recovery must survive the actual cleanup lifecycle, not only a happy-path fixture with a permanent checkout.

### E. Real feature-003 defects, plus a reviewer-output parsing stop

Independent review found genuine defects in extension/worker foundation:

- A present provider could spoof `ERR_MODULE_NOT_FOUND` and be mistaken for an absent optional module.
- Worker context/validation omitted required `requestedOutputs`; the corresponding fixture omitted it too.
- A supposedly fixed module/export allowlist was mutable at runtime, including entries and dependency arrays.

The rejection source remained in salvage refs. Its absence from accepted integration was not proof of missing upstream work.

A valid review referenced `T001 — fixed module/export allowlist`; the validator expected exactly `T001` and turned the rejection into a review dispute. Earlier commit `175e976` accepted the exact registered ID plus explicit display separator, retained labels/receipts and added supported stopped review continuation. It did not broadly infer requirement IDs from arbitrary prose. Foundation later completed after repair, including an authorized Sol 6.1 medium escalation.

Lesson: retain rigorous review, but correct harmless representation differences without inventing approval or suspending unnecessarily.

### F. Protected-test editing violations became terminal contract failures

Question-orientation work added top-level test helpers to a shared protected acceptance file. The guard permits only new top-level `test`/`it`/`describe`/`suite` calls; existing imports/helpers/statements/assertions must remain intact. Repairs repeated the violation. A generic thrown error became a terminal `contract` suspension.

During this chat's work, commit `8ba910e` gave these demonstrated guard violations typed implementation failures and bounded corrective feedback. Workers received explicit instructions to nest helpers and use dynamic imports within new tests/suites. Accepted question-orientation work brought the count to 68. Commit `a9e10d6` also corrected historical accounting so uncertain legacy repair outcomes were retained without incorrectly charging retries.

Lesson: an editing restriction needs clear guidance and the right recovery classification. Separate owned test modules would reduce this repeated source of friction.

### G. Incorrect task dependencies and impossible acceptance order

The next CLI task (`task_426aeb0f`, `003-scope-t005`) required a complete question-to-answer runtime, but accepted code only provided orientation and contracts. Runtime execution/integration work was assigned to later T006/T007. The consumer was forbidden to implement that future behavior.

Further auditing found related ordering errors:

- Feature 015 cold/warm reuse tests preceded the provider implementation they needed.
- Feature 023 timeline assertions preceded the ledger projection they needed.
- Feature 018 batch execution preceded required pre-batch validation.
- Product convergence/evidence-matrix work preceded some journeys whose evidence it had to report.

Repeated file-scope expansion could not solve these missing future capabilities. The old controller exhausted scope revisions and suspended.

We audited **all 96 remaining original units**, preserving reasons for both splits and retained groupings. The graph changed from **164 to 185 units**, preserving **all 68 accepted runtime records and their evidence**. There are 117 remaining revised units.

Feature 003 now orders runtime contract, worker transport, budget, lifecycle dispatch, admission, lineage, prediction checks, report binding, exposure/replacement, finalization and runtime composition before public CLI integration and final acceptance. Implementation and dependent tests are grouped where separating them would create an impossible passing unit.

The amended plan is analytics commit `e369fb4` (`codex/analytics-dependency-replan`), based on accepted implementation `34f5703`. The full original-to-replacement audit is retained in `docs/build/dependency-replan.json` and `.md`; unit handoffs are in `docs/build/task-handoffs.json`.

### H. Expanded repair verification required unfinished future owners

Sequential units share implementation files. The controller selected every owner of an expanded implementation path for verification—including unfinished future units. A valid upstream repair could therefore fail because future behavior was not implemented.

Engine commit `69f4326` added `repairCheckOwners`: additional verification selects already completed affected owners, including accepted sibling owners, and excludes pending/failed future work. A real CLI/controller regression repaired a shared producer while a deliberately failing future owner's check remained unexecuted. Accepted-owner checks still ran.

### I. Coordinator-introduced conflicting Codex startup flags

The restart adapter was changed to pass both `--approve-for-me` and `--sandbox workspace-write`. Codex rejects that combination. The first launch failed during argument parsing before Luna received implementation work.

This was our configuration mistake. Commit `634eaa2` removed the redundant sandbox option because `--approve-for-me` already selects workspace-write. Exact corrected argument parsing was checked locally; `--cd` remained explicit. Startup failures/counters were retained. A subsequent real worker probe returned `WRITE_PROBE=PASS; IGNORED=YES; CREATED_AND_REMOVED=YES`.

Lesson: harness argument compatibility belongs in cheap launch validation before model work.

### J. Stage-admission implementation defect followed by contradictory recovery permissions

The amended overnight run accepted four more units, moving from **68 to 72/185**. These used Luna xhigh.

Review then found a genuine timing defect in stage admission (`task_7907b678`): code validated execution pins, awaited admission, then cloned the mutable request for execution. Mutating the environment digest during the await could bypass the earlier validation.

Diagnostics correctly identified the defect and requested the task's own controller and acceptance-test files. `repairScope` initially authorized owned implementation/test/generated paths, then checked every requested path under an upstream-implementation-only rule. It rejected the already authorized test file:

`No upstream implementation authority: src/analytics/acceptance/003.test.ts`

That controller error became a contract suspension before repair was attempted. The earlier future-owner regression did not cover redundant requests for owned tests.

Commit **`b162bb4`** now immediately accepts already authorized paths after path validation; only additional paths require upstream implementation authority. Regression controls reject frozen paths, upstream tests, future implementation paths, unknown paths and path escapes. A real controller regression requests an owned test file and proceeds through repair, verification, publication and completion. Both new tests passed.

The suspension was released through supported amendment; counters, attempts and deadline were compared before/after and preserved. One controller restarted at approximately 8:07 AM Eastern with Luna xhigh diagnostics.

### K. Additional real defect discovered during stage-admission repair

After restart, review found a second issue: the executable/arguments could differ from worker-proposed code while recording the proposal's digest as program provenance. The controller compared caller-supplied pins/digests but did not sufficiently bind actual execution to that code.

Recovery continued automatically through another repair and independent review. At the 8:36 AM snapshot, incident `incident_63ecd26e3159` has **12 successful check receipts**, a passing independent review, and publication receipt `edce3c9e2250557219ab125478143a47d94fd682` based on `208468e5b4ce25c0c306465f11108e7e9a5765ab`.

The incident is `requeued`, not yet `resolved`; completed count remains 72. The engine is running a fresh execution of stage admission after the verified publication. This illustrates the still-existing duplicate-work concern below. A published repair must not be described as a completed task before the engine completes it.

### L. Expensive diagnostics, transport noise and misleading status

Retained worker/diagnostic transcripts contain very large token totals and repeated broad reads. One older diagnosis recorded over one million input tokens, mostly cached. Those totals are usage telemetry, not a calculated bill; cost in USD remains unavailable.

Optional MCP HTTP/handshake errors coexist with successful worker execution. They are not sufficient evidence of quota exhaustion or a code defect. Classification should use explicit structured provider failures.

The current ledger can retain old `stopReason: suspended` even while `active` shows an engine stage and `suspended` is empty. This makes a single status field misleading. Live lease/process identity, active stage, task state and current suspension map must be interpreted together.

## 5. What we changed and actually verified in this chat

- Audited all remaining task boundaries/dependencies and amended the graph without deleting accepted history.
- Preserved full original task obligations and requirement/success/edge-case mapping through splits.
- Added unit-specific consumed/produced interface handoffs and explicit later-owner boundaries.
- Added source-export prerequisite probes. They reject missing values, comments/type-only declarations, empty probes and path escapes. **An export probe proves existence, not correct behavior.**
- Corrected future-owner verification selection and redundant owned-test scope requests.
- Corrected startup flags and verified the actual worker's write access.
- Used supported stopped amendment/recovery controls and exact backups rather than editing task status to appear successful.
- Kept existing model ladder, deadline, historical receipts and unrelated user edits.

Verification includes a spec coverage audit of 23 specs, 234 functional requirements and 114 edge cases; compiler tests for mapping, prerequisites, cycles and output ownership; acyclic revised graph checks; and real recovery regressions for the two permission/owner defects. These establish particular planning/recovery properties, not that all product behavior is implemented correctly. No fresh full product-suite result is claimed after every engine patch.

Recent engine commits: `8ba910e`, `a9e10d6`, `69f4326`, `634eaa2`, `14795ae` (restart evidence), and `b162bb4`. Earlier controller milestones: `6bad4b2`, `3ea2bc9`, `48639e1`, `312c2e2`, `4c92a4a`, `175e976`.

## 6. Current run snapshot

As inspected around October 10, 8:36 AM Eastern:

- Run `run_b3a47590`; **72 completed / 185 total; 113 unfinished**.
- Controller active in engine execution of `task_7907b678`, following verified repair publication.
- No current suspension entries.
- Latest repair/review routing: **Luna xhigh**.
- Controller launch PID 34664; latest engine batch PID 30192. These are snapshot identities, not instructions to kill processes.
- Durable deadline: 9:31:22 AM Eastern today; approximately 55 minutes remained at capture.
- No deadline extension was made for this handoff.
- Current repair publication is accepted by checks/review, but task completion remains unverified.

## 7. Where I think we should focus next

### Priority 1: Make dependency correctness a compiler contract

Mandatory task contracts should declare consumed capabilities, their owners, produced capabilities, acceptance prerequisites and exact write ownership. Generate required edges from those declarations; reject absent/ambiguous producers and cycles. Do not infer semantic dependencies merely from sharing a file.

Acceptance dependencies matter as much as imports. A test may require a future provider even when production code does not import it. Review each task with: **Can it pass using only its accepted predecessors and its own changes?**

At admission, check actual accepted artifacts/exports and small behavior probes where existence is insufficient. Export detection alone will not catch the earlier empty CLI.

If a worker discovers an undeclared dependency, record a planning incident with missing capability and owner; validate a bounded graph amendment rather than retrying the impossible assignment. Autonomous amendments need explicit authorized limits, preserved history and requirement coverage. The controller must not freely rewrite product requirements to make tasks pass.

The revised analytics handoffs/probes are a project-specific start. Making them mandatory and reusable in the generic compiler is **proposed, not yet implemented**.

### Priority 2: Narrow failure categories and make recovery decisions explicit

`contract` currently suspends and is too broad as a catch-all. Distinguish forbidden writes/frozen changes from malformed output, duplicate requests, missing producers and controller defects. Harmless normalization should be automatic; malformed packets need bounded correction, not fabricated pass verdicts.

Repeated no-progress requests should receive their prior disposition and exact scope. Genuine scope/authority violations still need to stop. Avoid making the orchestrator silently patch its own trusted code in response to arbitrary worker text.

### Priority 3: Finish verified repairs without another coding invocation

After checks/review/publication, perform receipt-bound verification on the published tree and complete through the supported engine transition. Bind receipts to source commit, contract, command and environment; invalidate them when relevant inputs change. The current requeue opens another coding attempt, adding time/cost and opportunities for regression.

Existing deterministic-check reuse code is conditional and requires an environment fingerprint adapter. Its presence does not establish that this run is using safe caching or that duplicate coding has been removed.

### Priority 4: Test complete failure sequences

Add adversarial lifecycle tests spanning worker failure, diagnostic requests, guard validation, repair, review, publication, cleanup and crash/restart. Include the exact historical failures above, malformed review packets, source changes after review, duplicate runners and budget exhaustion. A helper passing in isolation is insufficient.

Required invariants: never lose accepted work; never overwrite it with stale salvage; never turn a missing future capability into a coding retry; never reset budgets during resume; never mark completion without applicable checks/review; every failure either progresses through a bounded response or stops with an accurate reason.

### Priority 5: Reduce unnecessary work and context

Provide bounded task execution instructions rather than invoking a whole-feature interactive Spec Kit workflow for every unit. Use focused incident packets and source excerpts; preserve full logs by reference. Give units separately owned test/support files where practical. Keep retries tied to measured changes and failure identity.

Validate tool arguments and real permissions before paid work. Prepare dependencies/build outputs in the caller that needs them. Track per-stage tokens when available, with caps that preserve useful checkpoints and allow bounded continuation rather than abrupt source loss.

### Priority 6: Throughput, honest status and measured autonomy

Policy concurrency is three, but every task reserves one `acceptance` resource with capacity one, so admissions are effectively serialized. Shared-file dependencies also legitimately serialize this chain. Reserve scarce resources at the relevant stage if the engine can do so safely; do not simply increase concurrency and permit conflicting writers.

Hold a failing task and its descendants while allowing genuinely independent branches to proceed. Derive current status consistently so historical stop reasons do not imply a live run is suspended.

Measure manual interventions, accepted units/hour, first-attempt acceptance, time in recovery/operator hold, repeated failure identities and token usage. Mixed historical attempt counts are not a model-quality failure rate. A first operational target is five consecutive accepted units spanning producer/consumer/integration, plus a deliberate crash/restart without intervention. That is an engineering gate, not a statistical reliability guarantee.

### Priority 7: Failure learning with evidence

Prefer an executable regression for a mechanically enforceable failure. Keep project-specific lessons in a ledger. Promote reusable skills only with validated applicability, counterexamples and separate review. Do not automatically install rules from one convincing retrospective or allow skills to override user authority/model budgets.

## 8. Questions to discuss with ChatGPT on the web

1. What minimal consumed/produced-capability schema can the compiler enforce without creating excessive task-authoring overhead?
2. How should acceptance prerequisites be represented so future-behavior dependencies are caught, including dynamically invoked CLI/providers?
3. Which graph amendments may a planner make autonomously, and how are scope, requirement coverage, old evidence and budgets protected?
4. What recovery state machine prevents duplicate coding and supports crash-safe verification/publication/completion?
5. Which failures need a human decision, which can be normalized, and which should enter bounded diagnostic repair?
6. Which lifecycle fault-injection tests must pass before claiming unattended operation?
7. How should context/resource limits and throughput metrics guide task decomposition without blaming the model for infrastructure/planning defects?

Please challenge the assumptions, distinguish implemented fixes from proposals, and favor a small enforceable kernel over another large untested framework. The aim is fewer manual interventions and more verified progress per unit of time and usage, while retaining analytical honesty and rigorous review.

## 9. Evidence and continuation references

Engine evidence:

- `C:/Users/Fresc/lightweight-dag/docs/advanced-analytics-handoff-2026-10-09.md` (earlier history; its status and permission instructions are stale).
- `docs/advanced-analytics-systemic-review-2026-10-09.md`.
- `docs/advanced-analytics-dependency-repair-2026-10-09.md`.
- `scripts/reliability/{controller,contracts,protocol,ledger,checks,process,engine-adapter}.mjs`.
- `scripts/reliability/reliability.test.mjs` and `scripts/analytics-input-contracts.test.mjs`.
- `scripts/{replan-analytics-tasks,analytics-replan-blueprint,finalize-analytics-replan,apply-analytics-replan,analytics-input-contracts}.mjs`.

Analytics evidence:

- `docs/build/{graph,execution-graph,run-manifest,reliability,contract-lock,dependency-replan,task-handoffs}.json`.
- `dag.run.json` plus `dag.run.d/state.json`; use the engine's `loadRun` to combine definition/runtime state.
- `dag.run.d/reliability/{controller.json,events.jsonl}`.
- `dag.run.d/reliability/incident_63ecd26e3159` and its retained review/check/publication receipts.
- `.dag-build/{model-routing.jsonl,reliable-launch.json,launch-env.json}`.
- `.dag-build/dependency-replan-before-20261009/` contains prior graph/config/ledger backups and completed-record comparisons.
- `.dag-build/checkpoints/` and task-specific salvage refs preserve unverified rejected source.

For a later coding continuation, inspect status/process ownership first and follow current repository instructions. Do not treat old handoff permissions as current policy: this session uses restricted workspace writes and explicit reviewed escalation for outside-root/Git/process operations. Preserve unrelated dirty files and do not merge integration into the user's main branch without authorization. The existing background controller continues independently; no additional controller was launched merely to produce this handoff.
