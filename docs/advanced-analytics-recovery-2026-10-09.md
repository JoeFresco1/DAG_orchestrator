# Analytics build recovery: October 9, 2026

This follow-up supersedes the stopped-run snapshot in the handoff document.

## Reproduced causes

T004's worker added four top-level fixture helpers to a protected existing test
module. The registration allowed additional test calls but no new module support
statements. The source was retained and the exact guard error was reproduced.

Recovery then failed at the orchestration layer:

1. The normal worker guard reported ownership; the repair guard threw an untyped
   error. The controller treated the latter as a contract dispute and suspended.
2. Incident JSON was written before diagnosis. Repair executed in the same call
   after classification without refreshing that JSON, so the worker received stale
   diagnostic context.
3. Failed checks were retained as receipts but not supplied as a current repair
   target. Large historical command outputs were included in subsequent prompts.
4. The prompt said to preserve existing helpers and add top-level tests, without
   stating explicitly that new helpers must live inside those test/suite callbacks.
5. Neither the original worker mistake nor its repeated repair was counted as a
   semantic rejection, so the model ladder could not advance correctly.

These observations establish controller and feedback defects. They do not establish
that every remaining task is too complex for Luna.

## Corrections

Engine commit: `8ba910e` (`Recover protected-test violations with fresh bounded feedback`).
Historical-outcome follow-up: `a9e10d6`. The follow-up preserves unknown old exit
outcomes without charging them and corrects inferred charges on a subsequent
resume. The live process was started on `8ba910e`; a planned boundary reload was
refused because the stage had already advanced, preserving the active engine.

- Protected-test violations have structured implementation failures with exact
  validation rule, file and evidence. They return to bounded repair instead of
  creating a contract suspension.
- Test baselines, frozen contracts, scope and Git history remain protected.
- Each retry gets the latest guard/check/review failure. Its incident snapshot is
  refreshed immediately before the repair command.
- Full receipts remain in the ledger; prompt snapshots carry relevant excerpts
  and a ledger reference. The live T004 repair snapshot measured 6,599 bytes.
- Known mechanical test violations use deterministic diagnosis instead of an LLM
  call to repeat the validator's finding.
- Resume reclassifies a legacy suspension only when the registered guard reproduces
  its exact recorded error on retained source. Matching original worker failures
  are counted. Historical repair requires positive zero-exit evidence; otherwise
  its outcome remains unknown and uncharged. A previously inferred charge is
  corrected with a new event, preserving original history; no budget is reset.
- Provider failures do not charge another implementation rejection merely because
  an earlier invalid test remains in the retained worktree.
- The analytics adapter states the exact helper/import restrictions for every unit
  and removes irrelevant 002-specific instructions from other units. The narrow
  idempotent update script is committed with the engine.

## Verification

- `pnpm build` passed.
- Registration preflight passed for all 164 tasks/contracts.
- All 29 existing controller tests passed in the broader run.
- The new guard recovery tests passed across focused runs: real CLI
  reject/correct/check/review/publish/completion; retained legacy suspension
  recovery; strict support and assertion protection; frozen/history hard stops;
  quota with invalid retained source preserving semantic budget; legacy recorded
  versus unknown exits; and correction of an earlier inferred charge.
- The first broader run exposed an incorrect new test expectation of one review;
  the actual pipeline deliberately performs repair review and fresh task review.
  The expectation was corrected to two and those regressions were rerun successfully.

## Live rollout and remaining limits

At 5:32 PM Eastern the same analytics run `run_b3a47590` resumed with controller
PID 24644 and recorded process birth. The retained T004 incident was released by
exact guard reproduction; semantic count was reconciled from zero to two known
rejected attempts. Luna xhigh was confirmed in the actual repair route, with no
remaining suspension. The existing deadline remains October 10 at 9:31 AM Eastern.

The live worker moved the helpers inside a prefixed parent test, awaited all eight
child cases, and passed `pnpm build` and unchanged scope acceptance (nine tests
including the parent). A separate coordinator read-only guard invocation passed
against that actual source. The controller checks and independent review then
passed, and the repair was published and requeued through the supported CLI.
The latest snapshot still counted 67/164 completed with T004 running its fresh
completion gate and no suspension. This does not claim all remaining units have
completed.

The next 11 units share the same test file; the shared guidance and recovery
correction therefore apply to a demonstrated recurring boundary. No ownership,
requirements or dependency graph was changed. T006/T007 is a relatively broad
integration unit and T016 is the whole-feature/live-demo gate; diagnose actual
rejections there before changing decomposition.

Acceptance capacity remains one, so task admissions are serialized even though
policy concurrency is three. Fresh task work/review after repair publication
still duplicates some effort. That optimization was deferred to preserve the
existing independent completion gate while correcting the demonstrated stop.

Use the live status/lease/routes for current state; this document is a snapshot.
