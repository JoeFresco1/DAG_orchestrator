# Reliable execution controller

`dag reliable` is an opt-in execution path for registered task contracts. It drives the existing runner and Git isolation; it does not introduce a second task-status system. The controller owns retry budgets, escalation, diagnostics and structured independent review. Ordinary runs retain their existing behavior.

## Commands

```text
dag reliable preflight --config reliability.json
dag reliable run --config reliability.json
dag reliable status --config reliability.json
dag reliable resume --config reliability.json
dag reliable audit --config reliability.json
dag reliable amend --config reliability.json --reason "Clarified input owner" --release task_example
```

Run/resume exits unsuccessfully if work remains unfinished or suspended. Status and audit are read-only. `amend` requires a stopped engine and a recorded reason, retains original deadlines and counters, and archives superseded incidents. It releases only explicitly named suspensions. Provider suspensions require a successful configured availability probe on resume, or an explicit amendment after the provider problem has been resolved.

Existing test modules retain their imports, helpers and assertions. Add new cases at the top level or register a separate test/support file. Frozen files retain their exact digest.

The registry must cover every non-skipped task. Register the entry point, accepted requirement IDs, review boundary, file roles, focused checks, input probes and resource demands before dispatch. No inferred owner receives write authority.

## Manifest

```json
{
  "version": 1,
  "runFile": "dag.run.json",
  "policy": {
    "concurrency": 2,
    "wallMs": 28800000,
    "incidentsPerTask": 2,
    "incidentsPerRun": 12,
    "infraRetries": 2,
    "replaceLegacyReview": true
  },
  "capacities": { "testSlot": 1 },
  "commands": {
    "work": { "program": "node", "args": ["adapters/work.mjs", "{taskId}", "{model}", "{reasoning}", "{spec}"], "timeoutMs": 900000 },
    "diagnose": { "program": "node", "args": ["adapters/diagnose.mjs", "{incidentFile}", "{model}", "{reasoning}"], "timeoutMs": 300000 },
    "repair": { "program": "node", "args": ["adapters/repair.mjs", "{incidentFile}", "{scopeFile}", "{model}", "{reasoning}"], "timeoutMs": 900000 },
    "review": { "program": "node", "args": ["adapters/review.mjs", "{taskId}", "{model}", "{reasoning}"], "timeoutMs": 300000 }
  },
  "tasks": {
    "task_example": {
      "entryPoint": "src/example.ts",
      "reviewBoundary": "R1: parse the registered input",
      "requirements": ["R1"],
      "files": [
        { "path": "src/example.ts", "role": "implementation" },
        { "path": "src/example.test.ts", "role": "test" }
      ],
      "checks": [{ "program": "node", "args": ["--test", "dist/example.test.js"], "timeoutMs": 120000 }],
      "inputs": [],
      "resources": { "testSlot": 1 }
    }
  }
}
```

Adapters are project-owned executable files, not supplied by this example. Work/repair/review adapters must honor the supplied model and reasoning arguments, execute non-interactively, and expose provider failures as typed packets. A deterministic task may set `deterministic: true` and use its original task command without a work adapter. Deterministic acceptance commands still require an independent structured review adapter.

The default ladder is Luna xhigh (3 attempts), Sol 6.1 medium (3 attempts), Sol 6.1 xhigh (4 attempts). These are total attempts, not extra retries. Astra and Terra are excluded. Counters span normal implementation and repair rejection. Preparation, provider waits and infrastructure retries do not consume semantic rejections. A repair that makes no source progress stops for reassessment rather than advancing through identical prerequisite failures.

`replaceLegacyReview` explicitly authorizes the controller to replace legacy plan/review commands and end-of-run review with the registered checks and independent review. Registration rejects legacy reviewers unless this policy is explicit. Original task definitions remain available. Register the equivalent acceptance requirements before enabling this policy.

Optional adapters: `prepare` installs worktree dependencies; `integration` runs the full integration gate before acceptance; `availability` checks a restored provider; `environment` supplies the environment digest needed for optional check reuse. All adapters use `program`, `args` and a deadline between 1 and 900000 milliseconds. No shell interpretation is added.

Consumed input probes name `owner`, `contract` and `check`. The owner must be a registered ancestor. Failed probes invoke diagnosis before dispatching the consumer. A diagnostic request can expand repair scope only to registered upstream implementation files; affected owner checks also run. Unknown or future owners stop at registration.

## Adapter packets

Use one complete JSON object on one line, with the exact prefix. Quota-related words elsewhere in logs do not classify a provider failure.

```text
DAG_FAILURE: {"version":1,"code":"implementation","stage":"validation","owner":"task_example","test":"example acceptance","requirement":"R1","evidence":["Expected 2, observed 3"]}
DAG_DIAGNOSIS: {"failure":{"version":1,"code":"ownership","stage":"preflight","owner":"task_producer","evidence":["Consumed field missing"]},"requestedFiles":["src/producer.ts"]}
DAG_SCOPE_REQUEST: {"files":["src/producer.ts"],"reason":"Consumed producer contract is broken"}
DAG_REVIEW: {"verdict":"pass","findings":[]}
DAG_REVIEW: {"verdict":"fail","findings":[{"severity":"blocker","requirement":"R1","reason":"Wrong output","test":"example acceptance","evidence":["Expected 2, observed 3"]}]}
DAG_ENVIRONMENT: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

Failure codes: implementation, ownership, contract, environment, quota, authentication, model_unavailable, review_dispute, unknown, user_stop, budget. Unknown failures go through diagnosis. Unresolved contracts, provider failures, operator stops and review disputes suspend the affected work. Suggestions cannot become blockers; blockers need an accepted requirement, evidence and a reproduction or code reference. Missing or contradictory verdicts fail closed. Reviewers cannot mutate verified sources.

## Persistence and ownership

The run's existing sidecar contains `reliability/controller.json`, event history, per-task acceptance receipts, check receipts and repair worktrees. Controller PID/birth identity prevents duplicate controllers. Ordinary CLI/viewer dispatch and mutations refuse a live controller lease; delegated engine processes receive a private lease token. Cleanup verifies process identities before terminating tracked descendants. The original user checkout is not the repair target.

Recovery persists preparation, repair, verification, review, commit, publication and requeue boundaries. Commit receipts precede publication; branch updates use the expected base, or fast-forward a clean registered integration checkout. Resume reconciles already published commits and uses the supported retry command. Only a subsequent independently checked task completion resolves an incident.

`policy.reuseChecks: true` enables successful deterministic-check reuse. It requires the environment adapter to fingerprint the installed runtime/dependencies. Cache identities include exact HEAD, tracked changes, registered file contents, dependency manifests, command, contract revision, environment digest, process environment and platform. Uncertain identities rerun the check; failures are not cached. Reviews are never cached.

The viewer displays the current controller stage, task, selected profile, remaining wall budget and suspension reasons. Metrics cover observed controller attempts only; unknown spend is null. Audit emits lesson candidates with evidence, not installed skills. Applicability review and regression controls are required before promoting a lesson.

## Verification and rollout limits

The repository test gate includes real-process lifecycle fixtures: actual CLI dispatch, Git worktrees, rejection, repair, checks, review, publication and supported requeue; durable-stage restart replay; quota preservation; lease collision; test protection; review mutation; inherited pipes; and cache invalidation.

Stage replay tests seed a crash boundary. They are not yet power-loss tests or a complete kill-at-every-instruction campaign. File guards detect repository edits; they are not an operating-system sandbox. Trusted adapters remain responsible for truthful environment digests, honoring model settings and checking their accepted requirements.

This implementation has not certified ten consecutive live analytics units. Migrating the analytics supervisor and its project adapters is a separate deployment step: stop the old supervisor, translate its ownership/check registry, run preflight and the project replay fixtures, then resume through this controller. Do not run both controllers together or declare chronic failures solved from unit-test totals alone.
