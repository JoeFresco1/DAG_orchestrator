import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { cliPath } from './launcher.js';
import { resolveRunFile } from './registry.js';
import { atomicWriteJson, readJsonFileWithBackup } from './store.js';

// Jobs run sequentially, on a clock and/or after another job. That is the
// "this run first, then that run" feature without a workflow engine.
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';

export interface JobArgs {
  concurrency?: number;
  retries?: number;
  timeout?: number;
  silence?: number;
  maxHours?: number;
  onDepFailure?: string;
  gates?: string;
  only?: string;
  killOrphans?: boolean;
}

export interface ScheduleJob {
  id: string;
  name: string;
  file: string;
  at: string | null;
  after: string | null;
  args: JobArgs;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  note: string | null;
  // Pid of the running `dag run`, so a scheduler that dies can tell whether
  // its job is still alive when it comes back.
  pid?: number | null;
}

export interface ScheduleFile {
  version: 1;
  jobs: ScheduleJob[];
}

export function schedulePath(): string {
  return process.env.DAG_SCHEDULE ?? join(homedir(), '.lightweight-dag', 'schedule.json');
}

export function loadSchedule(): ScheduleFile {
  const raw = readJsonFileWithBackup<ScheduleFile>(schedulePath());
  if (raw) return { version: 1, jobs: Array.isArray(raw.jobs) ? raw.jobs : [] };
  return { version: 1, jobs: [] };
}

export function saveSchedule(schedule: ScheduleFile): void {
  atomicWriteJson(schedulePath(), schedule);
}

export function parseAt(value: string): string {
  const trimmed = value.trim();
  // Accept `2026-09-16 01:00` (local) as well as anything Date can parse.
  const local = trimmed.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/);
  const date = local ? new Date(`${local[1]}T${local[2]}${local[3] ?? ':00'}`) : new Date(trimmed);
  if (Number.isNaN(date.getTime())) throw new Error(`cannot parse time: ${value}`);
  return date.toISOString();
}

export interface NewJobInput {
  name: string;
  file: string;
  at: string | null;
  after: string | null;
  args: JobArgs;
}

export function addJob(input: NewJobInput): ScheduleJob {
  const schedule = loadSchedule();
  const job: ScheduleJob = {
    ...input,
    file: resolveRunFile(input.file),
    id: `job_${Math.random().toString(36).slice(2, 8)}`,
    status: 'pending',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    note: null,
  };
  schedule.jobs.push(job);
  saveSchedule(schedule);
  return job;
}

export function removeJob(idOrName: string): boolean {
  const schedule = loadSchedule();
  const before = schedule.jobs.length;
  schedule.jobs = schedule.jobs.filter((j) => j.id !== idOrName && j.name !== idOrName);
  if (schedule.jobs.length === before) return false;
  saveSchedule(schedule);
  return true;
}

// Requeue a finished/failed/blocked job so the scheduler picks it up again.
export function retryJob(idOrName: string): ScheduleJob | null {
  const schedule = loadSchedule();
  const job = findJob(schedule, idOrName);
  if (!job) return null;
  job.status = 'pending';
  job.note = 'requeued manually';
  job.startedAt = null;
  job.finishedAt = null;
  job.exitCode = null;
  saveSchedule(schedule);
  return job;
}

export function findJob(schedule: ScheduleFile, idOrName: string): ScheduleJob | undefined {
  return schedule.jobs.find((j) => j.id === idOrName || j.name === idOrName);
}

export function jobArgsToArgv(args: JobArgs): string[] {
  const out: string[] = [];
  if (args.concurrency !== undefined) out.push('--concurrency', String(args.concurrency));
  if (args.retries !== undefined) out.push('--retries', String(args.retries));
  if (args.timeout !== undefined) out.push('--timeout', String(args.timeout));
  if (args.silence !== undefined) out.push('--silence', String(args.silence));
  if (args.maxHours !== undefined) out.push('--max-hours', String(args.maxHours));
  if (args.onDepFailure) out.push('--on-dep-failure', args.onDepFailure);
  if (args.gates) out.push('--gates', args.gates);
  if (args.only) out.push('--only', args.only);
  if (args.killOrphans) out.push('--kill-orphans');
  return out;
}

export interface DueDecision {
  due: boolean;
  blocked?: string;
}

export function decideDue(job: ScheduleJob, schedule: ScheduleFile, now = Date.now()): DueDecision {
  if (job.at && now < Date.parse(job.at)) return { due: false };
  if (job.after) {
    const predecessor = findJob(schedule, job.after);
    if (!predecessor) return { due: false, blocked: `unknown predecessor ${job.after}` };
    if (
      predecessor.status === 'failed' ||
      predecessor.status === 'blocked' ||
      predecessor.status === 'cancelled'
    ) {
      return { due: false, blocked: `predecessor ${predecessor.id} ${predecessor.status}` };
    }
    if (predecessor.status !== 'done') return { due: false };
  }
  return { due: true };
}

export function scheduleLogPath(): string {
  return join(homedir(), '.lightweight-dag', 'logs', 'schedule.log');
}

function log(line: string): void {
  const path = scheduleLogPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8');
  console.log(line);
}

// Signal 0 asks "does this process exist" without touching it.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface SchedulerOptions {
  pollMs?: number;
  once?: boolean;
  drain?: boolean;
  watch?: boolean;
  open?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Sequential scheduler: never more than one job in flight, so `--after`
// chains read like "run A, then run B".
export async function runScheduler(opts: SchedulerOptions = {}): Promise<number> {
  const pollMs = opts.pollMs ?? 5000;
  let child: ChildProcess | null = null;
  let runningId: string | null = null;
  let lastCode = 0;

  // A job left 'running' by a scheduler that died is not running: mark it
  // failed so its dependents (`--after`) can be decided instead of waiting
  // forever for a process that no longer exists.
  {
    const schedule = loadSchedule();
    let changed = false;
    for (const job of schedule.jobs) {
      if (job.status !== 'running') continue;
      if (job.pid && pidAlive(job.pid)) continue;
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.exitCode = null;
      job.note = job.pid
        ? `interrupted: pid ${job.pid} is gone (scheduler restarted)`
        : 'interrupted: scheduler restarted while this job was running';
      job.pid = null;
      changed = true;
      log(`job ${job.id} was left running by a dead scheduler; marked failed`);
    }
    if (changed) saveSchedule(schedule);
  }

  const killChild = (): void => {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      return;
    }
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  };

  process.on('SIGINT', () => {
    killChild();
    if (runningId) {
      const schedule = loadSchedule();
      const job = schedule.jobs.find((j) => j.id === runningId);
      if (job) {
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        job.note = 'cancelled by operator';
        saveSchedule(schedule);
      }
    }
    console.log('\nscheduler stopped');
    process.exit(130);
  });

  for (;;) {
    // Reap a finished job before choosing the next one.
    if (child && runningId) {
      await new Promise<void>((resolve) => {
        if (child && (child.exitCode !== null || child.signalCode !== null)) resolve();
        else child?.once('exit', () => resolve());
      });
      const code = child.exitCode ?? 1;
      lastCode = code;
      const schedule = loadSchedule();
      const job = schedule.jobs.find((j) => j.id === runningId);
      if (job) {
        job.exitCode = code;
        job.status = code === 0 ? 'done' : 'failed';
        job.finishedAt = new Date().toISOString();
        job.note = code === 0 ? 'completed' : `exited ${code}`;
        saveSchedule(schedule);
      }
      log(`job ${runningId} ${code === 0 ? 'done' : `failed (exit ${code})`}`);
      child = null;
      runningId = null;
      if (opts.once) return code === 0 ? 0 : 1;
    }

    // Block dependents of failed predecessors, and un-block jobs whose
    // predecessor was retried (status pending/running) or finished.
    {
      const schedule = loadSchedule();
      let changed = false;
      for (const job of schedule.jobs) {
        if (job.status === 'pending') {
          const decision = decideDue(job, schedule);
          if (decision.blocked) {
            job.status = 'blocked';
            job.note = decision.blocked;
            job.finishedAt = new Date().toISOString();
            changed = true;
            log(`job ${job.id} (${job.name}) blocked: ${decision.blocked}`);
          }
          continue;
        }
        if (job.status !== 'blocked' || !job.after) continue;
        const predecessor = findJob(schedule, job.after);
        if (predecessor && (predecessor.status === 'pending' || predecessor.status === 'running')) {
          job.status = 'pending';
          job.note = `unblocked: ${predecessor.id} was retried`;
          job.finishedAt = null;
          changed = true;
          log(`job ${job.id} (${job.name}) unblocked: predecessor ${predecessor.id} is ${predecessor.status}`);
        }
      }
      if (changed) saveSchedule(schedule);
    }

    const schedule = loadSchedule();
    const next = schedule.jobs.find((j) => j.status === 'pending' && decideDue(j, schedule).due);

    if (!next) {
      const pending = schedule.jobs.filter((j) => j.status === 'pending');
      if (pending.length === 0) {
        if (opts.watch) {
          await sleep(pollMs);
          continue;
        }
        return 0;
      }
      const anyDue = pending.some((j) => decideDue(j, schedule).due);
      if (opts.once || opts.drain) {
        if (!anyDue) {
          log(`${pending.length} job(s) not due yet`);
          return 0;
        }
        continue;
      }
      await sleep(pollMs);
      continue;
    }

    const argv = [cliPath(), 'run', '--file', next.file, ...jobArgsToArgv(next.args)];
    log(`job ${next.id} (${next.name}) starting: ${next.file}`);
    const jobLog = join(homedir(), '.lightweight-dag', 'logs', `${next.id}.log`);
    mkdirSync(dirname(jobLog), { recursive: true });
    const fd = openSync(jobLog, 'a');
    child = spawn(process.execPath, argv, {
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      detached: false,
    });
    closeSync(fd);
    const scheduleNow = loadSchedule();
    const job = scheduleNow.jobs.find((j) => j.id === next.id);
    if (job) {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      // Recorded so a scheduler that dies can tell its job is gone.
      job.pid = child.pid ?? null;
      saveSchedule(scheduleNow);
    }
    runningId = next.id;

    if (opts.open) {
      const { serverFor, openBrowser } = await import('./launcher.js');
      const server = serverFor(next.file);
      if (server) openBrowser(`http://localhost:${server.port}`);
    }
  }
  return lastCode;
}

export function jobSummary(job: ScheduleJob): string {
  const when = job.at ? `at ${job.at.slice(0, 16).replace('T', ' ')}` : '';
  const after = job.after ? `after ${job.after}` : '';
  const chain = [when, after].filter(Boolean).join(' ');
  return `${job.id} [${job.status}] ${job.name}${chain ? ` (${chain})` : ''} → ${job.file}`;
}
