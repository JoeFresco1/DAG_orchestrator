// View-model builders: turn run/runtime state into the JSON shapes the viewer
// consumes. Kept separate from the server so the payload contract is testable
// and the request handler stays thin.
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { foreignLock, loadRun } from './store.js';
import { deriveStatus } from './graph.js';
import { listRuns, projectOf } from './runs.js';
import { loadRegistry, projectId, type ProjectEntry } from './registry.js';
import type { Run } from './types.js';
import type { RunRuntime } from './server-types.js';

// Live job status for one runtime: what is running now, and (when idle) the
// last result plus any foreign lock that blocks starting it.
export function jobView(rt: RunRuntime): Record<string, unknown> {
  const active = rt.runner?.isRunning || rt.runner?.isStopping;
  const foreign = active ? null : foreignLock(rt.file);
  return {
    running: rt.runner?.isRunning ?? false,
    stopping: rt.runner?.isStopping ?? false,
    current: active ? (rt.runner?.current ?? []) : [],
    result: active ? null : (rt.runner?.result ?? null),
    startedAt: active ? rt.jobStartedAt : null,
    scope: active ? rt.activeScope : null,
    external: foreign ? { pid: foreign.pid, note: foreign.note, startedAt: foreign.startedAt } : null,
  };
}

// Reads the freshest state: from the in-memory runner while it is live, from
// disk otherwise.
export function currentRun(rt: RunRuntime): Run {
  return rt.runner && (rt.runner.isRunning || rt.runner.isStopping) ? rt.runner.state : loadRun(rt.file);
}

// FNV-1a over the task graph's identity fields, so the viewer can tell a real
// definition change from a state-only revision bump.
export function defHash(run: Run): number {
  let h = 2166136261;
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  };
  for (const t of Object.values(run.tasks)) {
    feed(t.id);
    feed(t.title);
    feed(t.deps.join(','));
  }
  return h >>> 0;
}

export function definitionPayload(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    objective: run.objective,
    createdAt: run.createdAt,
    settings: run.settings,
    tasks: Object.values(run.tasks).map((t) => ({
      id: t.id,
      title: t.title,
      deps: t.deps,
      seq: t.seq,
      model: t.model,
      variant: t.variant,
    })),
  };
}

export function summaryPayload(run: Run): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const tasks = Object.values(run.tasks).map((t) => {
    const display = deriveStatus(run, t);
    counts[display] = (counts[display] ?? 0) + 1;
    return {
      id: t.id,
      status: t.status,
      display,
      attempts: t.attempts,
      maxAttempts: t.maxAttempts,
      failureKind: t.failureKind,
      exitCode: t.exitCode,
      lastOutputAt: t.lastOutputAt,
      pid: t.pid,
      model: t.model,
      variant: t.variant,
      reviews: t.reviews,
      reviewRounds: t.reviewRounds,
      repairs: t.repairs,
      repairRounds: t.repairRounds,
    };
  });
  return {
    rev: run.rev,
    defRev: defHash(run),
    runId: run.id,
    objective: run.objective,
    updatedAt: run.updatedAt,
    counts,
    total: tasks.length,
    tasks,
  };
}

// The hub's project card: its runs, the active run's counts/status, and how
// many of them have a live job. `lookup` resolves a runId to its runtime.
export function projectPayload(
  entry: ProjectEntry,
  lookup: (runId: string) => RunRuntime | null,
): Record<string, unknown> {
  const dir = projectOf(entry.file);
  const runs = listRuns(dir).map((row) => {
    const rt = lookup(row.runId);
    return { ...row, job: rt ? jobView(rt) : null };
  });
  const active = runs.find((r) => !r.archived) ?? null;
  const running = runs.filter((r) => r.job?.running).length;
  return {
    id: projectId(entry.file),
    name: entry.name,
    dir,
    file: entry.file,
    exists: existsSync(entry.file),
    addedAt: entry.addedAt,
    activeRunId: active?.runId ?? null,
    running,
    totalRuns: runs.length,
    counts: active?.counts ?? {},
    status: active?.status ?? 'empty',
    runs,
  };
}

export function projectName(dir: string): string {
  const entry = loadRegistry().projects.find((p) => projectOf(p.file) === resolve(dir));
  return entry?.name ?? basename(dir);
}
