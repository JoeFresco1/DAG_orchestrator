# Autonomous correction of consumer-dependent verification

## Scope and root cause

`FlowRunner.verifyNode` previously ran the sole `node.verify` command before a
candidate could be integrated. Missing-artifact diagnosis could identify Receipt
as the producer required by Checkout's check. But Receipt already depends on
Checkout, so `deferNode` could only propose a cyclic implementation dependency and
hold. The independent local check used in the earlier experiment was not declared
as execution authority in the original v3 node contract.

This change supports that specific verification-staging mistake. It does not
generate tests, infer commands from filenames, split oversized implementation
tasks, repair cross-wave ownership, or fix completed-producer/stale-worktree
recovery. No other scheduler or controller was added.

## Necessary authority

The producing node keeps its flawed composed verifier and may declare one approved
local behavioral test using `local_check` (see the configuration example in
`docs/flow3.md`). This reuses `PlanningCheck`: an argument vector, bounded timeout,
known test runner, declared source files and positive selected-test evidence.

The `behavior` field names an actual passing TAP test case. A positive file/test
count alone is insufficient: Node can count an empty test file as a passing
file-level test. The named case must pass without a skip/todo directive. The test
must assert real producer outputs or rejection behavior; the regression checks
totals, remaining stock, invalid quantities and insufficient stock.

Test authority is authored up front. The files must already exist as approved
regular files and agree with integration. Original verifier entry files, package
configuration and explicitly protected test/requirement sources are included in
the frozen source comparison. The correction never writes those files.

**A byte-for-byte legacy plan with no declared local-check authority still holds.**
The earlier experimental fixture contained a local check function, but availability
of a function name alone is not permission to select it. Such plans now report the
missing `local_check` authority explicitly. The successful tests start with the
flawed `verify` assignment and declared local authority; the runner makes the
staging correction without an operator or external plan rewrite.

## Production execution path

* `src/flow3/contracts.ts`: optional `NodeBrief.local_check` and one persisted
  `NodeState.verificationCorrection` record. It retains the authored definition,
  original command, effective local command, acceptance prerequisites, frozen
  verification-source hashes, saved source commit/base and original attempt.
* `src/flow3/graph.ts`: validates the authority. A downstream `verify_requires`
  producer may remain a verification obligation when a local behavioral check is
  declared. Implementation `depends_on`, inferred implementation edges and real
  implementation cycles retain their existing checks. No reverse edge is added.
* `FlowRunner.verifyNode` → `correctVerification`: uses declared unfinished
  downstream verification prerequisites or an actual unambiguous missing artifact
  owned by a downstream consumer. Declared unavailable checks are recorded as
  deferred without execution, even if their executable might return zero prematurely.
  It refuses mixed
  prerequisites, assertion/compiler ambiguity, absent/changed local authority,
  missing test files and already charged repair contexts. Ordinary missing
  implementation producers retain the existing dependency recovery route.
* The correction commits/pins unverified worker source, persists a complete intent
  under the current run lock, and reuses `reopenProducers` for the consumer closure.
  It neither changes the authored `verify` nor alters implementation dependencies.
* `localVerification` selects the declared structured test. `phase` requires its
  normal conclusive result, positive count and passing named behavior. Only then
  does the existing candidate/landing/completion path release Receipt.
* `checkPrerequisites` and `commands('final')` retain the original composed check,
  its producer/consumer prerequisites and the effective local check. The original
  command remains mandatory even if it was not separately listed in `finalChecks`.
  Existing checkpoint result/identity handling remains authoritative for passing
  acceptance; no separate obligation success flag is introduced.
* `resumeCorrectedVerification` restores the pinned unverified commit and reruns
  checks without dispatching implementation again. Once a candidate is persisted,
  the existing saved-candidate landing path takes precedence. Existing repair
  recovery retains its authority and budget checks.
* `src/flow3/lifecycle.ts`: the correction is included in frozen acceptance identity.
  With no corrections, the identity input remains byte-for-byte compatible with
  the previous calculation; this was compared against archived committed code.
* `protectedPaths`, focused owner checks and checkpoint validation use the corrected
  local check where appropriate while preserving the original final obligation.

A node gets at most one staging correction for its frozen authored definition.
This is deterministic check routing, not another coding attempt: no repair round,
attempt counter, deadline or retry allowance is replenished. If the local test
finds an implementation defect, existing bounded node-repair policy applies.

## Regression and refusal coverage

`src/flow3/verification-correction.test.ts` executes real Node verifier subprocesses
and the actual `DagRunner` → `FlowRunner` → Git/store path. Only implementation
workers are simulated. It starts with Checkout's composed check still assigned.

Coverage includes:

* Implicit missing Receipt and explicit downstream `verify_requires` metadata.
* A misleading zero-exit checker cannot run before its declared consumer is ready.
* Checkout's named local behavior passes; Receipt becomes eligible; original
  composed verification passes against the final frozen identity.
* Scope expansion from Checkout-only selection to required Receipt, without
  claiming whole-product completion for a scoped run.
* A failed original composed check remains failed after all implementations land.
* Actual local implementation defects remain blocking.
* Missing authority, missing files, mixed downstream/implementation prerequisites,
  non-test/file-existence commands, empty-test policy and actual implementation
  cycles refuse rather than guess.
* Empty file-level tests and a skipped required case cannot establish local behavior.
* Worker changes to either local tests or the original composed checker are rejected.
* Changed persisted authority cannot inherit prior success.
* Real process death after intent persistence, after local check execution, and
  after candidate persistence. Resume preserves the same correction and original
  obligation, dispatches Checkout implementation zero additional times, and leaves
  already spent node/checkpoint repair charges unchanged.

Tests clear inherited `NODE_TEST_CONTEXT` only in the fixture executor so nested
real Node test processes execute rather than being suppressed by the outer test
runner. Orphan-executor safety is unchanged; crash fixtures isolate the chain from
unrelated live verifiers.

## End-to-end evidence

The existing evidence driver supports `--declare-local-check`; it registers the
frozen local behavior without replacing Checkout's assigned composed verifier.
`--cycle-only` isolates Checkout → Receipt with the other application prerequisites
already implemented. Both engines receive the same flawed verifier assignment and
local metadata; there are zero externally supplied staging transformations.

```powershell
npm run build
node scripts/flow3-e2e-evidence.mjs . C:\Users\Fresc\.lightweight-dag\experiments --declare-local-check --cycle-only
```

The broader nine-spec run can also be repeated with:

```powershell
node scripts/flow3-e2e-evidence.mjs . C:\Users\Fresc\.lightweight-dag\experiments --gate-catalog --cohort-discount --declare-local-check
```

That broader flawed plan is expected to retain its unrelated oversized Reporting
blocker. Completing Checkout and Receipt is not a claim that runtime decomposition
has been implemented or that all nine specifications finish unattended.

## Final executed results

* `npm run build`: passed on the final production code.
* `node scripts/run-tests.mjs` (the same complete suite invoked by `npm test`):
  **578 passed, 0 failed, 40 suites**, 464.391 seconds.
  Log: `C:/Users/Fresc/.lightweight-dag/flow3-verification-correction-delivery-suite.log`.
* `node --test dist/flow3/verification-correction.test.js`:
  **11 passed, 0 failed**, including all three process-death boundaries.
  Log: `C:/Users/Fresc/.lightweight-dag/flow3-verification-correction-delivery-focused.log`.
* `git diff --check`: passed.
* Compatibility probe against archived committed `acceptanceIdentity`: identical
  output for a saved run without verification corrections.

The final isolated end-to-end run is retained at
`C:/Users/Fresc/.lightweight-dag/experiments/flow3-e2e-2026-11-12-uo56d6`:

| Engine, same flawed assignment and local-check authority | Tasks completed | Original composed final check | Coding repairs | Extra implementation dispatches | External staging transformations | Seconds |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Committed HEAD `b54246e` | 0/2 | Not reached | 0 | 0 | 0 | 8.302 |
| Current working tree | 2/2 | Passed | 0 | 0 | 0 | 30.239 |

Current execution makes one implementation request per task, persists one staging
correction, and passes five frozen final results, including the unchanged composed
command and named local test. Real acceptance exercises the fixture's CLI and all
nine requirement groups against the stable prerequisite implementation. This
two-node experiment is not evidence of generating those prerequisite modules from
specifications in this test.

The broader original flawed nine-node fixture also progressed from the previously
measured 5/9 to 7/9: Checkout and Receipt finish; Reporting still fails as oversized
and CLI remains blocked by it. No runtime decomposition is claimed. This broader
observation precedes the final declared-readiness guard; the final isolated run
and complete suite above cover the delivery code.

All model responses in these experiments are simulated; verifier subprocesses,
source integration, durable state, correction selection and final acceptance are
real. No live provider behavior is claimed.
