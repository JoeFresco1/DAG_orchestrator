// Scheduling commands: `schedule` manages the job list, `scheduler` runs it.
import {
  addJob,
  jobSummary,
  loadSchedule,
  parseAt,
  removeJob,
  retryJob,
  runScheduler,
  type JobArgs,
} from '../scheduler.js';
import { resolveRunFile } from '../registry.js';
import { emit, flag, has, numberFlag } from '../cli-args.js';

// `schedule` is a small job store: add a run to the queue (optionally gated on
// another job or a start time), remove/retry one, or list what is queued.
// `scheduler` is the worker that drains the queue in order.
export async function scheduleCmd(argv: string[], cmd: string): Promise<void> {
  if (cmd === 'scheduler') {
    const code = await runScheduler({
      pollMs: (numberFlag(argv, 'poll', 0.1) ?? 5) * 1000,
      once: has(argv, 'once'),
      drain: has(argv, 'drain'),
      watch: has(argv, 'watch'),
      open: has(argv, 'open'),
    });
    process.exitCode = code;
    return;
  }
  const sub = argv[0] ?? 'list';
  if (sub === 'add') {
    const target = flag(argv, 'file') ?? flag(argv, 'dir');
    if (!target) throw new Error('usage: dag schedule add --file <run file> [--name N] [--at "YYYY-MM-DD HH:MM"] [--after <job>]');
    const args: JobArgs = {};
    const concurrency = flag(argv, 'concurrency');
    if (concurrency !== undefined) args.concurrency = Number(concurrency);
    const retries = flag(argv, 'retries');
    if (retries !== undefined) args.retries = Number(retries);
    const timeout = flag(argv, 'timeout');
    if (timeout !== undefined) args.timeout = Number(timeout);
    const silence = flag(argv, 'silence');
    if (silence !== undefined) args.silence = Number(silence);
    const maxHours = numberFlag(argv, 'max-hours', 0);
    if (maxHours !== undefined) args.maxHours = Number(maxHours);
    const onDepFailure = flag(argv, 'on-dep-failure');
    if (onDepFailure !== undefined) args.onDepFailure = onDepFailure;
    const gates = flag(argv, 'gates');
    if (gates !== undefined) args.gates = gates;
    const only = flag(argv, 'only');
    if (only !== undefined) args.only = only;
    if (has(argv, 'kill-orphans')) args.killOrphans = true;
    const at = flag(argv, 'at');
    const job = addJob({
      name: flag(argv, 'name') ?? resolveRunFile(target).replace(/.*[\\/]/, ''),
      file: target,
      at: at ? parseAt(at) : null,
      after: flag(argv, 'after') ?? null,
      args,
    });
    emit(argv, job, () => jobSummary(job));
    return;
  }
  if (sub === 'rm' || sub === 'remove') {
    const target = argv[1] ?? flag(argv, 'id');
    if (!target) throw new Error('usage: dag schedule rm <job id|name>');
    const removed = removeJob(target);
    emit(argv, { removed }, () => (removed ? `removed ${target}` : `no job matched ${target}`));
    if (!removed) process.exitCode = 1;
    return;
  }
  if (sub === 'retry') {
    const target = argv[1] ?? flag(argv, 'id');
    if (!target) throw new Error('usage: dag schedule retry <job id|name>');
    const job = retryJob(target);
    emit(argv, job ?? { retried: false }, () =>
      job ? `requeued ${job.id} (${job.name})` : `no job matched ${target}`,
    );
    if (!job) process.exitCode = 1;
    return;
  }
  if (sub === 'clear') {
    const schedule = loadSchedule();
    const before = schedule.jobs.length;
    const { saveSchedule } = await import('../scheduler.js');
    schedule.jobs = schedule.jobs.filter(
      (j) => j.status === 'pending' || j.status === 'running',
    );
    saveSchedule(schedule);
    const removedCount = before - schedule.jobs.length;
    emit(argv, { removed: removedCount }, () => `cleared ${removedCount} finished job(s)`);
    return;
  }
  const schedule = loadSchedule();
  emit(argv, schedule.jobs, () =>
    schedule.jobs.length === 0
      ? 'schedule is empty; add one with: dag schedule add --file <run file>'
      : schedule.jobs.map(jobSummary).join('\n'),
  );
}
