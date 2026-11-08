# Flow 3 crash-recovery certification

`dag crash-certify` runs a local hard-process-termination campaign against a
disposable Flow 3 fixture. It is the single documented campaign entry point; it
does not execute commands from a caller's run file or require an external service.
The acceptance requirements remain in the
[feature specification](../../specs/002-crash-recovery-certification/spec.md).
This guide complements the [Flow 3 recovery and lifecycle guide](../flow3.md);
the [design record](crash-certification-design.md) retains the implementation
background and original inventory.

## Run the campaign

Requirements are Node.js 20 or newer and Git on `PATH`. A built or installed
`dag` executable can run the command directly:

```sh
dag crash-certify
```

In a source checkout with npm dependencies installed (including the `tsx`
development dependency), invoke that same CLI entry point through the package
script:

```sh
npm run dag -- crash-certify
```

The default report is `.dag-crash-certification/campaign.json` in the current
directory. The campaign also creates one disposable repository per boundary in
`campaign.json.fixtures` beside that report, plus a lock file while it runs.
Those fixtures are retained for inspection. Use `--report PATH` to put the report
and fixtures elsewhere. The command accepts `--campaign-id ID` to name a campaign
and `--json` for the full report on stdout.

Do not set `--max-boundaries` for a full campaign. That option intentionally
limits how many untested boundaries this invocation runs. It leaves the report
interrupted and exits 2; invoke the command again with the same report path to
continue its missing boundaries. A signal interruption also preserves prior
iterations. If the campaign driver itself is killed before it can record the
signal, the next invocation records that interruption before resuming. A report
already marked complete is returned as-is; choose a new report path for a fresh
campaign.

## What the six injections test

For each boundary the campaign prepares a four-node local Git fixture: `alpha`
is already accepted, `salvage` is an intentionally failing task, `bravo` is the
injected task, and `charlie` depends on `bravo`. It starts a child `dag run`, waits
for the named durable-boundary marker, sends that process `SIGKILL`, then invokes
supported recovery commands. The injection points are these specific seams:

| Boundary | Kill point in the current Flow 3 path |
| --- | --- |
| `worker-launch` | The task's running state and undispatched work-attempt record have been saved; the executor has not yet been called. |
| `result-capture` | The work executor returned, but its terminal dispatch result has not yet been saved. The durable dispatch remains ambiguous at this point. |
| `verdict-persistence` | A successful verification result has been written to the local evidence file, before the verified candidate proceeds to commit. |
| `commit` | The verified source commit and `dag-node/...` candidate ref exist, before the run state saves the candidate record. |
| `merge` | The integration head and candidate are saved while the task is still running, before task completion is recorded. |
| `finalization` | The final run state has been saved at runner teardown, after accepted tasks and checkpoint results are durable. |

After recovery, the campaign compares the pre-kill accepted task with its later
record, checks candidate/source/integration commit attribution and Git ancestry,
and checks verification evidence for accepted tasks. It checks that attempt and
phase history remains available, lifetime attempts and repair accounting do not
decrease, and the fixture's reserved spend remains unchanged. It also checks that
the seeded failed task's reason, attempt log, salvage branch and commit remain
retrievable. At `result-capture`, it verifies that `bravo` is held until an
explicit resolution, then releases a deliberately delayed process to write into
its old worktree and checks that this late write does not alter accepted task
state or the integration branch.

This is coverage of these six local fixture seams and recovery path. The command
does not certify every run shape, platform process race, damaged-store restore,
standalone orphan reaping, or arbitrary external service effect. In particular,
it cannot prove exactly-once execution of arbitrary external commands.

## Resolve ambiguous effects

Recovery holds work that was dispatched but has no captured terminal result. It
also holds captured work with no persisted verified candidate because its
external effect may already have happened. The campaign's `result-capture`
fixture records this sequence:

1. `dag resume --file <fixture-run>` marks the task ambiguous and does not rerun it.
2. The fixture explicitly resolves it with
   `dag resume --file <fixture-run> --resolve-ambiguous bravo --resolution safe-to-repeat --reason <reason>`.
3. `dag run` continues after the decision is saved in dispatch history.

For a real run, inspect the external system before choosing `safe-to-repeat` and
give a reason that explains why repetition is safe. That is currently the only
supported resolution value. There is no command to record “the effect already
happened” and accept it as completed. If repeating is not safe, leave the task
held for explicit intervention; do not use the repeat resolution as a substitute
for reconciling the external effect. A recorded choice is an audit trail, not a
guarantee that the external operation ran once.

The campaign itself uses `dag resume` and `dag run` on disposable files. For
ordinary recovery, `dag run --file run.json` performs startup recovery and
continues work; `dag resume --file run.json` persists the recovery transition
without dispatching; `dag kill-orphans --file run.json` kills only PIDs still
recorded in task state. See [Flow 3 recovery instructions](../flow3.md) for the
recommended ordering and explicit resolution syntax.

## Read the report

The command prints a short boundary summary by default. With `--json`, the output
also contains the report path, schema version, campaign and run IDs, timestamps,
interruption history, and all boundary iterations. Each iteration records its
kill point, recovery actions and exit codes, local evidence references, task and
commit attribution, and a `failureReason` when an assertion fails.

Interpret campaign and boundary status separately:

| Report value | Meaning |
| --- | --- |
| `status: complete` | Every required boundary has an iteration. This describes coverage completeness, not whether certification passed. |
| `status: interrupted` | The report has missing boundaries or the campaign was interrupted. Entries with `outcome: not-run` have no coverage yet. |
| Boundary `outcome: completed` | All recorded iterations for that boundary passed their assertions. |
| Boundary `outcome: failed` | At least one iteration failed; read its `failureReason` and evidence. The report may still have `status: complete`. |
| Boundary `outcome: not-run` | No iteration for that boundary has been recorded. |

Exit code 0 means the report is complete and all six boundary outcomes are
`completed`. Exit code 1 means certification failed, including a complete report
with one or more failed boundaries. Exit code 2 means the campaign is
interrupted/incomplete. Treat any `failed` or `not-run` boundary as uncovered
acceptance, even if other iterations passed.

## Validation observed while preparing this guide

The real source CLI entry point was run on 2026-11-08 with a temporary report:
`npm run dag -- crash-certify --report <temporary-path> --campaign-id docs-check --json`.
It exercised all six injections and produced `status: complete`, but exited 1:
all six boundary outcomes were `failed`. Each iteration reported that the fixture
had no salvage branch and that its failed-work salvage branch/commit was missing.
The `verdict-persistence` and `commit` iterations also had unexpected
ambiguous-reconciliation assertion failures. This is a failed certification
observation, not evidence that the preservation requirements passed. The
temporary report was not added to the repository.

`git diff --check` passed. The supplied node documentation check and the
runner-owned wave and final acceptance suites were not run in this implementation
phase; they remain pending runner verification.
