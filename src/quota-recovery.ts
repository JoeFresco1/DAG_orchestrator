import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteJson, attemptLogPath, runPaths } from './store.js';
import { planningDefinition } from './planning/compile.js';
import { digest } from './planning/contracts.js';
import { git } from './git-worktree.js';
import type { Run, Task } from './types.js';

interface PausedTask {
  priorTask: Task; definition: string; remainingMs: number; session: string;
  source?: string; verificationOnly: boolean;
}
export interface QuotaPause {
  version: 1; id: string; runId: string; revision?: string; pausedAt: string;
  tasks: Record<string, PausedTask>; stoppedAt?: string; claimedAt?: string; migrationReason?: string;
}
export interface QuotaContinuation { taskId: string; source: string; id: string; deadline: number; session: string; verificationOnly: boolean; removeGenerated: string[] }
const directory = (file: string) => join(runPaths(file).dir, 'quota-pauses');
function session(file: string, task: Task): string {
  const log = readFileSync(attemptLogPath(file, task.id, task.attempts), 'utf8');
  const id = log.match(/^session id: ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\s*$/mi)?.[1];
  if (!id) throw Error(`Quota continuation requires the original worker session: ${task.id}`);
  return id;
}
export function captureQuotaPause(run: Run, file: string, pausedAt = new Date().toISOString(), remaining?: (task: Task) => number): QuotaPause {
  const tasks: QuotaPause['tasks'] = {};
  for (const task of Object.values(run.tasks).filter(t => t.status === 'running')) {
    const remainingMs = remaining ? remaining(task) : Date.parse(task.executionBudget?.deadlineAt ?? '') - Date.parse(pausedAt);
    if (!(remainingMs > 0)) throw Error(`No active execution time remains for quota pause: ${task.id}`);
    tasks[task.id] = { priorTask: structuredClone(task), definition: planningDefinition(task), remainingMs,
      session: session(file, task), verificationOnly: Date.parse(task.milestones?.implementedAt ?? '') >= Date.parse(task.startedAt ?? '') && Date.parse(task.milestones?.implementedAt ?? '') <= Date.parse(pausedAt) };
  }
  const pause: QuotaPause = { version: 1, id: `${run.id}-${Date.parse(pausedAt)}`, runId: run.id, revision: run.planning?.revision, pausedAt, tasks };
  atomicWriteJson(join(directory(file), `${pause.id}.json`), pause);
  return pause;
}
export function finishQuotaPause(run: Run, file: string, pause: QuotaPause): void {
  for (const [id, entry] of Object.entries(pause.tasks)) {
    const task = run.tasks[id];
    if (task?.status === 'completed') { delete pause.tasks[id]; continue; }
    if (!task || task.status !== 'pending' || task.failureKind !== 'killed' || task.attempts !== entry.priorTask.attempts || !task.commit)
      throw Error(`Quota pause did not preserve an interrupted source checkpoint: ${id}`);
    entry.source = task.commit;
  }
  pause.stoppedAt = new Date().toISOString();
  atomicWriteJson(join(directory(file), `${pause.id}.json`), pause);
}
/** Explicit migration of a genuine old-supervisor quota stop, never a normal failure. */
export function importStoppedQuotaPause(run: Run, file: string, reason: string): QuotaPause {
  const status = JSON.parse(readFileSync(join(runPaths(file).dir, 'pilot-status.json'), 'utf8'));
  if (status.status !== 'quota_paused' || !reason.trim() || !Number.isFinite(Date.parse(status.updatedAt)) || Object.values(run.tasks).some(t => t.status === 'running'))
    throw Error('Quota pause migration requires stopped supervisor quota_paused evidence and an explicit reason');
  const snapshot = structuredClone(run);
  for (const task of Object.values(snapshot.tasks)) {
    if (task.status === 'pending' && task.failureKind === 'killed' && task.commit && task.finishedAt &&
        Date.parse(task.finishedAt) <= Date.parse(status.updatedAt) && Date.parse(status.updatedAt) - Date.parse(task.finishedAt) < 60_000) task.status = 'running';
  }
  if (!Object.values(snapshot.tasks).some(t => t.status === 'running')) throw Error('No matching quota-interrupted attempts');
  const pause = captureQuotaPause(snapshot, file, status.updatedAt);
  pause.migrationReason = reason;
  finishQuotaPause(run, file, pause);
  return pause;
}
export function claimQuotaContinuations(run: Run, file: string, repo = dirname(file)): QuotaContinuation[] {
  const dir = directory(file);
  if (!existsSync(dir)) throw Error('No recorded quota pause exists');
  const entries = readdirSync(dir).filter(name => name.endsWith('.json')).map(name => ({ name, pause: JSON.parse(readFileSync(join(dir, name), 'utf8')) as QuotaPause }));
  // Crashes during quota shutdown can leave an incomplete record beside a
  // later, fully salvaged checkpoint. Only complete pauses for this exact run
  // and contract are candidates for continuation; keep incomplete records for
  // diagnosis without letting them make a valid checkpoint ambiguous.
  const pending = entries.filter(e => !e.pause.claimedAt && e.pause.stoppedAt && e.pause.runId === run.id &&
    e.pause.revision === run.planning?.revision && Object.keys(e.pause.tasks).length);
  if (pending.length !== 1) throw Error(`Expected exactly one complete unconsumed quota pause for run ${run.id}; found ${pending.length}`);
  const { name, pause } = pending[0]!;
  if (pause.version !== 1 || pause.runId !== run.id || pause.revision !== run.planning?.revision || !pause.stoppedAt)
    throw Error('Quota pause belongs to a different run, contract or incomplete stop');
  const continuations: QuotaContinuation[] = [];
  for (const [id, entry] of Object.entries(pause.tasks)) {
    const task = run.tasks[id], prior = entry.priorTask;
    if (!task || task.status !== 'pending' || task.failureKind !== 'killed' || task.attempts !== prior.attempts || task.attemptsInCycle !== prior.attemptsInCycle ||
        task.commit !== entry.source || planningDefinition(task) !== entry.definition || digest(task.executionBudget) !== digest(prior.executionBudget) ||
        !entry.source || session(file, task) !== entry.session || !(entry.remainingMs > 0) || !Number.isFinite(entry.remainingMs) ||
        git(repo, ['cat-file', '-e', `${entry.source}^{commit}`]).code)
      throw Error(`Quota continuation checkpoint mismatch: ${id}`);
    const used = entries.filter(e => e.pause.claimedAt && e.pause.tasks[id]?.priorTask.attempts === task.attempts).length;
    if (used >= Math.min(2, run.settings.infrastructureRetries ?? 2)) throw Error(`Quota infrastructure continuation limit reached: ${id}`);
    continuations.push({ taskId: id, source: entry.source, id: pause.id, deadline: Date.now() + entry.remainingMs, session: entry.session, verificationOnly: entry.verificationOnly, removeGenerated: [] });
  }
  pause.claimedAt = new Date().toISOString();
  atomicWriteJson(join(dir, name), pause);
  return continuations;
}

/** Verification after a resumed worker's transport failure keeps its already running active-time allowance. */
export function quotaVerificationDeadline(run: Run, file: string, task: Task, provenPriorIdentity?: { revision?: string; definition: string }): number | undefined {
  const dir = directory(file);
  if (!existsSync(dir)) return undefined;
  const claims = readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')) as QuotaPause)
    .filter(pause => pause.runId === run.id && pause.claimedAt && pause.tasks[task.id]?.priorTask.attempts === task.attempts)
    .sort((a, b) => Date.parse(b.claimedAt!) - Date.parse(a.claimedAt!));
  const latest = claims[0];
  if (!latest) return undefined;
  const entry = latest.tasks[task.id]!;
  const deadline = Date.parse(latest.claimedAt!) + entry.remainingMs;
  const expected = provenPriorIdentity ?? { revision: run.planning?.revision, definition: planningDefinition(task) };
  if (latest.version !== 1 || latest.revision !== expected.revision || entry.definition !== expected.definition ||
      !(deadline > Date.now()) || !Number.isFinite(deadline)) throw Error('Quota verification continuation has no matching unexpired active-time allowance');
  return deadline;
}
