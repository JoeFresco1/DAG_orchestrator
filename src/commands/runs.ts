// Run-history commands: `new-run` archives the active run and starts fresh,
// `runs` lists/shows/archives the runs kept beside the project.
import { existsSync } from 'node:fs';
import { assertNoForeignLock } from '../store.js';
import { activeRunFile, archiveRun, findRun, listRuns, projectOf, startNewRun } from '../runs.js';
import { emit, flag, guard } from '../cli-args.js';

// Archive the active run and start a fresh one, so history stays in the
// project folder instead of being overwritten.
export function newRunCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const objective = flag(argv, 'objective');
  if (!objective) throw new Error('--objective is required');
  const dir = projectOf(file);
  const active = activeRunFile(dir);
  // Refuse when another process holds the run: archiving under a live runner
  // would destroy the active run.
  if (existsSync(active)) {
    try {
      assertNoForeignLock(active);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }
  const { run, archivedTo } = startNewRun(dir, objective);
  emit(
    argv,
    { runId: run.id, archivedTo, file: active },
    () =>
      `${run.id}\n` +
      (archivedTo ? `archived the previous run to ${archivedTo}\n` : '') +
      `active run: ${active}`,
  );
}

// `runs list` (default) shows every run with its status and size; `runs show`
// resolves one runId to its file; `runs archive` moves the active run aside.
export function runsCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const sub = argv[0] ?? 'list';
  const dir = projectOf(file);
  if (sub === 'archive') {
    guard(file, argv);
    const target = archiveRun(dir, activeRunFile(dir));
    emit(argv, { archivedTo: target }, () => (target ? `archived to ${target}` : 'nothing to archive'));
    if (!target) process.exitCode = 1;
    return;
  }
  const rows = listRuns(dir);
  if (sub === 'show') {
    const id = flag(argv, 'id') ?? argv[1];
    if (!id) throw new Error('usage: dag runs show --id <runId>');
    const found = findRun(dir, id);
    if (!found) throw new Error(`no run ${id} in ${dir}`);
    emit(argv, found, () => `${found.runId}\n${found.archived ? 'archived' : 'active'}\n${found.file}`);
    return;
  }
  emit(argv, rows, () =>
    rows.length === 0
      ? 'no runs in this project yet'
      : rows
          .map(
            (r) =>
              `${r.runId}  ${r.archived ? 'archived' : 'active  '}  ${r.status.padEnd(8)} ${String(r.total).padStart(4)} tasks  ${r.objective.slice(0, 60)}`,
          )
          .join('\n'),
  );
}
