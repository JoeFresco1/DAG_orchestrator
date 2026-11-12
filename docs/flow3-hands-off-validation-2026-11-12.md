# Hands-off development validation — 2026-11-12

The changes improve autonomous execution, but do **not** yet establish unattended
specification-to-software completion. An authored plan with deliberately bad
verification/decomposition boundaries still stops. A separately supplied corrected
plan completes under favorable producer timing and repair ownership. Two additional
stress variants expose stops even with those plan corrections.

Only the evidence driver and this report were added during this validation. No
production scheduler, recovery mechanism, requirement, or acceptance implementation
was changed.

## Exact version and full-suite result

Committed HEAD is `b54246e24fd18055a51c898be5059d134002d5b9`. The previous changes,
including the final quota/replay precedence correction, are still **uncommitted**.
Consequently, testing committed HEAD alone would omit the changes under evaluation.

`npm test` was rerun against the current working tree:

* **567 passed, 0 failed, 40 suites**, 419.204 seconds including the test runner
  measurement; the npm command also rebuilt the code first.
* Log: `C:/Users/Fresc/.lightweight-dag/flow3-e2e-current-suite-2026-11-12.log`.
* Production/test source and build-input fingerprint:
  `b0b7a828b1fffc91717d58348feb3ace15ad80c04f71e7e208ad195c0a4da53e`.
  Each experiment recorded the same fingerprint and checked it again after its
  runs. No production source changed between suite execution and these experiments.
* The baseline comparator was a fresh `git archive` of committed HEAD, compiled
  separately using the same installed dependencies and Node v24.11.1 on Windows.
  Baseline means committed HEAD, not a promise that it differs solely by the last
  patch: the working tree also contains the pre-existing quota/progress changes.

## What was real and what was simulated

The fixture is an executable JavaScript order-processing CLI with nine immutable
requirements:

| Requirement | Behavior / implementation owner |
| --- | --- |
| R1 | Case-normalized catalog lookup and integer-cent price validation |
| R2 | Nonmutating stock reservation and insufficient-stock rejection |
| R3 | Ten-percent discount across all units, rounded in integer cents |
| R4 | Catalog-backed basket totals and invalid basket rejection |
| R5 | Checkout composing basket, discount, inventory and audit |
| R6 | Receipt rendering and invalid-total rejection |
| R7 | JSON stdin/stdout CLI, receipt/report output, nonzero invalid-order exit |
| R8 | Date/status sales selection plus sorted daily CSV aggregation, with boundary/rejection cases |
| R9 | Order-linked audit event creation |

The flawed planner response contains nine nodes. R8 is one oversized node. The
corrected response has ten nodes: R8 is split into filtering and aggregation, with
its original requirement text preserved. That response also assigns checkout a
meaningful local check; the unchanged composed receipt check remains required in
final acceptance. Both responses, their validation output and compiled run files
are retained in each fixture.

Planning/advisory/implementation/repair responses are deterministic simulations.
No real model or reasoning profile is represented by them. Provider labels are
`opencode` then `codex` solely to exercise an authorized harness chain. Worker
responses write actual modules; repairs obey the scope granted by FlowRunner and
refuse an incorrectly scoped repair. The advisory identifies the oversized node
and verification boundary but cannot mutate the plan.

The production CLI performs plan validation/compilation. Production `DagRunner`
delegates to `FlowRunner`; its normal scheduler, locks, durable store, worktrees,
Git integration, diagnosis, retry and repair paths execute. Every verifier runs a
real Node child process through `shellExecutor`. Frozen checks contain actual
assertions, module imports, CLI subprocess execution and negative-input cases.
No verifier returns a simulated pass.

Concurrency is three worker slots; implementation attempts retain the existing
two-attempt cap; checkpoint repair allowance is two and node repair allowance one.
The persisted run wall limit is 180 seconds. Configured final semantic review is
off; no target-branch publication is performed. Acceptance is against integration.

An independent post-run checkout of the accepted integration commit also passed
`node checks.mjs acceptance` and a real CLI request. Its output was:

```json
{"receipt":"order-1:270","csv":"date,orders,total\n2026-01-01,1,270\n"}
```

The final checkpoint contains 13 passing results for one identity, including a
16-behavioral-group full acceptance command naming R1–R9. Requirements and check
source are unchanged on every tested integration branch.

There are **no validated live-provider results**. A discarded pilot reached the
installed advisory command before its normal cancellation; no conclusive live
result was obtained and that pilot is excluded. All model phases in the recorded
matrix are intercepted, and the adapter rejects any unsimulated provider command.
These measurements do not establish real-model planning quality, context capacity,
token cost, provider reset behavior, or performance at 40 specifications.

## Decomposition is not native to this Flow 3 entry point

The raw nine-specification input is rejected with:
`Expected version 3 plan with title and nodes`.

`src/commands/planning.ts:35`–`compileFlowPlan` accepts authored node plans and
converts existing v2 task manifests; it does not invoke a specification-to-task
generator. `src/flow3/graph.ts:39` emits an advisory size warning. The running
FlowRunner does not split the oversized node.

The planner responses here are supplied by the fixture adapter, not generated by
FlowRunner. Calling their decomposition an autonomous system achievement would be
incorrect. The corrected response is an explicit counterfactual input, not a
successful recovery of the stopped flawed run. Its two external plan
transformations must not be hidden in a zero-human-intervention completion claim.

## Fault injection and timing controls

All cases omit basket's catalog dependency and `relies_on` declaration, so artifact
inference cannot silently fix it at admission. The actual basket check imports
catalog and reports the missing file. Inventory writes partial source, returns a
simulated HTTP 503 once, then succeeds only on an authorized alternate. Original
reporting writes saved partial source and reports simulated context exhaustion.

Checkout's flawed assigned verifier requires receipt, while receipt depends on
checkout. Explicitly declaring `verify_requires: ['receipt']` is separately tested
and rejected at admission as a cycle. The main scenario leaves that prerequisite
implicit so implementation executes and the runtime diagnosis is exercised.

Discount initially implements the wrong multi-unit calculation. Its local
single-unit check passes; the integration-pricing check really fails with an
assertion naming `discount.mjs` after five original tasks have integrated.

Three independently isolated modes were run, each comparing baseline/current
against flawed/corrected planner responses: **12 recorded executions**.

1. **Owner in the observing wave:** catalog is kept unfinished until basket's
   missing-input diagnosis. Discount has a valid declared catalog prerequisite,
   placing the discount owner in the wave that observes the later pricing defect.
2. **Owner in an earlier wave:** the same producer timing, but discount is an
   independent earlier task. This tests cross-wave repair attribution.
3. **Producer already integrated:** catalog completes before the real basket
   verification command executes in its already-created stale worktree. This
   deterministically reproduces a race first seen without timing controls.

Timing controls delay adapter responses or check dispatch; they do not alter
check contents, results, runtime dependency decisions or task status. They are
fixture fault injection, not another scheduler.

## Measured results

Counts below are original authored nodes; generated repair tasks are separate.
Successful recovery actions are classified strategies, not the number of log
messages. Repeated work means extra implementation requests; preserved edits were
asserted before the inventory fallback and basket revisit. Elapsed time is one
`runner.start()` through cleanup, excluding fixture setup, baseline compilation,
simulated planning and the subsequent diagnostic resume/probes. Runs shared the
host, so durations are observations rather than provider performance benchmarks.

| Mode | Engine / planner response | Original tasks completed | Repairs completed | Successful autonomous recoveries | Repeat implementation requests | Coding repair requests | Run seconds | Final acceptance |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Owner in wave | HEAD / flawed | 3/9 | 0 | 0 | 0 | 0 | 12.41 | Pending |
| Owner in wave | Current / flawed | 5/9 | 1 | 3 | 2 | 1 | 23.28 | Pending |
| Owner in wave | HEAD / corrected | 5/10 | 0 | 0 | 0 | 0 | 16.92 | Pending |
| Owner in wave | Current / corrected | 10/10 | 1 | 3 | 2 | 1 | 41.67 | Passed |
| Owner earlier | HEAD / flawed | 3/9 | 0 | 0 | 0 | 0 | 12.36 | Pending |
| Owner earlier | Current / flawed | 5/9 | 0 | 2 | 2 | 1 | 20.67 | Pending |
| Owner earlier | HEAD / corrected | 5/10 | 0 | 0 | 0 | 0 | 16.61 | Pending |
| Owner earlier | Current / corrected | 9/10 | 0 | 2 | 2 | 2 | 31.28 | Pending |
| Producer integrated | HEAD / flawed | 3/9 | 0 | 0 | 0 | 0 | 13.60 | Pending |
| Producer integrated | Current / flawed | 4/9 | 0 | 1 | 1 | 0 | 15.18 | Pending |
| Producer integrated | HEAD / corrected | 5/10 | 0 | 0 | 0 | 0 | 17.33 | Pending |
| Producer integrated | Current / corrected | 6/10 | 0 | 1 | 1 | 0 | 18.04 | Pending |

No human acted during an execution. However, no flawed response reached product
completion. Two plan transformations were supplied externally before each
corrected run. This is not evidence that two interventions always suffice: the
other timing/ownership variants still stop after those transformations.

The current primary flawed run made nine original implementation requests across
seven started tasks, plus one generated repair request. Extra implementation
requests were inventory's provider fallback and basket's saved-edit revisit.
Previously accepted original tasks were not redispatched for implementation;
discount was changed through its separate bounded repair. One of two checkpoint
rounds was charged. Checkout's cycle and reporting's size hold charged no node
repair. A diagnostic restart from the saved run made **zero executor calls**,
retained attempts, and left the repair charge at one.

The successful corrected run made 12 original implementation requests for ten
nodes plus one generated repair. There were no remaining task checks or final
suites. The failed primary run retains four unmet original task checks
(checkout, receipt, reporting, CLI) and two unexecuted final suites. Historical
deferred/failed observations remain false; they were not converted to passes.

## Exact stops and whether continuation would be safe

| Stop | Observed state / why execution settles | Could FlowRunner safely continue as currently implemented? |
| --- | --- | --- |
| Downstream local verification | Checkout has saved unaccepted source; its standalone frozen local check passes. Assigned composed check fails solely because `receipt.mjs` is absent. `deferNode` proposes checkout → receipt; `checkGraph` rejects the cycle because receipt → checkout already exists. Receipt and CLI remain pending. | **No with the declared verifier.** Adding the reverse edge or calling the task complete would be unsafe. A justified verification-boundary correction could retain composed acceptance and select an independently meaningful local integrity check. The runner does not currently authorize/make that correction. |
| Oversized reporting | Real admission warning is advisory. Simulated context exhaustion leaves a pinned partial source branch, one spent attempt, no child tasks and a policy hold. | **No automatic decomposition path exists.** Another identical implementation attempt is not an established recovery. A bounded revised task plan is needed. |
| Completed producer, stale worktree | Basket's real check cannot load catalog in its old worktree, although catalog is already integrated. `repairDecision` only returns producers whose status is not completed, so it holds instead of refreshing/rechecking basket. Basket remains failed; checkout, receipt and CLI cannot start. | **The available artifacts make a bounded refresh/reverification potentially safe**, preserving saved edits and checking integration conflicts. The existing loop has no route for this completed-producer case; plain resume does nothing. No coding repair was justified by this missing input. |
| Earlier-wave defect owner | The check correctly names discount, but `fixTouches` considers `check.nodes` from the observing wave. The generated repair owns basket instead of discount. The simulated repair refuses the unauthorized modification. With the corrected plan, CLI later detects the same upstream defect and also refuses to repair discount through CLI ownership. | **Not by widening the current worker's authority.** The existing runner could support a bounded repair of the actual declared owner, but current attribution does not find/authorize it here. A checkpoint repair and, in the corrected case, one node repair are spent; resume does not renew them. |

These stops are ordinary incomplete run outcomes, not crashes or exhausted run
wall time. `FlowRunner.run` reaches the required-implementation gate with failed
or pending work and defers final acceptance. The primary run still has unused
repair capacity, but its remaining causes are not authorized coding repairs.

Relevant production locations:

* `src/flow3/runner.ts`, `schedule` / `runChain`: dispatch and wave snapshots;
  `run`: required-work gate before final acceptance.
* `src/flow3/runner.ts`, `verifyNode` / `deferNode`: local check diagnosis, saved
  work, graph validation and cycle hold.
* `src/flow3/repair.ts`, `repairDecision`: declared/matched unfinished producer
  filter, resource/capacity hold and implementation repair classification.
* `src/flow3/runner.ts`, `fixTouches` / `addFix`: observing-wave ownership,
  persisted intent and durable charge.
* `src/flow3/graph.ts`, `checkGraph` / `compileFlowPlan`: admission, inferred
  producer edges, cycles and advisory sizing.

## Highest-impact recommendation

**Add a bounded verification-aware plan-correction action inside the existing
FlowRunner lifecycle, starting with local-verifier/downstream-consumer cycles.**

Its first supported correction should select an explicitly justified meaningful
local integrity check and retain the original composed check as a pending
acceptance obligation. It must validate the revised graph, preserve requirement
coverage and saved source, invalidate changed acceptance identity, and retain spent
budgets. It must not silently skip the sole verifier or integrate source on an
agent's completion claim. The existing single scheduler/store should own any
correction intent.

The evidence for prioritizing this over another retry path is concrete: local
checkout code already passes, yet the bad verification boundary blocks checkout,
receipt and CLI. Coupled with bounded decomposition of the oversized reporting
unit, the externally corrected input completes in the ownership control; the
runner cannot currently make either correction itself. Upfront verification-aware
specification decomposition is also missing from this Flow 3 entry point.

The stale-worktree and cross-wave owner findings remain separate high-impact gaps.
They should not be hidden by the successful controlled case. No implementation of
this recommendation was made during validation.

## Reproduce and inspect

Driver: `scripts/flow3-e2e-evidence.mjs`. From the repository, run the following
against a fresh output prefix; each invocation creates isolated fixture repos:

```powershell
npm run build
node scripts/flow3-e2e-evidence.mjs . C:\Users\Fresc\.lightweight-dag\experiments --gate-catalog --cohort-discount
node scripts/flow3-e2e-evidence.mjs . C:\Users\Fresc\.lightweight-dag\experiments --gate-catalog
node scripts/flow3-e2e-evidence.mjs . C:\Users\Fresc\.lightweight-dag\experiments
```

Recorded evidence directories:

* Owner-in-wave control: `C:/Users/Fresc/.lightweight-dag/experiments/flow3-e2e-2026-11-12-6iqJnP`.
* Cross-wave owner: `C:/Users/Fresc/.lightweight-dag/experiments/flow3-e2e-2026-11-12-ELZ2cu`.
* Already-integrated producer: `C:/Users/Fresc/.lightweight-dag/experiments/flow3-e2e-2026-11-12-tD3AS7`.
* Aggregate measurements and post-run product probe:
  `C:/Users/Fresc/.lightweight-dag/experiments/flow3-e2e-summary-2026-11-12.json`.

Each directory retains provenance, admission probes, per-run evidence, executor
traces, events, original specifications, planner responses, Git source, immutable
check records and the ordinary `dag.run.json` / sidecar store. Earlier pilot and
exploratory datasets are retained separately and are excluded from the table.
