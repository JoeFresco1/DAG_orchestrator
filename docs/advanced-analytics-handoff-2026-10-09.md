# Advanced Analytics DAG — handoff, October 9, 2026

## Read this first

The user is moving this work to a new chat. Their standing request is to finish the Advanced Analytics DAG build through the lightweight DAG, repair failures rather than repeatedly restarting unchanged work, and make recovery autonomous within their model/resource policy.

**Verified snapshot at October 9, 2026, 5:14 PM Eastern:**

- Run: `run_b3a47590`.
- **67 completed / 164 total; 1 failed; 96 pending; none running.**
- Controller is stopped, stage idle, stop reason `suspended`. No verified live controller lease.
- Current failed task: `task_0a96749e`, unit `003-scope-t004`, question intake/orientation in `src/analytics/controller.ts`.
- Current incident: `incident_0fbf1359e547`, phase `repair`, Luna xhigh.
- Suspension: typed `contract`, stage `recovery`, reason `suspend_decision`.
- Exact error: `New test support code requires a separate registered file: src/analytics/acceptance/003.test.ts`.
- Durable deadline: `1791639082003`, **October 10, 2026, 9:31:22 AM Eastern**. Ordinary resume does not extend it.
- The last user request before handoff was “we hit limits…restart.” Account tool reported ordinary usage allowed, 1% of the five-hour window and 44% of the weekly window consumed at that check. This is a snapshot, not a guarantee of future availability.
- We discovered the run was actually suspended on test ownership, not currently quota. We inspected it but **did not edit the current repair or restart it**. The user interrupted to request this handoff.

Do not say it is running without checking a PID/birth identity or the live controller lease. Do not reset tasks by editing JSON. Do not claim the saved T004 implementation is accepted.

## User policy and working style

- Build workers: **Luna xhigh, 3 total attempts → Sol 6.1 medium, 3 total attempts → Sol 6.1 xhigh, 4 total attempts**.
- **No Astra; no Terra.** The user's correction superseded an earlier Terra suggestion. They prefer multiple Sol xhigh attempts over Astra.
- Fresh diagnostic workers use Luna xhigh. Infrastructure failures must not consume semantic reasoning escalation attempts.
- Preserve completed work, retained rejected source, historical attempt exclusions, counters, original accepted requirements, and registered test baselines.
- Restart/repair is already authorized. Do not repeatedly ask permission for the same repair. Additional wall windows require explicit authorization; the Oct 9 request to continue authorized the current recorded 24-hour window.
- The user is angry about repeated blocks, expensive diagnostics, misleading status, and retries that do not fix causes. Give concise factual updates and actual evidence.
- Do not spawn unrelated subagents or run a second supervisor alongside the reliability controller.
- Windows PowerShell; danger-full-access; approval never. Never set `sandbox_permissions`. Background `Start-Process` must use `-WindowStyle Hidden`.
- Use Eastern time in user-facing status.

## Project vision and architecture decisions

This is an analytics product, separately forked from the software orchestrator to avoid software-factory language and assumptions in worker context. The user explicitly chose a separate repository.

The product should conduct exploratory and directed analytics, prediction, inference/hypothesis testing, and question answering. Process success records what executed; evidence determines what a result supports. Negative, null, failed, inconclusive, and conflicting analytical results are legitimate durable outcomes, not excuses to rerun until favorable.

Core intent:

- Questions, versioned/locked plans, exposure, dataset versions, transformations, executions, results, claims, reviews, and use decisions/authorizations remain separately attributable.
- Append-only inquiry/evidence history; later evidence can contradict earlier claims without deleting them.
- Trace a report value through Claim → Result → artifact → execution → transformation → dataset version.
- Record every admitted analytical attempt, including incomplete and unsuccessful attempts, in a readable ledger. Retrieve prior work before repeating analysis; record why a deliberate rerun is warranted.
- Avoid a folder of hundreds of indistinguishable CSV/XLSX exports. Registered artifacts, answer cards, retrieval, and durable records carry meaning/provenance. Notebooks are possible execution artifacts, not the memory system.
- Reusable data-source skills can hold schemas/table descriptions, business rules, safe access examples, and sample Python. Discover skill candidates from successful repeated work instead of forcing the user to request each one.
- Answer cards/results are distinct from reusable guidance. Candidates need provenance, conflict handling, validation, compatibility checks, authority review, and stale/revoked lifecycle. Do not automatically turn a useful finding into a rule.
- Gates account for evidence state and intended consumption/stakes. Avoid laundering a rubber-stamp review as methodological assurance. Exposure/plan revision history must remain honest.
- A “sealed” local partition accessible through the worker shell is a workflow convention, not independent enforcement. Record the guarantee actually provided.
- Deterministic checks need real executors, structured outcomes, policy versions, and evidence refs.
- Tool reuse (MLflow/DVC/etc.) is allowed; the user rejected “buy” framing. The novel layer is inquiry/claim/evidence provenance and its execution linkage.

The proposal was converted with Spec Kit into 23 feature/milestone specifications, then decomposed into 164 executable units. Council feedback prompted several specification-audit passes: canonical state vocabulary, check eligibility truth tables, ownership/dependencies, explicit recovery semantics, traceability, direction-sensitive improvement rules, retrieval metrics, and honest checklists. **Read actual current files for normative wording; this history does not certify all specs or all implementation complete.**

## Repositories, branches, and important files

### Execution engine

`C:\Users\Fresc\lightweight-dag`

- CLI: `C:/Users/Fresc/lightweight-dag/dist/cli.js`.
- Reliability modules: `scripts/reliability/controller.mjs`, `contracts.mjs`, `protocol.mjs`, `ledger.mjs`, `process.mjs`, `checks.mjs`, `engine-adapter.mjs`.
- Tests: `scripts/reliability/reliability.test.mjs`.
- CLI wrapper: `src/commands/reliability.ts`; help: `src/cli.ts`.
- Documentation: `docs/reliable-execution.md`.
- `.mjs` source is dynamically loaded; TypeScript wrapper changes require `pnpm build`.
- Main branch has our controller commits plus unrelated user changes. Do not sweep all dirty files into a commit.

### Analytics product

`C:\Users\Fresc\advanced-analytics-dag`

- Active run: `dag.run.json`, runtime under `dag.run.d/`.
- Integration branch: `dag/run_b3a47590`; user main is separate. Do not merge accepted integration into user main as a side effect of recovery.
- Viewer: `http://localhost:8792/r/run_b3a47590` (verify server is alive).
- Real viewer API: `GET http://localhost:8792/api/runs/run_b3a47590/run`.
- Proposal: `docs/specs/advanced-analytics-dag-proposal.md`.
- Specs: `specs/README.md`, individual feature directories, `.specify/memory/constitution.md`.
- Runtime registration: `docs/build/reliability.json`.
- Graphs: `docs/build/execution-graph.json` (164 units), `docs/build/graph.json`.
- Unit→task mapping: `docs/build/run-manifest.json`.
- Frozen original contract hashes: `docs/build/contract-lock.json` (248 LF-normalized hashes).
- New adapter: `scripts/build/reliability-adapter.mjs`.
- Prepare/registration: `scripts/build/reliability-prepare.mjs`, `scripts/build/register-reliability.mjs`.
- Migration notes: `docs/build/reliability-migration.md`.
- Controller durable ledger: `dag.run.d/reliability/controller.json`; history: `events.jsonl`.
- Current worktree: `dag.run.d/reliability/incident_0fbf1359e547`.
- Retained source: task-specific `refs/dag-salvage/...` and `.dag-build/checkpoints/`.
- Actual route log: `.dag-build/model-routing.jsonl`.
- Last launch receipt: `.dag-build/reliable-launch.json`; background PATH: `.dag-build/launch-env.json`.
- Historical counted-attempt exclusions: `.dag-build/escalation-policy.json`.

Do not launch old `scripts/build/supervise.mjs`. Do not alter frozen older build scripts to make acceptance easier. The new external reliability adapter delegates the accepted original checks.

## Instructions and skills

Both repos have `.codegraph/`. Follow AGENTS: use `codegraph explore` before locating/understanding code. Main index works. Analytics CodeGraph previously reported no available index; after checking, normal `rg`/reads are permitted. Do not initialize indexing without user request.

Applied skills:

- `C:\Users\Fresc\.codex\skills\lightweight-dag-failure-learning\SKILL.md`.
- `C:\Users\Fresc\.codex\skills\lightweight-dag-decomposition\SKILL.md`.

Read relevant analytics AGENTS, proposal, constitution and feature specs before changing product behavior. Diagnosis requires real failing evidence, owning boundary, meaningful regression and real-caller verification. Do not promote one-off guesses into general skills or relax accepted requirements to get a green run.

## Reliability controller and actual guarantees

Lifecycle: diagnose → prepare → repair → verify → review → commit → publish → published → requeued → resolved.

- Durable ledger, config/graph identity, verified PID/birth lease, exact scope registry, append-only events, bounded incident/attempt/wall policies.
- Actual CLI engine batches run with worktree isolation; accepted changes publish to integration, not caller checkout.
- A fresh normal task execution after publication must pass before an incident resolves.
- Checks run on the current artifact; source identity binds review to verified source. Reviews cannot secretly modify verified sources.
- All 164 units registered. Policy concurrency 3, but acceptance capacity 1 currently serializes admissions. Do not promise three simultaneous units.
- Defaults here: wall 24h, engine batch max 2h, work/repair 1h, review 30m, diagnosis/prepare 15m, infra retries 2, incidents/task 3, incidents/run 24, scope revisions 2.
- Shared test-file ownership does not demand acceptance for unfinished future units; extra owner checks apply to explicitly expanded upstream implementation files.
- Test guard preserves existing module statements/imports/helpers/assertions and existing tests. New top-level statements may only be ordinary `test`, `it`, `describe`, or `suite` calls. Helpers must be local to new tests/suites or separately registered; no new top-level import/helper bypass.
- Frozen hashes, original task text digests, generated reports and actual acceptance commands remain enforced.
- Prepare installs ignored dependencies for each worktree; each source tree needs its own generated `dist/`.
- Checkpoints every 60 seconds/end preserve owned non-frozen source/report files as **unverified**, not automatically accepted/restored.
- Model ladder is shared across normal implementation and repair rejections. Environment retries use separate counters.
- Provider fault classification uses structured packets/event metadata, not words such as “quota” in test output. Some event classifier fields remain incomplete; do not claim every quota case is correctly handled.

## Failure history — substantive and operational

### Older build troubles

The user reported duplicate runs with different harnesses (OpenCode/DeepSeek and Codex/Luna), long runs without progress, repeated failures, and a computer shutdown. Work was decomposed further, a fresh diagnostic capability added, and finally replaced with the bounded reliability controller. Use current records to distinguish historical attempts; do not revive obsolete supervisors or count ignored historical failures again.

### 002 acceptance report: missing actual CLI producer

Task `task_a5fb61d9`, unit `002-acceptance-report`, T015 repeatedly failed. Producer `src/analytics/demo-evidence.ts` had APIs/parser but lacked executable CLI behavior: the documented matrix command exited 0 with empty stdout. Consumer worker identified the patch but ownership rejected editing the ancestor producer; older diagnostics did not close the loop.

Reliable scoped ancestor repair accepted commit `8dc97628f1e8cbc692341036903d9b3848d8c045`:

- 617 TypeScript tests; 24 Python tests.
- 17 actual matrix CLI scenarios and all 17 real Edge browser scenarios.
- Coverage audit: 23 specs, 234 FRs, 114 edge cases.
- All seven affected producer checks plus consumer/matrix probe; independent review.
- Existing tests/frozen contracts retained.

Incident `incident_ded430da5186` is resolved. First migration incident `incident_d7be272aa2aa` is exhausted by explicit amendment, not a new failure to retry.

### Controller bug: accepted publication followed by missing generated dist

Repair was published, but accepted integration checkout lacked the ignored `dist/` generated in the repair worktree. Matrix probe repeatedly tried missing `dist/analytics/demo-evidence.js`. Requeued-incident recovery did nothing; 10,000 repeated probes over roughly four hours ended with misleading `converged_or_waiting`.

Fixed in `312c2e2`:

- Prepare/build current integration source before matrix CLI probe.
- Failed post-publication probe preserves accepted receipts, exhausts old incident with recorded reason, opens bounded new incident.
- Preserve typed probe faults; no universal ownership assumption.
- Explicit `controller_round_budget_exhausted` stop reason.
- Real regression proves failed probe runs once and accepted publication receipt survives.

### Controller bug: diagnostic integration checkout deleted after batch

The engine cleans the integration worktree after batches. Diagnostics assumed the startup-created checkout still existed; next task failed with `Diagnostic integration checkout missing`.

Fixed in `4c92a4a`:

- Recreate accepted integration checkout before every diagnosis and consumed-input probe.
- Persist full diagnostic receipt, including errors.
- Bounded environment retries independent of semantic model escalation.
- Real CLI regression for cleanup→diagnosis→repair→publish→requeue, plus environment retry regression.
- Adapter checkpoints now preserve rejected work before cleanup.

### 003 extension/worker foundation: real contract defects

Task `task_de40eddd`, unit `003-extension-foundation`, T001–T003.

Initial review found:

1. `ERR_MODULE_NOT_FOUND` plus matching URL was treated as exact optional provider absence, even when a present provider spoofed that error. Contract requires true exact module absence, not provider/transitive failure.
2. Worker invocation context/validator omitted `requestedOutputs`, required by frozen delegated-inquiry contract/data model. Fixture omitted it and passed.

Rejected source was **not lost**: retained ref `refs/dag-salvage/run_b3a47590-task_de40eddd-attempt-1`, commit `21831a3f43bb684f84e74b210abf38bc768079bd`. Absence from accepted integration was not a missing prerequisite.

After repair, build and 17 scoped tests passed. Independent review then found the supposedly fixed module/export allowlist was mutable at runtime. Reproduction returned `Object.isFrozen` false for array, entries and dependency arrays; mutating an entry to `src/analytics/evil.ts` was accepted by the registry.

Reviewer returned requirement `T001 — fixed module/export allowlist`, but validator required exactly `T001`; this valid blocker became `review_dispute` and suspended recovery.

Fixed in `175e976`:

- Accept only an exact registered ID followed by the explicit display separator ` — `; retain original label. No prose inference, partial-ID matching, unknown IDs or evidence weakening.
- Save full review receipt before validation.
- Project reviewer JSON schema now enums accepted requirement IDs plus blank for nonblocking suggestions, reducing malformed labels.
- Added supported stopped `reliable continue` action: explicit reason/window, retain incident/counters/verified source, fresh review release only.
- Build passed; tests for display-label rejection integrity, stopped continuation/counter preservation/source-change rejection, and real CLI repair lifecycle passed.

Oct 9 continuation reran independent review, repair escalated within authorized ladder to Sol 6.1 medium, and **003 foundation completed**. Incident `incident_cae36f93866d` is now resolved; completion count rose to 67. Earlier `incident_b70ab21f072e` is exhausted by amendment.

### Current T004 blocker: test helpers violate guard, diagnostics repeated same problem

Task `task_0a96749e` owns:

- `src/analytics/controller.ts`.
- `src/analytics/acceptance/003.test.ts`.
- `specs/003-delegated-inquiry/tasks.md`.
- `specs/003-delegated-inquiry/unit-verification/scope-t004.md`.

Incident `incident_0fbf1359e547` base `cd937f094a511c1f6804d21584826bebe281fa14`, worktree `C:\Users\Fresc\advanced-analytics-dag\dag.run.d\reliability\incident_0fbf1359e547`.

Initial rejection and diagnosis identify the same concrete problem: added top-level helpers in an existing protected acceptance file without a separately registered support file. Diagnostic classifies ownership and requests no extra paths. Repair remains noncompliant, so `guardDiff` throws an ordinary error that outer recovery classifies as `contract`, causing operator suspension rather than a bounded implementation correction.

Current added helpers:

- `scopeT004PlanRegistration`.
- `scopeT004ExploratoryPlan`.
- `scopeT004Request`.
- `scopeT004CommittedHistory`.

They precede eight new `scope:003-scope-t004: ...` tests after existing line ~577. Current diff adds roughly 464 lines. Existing statements/tests appear preserved. Worker report claims eight scoped tests passed; no independent acceptance/review has established current controller behavior. Verify, do not trust report.

Current worktree status at handoff:

- Modified `tasks.md` and acceptance test.
- Untracked new `controller.ts` and `unit-verification/scope-t004.md`.
- Semantic rejection count for current task: 0 (this guard suspension has not charged a semantic rejection).

Potential least-invasive repair: put new helper definitions inside a newly added allowed suite/test closure, preserving all existing module statements and tests. Confirm existing imports and the scope selector before choosing `describe` versus nested `t.test`; do not add another forbidden top-level import. Keep all eight cases executable and correctly selected. A separately registered support file would require an explicit scope/config amendment; do not silently invent it.

**No such repair was applied before handoff.**

Another control-path issue remains: `continue --release` currently supports only review disputes at phase `review` with unchanged verified source. It **cannot release this contract suspension in phase repair**. Do not call it expecting this task to restart. Prefer a narrowly supported stopped recovery control that revalidates owned corrected source and resumes verification with recorded rationale/counters preserved. Existing `amend` clears selected suspensions but exhausts active incidents; using it casually discards the useful phase/receipt context and spends a new incident. This needs deliberate handling, not a hand-reset.

### Diagnostic cost / transport noise

Diagnostics have consumed substantial tokens. T004 diagnostic reported input 1,293,471, cached input 1,161,472, output 23,409, reasoning 17,613. Earlier foundation diagnosis also used hundreds of thousands of input tokens. Read focused source/history, not entire controller ledgers/transcripts.

Codex subprocess output includes `rmcp`/`codex_apps` MCP HTTP response decoding/handshake failures even with `--ignore-user-config`. These messages may coexist with successful execution. Do not equate them to quota or an implementation defect. Structured provider classification should remain explicit.

## Main engine commits made in this work

- `6bad4b2` — bounded reliability controller and verified lifecycle.
- `3ea2bc9` — environment retries separate from semantic escalation.
- `48639e1` — scoped ownership, bounded long acceptance, preflight performance.
- `312c2e2` — bounded post-publication probe recovery and receipts.
- `4c92a4a` — recreate diagnostic checkout and persist failures.
- `175e976` — stopped continuation and exact review display-ID validation.

Focused gates passed as described above. Do not claim a fresh full suite was run after every patch; broaden only for concrete risk. The current T004 blocker is not fixed by those prior passing tests.

## Safe operating commands and traps

Use the absolute CLI and analytics working directory:

```powershell
node C:/Users/Fresc/lightweight-dag/dist/cli.js reliable status --config C:/Users/Fresc/advanced-analytics-dag/docs/build/reliability.json --json
node C:/Users/Fresc/lightweight-dag/dist/cli.js reliable resume --config C:/Users/Fresc/advanced-analytics-dag/docs/build/reliability.json --json
```

For explicitly authorized deadline renewal and supported review-dispute release:

```powershell
node C:/Users/Fresc/lightweight-dag/dist/cli.js reliable continue --config C:/Users/Fresc/advanced-analytics-dag/docs/build/reliability.json --reason "User authorized continuation" --release TASK_ID --hours 24 --json
```

Again: current contract suspension is not supported by this release command.

- Parse authoritative statuses with `loadRun` from `dist/store.js`, not just `JSON.parse(dag.run.json)`; runtime statuses are in sidecars.
- `reliable status` validates registration; use compact selected ledger fields when inspecting huge receipts.
- Controller lock PID/birth check uses `sameProcess` from `scripts/reliability/process.mjs`.
- Launch background Node with `Start-Process -WindowStyle Hidden`, analytics cwd, PATH from `.dag-build/launch-env.json`, separate stdout/stderr files, and save launch PID/birth/log receipt.
- Verify actual `.dag-build/model-routing.jsonl` entry and live lease before reporting active model/stage.
- Never run two controllers or old supervisor simultaneously.
- Do not issue `dag serve --help`: this handrolled CLI previously started a server instead of displaying help. Use documented server commands.
- Viewer recovery can use `dag servers --stop --dir ANALYTICS_ROOT` then `dag launch --dir ANALYTICS_ROOT`; check actual serving state first.
- No automatic monitor/heartbeat was installed for this continuation. Do not imply unattended chat oversight beyond the running controller.

## Dirty files and preservation

Main engine has unrelated dirty proposal edits, untracked UX review docs/scripts/output, and a one-line `src/runner.ts` legacy review-rejection salvage change. Preserve them. `src/review-salvage.test.ts` is untracked and previously passed. Our commits explicitly selected controller-related paths; temporary author args were used instead of changing global Git identity.

Analytics user main has dirty/untracked AGENTS/README/proposal/spec/build work; accepted implementation is on integration. New reliability adapter/config files may be untracked external trusted tooling in user main. Do not `git add .`, clean ignored files, remove retained repair worktrees, or overwrite user main with integration.

## Next actions for the receiving chat

1. Recheck current counts, lease, deadline, account availability, and suspended incident. Handoff is a snapshot.
2. Inspect relevant T004 contract/scope and exact added AST statements. Preserve current repair source and old baseline.
3. Fix test structure within the registered boundary; run `guardDiff` through the same controller contract. Do not weaken the guard or delete old tests.
4. Repair the supported stopped-recovery path so this corrected owned artifact can be verified/reviewed without resetting task state, model counters, or accepted work. Add a focused regression for the actual guard→suspension→correction→verification caller path.
5. Run unchanged T004 acceptance checks and fresh independent review. Publish only if both pass; then requeue normal task execution.
6. Restart exactly one reliability controller and confirm live actual routing. Current remaining window is until Oct 10, 9:31 AM Eastern. Do not renew merely because resume was called.
7. Report factual progress, current phase/model, and remaining defect. Keep implementation failure separate from controller/guard faults and provider limits.

The user has authorized continuation and fixes. The immediate objective is **a correctly resumed reliable build**, with the remaining analytics units completed under the agreed ladder—not another unchanged retry, not a new parallel run, and not acceptance by manually editing state.
