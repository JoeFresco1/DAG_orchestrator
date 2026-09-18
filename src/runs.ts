// Run history on disk: archive the active run, list active plus archived runs,
// and resolve a run id back to its file. The layout is documented just below.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadRun, runPaths, saveRun } from './store.js';
import { newRun } from './store.js';
import type { Run } from './types.js';

// Runs are first-class: the active run lives at the project root and archived
// runs live beside it, so history travels with the repository.
//
//   <project>/dag.run.json + dag.run.d/      the active run
//   <project>/dag.runs/<runId>/dag.run.json  archived runs (same shape)
//   <project>/dag.runs/<runId>/dag.run.d/

/** Where a run lives right now: its file, sidecar dir, and whether it is archive history. */
export interface RunLocation {
  runId: string;
  file: string;
  dir: string;
  archived: boolean;
  projectDir: string;
}

export function runsRoot(projectDir: string): string {
  return join(resolve(projectDir), 'dag.runs');
}

export function activeRunFile(projectDir: string): string {
  return join(resolve(projectDir), 'dag.run.json');
}

export function hasActiveRun(projectDir: string): boolean {
  return existsSync(activeRunFile(projectDir));
}

// Where an archived run of this project would live.
export function archiveDir(projectDir: string, runId: string): string {
  return join(runsRoot(projectDir), runId);
}

// Move the active run aside (run file, sidecar dir, backup and lock) under
// dag.runs/<runId>. Idempotent: an existing archive is kept and reported.
export function archiveRun(projectDir: string, file: string): string | null {
  if (!existsSync(file)) return null;
  const paths = runPaths(file);
  let runId: string;
  try {
    runId = loadRun(file).id;
  } catch {
    return null;
  }
  const target = archiveDir(projectDir, runId);
  if (existsSync(target)) return target; // already archived
  mkdirSync(runsRoot(projectDir), { recursive: true });
  mkdirSync(target, { recursive: true });

  renameSync(file, join(target, basename(paths.file)));
  if (existsSync(paths.dir)) {
    renameSync(paths.dir, join(target, basename(paths.dir)));
  }
  for (const extra of [`${file}.bak`, `${file}.lock`]) {
    if (existsSync(extra)) renameSync(extra, join(target, basename(extra)));
  }
  return target;
}

export interface RunSummaryRow {
  runId: string;
  objective: string;
  file: string;
  archived: boolean;
  status: string;
  total: number;
  counts: Record<string, number>;
  updatedAt: string;
}

/** Read a run file into a compact row for listings; null when unreadable. */
export function summarizeRunFile(file: string, archived: boolean): RunSummaryRow | null {
  try {
    const run: Run = loadRun(file);
    const counts: Record<string, number> = {};
    for (const t of Object.values(run.tasks)) counts[t.status] = (counts[t.status] ?? 0) + 1;
    // "settled" means no task can still change: every task is in a terminal
    // state, so the run has converged.
    const settled = Object.values(run.tasks).every(
      (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'skipped',
    );
    return {
      runId: run.id,
      objective: run.objective,
      file,
      archived,
      status: settled ? 'settled' : 'active',
      total: Object.keys(run.tasks).length,
      counts,
      updatedAt: run.updatedAt,
    };
  } catch {
    return null;
  }
}

// Active first, then archived runs newest-first.
export function listRuns(projectDir: string): RunSummaryRow[] {
  const rows: RunSummaryRow[] = [];
  const active = activeRunFile(projectDir);
  if (existsSync(active)) {
    const row = summarizeRunFile(active, false);
    if (row) rows.push(row);
  }
  const root = runsRoot(projectDir);
  if (existsSync(root)) {
    const dirs = readdirSync(root)
      .map((name) => join(root, name))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => basename(b).localeCompare(basename(a)));
    for (const dir of dirs) {
      const file = join(dir, basename(active));
      if (!existsSync(file)) continue;
      const row = summarizeRunFile(file, true);
      if (row) rows.push(row);
    }
  }
  return rows;
}

// Locate a run by id: the active slot first, then the archive. An unreadable
// active file falls through instead of failing the lookup.
export function findRun(projectDir: string, runId: string): RunLocation | null {
  const active = activeRunFile(projectDir);
  if (existsSync(active)) {
    try {
      if (loadRun(active).id === runId) {
        return { runId, file: active, dir: runPaths(active).dir, archived: false, projectDir };
      }
    } catch {
      // unreadable active run; fall through to the archive
    }
  }
  const dir = archiveDir(projectDir, runId);
  const file = join(dir, basename(active));
  if (existsSync(file)) {
    return { runId, file, dir: runPaths(file).dir, archived: true, projectDir };
  }
  return null;
}

// Start a fresh active run, archiving whatever was active before.
export function startNewRun(projectDir: string, objective: string): { run: Run; archivedTo: string | null } {
  const active = activeRunFile(projectDir);
  let archivedTo: string | null = null;
  if (existsSync(active)) {
    try {
      const previous = loadRun(active);
      if (Object.keys(previous.tasks).length > 0) {
        archivedTo = archiveRun(projectDir, active);
      } else {
        // An empty run is not history; just replace it.
        const paths = runPaths(active);
        rmSync(active, { force: true });
        rmSync(paths.dir, { recursive: true, force: true });
        rmSync(`${active}.lock`, { force: true });
      }
    } catch {
      // unreadable: keep it, the caller will overwrite
    }
  }
  const run = newRun(objective);
  saveRun(run, active);
  return { run, archivedTo };
}

export function projectOf(file: string): string {
  return dirname(resolve(file));
}
