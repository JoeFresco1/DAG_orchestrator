# Flow 3.0 continuation incident, 2026-10-20

Run `run_f07fc55f`, task `task_full_018_scope_t008`, attempt 1 used Codex
`gpt-6-luna` at `xhigh`. Its work phase began at 13:17:58 UTC and hit the
900,000 ms deadline at 13:32:58 UTC while waiting for a repository-wide test run.
The runner preserved 140 test-line additions in failed-attempt commit
`ffd6a4fc186c259277c8b44b94f1646875e495ab`; they were not accepted or merged.

The primary failure was orchestration: expensive acceptance ran inside the
implementation clock, despite a separate final-check configuration. Retained
legacy task prose still instructed the worker to run those suites. A second
orchestration error ran final acceptance before eleven required producers had
executed, producing expected missing-99-artifact failures. Independent baseline
product assertions and a Python `scripts` import error were also observed;
neither is evidence that the unfinished 99 implementations failed acceptance.

Evidence remains in
`C:/Users/Fresc/.lightweight-dag/continuations/run_1df76ca0-flow3/archive/recovery-20261020`.
The original `run_1df76ca0` and its completed-task evidence were not changed.

The user subsequently authorized finishing the implementation chain and fixing
real acceptance failures through review. Recovery uses a fresh explicit retry
cycle for the first task, retains lifetime attempts, raises implementation time
to 45 minutes, and generates one current worker brief with explicit runner-owned
acceptance. Build, syntax, file ownership and assigned artifact checks gate
landing. All 49 original acceptance references still map to the same 21 final
executions, preserving their original deadlines and nonempty-test rules.

The engine now defers final acceptance until all selected nodes are complete.
Independent ready work still progresses. A new regression reproduces a failed
producer, asserts that final checks do not run, explicitly retries it, and proves
the full check runs after the consumer is implemented. All 19 Flow 3.0 tests and
the engine build passed before restart. Worker prompt effectiveness and product
acceptance still require evidence from the resumed live run.

Retain the invariant in runner code and tests: missing prerequisites are waiting
conditions, not executed product failures. A truly failing test after its inputs
exist must still fail acceptance. Increasing implementation time alone would
not enforce that invariant or establish that the product works.

## Verification repair eligibility, 2026-10-21

Continuation task `task_full_99_scope_t002`, attempt 1 completed its work in
1,438,120 ms, then failed its 991 ms verifier because `COMPLETION.md` was rewritten
with CRLF endings. `git diff --check` reported trailing whitespace on all 747
report lines. The saved unverified implementation was pinned at
`5854d8e0c81b5a6632a1a39f93dcc5f5a5eeed65`. The continuation used one implementation
attempt and zero checkpoint repair rounds, so this formatting error blocked the
release handover until an explicit recovery reused the saved work with LF endings.

The user authorized a repair agent with prerequisite and scope guardrails. The
main engine now gives eligible verifier failures one in-place repair by default,
with a separate five-minute deadline and persisted round/failure records. It
reruns the original verifier before landing. Tests/contracts/check configuration
and check entrypoints are protected; out-of-scope edits, no-change repairs and
unchanged failure signatures stop automatic repair. Checkpoint repairs retain
the shared two-round cap and require bounded ownership and a concrete diagnostic.
Execution policy snapshots record the effective local/global budgets and timeout.

Declared `verify_requires` adds only known, acyclic producer edges at admission.
`checkPrerequisites` can defer a composed check until its known producers complete.
A missing-file diagnostic can also defer a checkpoint when it identifies one
unfinished artifact producer. Deferred results never certify acceptance or consume
repair budget. Unknown or ambiguous producers, cycles, missing environment inputs,
quota/authentication/timeouts and unclassified errors are held for diagnosis.
Failed nodes no longer receive indiscriminate fresh cycles from the run-level
checkpoint budget.

Validation: engine build passed; the combined 40-test run passed (33 Flow 3.0
regressions and seven execution-policy tests), including a
real Git CRLF rejection repaired in one saved implementation attempt, deferred
producer checks, acceptance/script/scope protection, timeout containment, repeated
failure detection, the two-round checkpoint cap and scope restrictions surviving
explicit retry/storage reload. The final additions cover self-referential
verification dependencies and disabling node repairs without the global checkpoint
budget bypassing that decision. Seven targeted final checks passed for those
paths, followed by four passing protection/deadline/retry checks including nested
package-script entrypoints. The running continuation uses its existing pinned engine; these changes
were not injected into an active run.

## Controller boundaries during publication checks, 2026-10-21

The first complete repository suite reported 508 passing and 18 failing tests.
Most failures shared one cause: the ordinary CLI rejected the historical execution
profile before loading the verified reliability-controller hooks. The controller
never reached implementation, review or recovery. The CLI now verifies the parent
controller lease and receipt first, and exempts only that authenticated managed
execution from the ordinary profile-retirement gate. Ordinary historical runs
still require an explicit supported-profile upgrade.

A factory-cycle regression reproduced a second boundary issue: ordinary follow-up
and discovery instructions were appended after a structured root-cause JSON packet.
Prompt guidance now applies to unmanaged lean workers, preserving controller-owned
packets and legacy harness argument contracts. The CLI isolation/scheduler fixtures
explicitly select a supported profile; all original outcome and acceptance
assertions remain. Factory assertion diagnostics now include the failed task reason.

The factory cycle, CLI isolation, scheduler outcome preservation, harness arguments
and a real CLI reliability-repair lifecycle passed their targeted reproductions.
The final complete repository suite passed all 526 tests with zero failures,
cancellations or skipped tests before publishing the combined branch.
