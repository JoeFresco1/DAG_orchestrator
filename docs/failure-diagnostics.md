# Failure diagnostics

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
