// Project-level commands: `init` (a new run file) and `projects` (the registry
// that backs hub mode and `launch`).
import { existsSync } from 'node:fs';
import { newRun, saveRun } from '../store.js';
import {
  addProject,
  findProject,
  loadRegistry,
  projectId,
  removeProject,
} from '../registry.js';
import { emit, flag, taskTimingFlags } from '../cli-args.js';

// `init` creates the run file with an objective, optionally seeding the run's
// retry budget from the same timing flags `add` accepts.
export function initCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const objective = flag(argv, 'objective') ?? 'untitled dag';
  const run = newRun(objective);
  const s = taskTimingFlags(argv);
  if (s.maxAttempts !== undefined) run.settings.maxAttempts = s.maxAttempts;
  saveRun(run, file);
  emit(argv, { runId: run.id, file }, () => `${run.id}\nSaved to ${file}`);
}

// `projects` manages the registry of run files the hub can see:
// add/rm/open one, or list them all with a flag showing whether the file is
// still on disk.
export async function projectsCmd(argv: string[]): Promise<void> {
  const sub = argv[0] ?? 'list';
  if (sub === 'add') {
    const target = flag(argv, 'dir') ?? argv[1];
    if (!target) throw new Error('usage: dag projects add --dir <project folder> [--name N]');
    const entry = addProject(target, flag(argv, 'name'));
    emit(argv, entry, () => `${entry.name}\t${entry.file}`);
    return;
  }
  if (sub === 'rm' || sub === 'remove') {
    const target = flag(argv, 'id') ?? argv[1];
    if (!target) throw new Error('usage: dag projects rm <id|path|name>');
    const removed = removeProject(target);
    emit(argv, { removed }, () => (removed ? `removed ${target}` : `no project matched ${target}`));
    if (!removed) process.exitCode = 1;
    return;
  }
  if (sub === 'open') {
    // Opens the project page in the hub, starting one if needed.
    const target = flag(argv, 'id') ?? argv[1];
    if (!target) throw new Error('usage: dag projects open <id|name> [--dir <folder>]');
    const entry = findProject(target) ?? addProject(flag(argv, 'dir') ?? target);
    const { launchProject, openBrowser } = await import('../launcher.js');
    const launched = await launchProject(entry, { open: false });
    const url = `${launched.url}/p/${projectId(entry.file)}`;
    openBrowser(url);
    emit(argv, { project: entry.name, url }, () => url);
    return;
  }
  const registry = loadRegistry();
  const rows = registry.projects.map((p) => ({
    id: projectId(p.file),
    name: p.name,
    file: p.file,
    exists: existsSync(p.file),
  }));
  emit(argv, rows, () =>
    rows.length === 0
      ? 'no projects registered; add one with: dag projects add --dir <folder>'
      : rows.map((r) => `${r.id}  ${r.exists ? ' ' : '!'} ${r.name}\t${r.file}`).join('\n'),
  );
}
