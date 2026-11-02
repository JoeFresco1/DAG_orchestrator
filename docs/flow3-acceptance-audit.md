# Flow 3 acceptance lifecycle audit (2026-11-01)

This audit precedes implementation. Authority remains `FlowRunner`, `Run.flowState`,
node state and the existing store. No additional scheduler or recovery service.

| Requirement | Existing evidence | Initial classification / demonstrated gap |
| --- | --- | --- |
| 1 Incremental integration | `node` verifies/pins a candidate; `land` serializes integration before downstream dispatch; chain tests exercise upstream files | Implemented and verified. Preserve. |
| 2 Completion scope | `run` blocks final checkpoint on incomplete selected nodes | Incomplete: selection is ephemeral; required/optional/product claims are absent; discovered producers outside selection are not reopened. |
| 3 Repair/review authority | `repairDecision`, `guardedRepair`, protected files, standalone review workflows | Incomplete: checkpoint context lacks durable authority; Flow 3 ignores configured final review. Standalone approval gates must stay unchanged. |
| 4 Acceptance identity | Checkpoint stores HEAD; dirty source guard | Incomplete: checks/requirements/external inputs absent; committed source mutation escapes dirty guard; results lack identity. |
| 5 Diagnose first | Conservative implementation/dependency/environment/policy/unknown routing | Incomplete: no explicit analytical/review-dispute/acceptance-gap classification. Unknown causes already hold; preserve that default. |
| 6 Accounting | Node repairAttempts; shared checkpoint repairRound; phase caps | Incomplete: retry/edit clears node counters; run deadline restarts; checkpoint creation spans multiple writes. Infrastructure is held, not automatically retried. |
| 7 Recoverable bounded repairs | File scopes, failure fingerprints, checkpoint output, saved candidates | Incomplete: no durable intent linking finding, charge and task; prompts can lose newer diagnosis. |
| 8 Focused verification | Node verify; final reruns completed node checks; prerequisites defer wave checks | Incomplete: repair nodes only run diff-check locally; accepted siblings are not checked until final; coarse checkpoint ownership. |
| 9 Conclusive evidence / reporting | Exit-code checks; empty configuration and stopped checkpoints fail | Incomplete: zero-test or inconclusive exit-zero output passes; missing evidence not configurable; separate lifecycle statuses absent. |

Implementation acceptance mapping: required unfinished/scoped/new producer cases ->
completion gate tests; incremental integration -> existing chain tests; authority and
optional review -> guard and configured review tests; frozen input/mutation/stale
review -> identity tests; budget/recovery -> durable journal/retry tests; negative
analysis/disputed review -> diagnosis tests; shared files -> sibling verification
tests; empty/interrupted/missing/inconclusive -> evidence tests; crash exactly-once
and latest prompts -> intent recovery tests. Existing scheduler/store remain the
only authority in all cases.

No ordinary Flow 3 target-branch auto-merge policy exists: accepted work stays on
its integration branch. Target-branch publication must therefore remain separate
and cannot be reported as merged merely because integration succeeded.

## Gap closure

The changes extend `FlowRunner` and `flowState`; accepted node integration and
standalone workflow approval gates are retained. The new `lifecycle` module is
pure completion/identity/evidence support, not another scheduler or state store.

| Gap | Consolidated implementation | Behavioral evidence |
| --- | --- | --- |
| Persist completion scope | `completionScope`, scheduler required closure, CLI/server full-run selection | Scoped resume; whole-product optional failure; discovered required producer; CLI product reporting |
| Complete acceptance identity | `acceptanceIdentity`, checkpoint/result identity and raw evidence sidecars | Source commit mutation, requirement/check/environment/fixture identities; verifier and reviewer mutation |
| Durable authority and accounting | Lifetime node ledger, checkpoint intent journal, persisted command/scope, fixed run deadline | Retry/edit accounting, no switching rejected repairs to implementation, two existing shared-round tests |
| Recoverable repair work | Stable task identity, pre-dispatch scope snapshot, saved-edit verification recovery | Injected crash between charge/task creation; real process death in both local and checkpoint repair |
| Focused verification | Overlapping accepted owners and accepted dependency closure; pending repairs precede downstream waves | Shared-file accepted siblings; unfinished downstream check excluded |
| Conclusive evidence | Explicit outcomes, positive test evidence, current required files, mutation guards | Empty/all-skipped/interrupted/missing/inconclusive cases; normal successful Node output retained |
| Review/reporting | Optional configured reviews bound to identity, diff tokens, raw output/history, separate lifecycle facts | Required review reruns on changed requirements; failure distinct from deterministic acceptance; optional review stays off |
| Conservative diagnosis | Analytical/review-dispute/acceptance-gap classifications retain evidence and hold for adjudication | Negative analytical outcomes and rejected reviewer findings do not authorize speculative coding |

Review findings that lack a reproduced implementation defect are held with their
original evidence. Fixture/acceptance corrections still need the applicable
explicit policy/approved work; this change does not weaken protected acceptance
sources or turn a reviewer claim into modification authority. `finalReviewRounds`
does not create a separate pool of speculative repairs.

## Original delivery validation (superseded by the recheck below)

- Build/type checking passes (`npm run build`).
- New lifecycle suite: 13/13 pass, including real process death during both local
  and checkpoint repairs and retry-mechanism budget preservation.
- Latest evidence/optional-producer/review-mutation boundary rerun: 3/3 pass.
- Broad suite: 539 executed, 538 passed. Its sole failure was the checkpoint
  retry diagnostic intercepted by the newly added local-repair hold. The hold
  was narrowed to local repairs; checkpoint retry and live-runner lock regression
  reruns both pass (2/2). The broad suite was not repeated after that final fix.
- `git diff --check` passes.

Logs: `output/acceptance-frozen-suite.log`,
`output/acceptance-lifecycle-delivery.log`,
`output/acceptance-final-boundaries.log`, and
`output/acceptance-final-retry-lock.log`.


## Requested recheck

A second code review found additional gaps beyond the original regression coverage.
These were fixed before the final full-suite run:

| Finding | Correction and regression coverage |
| --- | --- |
| Passing test names containing interrupted/inconclusive/cancelled were mistaken for failed execution outcomes | Parse outcome lines and test summaries separately from test descriptions; preserve valid analytical prose. Reject swallowed TAP failures and empty test-file summaries. |
| A second crash during repair recovery made the saved workspace impossible to resume | Create a recovered commit object without advancing the saved worker HEAD. The real process-death test now kills both the coding process and its first recovery verifier, for local and checkpoint repairs. |
| Explicit subset selection inherited every required task from a prior whole-product target; producer closures were also listed as excluded | An explicit selection establishes its scoped target and actual producer closure; ordinary resumes retain their saved target. Required producer IDs cannot also be excluded. |
| A missing producer already failed/skipped could remain classified as optional | Promote all identified unfinished producers to required. Failed work still needs its applicable retry authority; promotion does not grant attempts. |
| Later checks or review could erase/replace required evidence without invalidating the earlier pass | Record evidence hashes with results and validate them through checkpoint completion and review. |
| Per-task review claimed unreviewed tasks and could pass without any eligible review | Persist individual pass/fail/error coverage, reject empty required review, retain earlier output on later errors and across interrupted reviews. Use frozen check commands even if a reviewer damages package configuration. |
| Retained repair context could invoke checks for an owner that was no longer accepted | Filter focused obligations against current accepted owner status; pending siblings remain excluded until their own implementation completes. |

Repair authority validation is shared by fresh repairs, saved candidates and recovery;
node repair contexts retain raw evidence references. Relevant harness, silence and
review configuration also participate in the acceptance identity.

The broad run exposed an existing detached-notification test race: it assumed the
run-end child finished after the task-fail child. The test now waits for both
required observations and retains every assertion. Notification behavior was not
changed.

Final validation supersedes the earlier partial full-suite result:

- `npm test`: **545 passed, 0 failed, 0 cancelled, 0 skipped** (40 suites).
- The build/type check included in `npm test` passes.
- Focused lifecycle/repair regressions: **24/24 passed**.
- `git diff --check` passes.
- Hashes confirm all **168 source files** remained unchanged during the final run.

Evidence: `output/recheck-full-confirmed.log`,
`output/recheck-final-regressions.log`,
`output/recheck-notification-fixed.log`, and
`output/recheck-source-before.log` / `output/recheck-source-after.log`.
