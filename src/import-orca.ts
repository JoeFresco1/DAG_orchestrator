import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoCycle } from './graph.js';
import { logEvent, newRun, saveRun } from './store.js';
import type { Run, Task } from './types.js';

// Migration path off Orca: read its orchestration SQLite DB (read-only) and
// materialise one run as a dag.run.json with the same ids, specs and deps.
interface OrcaTaskRow {
  id: string;
  task_title: string | null;
  display_name: string | null;
  spec: string | null;
  status: string;
  deps: string | null;
  result: string | null;
  created_at: string | null;
}

interface OrcaRunRow {
  id: string;
  objective: string;
  created_at: string;
}

export function defaultOrcaDbPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'orca', 'orchestration.db');
}

export interface ImportOptions {
  dbPath?: string;
  runId: string;
  file: string;
  cmdTemplate?: string | null;
  only?: string[];
}

export interface ImportSummary {
  runId: string;
  objective: string;
  tasks: number;
  edges: number;
  statuses: Record<string, number>;
  file: string;
  taskIds: string[];
}

interface SqliteStatement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

// node:sqlite ships with Node 22+; a migration tool needs no dependency.
function openSqlite(path: string): SqliteDb {
  const require = createRequire(import.meta.url);
  const mod = require('node:sqlite') as {
    DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => SqliteDb;
  };
  return new mod.DatabaseSync(path, { readOnly: true });
}

export function listOrcaRuns(dbPath = defaultOrcaDbPath()): OrcaRunRow[] {
  if (!existsSync(dbPath)) throw new Error(`orca database not found: ${dbPath}`);
  const db = openSqlite(dbPath);
  try {
    return db
      .prepare('select id, objective, created_at from runs order by created_at desc')
      .all() as OrcaRunRow[];
  } finally {
    db.close();
  }
}

export function importOrcaRun(opts: ImportOptions): ImportSummary {
  const dbPath = opts.dbPath ?? defaultOrcaDbPath();
  if (!existsSync(dbPath)) throw new Error(`orca database not found: ${dbPath}`);
  const db = openSqlite(dbPath);
  let runRow: OrcaRunRow | undefined;
  let rows: OrcaTaskRow[];
  try {
    runRow = db
      .prepare('select id, objective, created_at from runs where id = ?')
      .get(opts.runId) as OrcaRunRow | undefined;
    if (!runRow) throw new Error(`no such orca run: ${opts.runId}`);
    rows = db
      .prepare(
        'select id, task_title, display_name, spec, status, deps, result, created_at ' +
          'from tasks where run_id = ? order by created_at',
      )
      .all(opts.runId) as OrcaTaskRow[];
  } finally {
    db.close();
  }

  const wanted = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  const selected = rows.filter((r) => !wanted || wanted.has(r.id));
  const knownIds = new Set(rows.map((r) => r.id));

  const run: Run = newRun(runRow.objective);
  const statuses: Record<string, number> = {};
  const taskIds: string[] = [];
  let edges = 0;
  let seq = 0;

  for (const row of selected) {
    const deps = (JSON.parse(row.deps ?? '[]') as string[]).filter((d) => knownIds.has(d));
    edges += deps.length;
    const task: Task = {
      id: row.id,
      title: (row.task_title ?? row.display_name ?? row.id).trim(),
      spec: row.spec ?? '',
      deps,
      status: 'pending',
      cmd: opts.cmdTemplate ?? null,
      gate: null,
      result: null,
      createdAt: row.created_at ?? new Date().toISOString(),
      seq: ++seq,
      attempts: 0,
      maxAttempts: run.settings.maxAttempts,
      timeoutMs: null,
      silenceMs: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      failureKind: null,
      lastOutputAt: null,
      lastOutput: null,
      pid: null,
      reviewCmd: null,
      reviewRounds: 0,
      reviews: 0,
      reviewResult: null,
      reviewExitCode: null,
      repairRounds: 0,
      repairs: 0,
      branch: null,
      commit: null,
      mergeRetries: 0,
      planCmd: null,
      plan: null,
      model: null,
      variant: null,
    };
    run.tasks[task.id] = task;
    statuses[row.status] = (statuses[row.status] ?? 0) + 1;
    taskIds.push(task.id);
  }

  // Only dependencies that were imported survive.
  for (const task of Object.values(run.tasks)) {
    task.deps = task.deps.filter((d) => run.tasks[d]);
  }
  assertNoCycle(run);

  logEvent(run, 'note', null, `imported from orca ${opts.runId} (${selected.length} tasks)`);
  saveRun(run, opts.file);

  return {
    runId: opts.runId,
    objective: runRow.objective,
    tasks: taskIds.length,
    edges,
    statuses,
    file: resolve(opts.file),
    taskIds,
  };
}
