# DAG Orchestrator

A file-backed orchestrator for coding agents. You describe work as a dependency
graph; it runs the graph with your agent CLI, in dependency order, in parallel,
each task in its own git worktree — and it verifies the work before anything is
merged.

It is deliberately small and boring: no daemon, no database, no Electron, no
server you have to keep alive. One run file per project, plain JSON you can
read, and a viewer that serves from it.

```
        ┌─ plan ──────── planner agent (optional)
task ───┼─ work ──────── your command / agent CLI
        ├─ review ────── grounded reviewer (optional, verdict-gated)
        └─ land ──────── commit + merge into dag/<runId>
```

## Requirements

- Node 20+ and git
- An agent CLI for tasks to call — [opencode](https://opencode.ai) is what it
  is built and tested against (`opencode run --auto ...`). Any non-interactive
  command works, including plain shell commands.

## Install

```bash
git clone https://github.com/JoeFresco1/DAG_orchestrator.git
cd DAG_orchestrator
pnpm install
pnpm build          # compiles to dist/ and vendors the viewer bundle
npm link            # optional: puts `dag` on your PATH
```

Without `npm link`, use `node dist/cli.js <command>` instead of `dag`.

## Quickstart

```bash
cd ~/my-project
dag init --objective "ship the capture pipeline"
dag settings --worktree task --concurrency 3 \
  --model opencode-go/your-model --variant xhigh \
  --notify "curl -s -d \"\$DAG_EVENT \$DAG_TASK\" https://your-hook"

# tasks are self-contained: inputs, outputs, acceptance
dag add --title "Add the parser" \
  --spec "Inputs: docs/TECH_SPEC.md §2. Outputs: src/parse.ts. Acceptance: pnpm test parse." \
  --cmd "opencode run --auto -m {model} --variant {variant} Do this task: {spec}" \
  --plan-cmd "opencode run --auto -m {model} --variant {variant} --agent plan Plan it: {spec}" \
  --review-cmd "opencode run --auto -m {model} --variant {variant} Verify the acceptance criterion against the real files. End with VERDICT: PASS or VERDICT: FAIL: reason — {spec}" \
  --review-rounds 1

dag add --title "Wire it up" --spec "..." --deps <id> --cmd "..."

dag serve --open          # watch it; press Run, or:
dag run --concurrency 3   # headless; exits 1 if anything failed
```

## How it works

**One run file per project.** `dag.run.json` holds the graph; a sidecar
directory holds everything else:

```
dag.run.json           graph: tasks, deps, specs, commands, policies
dag.run.d/state.json   statuses, attempts, results, verdicts
dag.run.d/events.jsonl append-only history (seq-cursored)
dag.run.d/logs/        per-attempt transcripts (the "terminals")
dag.run.d/plans/       planner output per attempt
dag.run.d/deps/        upstream evidence per attempt
```

**One runner per file.** A pid lock (stale-detecting) guarantees a single
writer, and that runner runs many workers in parallel. Different projects are
different files and run independently.

**Task lifecycle.** `plan → work → review → land`. A planning phase that fails
fails the task — the work never runs unplanned. A reviewer that rejects sends
the work back, bounded by `--review-rounds`. A reviewer that *crashes* fails as
infrastructure, not as a verdict.

**Verdicts are machine-readable.** Agent harnesses exit 0 whatever they
conclude, so a reviewer must end with:

```
VERDICT: PASS
VERDICT: FAIL: tests/test_import.py still asserts the old record shape
```

No verdict = **failed closed** (never a silent pass). Shell reviewers
(`pytest -q`) can use `--review-verdict exit-code` instead.

**Worktree isolation.** With `--worktree task`, every task runs in its own git
worktree on a per-run integration branch (`dag/<runId>`). A baseline snapshot
commit of your *current* working tree (untracked files included) is the base,
so uncommitted work is visible to the agents; your checkout is never touched.
Work merges only after the task and its reviewer pass; conflicts are redone on
the new base (bounded by `mergeRounds`). Failed or stopped tasks get a WIP
commit on their own `dag-task/…` branch instead — partial work is recoverable,
never merged.

**Failure is explicit.** Every failure carries a kind — `exit`, `spawn`,
`timeout`, `stalled`, `killed`, `manual`, `interrupted`, `review`, `merge`,
`plan`, `worktree` — plus exit code and the tail of the output. Nothing fails
silently.

**Liveness.** A hard per-attempt `timeout`; a `silence` alert that *warns* by
default (agents legitimately go quiet during buffered tool calls) with
`--silence-action kill` as an option; `dag heartbeat --id <task>` for workers
that write files instead of streaming.

**Crash recovery.** `dag resume` requeues interrupted tasks,
`dag kill-orphans` reaps process trees from a dead run, `dag serve
--auto-resume` does both at boot.

## Tokens

Usable in any task command (`cmd`, `planCmd`, `reviewCmd`):

| Token | Value |
|---|---|
| `{spec}` `{title}` `{id}` | the task's own fields |
| `{plan}` `{planFile}` | planner output, inline / as a file |
| `{deps}` | what each direct dependency actually produced (result, verdict, branch@commit) |
| `{depsAll}` `{depsFile}` | transitive roll-up, inline / as a file |
| `{model}` `{variant}` | effective model/effort: task override → run default; unset removes the flag |

## Multi-project, scheduling, migration

```bash
dag launch --all --open          # one server + stable port per project
dag servers | dag servers --stop --all

dag schedule add --file a/dag.run.json --name a
dag schedule add --file b/dag.run.json --name b --after a
dag scheduler                    # runs jobs strictly in order

dag import-orca --list           # migrate an existing Orca run (read-only)
dag import-orca --run run_xxx --cmd "opencode run --auto {spec}"
```

## CLI cheat sheet

```
init · add · edit · rm · list · status · ready · blocked · show · log · logs
run [--only a,b] [--concurrency N] [--on-dep-failure block|skip] [--max-hours H]
retry --id X [--cascade]     requeue a failed task (and its failed subtree)
retry-failed                 requeue everything that failed
resume · kill-orphans · skip-blocked · gc · settings · set · models
review --of a,b --cmd "check"        scaffold an integration node (repairs upstream)
review --id X --review-cmd "check"   attach a reviewer postcondition
gate · approve · reject · heartbeat · dot · serve · launch · schedule · scheduler
```

Run `dag --help` for the full surface. Every command accepts `--json`.

## Viewer

`dag serve --open`. Left-to-right DAG colored by status; queue with checkboxes
to run a subset; inspector with per-task model override; **double-click a task
for its live terminal** (streaming transcript, attempt switcher, follow mode);
collapsible panels; settings (☰) with per-field explanations; zoom readout
bottom-left. The viewer is ~1000 lines of vanilla JS with a vendored
vis-network; nothing is fetched from the network.

## Tests

```bash
pnpm test        # 66 tests: graph semantics, scheduling, watchdogs, retries,
                 # review/verdict protocol, worktree isolation + conflicts,
                 # locks, recovery, migration
```

## Notes

- This is a clean-room tool; it does not depend on or talk to Orca. The
  optional `import-orca` command reads Orca's SQLite database **read-only** to
  migrate an existing graph.
- Task state is plain JSON; nothing is hidden in a database you cannot diff.

MIT licensed.
