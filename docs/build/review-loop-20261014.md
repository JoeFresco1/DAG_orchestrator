# Review-loop and prompt transport diagnosis

## Confirmed evidence

The advanced_test_2 full run `run_2d5b54c3` had 217 tasks. Planning revision
`0c7cff45307edca129c2dd4c24dee7e12a38a35dc760bc7e5a9f67436dc2d0fb`
passed with 23 fingerprinted prior packet passes and one fresh packet review.
The existing project coordinator already implements affected-packet review and
an explicitly authorized bounded integration repair pass. No second cache or
integration controller is needed.

Implementation task `task_full_toolchain` reached review on attempt 1 at
2026-10-14 02:34 UTC with a 534-line diff. Its 30,760-character rendered spec was
placed in argv. Windows rejected the reviewer launch with `ENAMETOOLONG`; no
verdict was produced. This is a transport failure, not proof of faulty
implementation or insufficient model capability. Actual state was one failed
task and 216 pending tasks, not 217 attempted failures.

The unmerged source is retained at salvage commit
`c7a28d92842d2887c2fa43ed46c7c90aee511d21` in the analytics repository, with
incident artifacts under `dag.full.d/incidents/toolchain-review-spawn-attempt-1`.
This change neither accepts nor requeues it and grants no additional attempts.

## Minimal core changes

- Native Codex exec prompts travel over stdin, preserving the complete prompt,
  upstream context, model, reasoning and output-schema arguments. Other harnesses
  and unsupported command shapes retain existing behavior.
- Newly compiled canonical tasks no longer silently receive a review redo.
  Existing persisted factory review policies remain intact.
- Semantic review instructions distinguish concrete execution blockers from
  nonblocking integration follow-ups. Missing evidence remains inconclusive.
- The optional planning correction helper permits one correction/recheck,
  refuses unchanged corrections, and does not retry inconclusive evidence.

The 800-character decomposition budget measures authored task responsibility.
It does not constrain the full generated evidence packet. Truncating requirements
to work around a Windows command-line limit would be the wrong repair.

## Verification

Compilation and 41 focused tests passed. A real subprocess verifies the hash of
more than 180,000 characters received through stdin with short argv and unchanged
model/reasoning options. Regressions also cover no automatic task review redo,
one bounded planning correction, no unchanged review repeat, inconclusive evidence
remaining unapproved, and persisted factory policy preservation.

The full suite passed from a clean detached checkout containing these changes:
378 tests passed, zero failures or skips. Results are recorded in
`output/review-simplification-clean-suite-20261014.log`.
The earlier root-checkout run was stopped because stale compiled tests had no
corresponding source files; its log is retained but is not the authoritative
result. Live model review and analytics execution have not been relaunched as
part of these regressions.
