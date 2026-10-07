# Failure diagnostics

## Resolving missing implementation owners

An optional controller `reauthorize` hook handles an explicit repair error with
`code: RECOVERY_SCOPE_REQUIRED` and a structured `scopeRequest`. The project
resolves files against its trusted ownership/dependency registry; a worker's
request does not authorize edits. The kernel requires a strict scope expansion
retaining all prior files and the exact acceptance commands. At most two scope
expansions share the existing attempt and wall budgets. Missing resolvers,
unchanged scope, and changed checks stop before another identical repair.
Scope revisions remain in the incident record and do not approve a task.

Reusable, file-backed diagnosis extracted from the advanced analytics build.
No database or daemon is required. It supplements implementation retries with
a fresh read-only investigation. It never approves a task or rewrites its contract.

## Command

```powershell
dag diagnose --id task_123 --dry-run --json
dag diagnose --id task_123 --cwd C:\path\to\isolated-task --json
```

Default: after three distinct semantic review rejections, Codex Luna xhigh,
read-only sandbox, five-minute hard timeout. `--after`, `--model`, `--reasoning`,
and `--timeout` configure this explicit invocation. Without `--cwd`, the project
folder is inspected; supply the actual saved task checkout to inspect failed work.
The CLI emits JSON on stdout and progress on stderr. A held/failed diagnosis
exits nonzero. No eligible boundary returns JSON null without launching a model.

Records live in `<run-file-basename>.d/diagnostics/<runId>/<taskId>/` and include
the model, response, raw event log, schema, evidence references and disposition.
The run/task definition is not modified. The same boundary and contract revision
reuse the existing diagnostic rather than launching repeatedly. An interrupted
or failed diagnostic holds for controller resolution; it does not loop endlessly.
History is bounded by the store's event-log reader (latest 8 MiB); old rotated
events are not reconstructed by this command.

## Automatic use from a worker controller

Import `scripts/diagnostics/core.mjs`. Before launching a new implementation
attempt, pass `diagnoseBeforeWork` the fixed assigned scope (`unit`), event
history, unique rejected attempt IDs, accepted `contractRevision`, project and
checkout paths, and policy:

```js
const policy = {
  diagnostics: { enabled: true, afterRejections: 3, timeoutMs: 300000 },
  workers: [
    { harness: 'codex', model: 'gpt-6-luna', variant: 'xhigh', attempts: 3 },
    { harness: 'codex', model: 'gpt-6.1-sol', variant: 'medium', attempts: 3 },
    { harness: 'codex', model: 'gpt-6.1-sol', variant: 'xhigh', attempts: 4 },
  ],
};
```

The diagnostic can recommend an in-scope repair, existing-ladder escalation, or
a hold. Contract/ownership, environment, resource and unknown causes must hold.
Recommendation text is advisory: callers must retain ownership, permissions,
model budgets and unchanged acceptance gates. Diagnosis does not automatically
activate a skill. Optional `restoreFrozenBaseline` restores only files whose Git
HEAD contents match already accepted hashes; it never changes those hashes.

After choosing the actual repair profile, call `pinAttemptProfile(directory,
{runId, taskId, attempt, contractRevision}, profile)`. The independent reviewer
must call `readAttemptProfile` with the same identity instead of recalculating
the model from rejection count. Conflicting profiles or contract revisions fail
closed. This addresses the observed Luna-worker/Sol-reviewer routing mismatch.
Pinned identities must describe the actual unique attempt; do not reuse one
after changing the model or accepted scope.

The module and explicit CLI are available to all projects. The ordinary runner
is not globally opted into model diagnosis by installing this command; the
analytics controller has its own automatic integration. Existing analytics
wrappers need to adopt the profile-pinning API to fix their reviewer routing.

## Verification

`pnpm build` and `node --test dist/diagnostics.test.js` exercise the CLI against
a real run sidecar and the reusable module with deterministic launch fixtures.
Tests cover unique attempt counting, cache reuse, contract binding, failure
holds, safe baseline restoration, routing consistency and unchanged run state.
These tests do not spend model tokens or establish diagnostic-model accuracy.

## Automatic controller recovery

The reusable `scripts/diagnostics/recovery.mjs` closes the recovery loop for
controllers that explicitly enable it. `recoveryTrigger` includes a first terminal
timeout, stall, spawn or worktree failure, as well as repeated review rejections
and `BUILD_DIAGNOSTIC_HOLD`. Quota/authentication failures and deliberate stops
remain outside automatic model repair. `dag diagnose --dry-run` now reports
terminal infrastructure eligibility even with zero semantic rejections.

`recoverIncident` reserves a durable, contract-bound incident before consuming
model budget. The controller supplies trusted hooks for stopped-run checks,
diagnosis, scope authorization, repair, diff/contract validation, deterministic
verification, independent review, publication and supported requeue. A diagnostic
hold can reach the authorized coordinator through `allowHold: true`; it never
grants scope or permission to an implementation worker. Unknown causes and
resource-authority changes remain explicit blocked outcomes.

Default limits are two incidents per task, six per run, ten bounded repair
attempts and two hours per incident. The analytics adapter uses the configured
Luna xhigh → Sol 6.1 medium → Sol 6.1 xhigh ladder. Astra is prohibited.
`process.mjs` supplies streamed command evidence and process-tree termination
for timeouts. Duplicate incidents cannot relaunch diagnosis/repair. A crash
after recorded publication resumes only validated, idempotent requeue.

The analytics build supervisor installs the project adapter in
`scripts/build/controller-recovery.mjs`. It runs after the runner exits and before
restarting. Repairs use isolated Git worktrees, retain interrupted artifacts,
preserve frozen product requirements/guards, pass deterministic checks and a
fresh reviewer, then advance the integration branch and call `dag retry`.
Task success still requires the task's ordinary acceptance and reviewer. The
ordinary generic runner remains opt-in through a controller; this module does
not silently enable model launches in every project.

Focused tests exercise the timeout entry point, controller-hold recovery chain,
negative validation/review controls, bounded model routing, interrupted requeue,
quota refusal and persistent incident budgets. Process tests terminate a real
silent child. Deterministic launch fixtures verify wiring, not model accuracy.
