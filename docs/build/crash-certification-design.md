# Flow 3 crash-recovery certification design

## Inventory and current recovery commands

This inventory is grounded in `specs/002-crash-recovery-certification/spec.md`,
`docs/flow3.md`, `docs/dag-flow3.0.md`, the Flow 3 runner/store/CLI modules, and
their tests. Ordinary Flow 3 execution is owned by `FlowRunner` in
`src/flow3/runner.ts`; task and run persistence remains in `src/store.ts`.
`src/integration.ts` has a receipt-based publication protocol for another
execution path. Flow 3 currently lands candidates directly in its integration
worktree and does not call that receipt protocol.

Supported commands and their observed behavior:

| Command | Current effect | Recovery use |
| --- | --- | --- |
| `dag run --file <run.json>` | Executes the saved graph. Flow 3 calls `recoverInterrupted()` during startup, requeues tasks saved as `running`, reuses saved verified candidates, and resumes final acceptance. | Primary Flow 3 continuation after a process crash. The same `dag build --spec <spec> --file <run.json> --max-usd <amount>` can resume a build, as documented in `docs/flow3.md`. |
| `dag resume --file <run.json>` | Calls `recoverInterrupted()`, saves the requeued task states, and exits; it does not dispatch work. | State-only requeue. Follow with `dag run --file <run.json>`. |
| `dag kill-orphans --file <run.json>` | Kills and clears PIDs still recorded on tasks, recording per-PID outcomes as `note` events. It does not requeue tasks. | Reap before requeue: run this first, then `dag run --file <run.json>`. |
| `dag retry --file <run.json> --id <node-id> [--cascade]` | Explicitly requeues a failed task. Lifetime `attempts` remains; the attempt cycle restarts. Flow 3 retains a saved candidate only for merge/integration/interrupted/killed failures; other retry reasons clear it. | Operator retry for a failed node, not the ordinary crash path. |
| `dag retry-failed --file <run.json> [--cascade]` | Requeues failed and skipped tasks. | Explicit operator action after diagnosing failures, not a substitute for crash recovery. |
| `dag recover-checkpoint --file <run.json> --checkpoint <journal> [--events <jsonl>] [--receipts <dir>]` | Restores execution state from a committed planning-amendment checkpoint plus contiguous event history and verified published integration receipts. | Specialized damaged-sidecar restore; not ordinary Flow 3 crash recovery. |

There is a PID-ordering defect in the combined options shown by CLI help.
`dag run --kill-orphans` first calls `recoverInterrupted()`, which sets each
interrupted task's `pid` to `null`, and then calls `killOrphans()`, which scans
task PIDs. `dag resume --kill-orphans` has the same order. Thus these combined
options do not reap the PIDs returned by that recovery pass. For now, the
effective sequence is `dag kill-orphans --file <run.json>` followed by
`dag run --file <run.json>`. The campaign should test and correct the combined
path instead of treating help text as proof that it works.

`recoverInterrupted()` changes `running` to `pending`, stores
`failureKind: interrupted`, sets a human-readable interruption result, and
retains the lifetime attempt count. Flow 3 marks a task `running` and saves
before invoking work. An ordinary recovery therefore cannot tell whether the
external command had started. The runner reuses a persisted verified candidate
and its commit on later runs, but a dispatched command without a saved candidate
is run again.

The persisted layout is derived from the run file: `<run>.json` contains task
definitions; `<run>.d/state.json` contains task execution state and `flowState`;
`<run>.d/events.jsonl` is the append log (with rotation); `<run>.d/logs/` holds
per-attempt output; and `<run>.d/flow3/` holds check evidence and checkpoint
diagnostics. State and definition JSON writes use temp-file, fsync and rename
with `.bak` fallback. Event append is best-effort and errors are swallowed, so
events are history, not the sole acceptance authority. An unreadable modern
state with no valid backup fails `loadRun()` closed. Git work is on
`dag/<runId>`, `dag-node/<runId>-<node>-<attempt>`, and `dag-failed/...`
branches, with worker/integration worktrees under the project worktree root.

For Flow 3, attempts and cycle counts live on `Task`; phase history and
milestones are also persisted there. Spend mode persists only cumulative
`flowState.reservedCents`; there is no per-dispatch reservation ledger. Local
verification writes a `check-<uuid>.json` containing command, output digest,
exit code and source. However, `verifyNode()` discards the returned
`evidenceRef` on success, and `Candidate` stores only commit, base, attempt and
definition digest. A completed task records its source commit and integrated
head, but not a durable link to the successful local-verification evidence.

## Six boundary seams

These are the existing code seams where a deterministic, test-only probe can
pause after the stated durable operation and let a parent process terminate
the runner. There is no current Flow 3 boundary-probe hook or campaign CLI.

| Boundary | Current seam | Required kill/recovery observation |
| --- | --- | --- |
| Worker launch | `FlowRunner.node()` saves `running`, `attempts`, `attemptsInCycle` and `nodeState.worker` before `phase(..., 'work', ...)`; `FlowRunner.phase()` calls the injected `Executor`; `shellExecutor()` spawns and calls `setPid()`. | Kill after the attempt record and at process dispatch. Preserve already-completed nodes and counters. A pre-dispatch kill may be safely queued; a post-dispatch kill is ambiguous until resolved. |
| Result capture | `FlowRunner.phase()` receives `ExecOutcome`, then assigns `exitCode`; output has streamed to `attemptLogPath()`, while `task.result` is assigned later after verification/candidate creation. | Kill after the child exits and before its result/verdict is durably attached. Confirm the log and attempt remain identifiable and recovery does not infer a successful result from partial output. |
| Verdict persistence | `FlowRunner.verifyNode()` awaits `phase(..., 'verify', ...)`; successful check evidence is written in `phase()`, but the success reference is not saved on the task/candidate. `checkedAt` is set only after verification returns. | Kill after the verifier returns. Recovery must distinguish verified from unverified work using durable evidence bound to node definition, attempt and source. |
| Commit | `FlowRunner.node()` calls `commitAll()`, creates `dag-node/.../<attempt>`, mutates task commit/result, then saves `nodeState.candidate`. | Kill after commit/ref creation but before candidate state save. Recovery must discover and validate the candidate or hold it; it must not redo work silently or attribute an unrelated branch. |
| Merge | `FlowRunner.land()` merges the saved candidate and commits on the integration branch, reads `diffHead`, then saves. `complete()` separately writes completed status and `task-done`. | Kill after integration ref movement and before task completion. Recovery should use the saved candidate ancestry to finish idempotently; detect unexpected integration commits and preserve attribution. |
| Finalization | `FlowRunner.run()` computes implementation/acceptance/review/product statuses in `finally`, emits `run-end`, and calls its final `save()`. | Kill around final status persistence. Keep checkpoint identity/results and accepted nodes; on resume, recompute or continue without turning an interrupted/missing checkpoint into a pass. |

The executor context already has `onOutput`, `registerKill`, `aborted`, and
`setPid` hooks. These support streaming, normal stop/timeout and orphan PID
recording; they do not expose the six internal persistence boundaries. A hard
process kill bypasses runner `catch`/`finally` cleanup. In particular, the
catch-path that pins `dag-failed/...` salvage does not run after SIGKILL, and
startup requeues the node without pinning its old in-progress worktree. Graceful
stop preservation is not evidence that hard-kill salvage is complete.

## Preservation and attribution checks

For every injection iteration, snapshot the pre-kill accepted set and compare
it after recovery. The campaign should make these assertions, not just check
that the run eventually exits:

1. **Accepted state:** every previously completed node remains completed, with
   its original attempt, result, definition digest, verifier evidence digest,
   source commit and integration head. No field in an accepted record changes
   during recovery.
2. **Attempt and budget history:** lifetime attempts never decrease; the
   interrupted dispatch remains charged; phase outcomes and failure reason
   remain available; cumulative spend and repair ledger do not decrease or get
   charged twice. Compare saved state plus the per-attempt log, not only the
   event tail.
3. **Failed-work salvage:** a failed attempt that had changes before the kill
   retains a reachable salvage branch or worktree reference, the exact
   failure reason, and its log. The artifact remains retrievable after the
   next attempt replaces `nodeState.worker`.
4. **Evidence-to-commit attribution:** the verifier record identifies
   `(runId, nodeId, attemptId, definitionDigest, sourceCommit)` and its
   content hash. The candidate ref resolves to `sourceCommit`; the integration
   branch contains that source and the saved `integrationCommit`; the node's
   accepted record links the evidence and both commits. Re-check evidence
   bytes and Git object existence after recovery.
5. **Git/store agreement:** accepted integration commits are ancestors of the
   current `dag/<runId>` head. The integration worktree is clean. Every
   candidate ref or integration commit that recovery intends to adopt has a
   matching run/node/attempt record. An unmatched commit causes explicit
   intervention, not silent adoption or deletion.
6. **Late worker fencing:** after the new attempt is accepted, release the old
   worker or synthesize its delayed result/PID write. The old attempt token
   cannot change task state, evidence references, candidate refs or accepted
   commits. Its event is marked stale or discarded.
7. **Ambiguity and campaign coverage:** a kill before dispatch is recorded as
   safe-to-requeue. A kill after dispatch and before a terminal result is
   recorded as ambiguous and does not automatically re-execute the command.
   Each report iteration names boundary, task/attempt, kill point, recovery
   action and outcome. Unexercised boundaries remain listed; an interrupted
   campaign remains incomplete with prior iteration records intact.

## Gaps that the campaign must close

- **No six-boundary crash campaign:** existing tests cover saved repair recovery
  (`src/flow3/lifecycle.test.ts`), task requeue (`src/store.test.ts`), candidate
  landing/conflicts and in-process runner behavior (`src/flow3/flow3.test.ts`),
  and receipt publication recovery (`src/integration.test.ts`). Those are
  stage/restart tests; none injects a hard process termination at all six
  ordinary Flow 3 seams and emits a coverage report.
- **No deterministic boundary hook:** the Flow 3 executor is injectable, but
  there is no persisted barrier/event after each consequential write. Existing
  hooks cannot reliably stop the parent at synchronous commit/merge/final-save
  edges.
- **Blind command replay:** `running` has no persisted dispatch phase or
  external command identity. `recoverInterrupted()` requeues both a task killed
  before launch and one killed after an arbitrary command may have taken
  effect. FR-007 needs an explicit ambiguous state, not an exactly-once claim.
- **Late writer fencing is incomplete:** `ExecContext.aborted()` guards normal
  runner abort handling, but there is no durable attempt-generation token
  checked by every store/PID/result write. A detached process that survives
  recovery must be unable to publish a stale result.
- **Orphan option ordering:** combined `run/resume --kill-orphans` clears task
  PIDs before `killOrphans()` scans them. Standalone kill-before-run works, but
  the combined documented path needs a regression fix and a PID-reuse-safe
  process identity.
- **Hard-kill salvage:** failure salvage happens in the in-process node catch
  block. SIGKILL bypasses it; startup does not pin interrupted worktree changes
  before replacing the saved worker path.
- **Commit-before-candidate window:** the node branch can be created after
  commit but before `nodeState.candidate` is saved. Ordinary startup does not
  reconcile that orphan candidate branch.
- **Evidence attribution:** successful local-verification evidence is not
  retained in `NodeState` or `Candidate`; candidate commit identity alone does
  not prove which check accepted it.
- **Direct Flow 3 merge has no receipt journal:** `src/integration.ts` has
  intent/published receipts and stale-attempt checks, but `FlowRunner.land()`
  uses a different direct merge path. Its candidate ancestry handles the
  expected merge-before-completion crash; it does not generally inventory
  unexplained commits on the integration branch.
- **Campaign scope/report absent:** there is no campaign command, iteration
  journal, local coverage summary, or incomplete status for unexercised
  boundaries. This feature must remain local to the run store and Git repo and
  explicitly disclaim exactly-once arbitrary external effects.

## Proposed node/module contracts

These are implementation seams for the remaining work, not current APIs. Keep
`FlowRunner` as scheduler and `Run`/`flowState` as the only durable authority.
The certification runner must use disposable local Git/run fixtures and the
same supported recovery commands as users.

| Node | Owned output | Concrete interface and acceptance |
| --- | --- | --- |
| CR-01: boundary probes | `src/flow3/contracts.ts`, `src/runner.ts`, `src/flow3/runner.ts` | Add `CrashBoundary = 'worker-launch' \| 'result-capture' \| 'verdict-persistence' \| 'commit' \| 'merge' \| 'finalization'`, `CrashBoundaryEvent { runId: string; taskId?: string; attemptId?: string; attempt: number; durableRef?: string; at: string }`, and `FlowCrashProbe { afterDurableBoundary(boundary: CrashBoundary, event: CrashBoundaryEvent): Promise<void> }`. Add optional `RunnerOptions.crashProbe?: FlowCrashProbe`; call it only immediately after each named durable seam. Production default is absent/no-op. A test probe publishes an atomic ready marker and blocks while the parent kills the child. |
| CR-02: campaign driver/report | `src/flow3/crash-certification.ts`, `src/commands/run.ts` or a dedicated command module, `src/commands/index.ts` | Export `runCrashCampaign(options: CrashCampaignOptions): Promise<CrashCampaignReport>`. `CrashCampaignOptions` names an isolated repo/run fixture, required boundaries, process launcher/killer and recovery-command adapter; it accepts no network/service dependency. `CrashCampaignReport` stores version, campaign/run IDs, start/end, per-boundary/per-iteration status, observed outcome, recovery command and report completeness. Atomically persist iterations under `<run>.d/crash-certification/`; resume an interrupted campaign from that file. Add one documented command such as `dag certify-crash --spec specs/002-crash-recovery-certification/spec.md --report <local-report.json>`. Nonzero exit if any required boundary lacks a conclusive recovery result. |
| CR-03: accepted evidence and Git reconciliation | `src/flow3/contracts.ts`, `src/flow3/runner.ts`, new pure helper `src/flow3/recovery.ts` | Extend `Candidate`/`NodeState` with an acceptance tuple containing `attemptId`, definition digest, verifier evidence path+SHA-256, source commit, and integrated commit. Export `inspectFlow3Recovery({ run, repoDir, integrationBranch }): RecoveryInspection`; return accepted-record mismatches, valid saved candidates, orphan candidate refs, unexplained integration commits and dirty worktrees without mutating the run. `FlowRunner` applies only validated transitions and holds on unexplained commits. Check each accepted record's evidence hash and Git ancestry before reporting it intact. |
| CR-04: attempt fencing and orphan reaping | `src/types.ts`, `src/store.ts`, `src/runner.ts`, `src/commands/run.ts` | Persist an immutable `attemptId` before dispatch; include it in executor environment and every PID/result callback. Require `isCurrentAttempt(runId, taskId, attemptId)` before any delayed write; stale callbacks return `stale` and append a diagnostic only. Replace the PID-only recovery handoff with `InterruptedAttempt { taskId, attemptId, pid, processIdentity }`; expose `reapInterruptedProcesses(run, attempts)` and save each outcome. Pass the returned records directly from `run/resume --kill-orphans` instead of clearing then rescanning state. Validate process identity before tree-kill to reduce PID-reuse risk. |
| CR-05: ambiguous dispatch reconciliation | `src/flow3/contracts.ts`, `src/flow3/runner.ts`, `src/store.ts`, a reconciliation command in `src/commands/` | Persist `DispatchRecord { attemptId, commandDigest, dispatchedAt, terminalAt?, disposition: 'not-dispatched' \| 'ambiguous' \| 'resolved' }` before external dispatch and terminal outcome after capture. Recovery returns `safe-to-requeue \| ambiguous \| candidate-recovery`. Add `resolveAmbiguousAttempt({ run, taskId, attemptId, resolution, reason })`, where resolution is an explicit operator finding such as `observed-applied` or `safe-to-repeat`; save it in state and event history before continuing. Do not infer exactly-once behavior or automatically repeat `ambiguous` work. |
| CR-06: hard-kill certification tests | `src/flow3/crash-certification.test.ts` plus focused store/CLI tests | Spawn a child CLI against a temporary local multi-node repository, wait for each `FlowCrashProbe` barrier, terminate the process, recover only through supported commands, and run the preservation/attribution assertions above. Cover interrupted-campaign resume, unmatched integration commit, stale late write, sidecar unreadable fail-closed behavior, and both standalone and combined orphan reaping. A completed report lists all six outcomes; no partial report passes. |

The production acceptance-evidence tuple should be written before task
completion and bound to one source commit and one attempt. Recovery must not
adopt a branch solely because its name matches; it verifies the candidate's
commit, attempt ID, definition digest and evidence. Likewise, an operator
resolution for ambiguous effects is history, not proof that an arbitrary
external command was exactly once.

## Requirements-to-node map

| Requirement | Planned node(s) | Evidence required |
| --- | --- | --- |
| FR-001 | CR-01, CR-02, CR-06 | Deterministic injection at worker launch, result capture, verdict persistence, commit, merge and finalization; a hard-kill outcome for every boundary. |
| FR-002 | CR-02, CR-04, CR-06 | Campaign invokes only supported local recovery commands; no hand-edit of run/state files; recovery command history is in the report. |
| FR-003 | CR-03, CR-04, CR-06 | Before/after accepted-task, lifetime attempt, spend/repair ledger and salvage artifact snapshots match, with only explicit recovery additions. |
| FR-004 | CR-03, CR-06 | Each accepted node links its verifier evidence hash and definition/attempt identity to candidate source and integrated commit ancestry. |
| FR-005 | CR-04, CR-06 | Old process is reaped or fenced; delayed output/PID/result cannot modify the recovered attempt or accepted node. |
| FR-006 | CR-03, CR-04, CR-06 | Recovery inspection proves integration branch, worktree, candidate refs and durable accepted state agree; unexplained commits hold for intervention. |
| FR-007 | CR-05, CR-06 | Post-dispatch/no-terminal-result attempts become ambiguous; no automatic re-execution until an explicit recorded resolution. Pre-dispatch attempts remain safely requeueable. |
| FR-008 | CR-02, CR-06 | Durable report records each attempted boundary/outcome and lists every unexercised boundary; interrupted campaigns remain incomplete. |
| FR-009 | CR-02, CR-05, CR-06 | Campaign operates only on local run files and Git repos, makes no external-service claim, and documents arbitrary command effects as unresolved unless explicitly reconciled. |

## Checks and observations

- Inspected Flow 3 docs, contracts, runner, store, CLI command handlers,
  executor process hooks, integration code and focused tests; the observations
  above are source-grounded.
- Exercised the source CLI entry point with
  `node node_modules/tsx/dist/cli.mjs src/cli.ts`; it printed the registered
  help, including `run`, `resume`, `kill-orphans`, `retry`, and
  `recover-checkpoint`.
- `pnpm dag` could not run in this worktree: pnpm attempted `pnpm install` and
  refused the linked `node_modules` directory as outside the worktree. The
  direct source CLI invocation above succeeded without changing production
  code.
- A disposable live Flow 3 run/recovery smoke and hard-kill injection were not
  performed; the execution tool rejected the temporary fixture setup before it
  ran. The source CLI check exercised the entry point's help path only.
- No test suite or six-boundary crash campaign was run in this implementation
  phase. The provided node verification and runner-owned wave/final acceptance
  checks are pending runner verification.
