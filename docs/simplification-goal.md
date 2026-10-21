# Goal: one recovery path, one verdict format, one attempt pipeline

## Objective

Simplify the DAG logical flow so that a task attempt has one linear path, a
failure has one budget that bounds it, and a review has one verdict format —
without losing any defect class the current pipeline catches. The flow document
must end up with zero defensive disclaimers: if a paragraph exists only to
explain that two mechanisms do not stack, one of those mechanisms is being
removed or merged.

## Why (findings from the review)

1. **Six recovery routes, four budgets.** Attempt retries (`maxAttempts`),
   review redo (`reviewRounds`), merge redo (`mergeRounds`, src/runner.ts:2630),
   graph repair (`repairRounds`), harness-chain fallback (a different tool per
   attempt, with `failOnNonZeroExit` auto-enabled when a chain is set), and the
   grounded-planning hold/stopped-amend route (`holdAfter`,
   src/planning/runtime.ts:93). Plus the optional reliability controller — a
   second state machine (`scripts/reliability/controller.mjs`, ~34KB) with its
   own ledger, two rejection budgets, own worktree and own review. Each is
   defensible alone; the product of 4 budgets × 12 failure kinds is the defect
   surface, and it all lives in one 2,614-line `src/runner.ts`.
2. **Multiple review layers with multiple verdict semantics.** Planning review
   + correction helper + recheck + revision fingerprints; task `--review-cmd`;
   controller independent review; end-of-run code review; requirement evidence
   check; plus `dag chain-review` and integration nodes in the CLI. Canonical
   tasks default to `reviewRounds: 0`, so a reviewer can only dead-end a task —
   gates, not feedback loops.
3. **Stacked planning-validation heuristics.** Import/acceptance lint that
   admittedly cannot resolve dynamic loaders, aliases or package scripts
   (needs `check.files`, emits nonblocking warnings); three-way producer
   resolution; three separate fingerprints (manifest, revision, definition) —
   all overlapping with the runtime prerequisite probe that is the real
   authority at execution time.
4. **A branchy attempt pipeline.** Plan command → worker command → contract
   guard → postcondition guard → write-ownership validation → source-revision
   validation → reviewers → checks, all routing to the same failure node.
5. **The evidence base is thin.** ~550 events across two runs. Any plan that
   demands per-gate catch-rate counts before cutting will default to "keep
   everything."

## Target state, section by section

### §1 Decomposition and deterministic validation — keep the skeleton, drop the static analyzer

- **Keep:** cycle detection, requirement coverage, write exclusions without
  invented edges, sizing budgets.
- **Runtime probe becomes the single prerequisite authority.** The static
  import/acceptance lint is demoted to advisory (or removed); `check.files`
  stays as the explicit, user-authored assertion it already is.
- **Producer resolution → two outcomes:** resolved (baseline or unique
  evidenced producer) or blocking finding. Delete the third path.
- **Three fingerprints → one** plan content hash covering manifest + revision +
  definitions, so approval cannot be reused across any plan change.

### §2 Independent review and compilation — one gate, one pass

- Keep the single plan-time semantic review as the *only* agent review that
  gates admission. One pass; the correction helper becomes at most one
  fix-and-recheck cycle, not a nested state machine (already mostly true —
  simplify the prose and the API surface to match).
- Review instructions keep the blocking/nonblocking distinction; no other
  change needed here.

### §3 Run admission and scheduling — unchanged

Lock, resume, admission, worktree setup, concurrency and shared-write exclusion
are all load-bearing. Touch nothing.

### §4 One attempt — linearize

- Collapse contract guard, postcondition guard, write-ownership validation and
  source-revision validation into **one post-attempt validator with named
  assertions and a single failure path** into `failAttempt`.
- Order stays: plan phase → work → reviewers → checks → validator → land.
- Reviewer verdicts feed the attempt budget instead of dead-ending the task
  (see §5).

### §5 Failure routes — one budget, two routes

- **One attempt budget** (`maxAttempts`) with reason tags: `exit`, `timeout`,
  `stalled`, `review`, `merge`, `plan-fallback`. Review redo and merge redo
  stop being separate budgets — a rejection or conflict consumes an attempt
  like any other failure, with the reason recorded. Harness-chain fallback
  stays as what it already is: the next candidate on the same attempt budget.
- **One graph-level repair route:** `repairRounds` (or the project-authored
  integration repair — pick one; they requeue upstream work and must not both
  exist). The other becomes the default-off alias for a deprecation window.
- **The grounded-planning hold stays a distinct route** — it is a stop for
  evidence, not a retry, and is cheap.

### §6 Reliability controller — subordinate or delete

Decide by *distinct failure class covered*, not by fire counts (it covers
rare classes: interruption, environment corruption; the incumbent will always
win on volume with two runs of history). Either:

- **Fold the durable ledger into the runner's existing resume path** and drop
  the controller, or
- Demote it to a thin supervisor that owns only durable receipts and process
  liveness, with all retry/review/merge policy delegated to the runner.

It must not retain an independent second copy of §4/§5.

### §7 Integration and final convergence — keep, final review stays off by default

Integration verification remains an ordinary downstream task. Final review
stays `off` by default with its existing explicit opt-in; when enabled it uses
the same verdict format as every other review.

### Flow document

- 7 diagrams → ~4: overview, one attempt, failure routes, convergence.
- Delete every disclaimer that exists only to separate overlapping mechanisms.
- Update the code anchors list.

## Method (corrected evidence approach)

1. **Inventory all six recovery routes and every review layer first**, before
   any instrumentation — the previous plan's inventory undercounted (four
   routes, no chain fallback, no hold route, no chain/integration reviews).
2. **Mine existing `events.jsonl` and archived runs before adding counters**;
   only instrument gaps. Expect insufficient history and say so.
3. **Accept structural evidence when counts don't exist:** a gate is redundant
   if another gate provably covers the same failure class (by code path or
   seeded-defect test), not only if counters show co-firing. Allowed outcomes:
   remove, merge, keep (distinct class), opt-in — **plus merge-for-cohesion**
   when neither gate is redundant but the pair's configuration interaction is
   the risk.
4. **Judge the controller by failure class covered**, never by fire frequency.
5. Stop for review after the inventory and again after the cut proposal.

## Definition of done

- [ ] Gate/route inventory covering all six recovery routes, all review layers,
      all fingerprints, and every branch of the attempt pipeline.
- [ ] Before/after counts: recovery routes (6 → 2), independent budgets
      (4 → 1 + repair), verdict formats (→ 1), fingerprints (3 → 1),
      post-attempt branches (→ 1 validator), config knobs on `RunSettings`.
- [ ] Each removal either has evidence or a structural distinct-class
      argument, approved before implementation; one commit per change.
- [ ] Full test suite passes; every defect class in the regression corpus is
      still caught (seeded-defect tests added where a removed gate was the
      only catcher).
- [ ] `DAG logical flow` rewritten to match: ~4 diagrams, zero
      disclaimers-explaining-overlap, updated code anchors.
- [ ] Residual-risk note for anything kept without data.

## Non-goals

- New features or new gates.
- Manifest schema changes beyond fingerprint consolidation.
- Performance tuning.
- Rewriting the runner's scheduler, lock, worktree, or resume logic —
  consolidation targets the *failure routing and budgets* inside it, not its
  architecture. (Explicitly: merging budgets is in scope; re-architecting
  `runTasks` scheduling is not.)
