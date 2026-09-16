#!/usr/bin/env node
// Zero-dependency CLI. Every mutation rewrites the run files.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireLock,
  addTask,
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
  describeStuck,
  evaluateConvergence,
  getBlocked,
  getReady,
  summarize,
  topoSort,
} from './graph.js';
import { DagRunner } from './runner.js';
import { startServer } from './server.js';
import { parseWhen, type Reviewer } from './review-policy.js';
import { listAgentModels } from './agent-models.js';
import { addProject, loadRegistry, projectId, removeProject, resolveRunFile } from './registry.js';
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
import { MAX_CONCURRENCY } from './types.js';

const wantsJson = (argv: string[]): boolean => argv.includes('--json');
const emit = (argv: string[], data: unknown, human: () => string): void => {
  console.log(wantsJson(argv) ? JSON.stringify(data, null, 2) : human());
};

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function fileOf(argv: string[]): string {
  return flag(argv, 'file') ?? 'dag.run.json';
}

function parseList(v: string | undefined): string[] {
  return v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

// CLI accepts seconds; the file stores ms. 0 = no limit.
function secondsToMs(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid seconds value: ${v}`);
  return Math.round(n * 1000);
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
  if (argv.includes('--timeout')) out.timeoutMs = secondsToMs(flag(argv, 'timeout')) ?? 0;
  if (argv.includes('--silence')) out.silenceMs = secondsToMs(flag(argv, 'silence')) ?? 0;
  if (argv.includes('--review-cmd')) out.reviewCmd = flag(argv, 'review-cmd') ?? null;
  if (argv.includes('--plan-cmd')) out.planCmd = flag(argv, 'plan-cmd') ?? null;
  const reviewRounds = flag(argv, 'review-rounds');
  if (reviewRounds !== undefined) out.reviewRounds = Math.max(0, Number(reviewRounds));
  const repairRounds = flag(argv, 'repair-rounds');
  if (repairRounds !== undefined) out.repairRounds = Math.max(0, Number(repairRounds));
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
    console.log(`${run.id}\nSaved to ${file}`);
    return;
  }

  if (cmd === 'serve') {
    startServer({
      file,
      port: Number(flag(rest, 'port') ?? 8787),
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
        pollMs: Number(flag(rest, 'poll') ?? 5) * 1000,
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
      const maxHours = flag(rest, 'max-hours');
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

  if (cmd === 'settings') {
    guard(file, rest);
    const run = loadRun(file);
    const patch: Record<string, number | string> = {};
    const concurrency = flag(rest, 'concurrency');
    if (concurrency !== undefined) patch.concurrency = Number(concurrency);
    const maxAttempts = retriesToMaxAttempts(flag(rest, 'retries'));
    if (maxAttempts !== undefined) patch.maxAttempts = maxAttempts;
    const timeoutMs = secondsToMs(flag(rest, 'timeout'));
    if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
    const silenceMs = secondsToMs(flag(rest, 'silence'));
    if (silenceMs !== undefined) patch.silenceMs = silenceMs;
    const maxHours = flag(rest, 'max-hours');
    if (maxHours !== undefined) patch.maxWallClockMs = Math.round(Number(maxHours) * 3600_000);
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
    const model = flag(rest, 'model');
    if (model !== undefined) patch.model = model;
    const variant = flag(rest, 'variant');
    if (variant !== undefined) patch.variant = variant;
    Object.assign(patch, policyFlags(rest));
    const settings = setSettings(run, patch);
    saveRun(run, file);
    console.log(JSON.stringify(settings, null, 2));
    return;
  }

  if (cmd === 'run') {
    guard(file, rest);
    const run = loadRun(file);
    const concurrency = Number(flag(rest, 'concurrency') ?? run.settings.concurrency);
    run.settings.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, concurrency));
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
    const maxHours = flag(rest, 'max-hours');
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
    const manual = candidates.filter(
      (id) =>
        !run.tasks[id].cmd &&
        (run.tasks[id].status === 'pending' || run.tasks[id].status === 'ready'),
    );
    const scope = candidates.filter((id) => run.tasks[id].cmd);
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
      const killed = killOrphans(run);
      const n = killed.filter((k) => k.killed).length;
      if (n > 0) console.log(`killed ${n} orphan process(es)`);
    }

    const runner = new DagRunner(run, {
      file,
      persist: (state) => saveRun(state, file),
      onEvent: (ev) => {
        const where = ev.taskId ? `${ev.taskId} ` : '';
        console.log(`[${ev.ts.slice(11, 19)}] ${ev.type.padEnd(12)} ${where}${ev.message}`);
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
      },
      () => summarize(run),
    );
    if (!wantsJson(rest)) console.log(summarize(run));
    if (summary && summary.budgetReached) {
      console.log('note: wall clock budget reached before finishing');
    }
    if ((summary?.failed.length ?? 0) > 0 || (summary?.unfinished.length ?? 0) > 0) {
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
      cmd: flag(rest, 'cmd') ?? null,
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
    const cmdV = rest.includes('--cmd') ? (flag(rest, 'cmd') ?? null) : undefined;
    const status = flag(rest, 'status') as TaskStatus | undefined;
    if (title !== undefined) patch.title = title;
    if (spec !== undefined) patch.spec = spec;
    if (cmdV !== undefined) patch.cmd = cmdV;
    if (status !== undefined) patch.status = status;
    if (has(rest, 'clear-deps')) patch.deps = [];
    else if (rest.includes('--deps')) patch.deps = parseList(flag(rest, 'deps'));
    const timing = taskTimingFlags(rest);
    if (timing.maxAttempts !== undefined) patch.maxAttempts = timing.maxAttempts;
    if (timing.timeoutMs !== undefined) patch.timeoutMs = timing.timeoutMs;
    if (timing.silenceMs !== undefined) patch.silenceMs = timing.silenceMs;
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
    console.log(`removed ${id}`);
    return;
  }

  if (cmd === 'list') {
    const run = loadRun(file);
    const only = flag(rest, 'status');
    const limit = Number(flag(rest, 'limit') ?? 0);
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
      task.reviewers = (task.reviewers ?? []).filter((r) => r.name !== name);
      if (name === 'review' && task.reviewCmd) {
        task.reviewCmd = null;
      }
      saveRun(run, file);
      emit(rest, { removed: before - (task.reviewers ?? []).length }, () =>
        `removed reviewer "${name}" from ${id}`,
      );
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

  if (cmd === 'models') {
    const { models, error } = listAgentModels(flag(rest, 'refresh') === '1');
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
        reviewRounds: rounds !== undefined ? Number(rounds) : 1,
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
      reviewRounds: Number(flag(rest, 'review-rounds') ?? 0),
      repairRounds: repairRounds !== undefined ? Number(repairRounds) : 1,
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
    if (rest.includes('--cmd')) patch.cmd = flag(rest, 'cmd') ?? null;
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
    const reviewRounds = flag(rest, 'review-rounds');
    if (reviewRounds !== undefined) patch.reviewRounds = Number(reviewRounds);
    const repairRounds = flag(rest, 'repair-rounds');
    if (repairRounds !== undefined) patch.repairRounds = Number(repairRounds);
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
    const n = Number(flag(rest, 'n') ?? 40);
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
    const days = Number(flag(rest, 'days') ?? 7);
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
    console.log(`removed ${removed} file(s) older than ${days} day(s)`);
    return;
  }

  if (cmd === 'gate') {
    guard(file, rest);
    const run = loadRun(file);
    const id = flag(rest, 'id');
    const question = flag(rest, 'question');
    if (!id || !question) throw new Error('--id and --question are required');
    const options = parseList(flag(rest, 'options'));
    setGate(run, id, question, options.length > 0 ? options : ['approved', 'rejected']);
    saveRun(run, file);
    console.log(`gate set on ${id}`);
    return;
  }

  if (cmd === 'approve' || cmd === 'reject') {
    guard(file, rest);
    const run = loadRun(file);
    const id = flag(rest, 'id');
    if (!id) throw new Error('--id is required');
    resolveGate(run, id, cmd === 'approve');
    saveRun(run, file);
    console.log(`${id} ${cmd}d`);
    return;
  }

  if (cmd === 'dot') {
    const run = loadRun(file);
    console.log(`digraph "${run.id}" {`);
    console.log(`  label="${run.objective.replace(/"/g, "'")}";`);
    for (const t of Object.values(run.tasks)) {
      const display = deriveStatus(run, t);
      console.log(
        `  "${t.id}" [label="${t.id}\\n${t.title.replace(/"/g, "'")}\\n${display}"];`,
      );
      for (const d of t.deps) console.log(`  "${d}" -> "${t.id}";`);
    }
    console.log('}');
    return;
  }

  console.log(`DAG Orchestrator
usage: dag <cmd> [flags]

  launch [--all | --dir F ...] [--open] [--auto-resume]
                               one server per project, stable port each
  servers [--json] | servers --stop --all|--dir F
  projects [list|add --dir F [--name N]|rm <id|path|name>]
  serve --file F [--port 8787] [--open] [--auto-resume] [--kill-orphans]
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
  models [--refresh]            list models available to the agent CLI
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
