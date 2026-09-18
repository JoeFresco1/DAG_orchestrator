// Task-graph editing and inspection: add/edit/remove nodes, bulk `set`,
// reviewers attached to a task, gates, logs, and the diagnostic views
// (list/status/ready/blocked/show/dot).
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  addTask,
  attemptLogFiles,
  editTask,
  loadRun,
  readAttemptLog,
  readEventLog,
  recordHeartbeat,
  removeTask,
  resolveGate,
  runPaths,
  saveRun,
  setGate,
  setTasks,
} from '../store.js';
import {
  deriveStatus,
  describeStuck,
  getBlocked,
  getReady,
  summarize,
  topoSort,
} from '../graph.js';
import { type Reviewer } from '../review-policy.js';
import { findHarness, harnessCommands } from '../harnesses.js';
import { parseHarnessChain } from '../harness-chain.js';
import {
  cmdFlag,
  countFlag,
  emit,
  flag,
  flagRequired,
  guard,
  has,
  numberFlag,
  parseList,
  retriesToMaxAttempts,
  secondsToMs,
  shortN,
  taskTimingFlags,
} from '../cli-args.js';
import { TASK_STATUSES, type TaskStatus } from '../types.js';

// `add` appends a task to the graph. The spec is required to be self-contained
// (Inputs/Outputs/Acceptance) but the CLI only enforces title + optional spec,
// and accepts the same timing/review flags as `edit`.
export function addCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const title = flag(argv, 'title');
  const spec = flag(argv, 'spec') ?? '';
  if (!title) throw new Error('--title is required');
  const task = addTask(run, {
    title,
    spec,
    deps: parseList(flag(argv, 'deps')),
    cmd: cmdFlag(argv) ?? null,
    ...taskTimingFlags(argv),
  });
  saveRun(run, file);
  emit(argv, task, () => task.id);
}

// `edit` patches one task in place. A patch must change something; deps are
// replaced wholesale via --deps or cleared with --clear-deps.
export function editCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const id = flag(argv, 'id');
  if (!id) throw new Error('--id is required');
  const patch: Parameters<typeof editTask>[2] = {};
  const title = flag(argv, 'title');
  const spec = flag(argv, 'spec');
  const cmdV = cmdFlag(argv);
  const status = flag(argv, 'status') as TaskStatus | undefined;
  if (title !== undefined) patch.title = title;
  if (spec !== undefined) patch.spec = spec;
  if (cmdV !== undefined) patch.cmd = cmdV;
  if (status !== undefined) {
    if (!TASK_STATUSES.includes(status)) {
      throw new Error(`--status must be one of ${TASK_STATUSES.join('|')} (got ${status})`);
    }
    patch.status = status;
  }
  if (has(argv, 'clear-deps')) patch.deps = [];
  else if (argv.includes('--deps')) patch.deps = parseList(flagRequired(argv, 'deps'));
  const timing = taskTimingFlags(argv);
  if (timing.maxAttempts !== undefined) patch.maxAttempts = timing.maxAttempts;
  if (timing.timeoutMs !== undefined) patch.timeoutMs = timing.timeoutMs;
  if (timing.silenceMs !== undefined) patch.silenceMs = timing.silenceMs;
  // These four are documented on `edit`; they used to be parsed and dropped.
  if (timing.reviewCmd !== undefined) patch.reviewCmd = timing.reviewCmd;
  if (timing.planCmd !== undefined) patch.planCmd = timing.planCmd;
  if (timing.reviewRounds !== undefined) patch.reviewRounds = timing.reviewRounds;
  if (timing.repairRounds !== undefined) patch.repairRounds = timing.repairRounds;
  if (Object.keys(patch).length === 0) {
    throw new Error(
      'nothing to edit; use --title, --spec, --cmd, --deps, --status, --model, --review-cmd, ...',
    );
  }
  const task = editTask(run, id, patch);
  saveRun(run, file);
  console.log(`${task.id} ${task.status} deps=[${task.deps.join(',')}] attempts=${task.attempts}/${task.maxAttempts}`);
}

// `rm` deletes a node and strips it from the deps of every other task.
export function rmCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const id = flag(argv, 'id');
  if (!id) throw new Error('--id is required');
  removeTask(run, id);
  saveRun(run, file);
  emit(argv, { removed: id }, () => `removed ${id}`);
}

// `list` prints tasks in topological order, optionally filtered by derived
// status and capped with --limit.
export function listCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const run = loadRun(file);
  const only = flag(argv, 'status');
  const limit = countFlag(argv, 'limit', 0) ?? 0;
  const rows = topoSort(run)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      display: deriveStatus(run, t),
      deps: t.deps,
      attempts: t.attempts,
      maxAttempts: t.maxAttempts,
      failureKind: t.failureKind,
    }))
    .filter((r) => !only || r.display === only);
  // --limit 0 (the default) means no cap; a positive value truncates the list.
  const shown = limit > 0 ? rows.slice(0, limit) : rows;
  emit(argv, shown, () =>
    shown
      .map(
        (r) =>
          `${r.id} [${r.display}] deps=[${r.deps.join(',')}] attempts=${r.attempts}/${r.maxAttempts} ${r.title}`,
      )
      .concat(limit > 0 && rows.length > shown.length ? ['… more (use --limit 0 for all)'] : [])
      .join('\n'),
  );
}

// `status` is the run's health at a glance: counts by derived status plus the
// ready set, the blocked set, and why anything is stuck.
export function statusCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const run = loadRun(file);
  const counts: Record<string, number> = {};
  for (const t of Object.values(run.tasks)) {
    const d = deriveStatus(run, t);
    counts[d] = (counts[d] ?? 0) + 1;
  }
  emit(
    argv,
    {
      runId: run.id,
      rev: run.rev,
      total: Object.keys(run.tasks).length,
      counts,
      ready: getReady(run).map((t) => t.id),
      blocked: getBlocked(run).map((t) => t.id),
      stuck: describeStuck(run),
    },
    () => summarize(run),
  );
}

// `ready` lists tasks that would launch right now.
export function readyCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const run = loadRun(file);
  const tasks = getReady(run).map((t) => ({ id: t.id, title: t.title, cmd: t.cmd }));
  emit(argv, tasks, () => tasks.map((t) => `${t.id} ${t.title}`).join('\n'));
}

// `blocked` lists tasks whose dependencies cannot be satisfied (failed upstream).
export function blockedCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const run = loadRun(file);
  const tasks = getBlocked(run).map((t) => ({ id: t.id, title: t.title }));
  emit(argv, tasks, () => tasks.map((t) => `${t.id} ${t.title}`).join('\n'));
}

// `show` prints one task's full detail: status, deps, attempts, review/repair
// budgets, gate, command, result and the attempt logs on disk.
export function showCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const run = loadRun(file);
  const id = flag(argv, 'id');
  if (!id) throw new Error('--id is required');
  const task = run.tasks[id];
  if (!task) throw new Error(`unknown task ${id}`);
  const detail = {
    ...task,
    display: deriveStatus(run, task),
    attemptLogs: attemptLogFiles(file, id),
  };
  emit(argv, detail, () =>
    [
      `${task.id} [${detail.display}] ${task.title}`,
      `deps: ${task.deps.join(', ') || '(none)'}`,
      `attempts: ${task.attempts}/${task.maxAttempts}${task.failureKind ? ` · failure: ${task.failureKind}` : ''}${task.exitCode !== null ? ` · exit: ${task.exitCode}` : ''}`,
      task.reviewCmd ? `review: ${task.reviewCmd} (rounds ${task.reviews}/${task.reviewRounds + 1}, last exit ${task.reviewExitCode ?? '-'})` : '',
      task.repairRounds > 0 ? `repair rounds used: ${task.repairs}/${task.repairRounds}` : '',
      task.gate ? `gate: ${task.gate.question} [${task.gate.approved}]` : '',
      `cmd: ${task.cmd ?? '(manual)'}`,
      `result: ${task.result ?? '(none)'}`,
      task.reviewResult ? `review result: ${task.reviewResult}` : '',
      `logs: ${detail.attemptLogs.length > 0 ? detail.attemptLogs.map((n) => `attempt ${n}`).join(', ') : '(none)'}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

// `set` (alias `set-cmd`) bulk-edits tasks selected by --all/--only/--match:
// harness, command, reviewers, retry and timing budgets. Nothing is changed
// unless at least one field flag was passed.
export function setCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const patch: Parameters<typeof setTasks>[1] = {};
  if (argv.includes('--cmd')) patch.cmd = cmdFlag(argv) ?? null;
  const chainText = flag(argv, 'harness-chain');
  if (chainText !== undefined) {
    patch.harnessChain = chainText ? parseHarnessChain(chainText) : null;
  }
  const harnessName = flag(argv, 'harness');
  if (harnessName !== undefined) {
    const harness = findHarness(harnessName);
    if (!harness) throw new Error(`unknown harness ${harnessName}; try: dag harness list`);
    if (!harness.cmd) throw new Error(`harness ${harnessName} has no command preset`);
    Object.assign(
      patch,
      harnessCommands(harness, {
        withPlan: !has(argv, 'no-plan'),
        withReview: has(argv, 'with-review'),
      }),
    );
    // An explicit single tool supersedes a stale fallback chain.
    if (chainText === undefined) patch.harnessChain = null;
    // Model ids are provider-specific: carrying one across harnesses sends a
    // name the new tool cannot resolve, so clear it unless set in this call.
    if (!argv.includes('--model')) patch.model = null;
    if (!argv.includes('--variant')) patch.variant = null;
  }
  if (argv.includes('--model')) patch.model = flag(argv, 'model') ?? null;
  if (argv.includes('--reviewers-json')) {
    const parsed = JSON.parse(flag(argv, 'reviewers-json') ?? '[]') as Reviewer[];
    patch.reviewers = parsed;
  }
  if (argv.includes('--variant')) patch.variant = flag(argv, 'variant') ?? null;
  if (argv.includes('--review-cmd')) patch.reviewCmd = flag(argv, 'review-cmd') ?? null;
  if (argv.includes('--plan-cmd')) patch.planCmd = flag(argv, 'plan-cmd') ?? null;
  if (argv.includes('--prepare-cmd')) patch.prepareCmd = flag(argv, 'prepare-cmd') ?? null;
  if (has(argv, 'clear-review')) patch.reviewCmd = null;
  const reviewRounds = countFlag(argv, 'review-rounds', 0);
  if (reviewRounds !== undefined) patch.reviewRounds = reviewRounds;
  const repairRounds = flag(argv, 'repair-rounds');
  if (repairRounds !== undefined) patch.repairRounds = countFlag(argv, 'repair-rounds', 0);
  const maxAttempts = retriesToMaxAttempts(flag(argv, 'retries'));
  if (maxAttempts !== undefined) patch.maxAttempts = maxAttempts;
  const timeoutMs = secondsToMs(flag(argv, 'timeout'));
  if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
  const silenceMs = secondsToMs(flag(argv, 'silence'));
  if (silenceMs !== undefined) patch.silenceMs = silenceMs;
  if (Object.keys(patch).length === 0) {
    throw new Error(
      'nothing to set; use --cmd, --review-cmd, --review-rounds, --repair-rounds, --retries, --timeout, --silence',
    );
  }
  const changed = setTasks(run, patch, {
    all: has(argv, 'all'),
    only: parseList(flag(argv, 'only')),
    match: flag(argv, 'match'),
  });
  saveRun(run, file);
  emit(
    argv,
    { changed, fields: Object.keys(patch) },
    () =>
      changed.length > 0
        ? `updated ${changed.length} task(s): ${Object.keys(patch).join(', ')}`
        : 'no tasks matched',
  );
}

// `heartbeat` lets a worker that writes files instead of streaming stdout prove
// it is alive, so the silence watchdog leaves it alone.
export function heartbeatCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const id = flag(argv, 'id');
  if (!id) throw new Error('--id is required');
  recordHeartbeat(file, id);
  emit(argv, { id, at: new Date().toISOString() }, () => `heartbeat ${id}`);
}

// `log` prints the event history (last N lines, default 40).
export function logCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const n = shortN(argv) ?? countFlag(argv, 'lines', 0) ?? 40;
  const events = readEventLog(file, n);
  emit(argv, events, () =>
    events
      .map((ev) => `${ev.ts} ${ev.type}${ev.taskId ? ` ${ev.taskId}` : ''} ${ev.message}`)
      .join('\n'),
  );
}

// `logs` prints a task's captured stdout/stderr for one attempt (default: the
// latest attempt).
export function logsCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const id = flag(argv, 'id');
  if (!id) throw new Error('--id is required');
  const attempts = attemptLogFiles(file, id);
  if (attempts.length === 0) {
    emit(argv, { attempts: [], attempt: null, content: null }, () => `no attempt logs for ${id}`);
    return;
  }
  const requested = flag(argv, 'attempt');
  const attempt = requested ? Number(requested) : attempts[attempts.length - 1];
  const content = readAttemptLog(file, id, attempt);
  emit(argv, { attempts, attempt, content }, () => {
    return `# ${id} attempt ${attempt} (attempts: ${attempts.join(', ')})\n${content ?? '(empty)'}`;
  });
}

// `gc` prunes attempt logs and the rotated event log older than --days.
export function gcCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const days = numberFlag(argv, 'days', 0) ?? 7;
  const cutoff = Date.now() - days * 24 * 3600_000;
  const paths = runPaths(file);
  let removed = 0;
  try {
    for (const name of readdirSync(paths.logs)) {
      const full = join(paths.logs, name);
      if (statSync(full).mtimeMs < cutoff) {
        rmSync(full, { force: true });
        removed += 1;
      }
    }
  } catch {
    // no logs dir yet
  }
  try {
    // The event log rotates to a single `.1` file; older history is discarded.
    const rotated = `${paths.events}.1`;
    if (statSync(rotated).mtimeMs < cutoff) {
      rmSync(rotated, { force: true });
      removed += 1;
    }
  } catch {
    // no rotated log
  }
  emit(argv, { removed, days }, () => `removed ${removed} file(s) older than ${days} day(s)`);
}

// `gate` puts a human approval gate on a task; the run waits (or skips, per the
// run policy) until it is resolved.
export function gateCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const id = flag(argv, 'id');
  const question = flag(argv, 'question');
  if (!id || !question) throw new Error('--id and --question are required');
  const options = parseList(flag(argv, 'options'));
  const gate = setGate(run, id, question, options.length > 0 ? options : ['approved', 'rejected']);
  saveRun(run, file);
  emit(argv, { id, gate }, () => `gate set on ${id}`);
}

// `approve` / `reject` resolve the gate on a task.
export function approveCmd(argv: string[], cmd: string): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const id = flag(argv, 'id');
  if (!id) throw new Error('--id is required');
  const resolved = resolveGate(run, id, cmd === 'approve');
  saveRun(run, file);
  emit(argv, { id, resolved }, () => `${id} ${cmd}d`);
}

// `dot` renders the graph as Graphviz.
export function dotCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const run = loadRun(file);
  // Graphviz IDs come from untrusted task titles, so quotes are neutralized
  // rather than escaped.
  const lines = [`digraph "${run.id}" {`, `  label="${run.objective.replace(/"/g, "'")}";`];
  for (const t of Object.values(run.tasks)) {
    const display = deriveStatus(run, t);
    lines.push(`  "${t.id}" [label="${t.id}\\n${t.title.replace(/"/g, "'")}\\n${display}"];`);
    for (const d of t.deps) lines.push(`  "${d}" -> "${t.id}";`);
  }
  lines.push('}');
  emit(argv, { dot: lines.join('\n') }, () => lines.join('\n'));
}
