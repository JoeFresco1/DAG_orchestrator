# Running the software factory

The factory controller turns a structured goal into ordinary DAG tasks. The
existing `DagRunner` remains responsible for dependency scheduling, command
execution, review verdicts, worktree isolation, retries, and interrupted-task
recovery. Factory graphs and checkpoints live beside the run file under
`<run>.d/factory/`; `Run.storageVersion` and the public task CLI format stay at
version 2.

## Goal file

Create a JSON file with this shape. Task commands use the normal DAG tokens;
include `{spec}` when an agent command needs the task instructions.

```json
{
  "schemaVersion": 1,
  "goal": {
    "id": "owner-field",
    "title": "Keep owner data consistent",
    "description": "Expose a non-empty owner through the API and client."
  },
  "requirements": [
    {
      "id": "owner-required",
      "title": "Owner is required",
      "description": "Every created record has an owner.",
      "acceptanceCriteria": [
        "The API rejects a missing owner.",
        "The client handles the owner field without a null crash."
      ]
    }
  ],
  "implementation": [
    {
      "id": "api",
      "title": "Enforce owner in the API",
      "spec": "Update the create path and its tests.",
      "cmd": "codex exec --full-auto \"{spec}\"",
      "requirementIds": ["owner-required"],
      "codeUnits": ["src/owner.ts"]
    }
  ],
  "checks": [
    { "id": "typecheck", "title": "Typecheck", "cmd": "pnpm typecheck" }
  ],
  "phases": {
    "review": { "command": "codex exec --full-auto \"{spec}\"" },
    "verification": { "command": "codex exec --full-auto \"{spec}\"" },
    "rootCause": { "command": "codex exec --full-auto \"{spec}\"" },
    "remediation": { "command": "codex exec --full-auto \"{spec}\"" },
    "regression": { "command": "pnpm test" },
    "recertification": {
      "reviewCmd": "codex exec --full-auto \"{spec}\""
    }
  },
  "coverage": { "criticalFlow": 1, "weightedRisk": 0.95 }
}
```

Every requirement has at least one acceptance criterion. Each implementation
task names the requirement IDs and repository-relative TypeScript files it
implements. Files must exist in the code graph after implementation. The
coverage values should come from the risk and critical-flow evidence used by
your project.

The review command returns `{"observations": [...], "reviewedFiles": ["src/owner.ts"]}`.
List only code-scope files actually inspected. The controller records these
against the code graph snapshot; changed files also need passing scoped
recertification review. Older observation arrays are accepted for finding
extraction but supply no coverage evidence, so automatic convergence waits.
Verification returns one JSON
`VerificationAssessment` per generated hypothesis, following the schema in
the task prompt and citing its supplied evidence IDs. The root-cause command
returns a JSON array of `RootCauseAssessment` objects; return `[]` when no
shared cause is supported. Each remediation command gets a compiler-generated
scope and links to its verified evidence. The recertification reviewer must
end with `VERDICT: PASS` or `VERDICT: FAIL: reason`.

## Start, inspect, and resume

```bash
dag factory start --goal docs/factory/owner-field.json --file dag.run.json
dag factory status --file dag.run.json
dag factory resume --file dag.run.json
```

## Review an existing application

Use a structured goal with requirements, deterministic checks, phase commands,
and coverage values as above. Set `"mode": "review"` and
`"implementation": []`. Optionally set
`"review": { "codeUnits": ["src/owner.ts"] }` to narrow the code scope;
omitting `codeUnits` reviews all indexed code files. You can also pass an
ordinary completed DAG run as context. The review reads that run and writes a
separate factory run file.

```bash
dag factory review --goal review-goal.json --source-run dag.run.json --file dag.review.json
dag factory status --file dag.review.json
dag factory resume --file dag.review.json
```

`dag factory review` also accepts a build goal: it selects review mode and
clears its implementation task list for the new run. It runs checks, code
review, verification, and certification. The review report is saved under the
run's factory sidecar and can be read with `dag factory report --file
dag.review.json` (add `--json` for the full evidence record). If verified
defects remain, the run pauses at `report` with a proposed remediation plan.
No repair tasks exist until you choose one of these commands:

```bash
dag factory fix --file dag.review.json    # create and run the proposed repair DAG
dag factory close --file dag.review.json  # finish with findings still unresolved
```

`dag factory resume` stays at the report checkpoint until you make that
choice. The report is tied to the source commit; if source changes, start a
new review before repairing. A clean review proceeds to certification. Review
mode derives its convergence assessment from completed task logs and attempts
and uses a default policy when the goal has no `convergencePolicy`. Supply
`--policy` and `--assessment` on resume when your project needs different
thresholds or additional measured evidence.

### Start from the repository without a goal file

From a committed TypeScript repository with `tsconfig.json`:

```bash
dag factory review --file dag.review.json
dag factory report --file dag.review.json
```

This creates a review goal from the indexed files and uses the Codex harness.
It selects `npm run test`, `npm run typecheck`, or `npm run build` when that
script exists, in that order. If the repository has no such script, pass
`--check "command"`. Use `--harness`, `--cmd`, `--recert-cmd`, and
`--code-units src/a.ts,src/b.ts` to control the reviewer or scope. You may
also pass `--source-run` for read-only context from an earlier DAG. The
generated goal declares only the configured check as its critical flow and
records zero weighted product-risk coverage; a structured goal is needed to
claim broader coverage.

The controller executes these phases in order:

1. Compile the requirement graph and implementation tasks.
2. Run implementation tasks, deterministic checks, and the review task.
3. Normalize review observations, cluster hypotheses, and save the initial
   certified baseline.
4. Run adversarial verification tasks for each hypothesis.
5. Assess verified root causes and compile the remediation DAG.
6. Execute remediation tasks, then independently recheck every verified defect
   against fresh source evidence. Unresolved or inconclusive rechecks block certification.
7. Run final regression checks and routed recertification reviews, then save a
   new certificate and certified baseline.
8. Evaluate the measured convergence assessment against `convergencePolicy`.
   Only a `stop` decision completes the factory; `continue` or `escalate` remains waiting.

Build and review modes derive `confidenceFrontier`, `budget`, `criticalFlows`,
`findings`, and `reviewUnits` from recorded review output, file coverage,
defect rechecks, recertification, and task attempts. Review coverage is
risk-weighted using the code graph and saved in `risk-coverage-v1.json`.
The default convergence policy requires full inspected-file coverage and a
quiet review window. A custom `convergencePolicy` can set stricter thresholds;
for example, `minimumRequestsForYield: 1000` needs 1,000 actual requests in
the window and will keep a short run waiting. `--assessment` remains an
explicit override for measurements made outside the controller.

The requirement, code, execution, and defect graphs are persisted as separate
versioned artifacts with trace links between them. Tasks appear in normal DAG
commands such as `dag list`, `dag show`, `dag logs`, and `dag retry`.

The controller checkpoint and each task status are written atomically. If the
process stops, run `dag factory resume`. Interrupted tasks are requeued by the
runner's normal recovery path. For a permanently failed task, inspect its logs,
run `dag retry --id <task-id> --cascade` (or `dag retry-failed --cascade`),
then resume the factory. A different goal requires a new run file.

The current repo must have a valid Git commit and a clean source tree for
certification. Commit source changes made without task worktrees before
resuming. With
`--worktree task`, factory analysis follows the existing `dag/<runId>`
integration branch; task work remains isolated by the existing runner.

## Persisted artifacts

```text
dag.run.d/factory/manifest.json
dag.run.d/factory/controller-v1.json
dag.run.d/factory/goal-v1.json
dag.run.d/factory/graph-model-v1.json
dag.run.d/factory/code-v1.json
dag.run.d/factory/observations-v1.json
dag.run.d/factory/hypotheses-v1.json
dag.run.d/factory/verification-v1.json
dag.run.d/factory/root-causes-v1.json
dag.run.d/factory/review-report-v1.json
dag.run.d/factory/remediation-plan-v1.json
dag.run.d/factory/remediation-verification-v1.json
dag.run.d/factory/impact-v1.json
dag.run.d/factory/recertification-plan-v1.json
dag.run.d/factory/certification-v1.json
dag.run.d/factory/baseline-final-v1.json
dag.run.d/factory/convergence-decision-v1.json
```

Every manifest artifact reference includes a SHA-256 digest. A damaged or
stale artifact fails closed instead of silently advancing the controller.
