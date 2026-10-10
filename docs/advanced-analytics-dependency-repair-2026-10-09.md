# Analytics dependency repair — 2026-10-09

## Finding

The repeated stops were not evidence that every task exceeded Luna's capabilities. The graph required consumers to pass before their producers existed. The current CLI unit depended on a runtime/executor assigned to its successor. Similar impossible test-first ordering existed in source reuse and the analysis ledger. The final evidence matrix also preceded some of the journeys whose evidence it required.

A separate controller defect amplified this: expanded repair verification selected every task owning a shared implementation file, including unfinished downstream units. Correctly repairing an upstream function could therefore trigger acceptance requirements for future work.

## Amendment

- Preserve all 68 accepted task records and their evidence.
- Audit all 96 remaining original units, retaining a reason and replacement mapping for each.
- Replace the 164-unit graph with 185 units, including 117 remaining units.
- Establish runtime contracts, worker transport, budget handling, lifecycle dispatch, stage admission, lineage, prediction checks, report binding, exposure, finalization and runtime composition before CLI integration.
- Keep tests with the implementation that makes them pass; retain full feature and product acceptance after focused units.
- Register explicit consumed exports and producer dependencies. Prerequisite probes reject missing exports, comments and type-only declarations; behavioral tests remain the acceptance authority.
- Give workers and reviewers a unit-specific producer/consumer handoff and later-owner boundaries.
- Restrict expanded repair verification to already accepted owners of the expanded implementation files. Preserve accepted sibling-owner checks as well as ancestor checks.
- Preserve retry history, the existing deadline, and the Luna xhigh → Sol 6.1 medium → Sol 6.1 xhigh ladder. No Astra fallback.

The complete per-unit audit and original-to-replacement mappings are in the analytics repository's `docs/build/dependency-replan.md` and `.json`. Its `docs/build/task-handoffs.json` contains the execution handoffs. The planning commit is `e369fb4` on `codex/analytics-dependency-replan`, based on accepted implementation `34f5703`.

## Verification performed

- Spec coverage audit: 23 specs, 234 functional requirements, 114 edge cases; structural references resolve.
- Planning contract tests: unique task mapping, missing coverage, prerequisite ordering, cycles, declared output ownership and cross-feature conflicts pass.
- Compiled graph audit: 185 units, 68 accepted units preserved, all 96 former pending units accounted for, 117 handoffs, no cycles, and each declared consumed export has an earlier producer.
- Input-probe regression: source comments/types/declarations cannot masquerade as implemented exports; missing exports, empty probes and escaping paths fail.
- Recovery regression through the actual CLI/controller: a consumer repairs a shared producer, passes its own and the accepted producer's checks, and completes while the deliberately failing future owner's checks remain unexecuted.

These checks validate planning and recovery behavior. They do not establish that the remaining analytics implementation is complete or that future model attempts cannot fail. Sustained accepted progress must be measured on the amended run.

## Recovery and preservation

The amendment tool refuses an active controller, saves prior graph/configuration/ledger and completed task records under `.dag-build/dependency-replan-before-20261009`, uses supported DAG edit/add/remove/retry controls, and compares completed records and budget counters before and after. It advances only the run integration branch, without merging into the user's main branch.

The stopped old incident is retained as superseded history. New task work starts from the amended accepted integration baseline. The current CLI task retains its ID and attempt history but waits behind the newly explicit runtime producers.

The existing shared acceptance resource serializes admissions. This repair does not increase concurrency to mask dependency errors. Model cost is unavailable; existing time and attempt caps remain in force.

## Restart verification

The amendment applied successfully at 2026-10-10 02:36:59 UTC: 185 registered tasks, 68 accepted records unchanged, 117 pending; deadline and counters matched the saved baseline.

The first restart exposed a coordinator-introduced adapter error: `--approve-for-me` conflicts with `--sandbox workspace-write`. Codex exited during argument parsing, before model work. Removed the redundant sandbox option (`--approve-for-me` already selects workspace-write), retained explicit `--cd`, verified argument parsing locally, and released the environment suspension through `reliable amend` and `dag retry`. The failed startup receipts and infrastructure counts remain recorded; semantic/model counters were not reset.

The corrected controller launched at 02:39:34 UTC (PID 32160), passed prerequisite probes and dispatched `task_63bfefe6` / `003-runtime-contract`. Actual routing at 02:40:12 UTC records `gpt-6-luna`, `xhigh`. Its real shell returned `WRITE_PROBE=PASS; IGNORED=YES; CREATED_AND_REMOVED=YES`. At this checkpoint the task is executing, no suspension is present, and 68 tasks remain accepted; its independent review has not yet completed. Controller deadline remains October 10 at 09:31 Eastern. See `.dag-build/reliable-launch.json` for current logs and process identity; do not assume this snapshot remains live.
