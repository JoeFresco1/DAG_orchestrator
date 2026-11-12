# Flow 3 autonomous execution and recovery audit

Investigation and targeted changes, 2026-11-11. This describes the current source,
including quota support already present in the working copy before this task.
It does not attribute those pre-existing changes to this implementation.

## Confirmed execution paths

| Concern | Actual production path and status |
| --- | --- |
| Dispatch | `src/flow3/runner.ts`, `schedule` and `runChain`, call `src/graph.ts:33`, `depsMet`. Dependencies must be completed, gates open, scope selected, worker slots available and file ownership nonconflicting. `chainWaves` groups units; it does not override readiness. Operational. |
| Node completion | `node` runs work, `verifyNode`, pins a verified candidate, calls serialized `land`, then `complete`. A worker's implementation claim/milestone is insufficient. Operational. |
| Code location | Worker worktrees hold unfinished edits; pinned Git branches/refs retain failed or verified source. Successful candidates merge into `dag/<runId>` in the integration worktree. The caller checkout is not the integration target. Operational. |
| Completion fields | `src/flow3/contracts.ts`, `FlowState`: `implementationComplete`, `acceptanceStatus`, `productComplete` are run-level, not per-node alternate readiness states. |
| Acceptance readiness | `checkpoint` uses `checkPrerequisites` to record `passed: false`, `outcome: deferred` without running a premature check or charging repairs. Later wave/full checkpoints execute checks afresh. Operational. |
| Local verification prerequisites | `src/flow3/graph.ts`, `checkGraph`, converts `verify_requires` into ordinary acyclic dependencies. A node's local check is the integrity gate for its candidate, not an independently deferrable acceptance claim. Operational. |
| Producer reopening | Previously only the final-checkpoint defer branch promoted existing producers and dependency closure into required scope. Wave diagnoses could defer, but could not promote excluded producers there. Partially implemented; corrected below. |
| Local missing inputs | Previously `repairDecision` identified producers only for checkpoint/integration phases; local verification explicitly converted defer to hold. Work failed, descendants blocked and independent branches continued. Partially implemented; corrected below for uniquely identified declared artifact producers. |
| Infrastructure | `phase` enforces phase/idle/run deadlines, cancels executors and preserves tainted worktrees. Setup, timeouts, stalls, auth/permissions, unknown errors and unclassified dependencies hold rather than authorize coding repair. Operational and intentionally conservative. |
| Quota | Working-copy `quotaSignal`, `pinInterruptedWork`, `awaitQuota` preserve confirmed quota-interrupted work/remaining time and use an available read-only probe. Unsupported probes require explicit continuation. Quota waiting settles active work and globally pauses new dispatch; it is not per-provider scheduling. Operational working-copy support. |
| Legacy recovery | `FlowRunner.run` explicitly rejects `quotaRecovery` and `verificationRecovery`. `src/runner.ts` implements those for the lean lifecycle using execution budgets, old pause records, original sessions and verification source contracts. Existing but intentionally unavailable to Flow 3, not forgotten wiring. Left disconnected. |
| Deterministic defects | `verifyNode` diagnoses exact check evidence and uses durable per-node repair ledgers; checkpoint repairs use persisted intents and a shared run-wide allowance. Repeated/no-change/out-of-scope/protected-file changes stop. Operational. |
| Integration conflicts | `land` preserves the verified candidate and restricts resolution to conflict markers. Retry lands the candidate without a new implementation dispatch. Operational. |
| Resume | `recoverInterrupted`, saved candidates, `resumeRepairIntents`, `recoverRepair` and persisted deadlines/ledgers restore existing progress without renewing repair allowances. Saved repair edits are verified before becoming candidates. Operational. |
| Oversized tasks | `checkGraph` emits advisory size warnings. `src/planning/amend.ts:11`, `amendPlan`, is a stopped, lock-owning manifest amendment: it rejects running work, removal of attempted tasks and changes to accepted identities. It is not an active FlowRunner decomposition API. There is no runtime node-splitting/replanning call path. Missing capability, now explicitly diagnosed on recognizable context exhaustion. |

There is no separate Flow 3 `HOLD` task status: a hold is a durable diagnosis and
an unsuccessful run summary, usually with a failed task or deferred obligation.
Graph/configuration/lock failures stop startup. Unsettled executors stop the run
to protect shared source. Ordinary node failures leave unrelated branches running.
Required unfinished work prevents final acceptance; failed/inconclusive acceptance
or configured review prevents delivery success. CLI reports unsuccessful runs;
node failures do not directly call process exit. `DagRunner.start` in
`src/runner.ts:615` delegates ordinary Flow 3 runs; `src/commands/run.ts:230`
sets CLI exit code 1 when the returned Flow 3 summary did not pass.

## Readiness correction

No relaxation of `depsMet` is warranted: completed nodes already provide verified,
integrated code while whole-product acceptance may remain pending. Four meanings
are represented without four new persisted statuses:

* Implementation readiness: completed producer dependencies plus normal dispatch guards.
* Integration readiness: conclusive local verification and an available candidate.
* Acceptance readiness: declared per-command `checkPrerequisites` and assembled scope.
* Delivery readiness: required implementation, frozen final evidence and configured review.

The execution loop repeats scheduling only after actual producer/scope changes or
a persisted node suspension. An unchanged apparently ready descendant behind an
unusable chain does not cause a busy loop.

Composed checks that need downstream contributors belong in wave/final checks
with `checkPrerequisites`; the producer keeps its fast local integrity check.
Automatically skipping the only local verifier would expose unverified code and
is not safe. A producer whose only verifier requires its own consumer remains a
contract/decomposition problem, not permission to call that producer completed.

## Changes implemented

1. `FlowRunner.reopenProducers` extracts the existing closure/scope promotion.
   Admission-added edges now participate in closure before dispatch. Scheduling
   promotes prerequisites of active configured checks; wave and final diagnoses
   reuse the same helper. Completed tasks/evidence are retained; failed producers
   gain no attempts. Unknown task creation is not inferred from worker prose.
2. `repairDecision` can recognize a uniquely declared missing artifact producer in
   work/local verification. `deferNode` validates the proposed edge with the existing
   graph checker, pins a replay commit of clean saved edits and persists
   `NodeState.dependencyWork`. The same execution loop revisits the task after its
   producers integrate. Replay applies the saved delta on the current integration
   base; conflicts hold and retain source. Verification remains mandatory. A revisit
   spends a remaining implementation attempt; it does not spend or renew repair
   rounds. A subsequent quota checkpoint takes precedence over the older replay
   metadata because it already contains those edits. Cycles, exhausted attempts
   and already charged repairs hold.
3. Recognizable worker transport/rate-limit errors can select a distinct alternate
   already configured in the harness chain. This uses the existing capped attempt
   loop and saved workspace, clears the old conversation, and persists the next
   attempt before dispatch. Authentication, ambiguous timeouts, verifier failures
   and unknown errors do not receive this fallback. A work-command override is not
   silently replaced. No new scheduler, cooldown budget or retry allowance exists.
4. Recognizable context exhaustion records that bounded runtime decomposition is
   unavailable. Failed work remains pinned; unchanged oversized tasks are not
   automatically retried.
5. `phase` snapshots required evidence hashes before check execution.
   `evidenceFailure` accepts witnessed creation/content change as proof of current
   evidence when the filesystem timestamp predates `Date.now()`. A local probe
   reproduced newly written timestamps up to 0.553 ms before the immediately
   preceding clock read (551/1,000 writes). No clock tolerance was added:
   unchanged old evidence still fails, and subsequent deletion/change still
   invalidates accepted evidence. A deterministic production-path test forces
   old timestamps for both changed and unchanged evidence.

Old failed/deferred check records remain observations, never passes. Source and
dependency changes flow into the existing frozen acceptance identity; final checks
run again for the resulting source/requirements/check identity. The single-writer
lock, repair authority, immutable check artifacts and saved-candidate paths remain.

## Remaining autonomy gaps, in practical order

1. A missing producer absent from all declared contracts cannot be safely invented.
   Ambiguous producer identity or a cycle needs graph/requirement correction.
2. A producer's sole local verifier may actually be a composed acceptance suite.
   Safe progress requires a separate meaningful local check, plus moving composed
   acceptance to existing checkpoint obligations. No automatic checker synthesis.
3. Runtime decomposition is absent. Context exhaustion preserves work but requires
   bounded child contracts, ownership, requirement coverage and safe graph replacement.
4. Transient errors without a configured distinct alternate hold. No persisted
   cooldown for the same provider was added. Confirmed quota waiting pauses all
   dispatch, including independent work on other providers.
5. Auth/permissions, setup defects, ambiguous timeouts, failed producers with no
   remaining authority, replay conflicts and disputed diagnoses still require an
   established authorized recovery. No indiscriminate retry or policy edits.

The next smallest useful change is admission diagnostics for node-local checks
that need downstream work, with an explicit migration to existing composed
checkpoint checks and a separately authored local verifier. This fixes a recurring
planning mistake without weakening candidate integrity or introducing provisional
completion. Runtime decomposition should remain a separately bounded change.

## Verification

`src/flow3/autonomy.test.ts` exercises actual `DagRunner`/`FlowRunner` execution,
Git worktrees, integration, persisted state and subprocess death. Scenarios cover
authorized fallback/exhaustion, auth/context holds, early producer promotion,
admission closure, wave diagnosis, local deferred edits, failed producers,
cycle rejection and crash/resume. Existing Flow 3 suites cover candidate recovery,
repair budgets/authority, identity invalidation, inconclusive evidence and locks.
Executed results:

* `npm test`: **566 passed, 0 failed**, 40 suites, after the evidence freshness
  correction. Log: `C:/Users/Fresc/.lightweight-dag/flow3-autonomy-verified-suite.log`.
* Final targeted execution after the one-line quota/replay precedence correction:
  `node --test --test-name-pattern 'quota interruption during prerequisite replay|witnessed evidence changes|verified candidate survives process death' dist/flow3/autonomy.test.js`:
  **3 passed, 0 failed**. This includes the additional combined recovery scenario
  introduced after the full-suite run started.
* Earlier focused execution of the five Flow 3 test files: **72 passed, 0 failed**.
* `npm run build` and `git diff --check`: passed on the final code.

Initial full runs were not clean: the first reported 560/562 passes (the old
local-producer hold assertion and the evidence-clock case); the next reported
564/565 passes (the evidence-clock case). The obsolete assertion was updated for
the intentional defer behavior, and the timestamp defect was corrected with
witnessed evidence changes. The passing full run above follows those corrections;
the earlier failures are not counted as passing results.

Live provider requests, real rate-limit resets and automatic runtime decomposition
are not demonstrated by deterministic executor scenarios.
