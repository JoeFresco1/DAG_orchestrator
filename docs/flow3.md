# Software DAG Flow 3.0

New `dag init`, `dag new-run`, and `dag plan compile` runs use `flow3`.
The supplied design is preserved in [dag-flow3.0.md](dag-flow3.0.md).

## Author and compile small nodes

```json
{
  "version": 3,
  "title": "Parser and CLI",
  "cmd": "codex exec {spec}",
  "settings": {
    "waveChecks": ["npm run build", "npm run typecheck"],
    "finalChecks": ["npm test", "npm run verify:spec"],
    "repairRounds": 2
  },
  "nodes": [
    {
      "id": "parser",
      "goal": "Implement parse() and its focused test.",
      "depends_on": [],
      "touches": ["src/parser.ts", "src/parser.test.ts"],
      "creates": ["src/parser.ts", "parse"],
      "relies_on": [],
      "verify": "npm run test:parser"
    },
    {
      "id": "cli",
      "goal": "Call parse() from the CLI and cover its output.",
      "depends_on": ["parser"],
      "touches": ["src/cli.ts", "src/cli.test.ts"],
      "creates": [],
      "relies_on": ["parse"],
      "verify": "npm run test:cli"
    }
  ]
}
```

```powershell
dag plan validate --plan flow.json --json
dag plan compile --plan flow.json --file dag.run.json
dag settings --concurrency 4 --worktree-prepare "npm ci"
dag run --file dag.run.json
```

Use exact shared file/symbol/signature names in `creates` and `relies_on`.
Admission rejects malformed/duplicate IDs, unknown dependencies, ambiguous
producers, unsafe file paths and cycles. It adds an unambiguous producer edge
when a consumer touches or relies on a declared creation. Transitive dependencies
already cover a producer. Corrections are transactional: an invalid correction
does not partially modify the graph. Larger scope is a warning to split the node,
not another startup gate. Decomposition is authored by the planning agent; the
runner does not guess how to divide an objective into new requirements.

`dag add` and `dag edit` accept `--goal`, `--touches`, `--creates`, `--relies-on`
and `--verify`. `add` also accepts `--id`. Comma-separated lists are literal
paths or interface names, not globs. A work command or harness must be supplied
before execution. A missing command fails that node rather than silently omitting
it from a full run.

Version 2 plans compile into the same execution path by default. Their original
manifest stays attached; the first task check becomes its local verify and the
remaining declared checks run at final integration. `--profile lean` retains the
historical compiler and execution policy. Upgrading an existing stopped run uses
`dag settings --profile flow3`; legacy tasks without contracts also need the new
brief and `verify` fields. The runner does not rewrite active run files.

## Dispatch and worker reuse

The runner checks the graph, acquires the run lock and creates/reuses `dag/<runId>`.
It allocates pool slots as needed up to concurrency. Each slot gets one worktree;
it is reset to the latest integration head between units. Ignored `node_modules`
and `.venv` directories can link to existing repository dependencies. Setup runs
once per slot and once for the integration environment; ignored warm caches
survive resets. Tracked/untracked task changes are committed before a slot is reused.

Maximal chains with one predecessor and one successor stay in the same slot.
Codex uses the explicit JSON thread ID, OpenCode its emitted session ID, and
Claude an explicit UUID; the next node resumes that conversation. A retry or
change of harness starts a fresh conversation. Other command-line tools still
reuse the worktree but have no automatic conversation adapter. Never use a
global "last session" switch with parallel workers.

Only pending nodes with completed dependencies, open approval gates and available
slots dispatch. Units with overlapping `touches` run serially. Failed/skipped
dependencies block their descendants. Failure does not stop an independent unit.
Collapsed chain units form topological waves; a wave checkpoint waits for active
units to finish before checking the shared integration branch.

Each node runs **work, then verify, then land**. A concrete implementation failure
can use one retry with its actual diagnostic, saved edits and worker session.
Setup, quota, authentication, timeout, missing-input and unknown failures are held
for diagnosis instead of invoking another coding attempt. There are at most two
implementation attempts. `planCmd`, agent reviewers, shared task deadlines,
planning holds and per-node contract guards do not run in this profile. Incompatible
external guard hooks are rejected with instructions to move them into verify or
checkpoints, rather than silently ignored.

Worker prompts assign wave and final acceptance execution to the runner. Workers
implement the behavior, tests and evidence files and report unrun checks as pending.
The final checkpoint waits until every selected node has completed. A missing or
failed producer leaves final acceptance deferred, avoiding failures for artifacts
that downstream tasks have not created yet. Independent ready branches still run.
Use per-task or run `timeoutMs` to fit implementation scope; acceptance commands
retain their own phase deadlines.

One advisory plan review starts alongside dispatch when an agent is available.
It runs in a separate disposable worktree, with Codex in read-only mode;
failures and suggestions are logged.
Suggestions never mutate an executing graph or gate startup. Deterministic
producer-edge corrections are applied by admission; scope splitting remains a
planning operation. No additional review is launched after each node.

## Checkpoints and repairs

`waveChecks` contains build/typecheck commands. `finalChecks` contains full tests,
integration and spec verification. If omitted, corresponding npm scripts are
detected (`build`, `typecheck`, `test`, `verify:spec`). Non-npm projects should
configure both lists explicitly. Missing configuration is a reported incomplete
run, not a passing empty suite, and does not launch a pointless coding repair.

The final pass also reruns wave commands and every completed node's verify against
the merged source. A pass therefore covers the integrated result, not just isolated
worktrees. Checks run on the integration worktree; modifications to source are
reported and preserved as a diagnostic patch, then discarded from that worktree.

An eligible node verifier failure gets an in-place repair in the same worktree and
session. `nodeRepairRounds` defaults to 1 and accepts 0..2. This budget is separate
from implementation attempts, so a one-attempt node can fix a formatting error
without redoing implementation. Repairs have their own `phaseTimeouts.repair`
deadline (five minutes by default), and the original verifier runs again before
the candidate can land. The repair count and failure fingerprints are persisted.

Only concrete formatting, syntax, type and behavioral assertion diagnostics are
eligible. Unknown failures, execution prerequisites, acceptance/control guard
failures and missing inputs stay held for diagnosis. Unchanged diagnostics after
repair, a repair with no source changes, an expired repair budget, or an agent
that does not stop cannot start an unbounded loop. Explicit `dag retry` starts a
new user-authorized recovery cycle; the runner never silently renews failed nodes.

Eligible checkpoint errors become a fix node using `repairCommand` or the
configured/inferred worker harness. File hints come from completed owners,
narrowed to diagnostic file references when available. If no bounded ownership
can be found (at most eight file hints), repair is held for scoped diagnosis.
The original checkpoint reruns after landing; `git diff --check` alone never
certifies acceptance. `repairRounds` allows 0..2 rounds shared across wave/final
repair, persisted across restarts. Repeated identical failures stop earlier.

All repair agents have enforced file boundaries: they can change only the owning
node's file hints. Existing and new test/spec/contract files, check scripts,
standard check configuration and configured `repairProtectedPaths` are protected.
Check entrypoints referenced through nested package scripts are protected too.
Frozen/test paths from an attached v2 manifest are also protected. An agent that
changes these files or Git history fails the repair and its source is not landed.
Use explicit reviewed work to correct a defective test or configuration.

### Deferring prerequisites

Use `verify_requires` on a node for producers needed by its local verifier.
Admission adds the corresponding missing dependency edges only when all producer
IDs exist and the graph remains acyclic. Missing IDs, ambiguous creators and
cycles remain graph problems; an agent cannot invent producers or remove edges.

Wave/composed commands may declare `checkPrerequisites`, mapping the exact command
to producer node IDs. The runner records an unmet check as **deferred**, does not
execute it or spend repair budget, and retries it at subsequent wave/final checks.
A deferred check is never counted as passing acceptance. A missing-file diagnostic
may also defer a checkpoint if it names an artifact with exactly one declared,
unfinished producer. Missing packages/tools, unknown ownership and a missing
artifact whose producer already completed require diagnosis.

```json
{
  "settings": {
    "nodeRepairRounds": 1,
    "repairRounds": 2,
    "phaseTimeouts": { "repair": 300000 },
    "repairProtectedPaths": ["acceptance", "scripts/release-check.mjs"],
    "checkPrerequisites": { "npm run integration": ["api", "client"] }
  }
}
```

Put `"verify_requires": ["api"]` on a consumer node when its local check needs
the `api` producer. A runtime local check that unexpectedly needs a future node
is held for a graph correction; it cannot be silently passed or deferred past
a downstream task that depends on its own successful verification.

## Merge conflicts preserve good work

Local verification produces an immutable candidate commit pinned on a node branch.
Landing serializes merges into integration. If a conflict occurs, `conflictCommand`
(or the repair harness) receives only the conflict-resolution instruction. The
runner checks that every non-conflict file and every byte outside marker blocks
is unchanged, and that the resolver did not alter Git history. It stages the
resolved files and completes the merge. Unsupported/binary conflicts fail landing.

A failed resolver leaves the verified candidate intact. `dag retry --id ID` retries
landing that candidate; it does not consume another implementation attempt.
Changing a node definition invalidates the candidate. A crash after merge is
reconciled through the saved source's ancestry before dispatching more coding work.

## Independent phase clocks and evidence

| Phase | Default cap |
| --- | --- |
| Setup | 5 minutes |
| Work | 15 minutes |
| Fast verify | 30 seconds; configurable up to 60 seconds |
| Agent repair | 5 minutes |
| Native merge/commit | 2 minutes per operation |
| Conflict resolution | 2 minutes |
| Wave command | 3 minutes |
| Final integration command | 15 minutes |
| Advisory review | 30 seconds; configurable up to 60 seconds |

The default idle cap is 3 minutes. Output or `dag heartbeat --file "$env:DAG_FILE"
--id "$env:DAG_TASK"` refreshes it. Setup cannot spend the coding phase's time.
Every phase records start, finish, duration and result in events and node phase
history; stdout/stderr goes into bounded attempt logs. If an executor cannot be
stopped, the workspace is preserved and new dispatch stops.

Example settings file for `dag settings --flow-config flow-settings.json`:

```json
{
  "phaseTimeouts": { "setup": 300000, "work": 900000, "verify": 15000 },
  "idleTimeoutMs": 180000,
  "cachePaths": ["node_modules", ".venv"],
  "waveChecks": ["npm run build", "npm run typecheck"],
  "finalChecks": ["npm test", "npm run verify:spec"],
  "advisoryCommand": "codex exec {spec}",
  "repairCommand": "codex exec {spec}",
  "conflictCommand": "codex exec {spec}",
  "repairRounds": 2
}
```

The CLI exits nonzero for failed/blocked/skipped nodes, failed checks, missing
checkpoint configuration, stop, or budget exhaustion. `summary.flow3` and the
persisted `flowState` expose acceptance and remaining issues to the viewer/API.
Factory/controller-managed runs retain their separate lifecycle.
