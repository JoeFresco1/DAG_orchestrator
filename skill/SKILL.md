---
name: dag-orchestrator
description: >-
  Plan and execute work as a dependency graph with the global `dag` CLI —
  a file-backed orchestrator for coding agents. Use when the
  user wants to break a feature/project into tasks with dependencies, run
  tasks with agents or shell commands, schedule runs ("run this first, then
  that"), inspect DAG progress, or recover failed/blocked work. Triggers:
  "dag", "dag orchestrator", "dependency graph", "orchestrate these tasks",
  "run this plan", "schedule the runs", "retry the failed tasks".
---

# DAG Orchestrator

Global CLI: `dag`. If it is missing, install it from this repository:
`pnpm install && pnpm build && npm link` (or run `node dist/cli.js …`).

Each project owns one run file — `./dag.run.json` plus a `dag.run.d/` sidecar
(state, events, logs). One hub process can serve many projects: `/` lists
them, `/r/<runId>` shows one run scoped end to end. `dag new-run` archives the
active run so history stays in the project folder.

## Ground rules

- Work in the current project directory; `--file` defaults to `./dag.run.json`.
- Pass `--json` for anything you need to parse.
- While a run is active the run file is locked. Do not edit tasks then —
  wait, or stop the run first. `dag add` will refuse with the lock holder.
- Prefer many small, independently verifiable tasks over one big task.

## Inspect first

```bash
dag status --json          # counts, ready, blocked, stuck reasons
dag list --json --limit 200
dag ready --json           # what would launch right now
dag log --n 20             # event history
```

## Create tasks

```bash
dag add --title "Build the parser" \
  --spec "Inputs: docs/TECH_SPEC.md sections 2-3. Outputs: src/parser.ts with parse(). Acceptance: pnpm test src/parser.test.ts passes." \
  --deps task_ab12cd34 --cmd "pnpm test src/parser.test.ts" \
  --retries 2 --timeout 1800 --silence 600 --json
```

Spec rules — self-contained so a worker never asks questions or enters plan mode:

- **Inputs**: files/interfaces to read, which deps it builds on.
- **Outputs**: exact files or commands produced.
- **Acceptance**: a runnable check (test command, expected output/exit code).
- Imperative sentences. No "investigate", "as appropriate", "consider".

`--cmd` is required for auto-runs. A task without `cmd` is manual: the runner
skips it and the viewer marks it done by hand.

## Wire the graph

- `--deps id1,id2` enforces order; independent tasks run in parallel up to
  `--concurrency`.
- Human approval gates: `dag gate --id X --question "Ship it?"`, then
  `dag approve --id X` / `dag reject --id X`.
- Edit anything, any time: `dag edit --id X --spec ... --deps a,b`,
  `dag rm --id X`.

## Run

```bash
# Foreground: waits, prints events, exits 1 if anything failed/unfinished
dag run --concurrency 4
dag run --only task_a,task_b          # scoped run
dag run --on-dep-failure skip         # failures don't strand descendants
dag run --gates skip --max-hours 8    # unattended policy + budget
```

Set `--retries N` (extra attempts with exponential backoff) and
`--timeout`/`--silence` (hard cap; no-output stall) per task or per run.
Timeout and stall failures are retried automatically while attempts remain.

## Watch (one browser window per project)

```bash
dag launch --dir C:\path\to\project --open   # stable port, opens browser
dag launch --all --open                      # every registered project
dag servers                                  # list URLs + pids
dag servers --stop --all
```

Or single project: `dag serve --open`.

## Unattended / after a crash

```bash
dag serve --auto-resume --kill-orphans   # recover + start, no clicking
dag resume                               # just requeue interrupted tasks
dag kill-orphans                         # reap processes from a dead run
```

## Schedule runs (A first, then B)

```bash
dag schedule add --file C:\a\dag.run.json --name a --concurrency 8
dag schedule add --file C:\b\dag.run.json --name b --after a
dag schedule add --file C:\c\dag.run.json --name c --at "2026-09-16 01:00" --after b
dag scheduler            # runs them one at a time, in order
dag schedule list        # job ids, statuses, chains
dag schedule rm <job>
```

If a predecessor fails, its dependents are marked `blocked`, not run.

## Recovery — never hand-reset tasks

```bash
dag retry --id X --cascade     # requeue a failed task and its failed subtree
dag retry-failed --cascade     # requeue everything that failed
dag skip-blocked               # mark blocked/gated as skipped so the run converges
dag logs --id X                # per-attempt stdout/stderr
dag logs --id X --attempt 2
```

Statuses: `pending | ready | running | completed | failed | skipped`
(derived: `blocked`, `gated`). Failure kinds: `exit | spawn | timeout |
stalled | killed | manual | interrupted`. Exit codes and results are recorded
on every failure; `dag run` exits 1 when anything failed or is unfinished.

## Agents as workers

`--cmd` accepts any non-interactive shell command. To put an agent on a task,
write the spec to a file in the task or inline it:

```bash
dag add --title "Implement auth" --spec "..." --cmd "opencode run \"Implement auth per docs/TECH_SPEC.md\"" --json
```

Keep commands non-interactive; the runner detects output silence and kills at
the timeout. `--model` / agent flags belong inside the command.

## Worktree isolation (parallel agents)

Parallel tasks editing one working tree will collide. `--worktree task` gives
every task its own git worktree on a per-run integration branch, so agents
never touch the caller's checkout:

```bash
dag settings --worktree task --concurrency 3
dag run --worktree task --concurrency 3
```

- A snapshot commit of the *current* working tree (dirty edits + untracked
  files) is the base, so uncommitted work is visible to the agents.
- Each task runs in its own worktree, commits its changes, and merges into
  `dag/<runId>`. A downstream task branches after its deps merged, so it sees
  their work.
- A merge conflict is redone on the new base (bounded by `mergeRounds`,
  default 2), not charged against command retries. It only fails the task
  after those redos.
- The user's branch is untouched: review with `git log dag/<runId>` and merge
  it when satisfied. Failed tasks keep their branch for inspection.
- If isolation cannot be set up, the run refuses to start rather than letting
  agents loose in the real tree.

## Planning phase (plan → work → review)

`--plan-cmd` runs *before* the task's command. Its output is captured on the
task and written to a plan file, both available to the work command as
`{plan}` (inline text) and `{planFile}` (absolute path):

```bash
dag set --match "^D-[2-7]" \
  --plan-cmd "opencode run --auto -m opencode-go/muse-spark-1.3-contributor --variant xhigh --agent plan Produce a step-by-step implementation plan (files to touch, order, checks) for: {spec}" \
  --cmd "opencode run --auto -m opencode-go/muse-spark-1.3-contributor --variant xhigh Implement this. A plan is at {planFile}; follow it, deviate only if it is wrong. Task: {spec}" \
  --review-cmd "opencode run --auto -m opencode-go/muse-spark-1.3-contributor --variant xhigh Inspect the working tree and verify this acceptance criterion is genuinely met (run the checks). Reply FAIL and say what is missing if not: {spec}" \
  --review-rounds 1
```

A planning phase that fails fails the task (`failureKind: plan`) and the work
command never runs — a plan you asked for is not optional. Tokens usable
anywhere in a command: `{id}`, `{title}`, `{spec}`, `{plan}`, `{planFile}`,
`{deps}`, `{depsAll}`, `{depsFile}`.

## Grounding reviewers in upstream evidence

`{deps}` inlines what each **direct** dependency actually produced (status,
result, review verdict, branch/commit). `{depsAll}` is a compact roll-up of
every transitive upstream task. `{depsFile}` is a markdown file with both.
This is what makes an integration check grade claims against the graph rather
than vibes:

```bash
# A verifier that knows what the wave delivered (note {depsAll}).
dag set --match "^D-8" --cmd "opencode run --auto -m <model> --variant xhigh \
  You are the convergence verifier. Evidence from every upstream task: {depsAll} \
  Inspect the working tree, run the phase checks, reply FAIL naming incomplete tasks: {spec}"

# A reviewer that checks the artifact against what upstream promised.
dag set --match "^D-[2-7]" --review-cmd "opencode run --auto -m <model> --variant xhigh \
  Verify this acceptance criterion against the real files. Upstream produced: {deps} \
  Reply FAIL with specifics if it is not genuinely met: {spec}"
```

## Reviewer agents (postconditions)
A `--review-cmd` runs after the task's command succeeds. Exit 0 accepts the
work; non-zero rejects it and the task is redone (bounded by
`--review-rounds`, default 0 = one review pass, no redo). A reviewer that
times out or stalls fails the task outright — that is infrastructure, not a
verdict.

```bash
# An agent verifies the artifact before the task can complete.
dag add --title "Implement parser" --spec "..." \
  --cmd "opencode run \"Implement parser per docs/TECH_SPEC.md\"" \
  --review-cmd "opencode run \"Read src/parser.ts and run pnpm test src/parser.test.ts. Exit 1 if it does not meet the spec.\"" \
  --review-rounds 2 --json
```

## Integration agents (repair upstream)

An integration node depends on several tasks and checks that their outputs
mesh. Scaffold one with `dag review` — it generates the spec (listing the
upstream tasks and their results), sets the deps, and defaults
`--repair-rounds 1`, so a permanent failure requeues the upstream plus itself
instead of dying:

```bash
dag review --of task_api,task_client \
  --cmd "pnpm test integration" \
  --title "integration: API + client agree" \
  --repair-rounds 1 --json
```

Review an existing task alone (postcondition, no upstream repair):

```bash
dag review --id task_parser --review-cmd "pnpm test src/parser.test.ts" --review-rounds 2
```

Inspect any task's state, verdict, and logs from inside a worker:
`dag show --id task_x --json`.

Events to watch: `task-review` (verdicts), `task-repair` (upstream requeued),
`task-stall-warning` (quiet worker), all visible in `dag log` and the viewer.

## Liveness

- Silence watchdog: a running task killed after `--silence` seconds with no
  stdout/stderr, retried while attempts remain.
- Heartbeats: a worker that writes files instead of streaming output can call
  `dag heartbeat --id <task>` (any language, any tool) to prove liveness and
  avoid the stall kill.
- Setup: `dag settings --silence 600 --timeout 3600 --notify "<cmd>"`.

## Notifications while you are away

`notifyCmd` runs on `task-fail`, `task-timeout`, `task-stalled`, `run-stop`,
and `run-end`, with `DAG_EVENT`, `DAG_TASK`, `DAG_MESSAGE`, `DAG_FILE`,
`DAG_RUN` in its environment:

```bash
dag settings --notify "curl -s -X POST -d \"$DAG_EVENT $DAG_TASK\" https://example.com/hook"
```

## Reviewers and prepare (recent)

- A task can carry **several reviewers**, each with its own verdict:
  `dag reviewer add --id X --name regression --cmd "uv run pytest -q" --when always --verdict exit-code`,
  `--name contract --cmd "opencode run … End with VERDICT: PASS or VERDICT: FAIL: reason" --when diff-lines>250`.
  `when` is `always | on-reject | diff-lines>N | diff-touches:glob,glob` (clauses ANDed with `;`).
  Agent reviewers must end with `VERDICT: PASS` or `VERDICT: FAIL: reason`; no verdict fails closed.
- Worktrees have no `.venv`/`node_modules` (they are not in git), so set a prepare step:
  `dag settings --worktree-prepare "uv sync --directory backend --frozen"`.
- Review rejection reasons are fed back to the redo prompt via `{lastRejection}`.

## One host, many projects

`dag serve` (no `--file`) is a hub over every registered project:
`/` lists projects and their runs; `/r/<runId>` shows exactly one run.
`dag serve --file dag.run.json` still focuses a single run.

Runs live in the project folder and history is kept beside it:

```bash
dag new-run --objective "next plan"   # archive the active run, start fresh
dag runs                             # active + archived runs with counts
```

Archived runs are read-only history; starting one is refused. Each run has its
own runner and lock, so runs in different projects proceed concurrently.
