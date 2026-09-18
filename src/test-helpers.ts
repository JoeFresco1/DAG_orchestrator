// Shared fixtures for the split test files: the run/task factory, an executor
// that never settles, and the temp-dir helpers (plain and git-backed).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTask, newRun, runPaths } from './store.js';
import { git } from './git-worktree.js';
import type { ExecContext } from './runner.js';
import type { Run, Task } from './types.js';

// A run with one task per id, spread onto the returned object for convenience.
export function make(ids: string[]): { run: Run; [k: string]: unknown } {
  const run = newRun('t');
  const tasks: Record<string, Task> = {};
  for (const id of ids) tasks[id] = addTask(run, { title: id, spec: '' });
  return { run, ...tasks };
}

// An executor that never settles or aborts: models a hung agent process.
export function never(_task: Task, _ctx: ExecContext): Promise<never> {
  return new Promise<never>(() => {});
}

export function runsDir(file: string): string {
  return runPaths(file).dir;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dag-'));
}

// A throwaway git repo with one commit, for the worktree tests.
export function gitRepo(): string {
  const dir = tempDir();
  const g = (args: string[]): ReturnType<typeof git> => git(dir, args);
  g(['init', '-q']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  writeFileSync(join(dir, 'tracked.txt'), 'tracked\n');
  g(['add', 'tracked.txt']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base']);
  return dir;
}