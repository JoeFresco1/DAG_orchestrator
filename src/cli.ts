#!/usr/bin/env node
// Zero-dependency CLI. Every mutation rewrites the run files.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireLock,
  addTask,
  assertNoForeignLock,
  attemptLogFiles,
  buildIntegrationSpec,
  editTask,
  killOrphans,
  loadRun,
  newRun,
  orphanedPids,
  readAttemptLog,
  readEventLog,
  recoverInterrupted,
  recordHeartbeat,
  removeTask,
  resolveGate,
  retryFailed,
  retryTask,
  runPaths,
  saveRun,
  setGate,
  setSettings,
  setTasks,
  skipBlocked,
  skipGated,
} from './store.js';
import {
  deriveStatus,
  computeDepths,
  describeStuck,
  evaluateConvergence,
  getBlocked,
  getReady,
  summarize,
  topoSort,
  transitiveDepIds,
} from './graph.js';
import { DagRunner } from './runner.js';
import { startServer } from './server.js';
import { parseWhen, type Reviewer } from './review-policy.js';
import { HARNESSES, findHarness, harnessCommands } from './harnesses.js';
import { parseHarnessChain } from './harness-chain.js';
import { activeRunFile, archiveRun, findRun, listRuns, projectOf, startNewRun } from './runs.js';
import { listAgentModels } from './agent-models.js';
import { resolveCommand } from './command-resolution.js';
import { addProject, findProject, loadRegistry, projectId, removeProject, resolveRunFile } from './registry.js';
import {
  launchProject,
  pruneServers,
  projectEntriesFromArgs,
  stopServer,
} from './launcher.js';
import {
  addJob,
  jobSummary,
  loadSchedule,
  parseAt,
  removeJob,
  retryJob,
  runScheduler,
  type JobArgs,
} from './scheduler.js';
import type { DepFailurePolicy, GatePolicy, TaskStatus } from './types.js';
import { MAX_CONCURRENCY, TASK_STATUSES, type Task } from './types.js';

const wantsJson = (argv: string[]): boolean => argv.includes('--json');
const emit = (argv: string[], data: unknown, human: () => string): void => {
  console.log(wantsJson(argv) ? JSON.stringify(data, null, 2) : human());
};

// A value that looks like another flag means the value is missing. Without
// this, `set --cmd --file X` stores the literal string "--file" as the command.
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  if (next === undefined || (next.startsWith('--') && next !== '--')) return undefined;
  return next;
}

// For flags whose value is required: `--cmd` with nothing after it is a
// mistake, not a request to clear the field.
function flagRequired(argv: string[], name: string): string {
  const v = flag(argv, name);
  if (v === undefined) throw new Error(`--${name} needs a value`);
  return v;
}

// --cmd takes a value: a missing one is a mistake, an empty string an explicit clear.
function cmdFlag(argv: string[]): string | null | undefined {
  if (!argv.includes('--cmd')) return undefined;
  const value = flagRequired(argv, 'cmd');
  return value.trim() === '' ? null : value;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

// `-n` is not a --flag, so it needs its own reader.
function shortN(argv: string[]): number | undefined {
  const i = argv.indexOf('-n');
  if (i < 0) return undefined;
  const raw = argv[i + 1];
  if (raw === undefined || raw.startsWith('-')) throw new Error('-n needs a value');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`-n must be an integer >= 0 (got ${raw})`);
  return n;
}

function fileOf(argv: string[]): string {
  return flag(argv, 'file') ?? 'dag.run.json';
}

function parseList(v: string | undefined): string[] {
  const seen = new Set<string>();
  for (const item of v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []) {
    seen.add(item);
  }
  return [...seen];
}

// CLI accepts seconds; the file stores ms. 0 = no limit.
function secondsToMs(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid seconds value: ${v}`);
  return Math.round(n * 1000);
}

// Counts and budgets: reject junk instead of silently storing NaN/null.
function countFlag(argv: string[], name: string, min = 0): number | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`--${name} must be an integer >= ${min} (got ${raw})`);
  }
  return n;
}

function numberFlag(argv: string[], name: string, min = 0): number | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`--${name} must be a number >= ${min} (got ${raw})`);
  }
  return n;
}

function retriesToMaxAttempts(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid --retries value: ${v}`);
  return n + 1;
}

function taskTimingFlags(argv: string[]): {
  maxAttempts?: number;
  timeoutMs?: number | null;
  silenceMs?: number | null;
  reviewCmd?: string | null;
  planCmd?: string | null;
  reviewRounds?: number;
  repairRounds?: number;
} {
  const out: {
    maxAttempts?: number;
    timeoutMs?: number | null;
    silenceMs?: number | null;
    reviewCmd?: string | null;
    planCmd?: string | null;
    reviewRounds?: number;
    repairRounds?: number;
  } = {};
  const maxAttempts = retriesToMaxAttempts(flag(argv, 'retries'));
  if (maxAttempts !== undefined) out.maxAttempts = maxAttempts;
  if (has(argv, 'timeout')) out.timeoutMs = secondsToMs(flagRequired(argv, 'timeout'));
  if (has(argv, 'silence')) out.silenceMs = secondsToMs(flagRequired(argv, 'silence'));
  if (has(argv, 'review-cmd')) out.reviewCmd = flag(argv, 'review-cmd') ?? null;
  if (has(argv, 'plan-cmd')) out.planCmd = flag(argv, 'plan-cmd') ?? null;
  const reviewRounds = countFlag(argv, 'review-rounds');
  if (reviewRounds !== undefined) out.reviewRounds = reviewRounds;
  const repairRounds = countFlag(argv, 'repair-rounds');
  if (repairRounds !== undefined) out.repairRounds = repairRounds;
  return out;
}

function policyFlags(argv: string[]): {
  onDepFailure?: DepFailurePolicy;
  onGateBlocked?: GatePolicy;
} {
  const out: { onDepFailure?: DepFailurePolicy; onGateBlocked?: GatePolicy } = {};
  const dep = flag(argv, 'on-dep-failure');
  if (dep !== undefined) {
    if (dep !== 'block' && dep !== 'skip') {
      throw new Error(`--on-dep-failure must be block|skip (got ${dep})`);
    }
    out.onDepFailure = dep;
  }
  const gates = flag(argv, 'gates');
  if (gates !== undefined) {
    if (gates !== 'wait' && gates !== 'skip') {
      throw new Error(`--gates must be wait|skip (got ${gates})`);
    }
    out.onGateBlocked = gates;
  }
  return out;
}

// Every mutating command owns the run file for its (short) lifetime, so two
// CLI processes can never interleave writes. Read-only commands don't lock.
// The lock is released on exit; a killed process leaves a stale lock that the
// next command steals automatically.
function guard(file: string, argv: string[]): void {
  const note = `dag ${process.argv[2] ?? 'edit'}`;
  const release = acquireLock(file, note, has(argv, 'force'));
  process.on('exit', release);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const file = fileOf(rest);

  if (cmd === 'init') {
    const objective = flag(rest, 'objective') ?? 'untitled dag';
    const run = newRun(objective);
    const s = taskTimingFlags(rest);
    if (s.maxAttempts !== undefined) run.settings.maxAttempts = s.maxAttempts;
    saveRun(run, file);
    emit(rest, { runId: run.id, file }, () => `${run.id}\nSaved to ${file}`);
    return;
  }

  if (cmd === 'serve') {
    // With --file: serve that run. Without it: hub mode, serving every
    // registered project from the registry (never an implicit ./dag.run.json).
    const explicit = flag(rest, 'file');
    startServer({
      file: explicit,
      port: countFlag(rest, 'port', 1) ?? 8787,
      autoResume: has(rest, 'auto-resume'),
      killOrphansOnResume: has(rest, 'kill-orphans'),
      open: has(rest, 'open'),
    });
    await new Promise(() => {});
    return;
  }

  if (cmd === 'launch') {
    // One server per project, each on its own stable port, so every project
    // gets its own browser window and nothing is shared.
    const dirs: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--dir' && rest[i + 1]) dirs.push(rest[i + 1]);
    }
    const entries = projectEntriesFromArgs(dirs, has(rest, 'all'));
    if (entries.length === 0) {
      console.log('no projects selected; use --all or --dir <folder> (repeatable)');
      console.log('tip: register one first with: dag projects add --dir C:\\path\\to\\project');
      process.exitCode = 1;
      return;
    }
    const results: Awaited<ReturnType<typeof launchProject>>[] = [];
    for (const entry of entries) {
      const result = await launchProject(entry, {
        open: has(rest, 'open'),
        autoResume: has(rest, 'auto-resume'),
        killOrphans: has(rest, 'kill-orphans'),
      });
      results.push(result);
    }
    emit(rest, results, () =>
      results
        .map(
          (r) =>
            `${r.alreadyRunning ? 'running' : 'started'}  ${r.entry.name}\t${r.url}\t${r.entry.file}`,
        )
        .join('\n'),
    );
    return;
  }

  if (cmd === 'servers') {
    if (has(rest, 'stop')) {
      const dirs: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--dir' && rest[i + 1]) dirs.push(rest[i + 1]);
      }
      const targets = has(rest, 'all')
        ? pruneServers().map((s) => ({ name: s.name, file: s.file }))
        : dirs.map((d) => {
            const entry = addProject(d);
            return { name: entry.name, file: entry.file };
          });
      if (targets.length === 0) {
        console.log('no servers recorded; use --all or --dir <folder>');
        return;
      }
      const rows = targets.map((t) => ({ name: t.name, ...stopServer(t.file) }));
      emit(rest, rows, () =>
        rows
          .map((r) =>
            r.pid === null
              ? `not running\t${r.name}`
              : r.stopped
                ? `stopped\t${r.name}\tpid ${r.pid}`
                : `still alive\t${r.name}\tpid ${r.pid}`,
          )
          .join('\n'),
      );
      return;
    }
    const alive = pruneServers();
    const rows = alive.map((s) => ({
      ...s,
      url: `http://localhost:${s.port}`,
      alive: true,
    }));
    emit(rest, rows, () =>
      rows.length === 0
        ? 'no servers running; start them with: dag launch --all --open'
        : rows.map((r) => `${r.name}\t${r.url}\tpid ${r.pid}\t${r.file}`).join('\n'),
    );
    return;
  }

  if (cmd === 'schedule' || cmd === 'scheduler') {
    if (cmd === 'scheduler') {
      const code = await runScheduler({
        pollMs: (numberFlag(rest, 'poll', 0.1) ?? 5) * 1000,
        once: has(rest, 'once'),
        drain: has(rest, 'drain'),
        watch: has(rest, 'watch'),
        open: has(rest, 'open'),
      });
      process.exitCode = code;
      return;
    }
    const sub = rest[0] ?? 'list';
    if (sub === 'add') {
      const target = flag(rest, 'file') ?? flag(rest, 'dir');
      if (!target) throw new Error('usage: dag schedule add --file <run file> [--name N] [--at "YYYY-MM-DD HH:MM"] [--after <job>]');
      const args: JobArgs = {};
      const concurrency = flag(rest, 'concurrency');
      if (concurrency !== undefined) args.concurrency = Number(concurrency);
      const retries = flag(rest, 'retries');
      if (retries !== undefined) args.retries = Number(retries);
      const timeout = flag(rest, 'timeout');
      if (timeout !== undefined) args.timeout = Number(timeout);
      const silence = flag(rest, 'silence');
      if (silence !== undefined) args.silence = Number(silence);
      const maxHours = numberFlag(rest, 'max-hours', 0);
      if (maxHours !== undefined) args.maxHours = Number(maxHours);
      const onDepFailure = flag(rest, 'on-dep-failure');
      if (onDepFailure !== undefined) args.onDepFailure = onDepFailure;
      const gates = flag(rest, 'gates');
      if (gates !== undefined) args.gates = gates;
      const only = flag(rest, 'only');
      if (only !== undefined) args.only = only;
      if (has(rest, 'kill-orphans')) args.killOrphans = true;
      const at = flag(rest, 'at');
      const job = addJob({
        name: flag(rest, 'name') ?? resolveRunFile(target).replace(/.*[\\/]/, ''),
        file: target,
        at: at ? parseAt(at) : null,
        after: flag(rest, 'after') ?? null,
        args,
      });
      emit(rest, job, () => jobSummary(job));
      return;
    }
    if (sub === 'rm' || sub === 'remove') {
      const target = rest[1] ?? flag(rest, 'id');
      if (!target) throw new Error('usage: dag schedule rm <job id|name>');
      const removed = removeJob(target);
      emit(rest, { removed }, () => (removed ? `removed ${target}` : `no job matched ${target}`));
      if (!removed) process.exitCode = 1;
      return;
    }
    if (sub === 'retry') {
      const target = rest[1] ?? flag(rest, 'id');
      if (!target) throw new Error('usage: dag schedule retry <job id|name>');
      const job = retryJob(target);
      emit(rest, job ?? { retried: false }, () =>
        job ? `requeued ${job.id} (${job.name})` : `no job matched ${target}`,
      );
      if (!job) process.exitCode = 1;
      return;
    }
    if (sub === 'clear') {      const schedule = loadSchedule();
      const before = schedule.jobs.length;
      const { saveSchedule } = await import('./scheduler.js');
      schedule.jobs = schedule.jobs.filter(
        (j) => j.status === 'pending' || j.status === 'running',
      );
      saveSchedule(schedule);
      const removedCount = before - schedule.jobs.length;
      emit(rest, { removed: removedCount }, () => `cleared ${removedCount} finished job(s)`);
      return;
    }
    const schedule = loadSchedule();
    emit(rest, schedule.jobs, () =>
      schedule.jobs.length === 0
        ? 'schedule is empty; add one with: dag schedule add --file <run file>'
        : schedule.jobs.map(jobSummary).join('\n'),
    );
    return;
  }

  if (cmd === 'projects') {
    const sub = rest[0] ?? 'list';
    if (sub === 'add') {
      const target = flag(rest, 'dir') ?? rest[1];
      if (!target) throw new Error('usage: dag projects add --dir <project folder> [--name N]');
      const entry = addProject(target, flag(rest, 'name'));
      emit(rest, entry, () => `${entry.name}\t${entry.file}`);
      return;
    }
    if (sub === 'rm' || sub === 'remove') {
      const target = flag(rest, 'id') ?? rest[1];
      if (!target) throw new Error('usage: dag projects rm <id|path|name>');
      const removed = removeProject(target);
      emit(rest, { removed }, () => (removed ? `removed ${target}` : `no project matched ${target}`));
      if (!removed) process.exitCode = 1;
      return;
    }
    if (sub === 'open') {
      // Opens the project page in the hub, starting one if needed.
      const target = flag(rest, 'id') ?? rest[1];
      if (!target) throw new Error('usage: dag projects open <id|name> [--dir <folder>]');
      const entry = findProject(target) ?? addProject(flag(rest, 'dir') ?? target);
      const { launchProject, openBrowser } = await import('./launcher.js');
      const launched = await launchProject(entry, { open: false });
      const url = `${launched.url}/p/${projectId(entry.file)}`;
      openBrowser(url);
      emit(rest, { project: entry.name, url }, () => url);
      return;
    }
    const registry = loadRegistry();
    const rows = registry.projects.map((p) => ({
      id: projectId(p.file),
      name: p.name,
      file: p.file,
      exists: existsSync(p.file),
    }));
    emit(rest, rows, () =>
      rows.length === 0
        ? 'no projects registered; add one with: dag projects add --dir <folder>'
        : rows.map((r) => `${r.id}  ${r.exists ? ' ' : '!'} ${r.name}\t${r.file}`).join('\n'),
    );
    return;
  }

  if (cmd === 'layers') {
    const run = loadRun(file);
    const depths = computeDepths(run);
    const waves = new Map<number, Task[]>();
    for (const task of Object.values(run.tasks)) {
      const d = depths.get(task.id) ?? 0;
      const list = waves.get(d) ?? [];
      list.push(task);
      waves.set(d, list);
    }
    const rows = [...waves.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([depth, list]) => ({
        wave: depth,
        tasks: list.length,
        ids: list.map((t) => t.id),
        titles: list.map((t) => t.title),
      }));
    emit(rest, { waves: rows }, () =>
      rows
        .map((r) => `wave ${r.wave}: ${r.tasks} task(s) — ${r.titles.slice(0, 4).join(' | ')}${r.titles.length > 4 ? ' | …' : ''}`)
        .join('\n'),
    );
    return;
  }

  if (cmd === 'chain-review') {
    guard(file, rest);
    const run = loadRun(file);
    const depths = computeDepths(run);
    const all = Object.values(run.tasks);

    // Which tasks are covered: an explicit list, one wave, or everything.
    let covered: Task[];
    const of = parseList(flag(rest, 'of'));
    const wave = countFlag(rest, 'wave', 0);
    const from = flag(rest, 'from');
    const depth = countFlag(rest, 'depth', 1) ?? 1;
    if (of.length > 0) {
      const unknown = of.filter((id) => !run.tasks[id]);
      if (unknown.length > 0) throw new Error(`unknown task(s): ${unknown.join(', ')}`);
      covered = of.map((id) => run.tasks[id]);
    } else if (wave !== undefined) {
      covered = all.filter((t) => (depths.get(t.id) ?? 0) === wave);
      if (covered.length === 0) throw new Error(`no tasks in wave ${wave}; try: dag layers`);
    } else if (from !== undefined) {
      if (!run.tasks[from]) throw new Error(`unknown task ${from}`);
      const subtree = new Set([from, ...transitiveDepIds(run, from)]);
      // Cover the dependency cone of the anchor, in topological order.
      covered = topoSort(run).filter((t) => subtree.has(t.id));
      if (depth > 1) covered = covered.filter((t) => (depths.get(t.id) ?? 0) <= (depths.get(from) ?? 0));
    } else if (has(rest, 'all')) {
      covered = topoSort(run);
    } else {
      throw new Error('choose what to review: --of a,b | --wave N | --from <id> | --all');
    }
    const done = covered.filter((t) => t.status === 'completed' && !t.covers);
    if (done.length === 0) {
      throw new Error('nothing to review: none of the selected tasks completed (chain tasks are not reviewed twice)');
    }
    // 500 tasks is not one reviewer's job: chunk by --batch (default keeps one
    // task per chunk for an explicit --of, and 25 otherwise).
    const batch = countFlag(rest, 'batch', 1) ?? (of.length > 0 ? done.length : 25);
    const chunks: Task[][] = [];
    for (let i = 0; i < done.length; i += batch) chunks.push(done.slice(i, i + batch));

    const cmd =
      flag(rest, 'cmd') ??
      (run.settings.harnessChain?.length
        ? findHarness(run.settings.harnessChain[run.settings.harnessChain.length - 1].harness)?.cmd
        : undefined) ??
      findHarness('opencode')?.cmd;
    if (!cmd) throw new Error('no command for the reviewer; pass --cmd');

    const created: string[] = [];
    for (const chunk of chunks) {
      const titleBase = flag(rest, 'title') ?? 'chain review';
      const title =
        chunks.length === 1
          ? `${titleBase}: ${chunk.length} task(s)`
          : `${titleBase}: ${chunk.length} task(s) [${created.length + 1}/${chunks.length}]`;
      const spec = [
        'Review the combined work of the tasks listed at the end of this prompt.',
        'This is a review, not an implementation: do not modify files.',
        '',
        'Facts about the covered work:',
        '- covered tasks:',
        '{coverage}',
        '- one diff per task, plus a manifest, live in: {coverageDir}',
        '  (the manifest is {coverageManifest}; each entry names its task, spec, result and diff file)',
        '- changed files across the chain:',
        '{coverageFiles}',
        '- change summary:',
        '{coverageStat}',
        '',
        'Do this:',
        '1. Read the manifest, then the per-task diffs. For each task, check the code actually satisfies its spec - not just that the task ran.',
        '2. Look for what per-task reviews cannot see: tasks contradicting each other, a later task undoing an earlier one, changes that only work in isolation, gaps between tasks, broken integration.',
        '3. Verify with the repository own checks where cheap (build, tests, lint), and say what you ran.',
        '4. Report concrete findings with file:line and the task that caused them.',
        '',
        'End with exactly one line: VERDICT: PASS or VERDICT: FAIL: <reason>',
      ].join('\n');
      const task = addTask(run, {
        title,
        spec,
        cmd,
        deps: chunk.map((t) => t.id),
        covers: chunk.map((t) => t.id),
      });
      created.push(task.id);
    }
    saveRun(run, file);
    emit(
      rest,
      { created, covered: done.map((t) => t.id), chunks: chunks.map((c) => c.length) },
      () =>
        `created ${created.length} chain review task(s) over ${done.length} task(s): ${created.join(', ')}`,
    );
    return;
  }

  if (cmd === 'final-review') {
    guard(file, rest);
    const run = loadRun(file);
    const mode = flag(rest, 'mode') ?? run.settings.finalReview ?? 'off';
    if (mode !== 'per-task' && mode !== 'run') {
      throw new Error('nothing to review: use --mode per-task|run (or dag settings --final-review)');
    }
    run.settings.finalReview = mode;
    const rounds = countFlag(rest, 'rounds', 0);
    if (rounds !== undefined) run.settings.finalReviewRounds = rounds;
    if (has(rest, 'cmd')) run.settings.finalReviewCmd = flag(rest, 'cmd') ?? null;
    saveRun(run, file);
    const runner = new DagRunner(run, {
      file,
      persist: (state) => saveRun(state, file),
      onEvent: (ev) => {
        const line = `[${ev.ts.slice(11, 19)}] ${ev.type.padEnd(18)} ${ev.taskId ? `${ev.taskId} ` : ''}${ev.message}`;
        if (wantsJson(rest)) console.error(line);
        else console.log(line);
      },
    });
    // Review without re-running work: the scope is exactly what already
    // completed (a task the review sends back is re-executed by the same id).
    const reviewScope = new Set(
      Object.keys(run.tasks).filter((id) => run.tasks[id].status === 'completed'),
    );
    await runner.start(reviewScope);
    saveRun(run, file);
    const summary = runner.result;
    emit(
      rest,
      {
        runId: run.id,
        review: summary?.finalReview ?? null,
        failed: summary?.failed ?? [],
      },
      () => {
        const review = summary?.finalReview;
        if (!review) return 'no review ran';
        return `review ${review.verdict}${review.reason ? `: ${review.reason}` : ''}` +
          `\n  reviewed: ${review.reviewed.join(', ') || '(none)'}` +
          `\n  failed: ${review.failed.join(', ') || '(none)'}`;
      },
    );
    if (summary?.finalReview && summary.finalReview.verdict !== 'pass' && summary.finalReview.verdict !== 'skipped') {
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'settings') {
    guard(file, rest);
    const run = loadRun(file);
    const patch: Parameters<typeof setSettings>[1] = {};
    const concurrency = countFlag(rest, 'concurrency', 1);
    if (concurrency !== undefined) {
      if (concurrency > MAX_CONCURRENCY) {
        throw new Error(`--concurrency max is ${MAX_CONCURRENCY}`);
      }
      patch.concurrency = concurrency;
    }
    const maxAttempts = retriesToMaxAttempts(flag(rest, 'retries'));
    if (maxAttempts !== undefined) patch.maxAttempts = maxAttempts;
    const timeoutMs = secondsToMs(flag(rest, 'timeout'));
    if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
    const silenceMs = secondsToMs(flag(rest, 'silence'));
    if (silenceMs !== undefined) patch.silenceMs = silenceMs;
    const maxHours = numberFlag(rest, 'max-hours', 0);
    if (maxHours !== undefined) patch.maxWallClockMs = Math.round(maxHours * 3600_000);
    const notify = flag(rest, 'notify');
    if (notify !== undefined) patch.notifyCmd = notify;
    const worktree = flag(rest, 'worktree');
    if (worktree !== undefined) {
      if (worktree !== 'none' && worktree !== 'task') {
        throw new Error(`--worktree must be none|task (got ${worktree})`);
      }
      patch.worktree = worktree;
    }
    const silenceAction = flag(rest, 'silence-action');
    if (silenceAction !== undefined) {
      if (silenceAction !== 'warn' && silenceAction !== 'kill') {
        throw new Error(`--silence-action must be warn|kill (got ${silenceAction})`);
      }
      patch.silenceAction = silenceAction;
    }
    const prepare = flag(rest, 'worktree-prepare');
    if (prepare !== undefined) patch.worktreePrepareCmd = prepare;
    const chain = flag(rest, 'harness-chain');
    if (chain !== undefined) patch.harnessChain = chain ? parseHarnessChain(chain) : [];
    if (has(rest, 'fail-on-exit')) patch.failOnNonZeroExit = true;
    if (has(rest, 'no-fail-on-exit')) patch.failOnNonZeroExit = false;
    if (has(rest, 'auto-fail-on-exit')) patch.failOnNonZeroExit = null;
    const finalReview = flag(rest, 'final-review');
    if (finalReview !== undefined) {
      if (finalReview !== 'off' && finalReview !== 'per-task' && finalReview !== 'run') {
        throw new Error(`--final-review must be off|per-task|run (got ${finalReview})`);
      }
      patch.finalReview = finalReview;
    }
    const finalReviewRounds = countFlag(rest, 'final-review-rounds', 0);
    if (finalReviewRounds !== undefined) patch.finalReviewRounds = finalReviewRounds;
    if (has(rest, 'final-review-cmd')) {
      patch.finalReviewCmd = flag(rest, 'final-review-cmd') ?? null;
    }
    const model = flag(rest, 'model');
    if (model !== undefined) patch.model = model;
    const variant = flag(rest, 'variant');
    if (variant !== undefined) patch.variant = variant;
    Object.assign(patch, policyFlags(rest));
    if (Object.keys(patch).length === 0) {
      throw new Error(
        'nothing to set; use --concurrency, --retries, --timeout, --silence, --max-hours, --worktree, --model, ...',
      );
    }
    const settings = setSettings(run, patch);
    saveRun(run, file);
    console.log(JSON.stringify(settings, null, 2));
    return;
  }

  if (cmd === 'run') {
    guard(file, rest);
    const run = loadRun(file);
    const requested = countFlag(rest, 'concurrency', 1) ?? run.settings.concurrency;
    if (requested > MAX_CONCURRENCY) throw new Error(`--concurrency max is ${MAX_CONCURRENCY}`);
    const concurrency = Math.max(1, requested);
    run.settings.concurrency = concurrency;
    if (concurrency > MAX_CONCURRENCY) {
      console.log(`concurrency capped at ${MAX_CONCURRENCY}`);
    }
    const only = rest.includes('--only') ? new Set(parseList(flag(rest, 'only'))) : null;
    if (only !== null) {
      const unknown = [...only].filter((id) => !run.tasks[id]);
      if (unknown.length > 0) throw new Error(`unknown tasks: ${unknown.join(', ')}`);
    }
    if (has(rest, 'dry-run')) {
      console.log(summarize(run));
      console.log(`convergence: ${evaluateConvergence(run)}`);
      return;
    }
    const timing = taskTimingFlags(rest);
    if (timing.maxAttempts !== undefined) run.settings.maxAttempts = timing.maxAttempts;
    if (timing.timeoutMs !== undefined && timing.timeoutMs !== null) {
      run.settings.timeoutMs = timing.timeoutMs;
    }
    if (timing.silenceMs !== undefined && timing.silenceMs !== null) {
      run.settings.silenceMs = timing.silenceMs;
    }
    Object.assign(run.settings, policyFlags(rest));
    const maxHours = numberFlag(rest, 'max-hours', 0);
    if (maxHours !== undefined) run.settings.maxWallClockMs = Math.round(Number(maxHours) * 3600_000);
    const worktree = flag(rest, 'worktree');
    if (worktree !== undefined) {
      if (worktree !== 'none' && worktree !== 'task') {
        throw new Error(`--worktree must be none|task (got ${worktree})`);
      }
      run.settings.worktree = worktree;
    }
    const silenceAction = flag(rest, 'silence-action');
    if (silenceAction !== undefined) {
      if (silenceAction !== 'warn' && silenceAction !== 'kill') {
        throw new Error(`--silence-action must be warn|kill (got ${silenceAction})`);
      }
      run.settings.silenceAction = silenceAction;
    }

    const candidates = only === null ? Object.keys(run.tasks) : [...only];
    // A harness chain supplies the command at run time, so it counts as runnable.
    const runnable = (id: string): boolean =>
      Boolean(
        run.tasks[id].cmd ||
          run.tasks[id].harnessChain?.length ||
          run.settings.harnessChain?.length,
      );
    const manual = candidates.filter(
      (id) =>
        !runnable(id) &&
        (run.tasks[id].status === 'pending' || run.tasks[id].status === 'ready'),
    );
    const scope = candidates.filter((id) => runnable(id));
    if (scope.length === 0) {
      console.log(
        manual.length > 0
          ? `nothing to run: manual task(s) without cmd: ${manual.join(', ')}`
          : 'nothing to run: no task selected',
      );
      console.log(summarize(run));
      process.exitCode = 1;
      return;
    }
    if (manual.length > 0) {
      console.log(`skipping ${manual.length} manual task(s) without cmd: ${manual.join(', ')}`);
    }
    if (has(rest, 'kill-orphans')) {
      // Recover first: only then do the crashed run's tasks carry the pids we
      // are about to kill (and the runner's own recovery pass is idempotent).
      recoverInterrupted(run);
      const killed = killOrphans(run);
      const n = killed.filter((k) => k.killed).length;
      if (n > 0) console.log(`killed ${n} orphan process(es)`);
    }

    const runner = new DagRunner(run, {
      file,
      persist: (state) => saveRun(state, file),
      onEvent: (ev) => {
        const where = ev.taskId ? `${ev.taskId} ` : '';
        // Progress goes to stderr under --json so stdout stays parseable.
        const line = `[${ev.ts.slice(11, 19)}] ${ev.type.padEnd(12)} ${where}${ev.message}`;
        if (wantsJson(rest)) console.error(line);
        else console.log(line);
      },
    });
    const onSignal = (): void => {
      console.log('\nstopping (signal received)…');
      void runner.stop();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    await runner.start(new Set(scope));
    saveRun(run, file);
    const summary = runner.result;
    emit(
      rest,
      {
        runId: run.id,
        completed: summary?.completed ?? [],
        failed: summary?.failed ?? [],
        skipped: summary?.skipped ?? [],
        unfinished: summary?.unfinished ?? [],
        budgetReached: summary?.budgetReached ?? false,
        interrupted: summary?.interrupted ?? { requeued: [], orphanPids: [] },
        finalReview: summary?.finalReview ?? null,
      },
      () => summarize(run),
    );
    if (summary && summary.budgetReached) {
      console.log('note: wall clock budget reached before finishing');
    }
    if (!summary) {
      // The runner refused to start (isolation unavailable, bad graph): say so
      // and fail, because a scheduler treats exit 0 as success.
      console.error('run did not start; nothing was executed');
      process.exitCode = 1;
      return;
    }
    const review = summary.finalReview;
    if (review && review.verdict !== 'pass' && review.verdict !== 'skipped') {
      process.exitCode = 1;
    }
    if (summary.failed.length > 0 || summary.unfinished.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'resume') {
    guard(file, rest);
    const run = loadRun(file);
    const recovery = recoverInterrupted(run);
    saveRun(run, file);
    if (has(rest, 'kill-orphans')) {
      const killed = killOrphans(run);
      saveRun(run, file);
      console.log(`killed ${killed.filter((k) => k.killed).length} orphan process(es)`);
    }
    if (recovery.requeued.length === 0) {
      emit(rest, recovery, () => 'nothing to recover');
    } else {
      emit(rest, recovery, () => {
        const lines = [
          `requeued ${recovery.requeued.length} interrupted task(s): ${recovery.requeued.join(', ')}`,
        ];
        if (recovery.orphanPids.length > 0) {
          lines.push(
            `possible orphan pid(s): ${recovery.orphanPids.join(', ')} — run 'dag kill-orphans' to kill them`,
          );
        }
        return lines.join('\n');
      });
    }
    if (!wantsJson(rest)) console.log(summarize(run));
    return;
  }

  if (cmd === 'skip-blocked') {
    guard(file, rest);
    const run = loadRun(file);
    const skipped = [...skipBlocked(run), ...skipGated(run)];
    saveRun(run, file);
    emit(
      rest,
      { skipped },
      () => (skipped.length > 0 ? `skipped ${skipped.length} task(s): ${skipped.join(', ')}` : 'nothing to skip'),
    );
    return;
  }

  if (cmd === 'kill-orphans') {
    guard(file, rest);
    const run = loadRun(file);
    const pids = orphanedPids(run);
    if (pids.length === 0) {
      emit(rest, { killed: [] }, () => 'no orphan pids recorded');
      return;
    }
    const killed = killOrphans(run);
    saveRun(run, file);
    emit(rest, { killed }, () => killed.map((k) => `pid ${k.pid}: ${k.killed ? 'killed' : 'not found'}`).join('\n'));
    return;
  }

  if (cmd === 'add') {
    guard(file, rest);
    const run = loadRun(file);
    const title = flag(rest, 'title');
    const spec = flag(rest, 'spec') ?? '';
    if (!title) throw new Error('--title is required');
    const task = addTask(run, {
      title,
      spec,
      deps: parseList(flag(rest, 'deps')),
      cmd: cmdFlag(rest) ?? null,
      ...taskTimingFlags(rest),
    });
    saveRun(run, file);
    emit(rest, task, () => task.id);
    return;
  }

  if (cmd === 'edit') {
    guard(file, rest);
    const run = loadRun(file);
    const id = flag(rest, 'id');
    if (!id) throw new Error('--id is required');
    const patch: Parameters<typeof editTask>[2] = {};
    const title = flag(rest, 'title');
    const spec = flag(rest, 'spec');
    const cmdV = cmdFlag(rest);
    const status = flag(rest, 'status') as TaskStatus | undefined;
    if (title !== undefined) patch.title = title;
    if (spec !== undefined) patch.spec = spec;
    if (cmdV !== undefined) patch.cmd = cmdV;
    if (status !== undefined) {
      if (!TASK_STATUSES.includes(status)) {
        throw new Error(`--status must be one of ${TASK_STATUSES.join('|')} (got ${status})`);
      }
      patch.status = status;
    }
    if (has(rest, 'clear-deps')) patch.deps = [];
    else if (rest.includes('--deps')) patch.deps = parseList(flagRequired(rest, 'deps'));
    const timing = taskTimingFlags(rest);
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
    return;
  }

  if (cmd === 'rm') {
    guard(file, rest);
    const run = loadRun(file);
    const id = flag(rest, 'id');
    if (!id) throw new Error('--id is required');
    removeTask(run, id);
    saveRun(run, file);
    emit(rest, { removed: id }, () => `removed ${id}`);
    return;
  }

  if (cmd === 'list') {
    const run = loadRun(file);
    const only = flag(rest, 'status');
    const limit = countFlag(rest, 'limit', 0) ?? 0;
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
    const shown = limit > 0 ? rows.slice(0, limit) : rows;
    emit(rest, shown, () =>
      shown
        .map(
          (r) =>
            `${r.id} [${r.display}] deps=[${r.deps.join(',')}] attempts=${r.attempts}/${r.maxAttempts} ${r.title}`,
        )
        .concat(limit > 0 && rows.length > shown.length ? ['… more (use --limit 0 for all)'] : [])
        .join('\n'),
    );
    return;
  }

  if (cmd === 'status') {
    const run = loadRun(file);
    const counts: Record<string, number> = {};
    for (const t of Object.values(run.tasks)) {
      const d = deriveStatus(run, t);
      counts[d] = (counts[d] ?? 0) + 1;
    }
    emit(
      rest,
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
    return;
  }

  if (cmd === 'ready') {
    const run = loadRun(file);
    const tasks = getReady(run).map((t) => ({ id: t.id, title: t.title, cmd: t.cmd }));
    emit(rest, tasks, () => tasks.map((t) => `${t.id} ${t.title}`).join('\n'));
    return;
  }

  if (cmd === 'blocked') {
    const run = loadRun(file);
    const tasks = getBlocked(run).map((t) => ({ id: t.id, title: t.title }));
    emit(rest, tasks, () => tasks.map((t) => `${t.id} ${t.title}`).join('\n'));
    return;
  }

  if (cmd === 'retry') {
    guard(file, rest);
    const run = loadRun(file);
    const id = flag(rest, 'id');
    if (!id) throw new Error('--id is required (or use retry-failed)');
    const touched = retryTask(run, id, has(rest, 'cascade'));
    saveRun(run, file);
    emit(rest, { requeued: touched }, () => `requeued: ${touched.join(', ')}`);
    return;
  }

  if (cmd === 'retry-failed') {
    guard(file, rest);
    const run = loadRun(file);
    const touched = retryFailed(run, has(rest, 'cascade'));
    saveRun(run, file);
    emit(
      rest,
      { requeued: touched },
      () => (touched.length > 0 ? `requeued: ${touched.join(', ')}` : 'no failed tasks'),
    );
    return;
  }

  if (cmd === 'reviewer') {
    // Manage the reviewers attached to a task: each emits its own verdict and
    // the task passes only when every applicable one passes.
    guard(file, rest);
    const run = loadRun(file);
    const id = flag(rest, 'id');
    const sub = rest[0] ?? 'list';
    if (sub === 'list') {
      if (!id) throw new Error('usage: dag reviewer list --id <task>');
      const task = run.tasks[id];
      if (!task) throw new Error(`unknown task ${id}`);
      const list = [...(task.reviewers ?? [])];
      if (task.reviewCmd) list.push({ name: 'review', cmd: task.reviewCmd, when: 'always' });
      emit(rest, list, () =>
        list.length === 0
          ? 'no reviewers'
          : list
              .map((r) => `${r.name.padEnd(12)} when=${r.when ?? 'always'} verdict=${r.verdict ?? 'default'}\n  ${r.cmd}`)
              .join('\n'),
      );
      return;
    }
    if (sub === 'rm' || sub === 'remove') {
      if (!id) throw new Error('usage: dag reviewer rm --id <task> --name <reviewer>');
      const name = flag(rest, 'name');
      if (!name) throw new Error('--name is required');
      const task = run.tasks[id];
      if (!task) throw new Error(`unknown task ${id}`);
      const before = (task.reviewers ?? []).length;
      const legacyCleared = name === 'review' && Boolean(task.reviewCmd);
      task.reviewers = (task.reviewers ?? []).filter((r) => r.name !== name);
      if (legacyCleared) task.reviewCmd = null;
      const removed = before - (task.reviewers ?? []).length;
      if (removed === 0 && !legacyCleared) {
        throw new Error(`no reviewer named "${name}" on ${id}`);
      }
      saveRun(run, file);
      emit(rest, { removed }, () => `removed reviewer "${name}" from ${id}`);
      return;
    }
    if (sub === 'add' || sub === 'set') {
      if (!id) throw new Error('usage: dag reviewer add --id <task> --name N --cmd "..." [--when W] [--verdict v]');
      const name = flag(rest, 'name');
      const cmdText = flag(rest, 'cmd');
      if (!name || !cmdText) throw new Error('--name and --cmd are required');
      const when = flag(rest, 'when') ?? 'always';
      const invalid = parseWhen(when).invalid;
      if (invalid) throw new Error(`unknown --when clause "${invalid}"`);
      const verdict = flag(rest, 'verdict');
      if (verdict !== undefined && verdict !== 'marker' && verdict !== 'exit-code') {
        throw new Error(`--verdict must be marker|exit-code (got ${verdict})`);
      }
      const task = run.tasks[id];
      if (!task) throw new Error(`unknown task ${id}`);
      const list = (task.reviewers ?? []).filter((r) => r.name !== name);
      list.push({
        name,
        cmd: cmdText,
        when,
        ...(verdict ? { verdict: verdict as 'marker' | 'exit-code' } : {}),
        ...(flag(rest, 'why') ? { why: flag(rest, 'why') } : {}),
      });
      task.reviewers = list;
      saveRun(run, file);
      emit(rest, task.reviewers, () => `${id}: ${list.length} reviewer(s), added "${name}" (${when})`);
      return;
    }
    throw new Error('usage: dag reviewer add|rm|list --id <task> [--name N] [--cmd C] [--when W] [--verdict v]');
  }

  if (cmd === 'new-run') {
    // Archive the active run and start a fresh one, so history stays in the
    // project folder instead of being overwritten.
    guard(file, rest);
    const objective = flag(rest, 'objective');
    if (!objective) throw new Error('--objective is required');
    const dir = projectOf(file);
    const active = activeRunFile(dir);
    if (existsSync(active)) {
      try {
        assertNoForeignLock(active);
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err));
      }
    }
    const { run, archivedTo } = startNewRun(dir, objective);
    emit(
      rest,
      { runId: run.id, archivedTo, file: active },
      () =>
        `${run.id}\n` +
        (archivedTo ? `archived the previous run to ${archivedTo}\n` : '') +
        `active run: ${active}`,
    );
    return;
  }

  if (cmd === 'runs') {
    const sub = rest[0] ?? 'list';
    const dir = projectOf(file);
    if (sub === 'archive') {
      guard(file, rest);
      const target = archiveRun(dir, activeRunFile(dir));
      emit(rest, { archivedTo: target }, () => (target ? `archived to ${target}` : 'nothing to archive'));
      if (!target) process.exitCode = 1;
      return;
    }
    const rows = listRuns(dir);
    if (sub === 'show') {
      const id = flag(rest, 'id') ?? rest[1];
      if (!id) throw new Error('usage: dag runs show --id <runId>');
      const found = findRun(dir, id);
      if (!found) throw new Error(`no run ${id} in ${dir}`);
      emit(rest, found, () => `${found.runId}\n${found.archived ? 'archived' : 'active'}\n${found.file}`);
      return;
    }
    emit(rest, rows, () =>
      rows.length === 0
        ? 'no runs in this project yet'
        : rows
            .map(
              (r) =>
                `${r.runId}  ${r.archived ? 'archived' : 'active  '}  ${r.status.padEnd(8)} ${String(r.total).padStart(4)} tasks  ${r.objective.slice(0, 60)}`,
            )
            .join('\n'),
    );
    return;
  }

  if (cmd === 'harness') {
    // Presets for driving other agent CLIs, so a task is not tied to one tool.
    const sub = rest[0] ?? 'list';
    if (sub === 'show') {
      const name = flag(rest, 'name') ?? rest[1];
      const harness = name ? findHarness(name) : undefined;
      if (!harness) throw new Error(`unknown harness ${name ?? ''}; try: dag harness list`);
      emit(rest, harness, () => JSON.stringify(harness, null, 2));
      return;
    }
    const rows = HARNESSES.map((h) => ({
      name: h.name,
      label: h.label,
      detected: h.binary ? existsSync(resolveCommand(h.binary).file) : true,
      verified: h.verified,
      cmd: h.cmd,
      notes: h.notes ?? '',
    }));
    emit(rest, rows, () =>
      rows
        .map(
          (r) =>
            `${r.detected ? '[x]' : '[ ]'} ${r.name.padEnd(14)} ${r.label.padEnd(18)} ${r.verified ? 'verified' : 'unverified'}` +
            (r.cmd ? `\n    ${r.cmd}` : '') +
            (r.notes ? `\n    ${r.notes}` : ''),
        )
        .join('\n'),
    );
    return;
  }

  if (cmd === 'models') {
    const harnessName = flag(rest, 'harness') ?? 'opencode';
    const harness = findHarness(harnessName);
    if (harness && !harness.modelListCmd) {
      emit(rest, { models: [], error: `${harnessName} has no model list command; set --model free-text` }, () =>
        `${harnessName} has no model list command; set --model free-text`,
      );
      return;
    }
    const { models, error } = await listAgentModels(flag(rest, 'refresh') === '1');
    emit(rest, { models, error }, () =>
      error
        ? `could not list models: ${error}`
        : models.length === 0
          ? 'no models reported by opencode'
          : models.join('\n'),
    );
    return;
  }

  if (cmd === 'show') {
    const run = loadRun(file);
    const id = flag(rest, 'id');
    if (!id) throw new Error('--id is required');
    const task = run.tasks[id];
    if (!task) throw new Error(`unknown task ${id}`);
    const detail = {
      ...task,
      display: deriveStatus(run, task),
      attemptLogs: attemptLogFiles(file, id),
    };
    emit(rest, detail, () =>
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
    return;
  }

  if (cmd === 'review') {
    // Scaffold an integration node whose failure repairs its upstream, or
    // attach a postcondition to an existing task with --id.
    guard(file, rest);
    const run = loadRun(file);
    const attachTo = flag(rest, 'id');
    if (attachTo && !rest.includes('--of')) {
      const reviewCmd = flag(rest, 'review-cmd');
      if (!reviewCmd) throw new Error('--review-cmd is required when reviewing an existing task');
      const rounds = flag(rest, 'review-rounds');
      const task = editTask(run, attachTo, {
        reviewCmd,
        reviewRounds: rounds !== undefined ? countFlag(rest, 'review-rounds', 0) ?? 1 : 1,
      });
      saveRun(run, file);
      emit(rest, task, () => `${task.id} reviewCmd set (rounds ${task.reviewRounds})`);
      return;
    }
    const deps = parseList(flag(rest, 'of'));
    if (deps.length === 0) throw new Error('--of id1,id2 is required (or --id to review one task)');
    for (const d of deps) {
      if (!run.tasks[d]) throw new Error(`unknown dep ${d}`);
    }
    const checkCmd = flag(rest, 'cmd');
    if (!checkCmd) throw new Error('--cmd is required: the command that checks the pieces mesh');
    const title =
      flag(rest, 'title') ??
      `integration: ${deps.map((id) => run.tasks[id].title).join(' + ')}`;
    const spec = flag(rest, 'spec') ?? buildIntegrationSpec(run, deps, checkCmd);
    const repairRounds = flag(rest, 'repair-rounds');
    const task = addTask(run, {
      title,
      spec,
      deps,
      cmd: checkCmd,
      maxAttempts: retriesToMaxAttempts(flag(rest, 'retries')),
      timeoutMs: secondsToMs(flag(rest, 'timeout')) ?? null,
      silenceMs: secondsToMs(flag(rest, 'silence')) ?? null,
      reviewCmd: rest.includes('--review-cmd') ? (flag(rest, 'review-cmd') ?? null) : null,
      reviewRounds: countFlag(rest, 'review-rounds', 0) ?? 0,
      repairRounds: repairRounds !== undefined ? countFlag(rest, 'repair-rounds', 0) ?? 1 : 1,
    });
    saveRun(run, file);
    emit(
      rest,
      task,
      () =>
        `${task.id}\n${task.title}\ndeps=[${deps.join(',')}] repairRounds=${task.repairRounds}\n\n${task.spec}`,
    );
    return;
  }

  if (cmd === 'set' || cmd === 'set-cmd') {
    // Bulk-edit tasks: harness, reviewer/repair policy, retry and timing budgets.
    guard(file, rest);
    const run = loadRun(file);
    const patch: Parameters<typeof setTasks>[1] = {};
    if (rest.includes('--cmd')) patch.cmd = cmdFlag(rest) ?? null;
    const chainText = flag(rest, 'harness-chain');
    if (chainText !== undefined) {
      patch.harnessChain = chainText ? parseHarnessChain(chainText) : null;
    }
    const harnessName = flag(rest, 'harness');
    if (harnessName !== undefined) {
      const harness = findHarness(harnessName);
      if (!harness) throw new Error(`unknown harness ${harnessName}; try: dag harness list`);
      if (!harness.cmd) throw new Error(`harness ${harnessName} has no command preset`);
      Object.assign(
        patch,
        harnessCommands(harness, {
          withPlan: !has(rest, 'no-plan'),
          withReview: has(rest, 'with-review'),
        }),
      );
      // An explicit single tool supersedes a stale fallback chain.
      if (chainText === undefined) patch.harnessChain = null;
      // Model ids are provider-specific: carrying one across harnesses sends a
      // name the new tool cannot resolve, so clear it unless set in this call.
      if (!rest.includes('--model')) patch.model = null;
      if (!rest.includes('--variant')) patch.variant = null;
    }
    if (rest.includes('--model')) patch.model = flag(rest, 'model') ?? null;
    if (rest.includes('--reviewers-json')) {
      const parsed = JSON.parse(flag(rest, 'reviewers-json') ?? '[]') as Reviewer[];
      patch.reviewers = parsed;
    }
    if (rest.includes('--variant')) patch.variant = flag(rest, 'variant') ?? null;
    if (rest.includes('--review-cmd')) patch.reviewCmd = flag(rest, 'review-cmd') ?? null;
    if (rest.includes('--plan-cmd')) patch.planCmd = flag(rest, 'plan-cmd') ?? null;
    if (rest.includes('--prepare-cmd')) patch.prepareCmd = flag(rest, 'prepare-cmd') ?? null;
    if (has(rest, 'clear-review')) patch.reviewCmd = null;
    const reviewRounds = countFlag(rest, 'review-rounds', 0);
    if (reviewRounds !== undefined) patch.reviewRounds = reviewRounds;
    const repairRounds = flag(rest, 'repair-rounds');
    if (repairRounds !== undefined) patch.repairRounds = countFlag(rest, 'repair-rounds', 0);
    const maxAttempts = retriesToMaxAttempts(flag(rest, 'retries'));
    if (maxAttempts !== undefined) patch.maxAttempts = maxAttempts;
    const timeoutMs = secondsToMs(flag(rest, 'timeout'));
    if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
    const silenceMs = secondsToMs(flag(rest, 'silence'));
    if (silenceMs !== undefined) patch.silenceMs = silenceMs;
    if (Object.keys(patch).length === 0) {
      throw new Error(
        'nothing to set; use --cmd, --review-cmd, --review-rounds, --repair-rounds, --retries, --timeout, --silence',
      );
    }
    const changed = setTasks(run, patch, {
      all: has(rest, 'all'),
      only: parseList(flag(rest, 'only')),
      match: flag(rest, 'match'),
    });
    saveRun(run, file);
    emit(
      rest,
      { changed, fields: Object.keys(patch) },
      () =>
        changed.length > 0
          ? `updated ${changed.length} task(s): ${Object.keys(patch).join(', ')}`
          : 'no tasks matched',
    );
    return;
  }

  if (cmd === 'heartbeat') {
    // Lets a worker that writes files instead of streaming stdout prove it
    // is alive, so the silence watchdog leaves it alone.
    const id = flag(rest, 'id');
    if (!id) throw new Error('--id is required');
    recordHeartbeat(file, id);
    emit(rest, { id, at: new Date().toISOString() }, () => `heartbeat ${id}`);
    return;
  }

  if (cmd === 'log') {
    const n = shortN(rest) ?? countFlag(rest, 'lines', 0) ?? 40;
    const events = readEventLog(file, n);
    emit(rest, events, () =>
      events
        .map((ev) => `${ev.ts} ${ev.type}${ev.taskId ? ` ${ev.taskId}` : ''} ${ev.message}`)
        .join('\n'),
    );
    return;
  }

  if (cmd === 'logs') {
    const id = flag(rest, 'id');
    if (!id) throw new Error('--id is required');
    const attempts = attemptLogFiles(file, id);
    if (attempts.length === 0) {
      emit(rest, { attempts: [], attempt: null, content: null }, () => `no attempt logs for ${id}`);
      return;
    }
    const requested = flag(rest, 'attempt');
    const attempt = requested ? Number(requested) : attempts[attempts.length - 1];
    const content = readAttemptLog(file, id, attempt);
    emit(rest, { attempts, attempt, content }, () => {
      return `# ${id} attempt ${attempt} (attempts: ${attempts.join(', ')})\n${content ?? '(empty)'}`;
    });
    return;
  }

  if (cmd === 'gc') {
    const days = numberFlag(rest, 'days', 0) ?? 7;
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
      const rotated = `${paths.events}.1`;
      if (statSync(rotated).mtimeMs < cutoff) {
        rmSync(rotated, { force: true });
        removed += 1;
      }
    } catch {
      // no rotated log
    }
    emit(rest, { removed, days }, () => `removed ${removed} file(s) older than ${days} day(s)`);
    return;
  }

  if (cmd === 'gate') {
    guard(file, rest);
    const run = loadRun(file);
    const id = flag(rest, 'id');
    const question = flag(rest, 'question');
    if (!id || !question) throw new Error('--id and --question are required');
    const options = parseList(flag(rest, 'options'));
    const gate = setGate(run, id, question, options.length > 0 ? options : ['approved', 'rejected']);
    saveRun(run, file);
    emit(rest, { id, gate }, () => `gate set on ${id}`);
    return;
  }

  if (cmd === 'approve' || cmd === 'reject') {
    guard(file, rest);
    const run = loadRun(file);
    const id = flag(rest, 'id');
    if (!id) throw new Error('--id is required');
    const resolved = resolveGate(run, id, cmd === 'approve');
    saveRun(run, file);
    emit(rest, { id, resolved }, () => `${id} ${cmd}d`);
    return;
  }

  if (cmd === 'dot') {
    const run = loadRun(file);
    const lines = [`digraph "${run.id}" {`, `  label="${run.objective.replace(/"/g, "'")}";`];
    for (const t of Object.values(run.tasks)) {
      const display = deriveStatus(run, t);
      lines.push(`  "${t.id}" [label="${t.id}\\n${t.title.replace(/"/g, "'")}\\n${display}"];`);
      for (const d of t.deps) lines.push(`  "${d}" -> "${t.id}";`);
    }
    lines.push('}');
    emit(rest, { dot: lines.join('\n') }, () => lines.join('\n'));
    return;
  }

  console.log(`DAG Orchestrator
usage: dag <cmd> [flags]

  launch [--all | --dir F ...] [--open] [--auto-resume]
                               one server per project, stable port each
  servers [--json] | servers --stop --all|--dir F
  projects [list|add --dir F [--name N]|rm <id|path|name>|open <id|name>]
                               open: hub page for one project
  serve [--file F] [--port 8787] [--open] [--auto-resume] [--kill-orphans]
                               no --file: one hub for every registered project
  schedule add --file F [--name N] [--at "YYYY-MM-DD HH:MM"] [--after JOB]
      [--concurrency N] [--retries N] [--timeout SEC] [--silence SEC]
      [--max-hours H] [--on-dep-failure block|skip] [--gates wait|skip]
  schedule list | schedule rm <job> | schedule clear
  scheduler [--poll SEC] [--once] [--drain] [--watch] [--open]
                               run scheduled jobs one at a time
  init --objective "..."        new run file
  add --title T --spec S [--deps a,b] [--cmd "..."] [--retries N]
      [--timeout SEC] [--silence SEC] [--plan-cmd "..."] [--review-cmd "..."]
      [--review-rounds N] [--repair-rounds N]
  edit --id ID [--title T] [--spec S] [--deps a,b | --clear-deps] [--cmd C]
      [--status S] [--retries N] [--timeout SEC] [--silence SEC]
      [--plan-cmd C] [--review-cmd C] [--review-rounds N] [--repair-rounds N]
  rm --id ID                   delete node, strip it from others' deps
  list [--status S] [--limit N] | status | ready | blocked
  retry --id ID [--cascade]    requeue failed task (cascade: its failed subtree)
  retry-failed [--cascade]     requeue every failed task
  review --of a,b --cmd "check" [--title T] [--repair-rounds N]
                               scaffold an integration node (repairs upstream on failure)
  review --id X --review-cmd "check" [--review-rounds N]
                               attach a reviewer postcondition to a task
  show --id ID                 full task detail incl. review/verdict/logs
  reviewer list --id ID        reviewers attached to a task
  reviewer add --id ID --name N --cmd "..." [--when always|on-reject|diff-lines>N|diff-touches:glob]
      [--verdict marker|exit-code]   each reviewer emits its own verdict
  reviewer rm --id ID --name N
  set-cmd [--all | --only a,b | --match REGEX] --cmd "harness ... {spec}"
  harness [list|show --name N]  agent CLI presets (opencode, claude, codex, …)
  models [--harness N] [--refresh]   models available to that agent CLI
  set --harness NAME            retarget tasks at another agent CLI
  set --harness-chain "a:x,b"   ordered fallback: attempt 1 uses a, 2 uses b
  settings --fail-on-exit       non-zero work exit fails the task (default: auto)
      [--with-review] [--no-plan]
  new-run --objective "..."     archive the active run, start a fresh one
  runs [list] | runs show --id ID | runs archive
  set [--all | --only a,b | --match REGEX]
      [--cmd "..." | --clear-review] [--plan-cmd "..."] [--review-cmd "..."]
      [--review-rounds N] [--repair-rounds N] [--retries N] [--timeout SEC]
      [--silence SEC]
                               bulk edit harness / planner / reviewer / repair
  resume                       requeue tasks interrupted by a crash/restart
  skip-blocked                 mark blocked/gated tasks skipped so the run converges
  kill-orphans                 kill process trees left behind by a crash
  heartbeat --id ID            keep-alive for workers that don't stream stdout
  log [-n 40]                  event log (full history)
  logs --id ID [--attempt N]   per-attempt stdout/stderr
  gc [--days 7]                prune old attempt logs
  final-review [--mode per-task|run] [--rounds N] [--cmd "agent ..."]
  settings --final-review off|per-task|run   end-of-run code review
  layers                       dependency waves in this run
  chain-review --of a,b | --wave N | --from ID | --all [--batch N] [--cmd C]
                               review tasks that review the work of other tasks
  settings [--concurrency N] [--retries N] [--timeout SEC] [--silence SEC]
      [--max-hours H] [--on-dep-failure block|skip] [--gates wait|skip]
      [--notify "command"] [--worktree none|task]
  gate --id ID --question Q | approve --id ID | reject --id ID
  dot                          graphviz chart
  run --file F [--concurrency N] [--only a,b] [--retries N] [--timeout SEC]
      [--silence SEC] [--max-hours H] [--on-dep-failure block|skip]
      [--gates wait|skip] [--worktree none|task] [--kill-orphans] [--dry-run]
      [--force]

Every command accepts --file, --force (override a foreign lock), and --json.
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
