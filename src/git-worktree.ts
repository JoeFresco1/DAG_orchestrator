import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Worktree isolation: one integration branch per run, one worktree per task
// branched from it, merged back on success. A downstream task sees its
// upstream's work because it branches *after* those merges.
//
// The base is a snapshot commit of the working tree (including untracked
// files, excluding our own run artifacts), so a dirty repo does not change
// what the agents see.

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(dir: string, args: string[], env?: NodeJS.ProcessEnv): GitResult {
  const res = spawnSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return {
    code: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

// Windows refuses paths past ~260 chars unless they carry the \\?\ prefix;
// deep repos (backend/app/interfaces/http/schemas/...) blow past that inside
// a temp worktree, so removals need the prefix even when git gives up.
function longPath(path: string): string {
  if (process.platform !== 'win32') return path;
  const abs = path.startsWith('\\\\?\\') ? path : `\\\\?\\${path}`;
  return abs.replace(/\//g, '\\');
}

export function isGitRepo(dir: string): boolean {
  return git(dir, ['rev-parse', '--is-inside-work-tree']).stdout === 'true';
}

export function isDirty(dir: string): boolean {
  const res = git(dir, ['status', '--porcelain']);
  // Our own artifacts don't count as "dirty" for snapshot purposes.
  const lines = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !/dag\.run\.d\//.test(l) &&
        !/dag\.run\.json/.test(l) &&
        !/\.orca-dag\./.test(l),
    );
  return lines.length > 0;
}

export function headCommit(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).stdout;
}

export function currentBranch(dir: string): string {
  return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
}

const IDENTITY = ['-c', 'user.name=lightweight-dag', '-c', 'user.email=dag@localhost'];

// Commit the current working tree (tracked + untracked, minus run artifacts)
// without touching the caller's index or branch: a throwaway index file feeds
// `write-tree`, and `commit-tree` parents it on HEAD.
export function snapshotCommit(repoDir: string): string {
  const tmpIndex = join(tmpdir(), `dag-index-${process.pid}-${Date.now()}`);
  try {
    const env = { GIT_INDEX_FILE: tmpIndex };
    const head = headCommit(repoDir);
    if (git(repoDir, ['read-tree', head], env).code !== 0) git(repoDir, ['read-tree', '--empty'], env);
    const add = git(
      repoDir,
      [
        'add',
        '-A',
        '--',
        '.',
        ':(exclude)dag.run.d',
        ':(exclude)dag.run.json',
        ':(exclude)dag.run.json.bak',
        ':(exclude)dag.run.json.lock',
        ':(exclude)..orca-dag.scheduler-state.json.tmp.failed',
      ],
      env,
    );
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr}`);
    const tree = git(repoDir, ['write-tree'], env).stdout;
    const commit = git(
      repoDir,
      [...IDENTITY, 'commit-tree', tree, '-p', head, '-m', 'dag: working-tree snapshot'],
    ).stdout;
    if (!commit) throw new Error('git commit-tree produced no commit');
    return commit;
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

// Short on purpose: a deep repo plus a deep temp path overruns Windows'
// 260-char limit inside the worktree.
export function worktreeRoot(repoDir: string, runId: string): string {
  const key = createHash('sha1').update(`${repoDir}:${runId}`).digest('hex').slice(0, 10);
  return join(tmpdir(), 'dwt', key);
}

export function ensureIntegrationWorktree(
  repoDir: string,
  runId: string,
  base?: string,
): { path: string; branch: string; base: string } {
  const branch = `dag/${runId}`;
  const path = join(worktreeRoot(repoDir, runId), 'integration');
  if (existsSync(join(path, '.git'))) {
    // Already attached from an earlier attempt; reuse what it has merged.
    return { path, branch, base: git(path, ['rev-parse', 'HEAD']).stdout };
  }
  mkdirSync(path, { recursive: true });
  rmSync(path, { recursive: true, force: true });
  const resolvedBase = base ?? (isDirty(repoDir) ? snapshotCommit(repoDir) : headCommit(repoDir));
  const existing = git(repoDir, ['rev-parse', '--verify', branch]).code === 0;
  const args = existing
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, resolvedBase];
  const res = git(repoDir, args);
  if (res.code !== 0) throw new Error(`worktree add failed: ${res.stderr || res.stdout}`);
  return { path, branch, base: git(path, ['rev-parse', 'HEAD']).stdout };
}

export function createTaskWorktree(
  repoDir: string,
  runId: string,
  taskId: string,
  fromBranch: string,
): { path: string; branch: string } {
  // Flat ref: git refs are a directory tree, so `dag/<run>` and
  // `dag/<run>/<task>` cannot coexist. Task branches live under dag-task/.
  const branch = `dag-task/${runId}-${taskId}`;
  const path = join(worktreeRoot(repoDir, runId), taskId);
  rmSync(path, { recursive: true, force: true });
  // -B resets an existing branch, so retries start from the current base.
  const res = git(repoDir, ['worktree', 'add', '--force', '-B', branch, path, fromBranch]);
  if (res.code !== 0) throw new Error(`worktree add failed: ${res.stderr || res.stdout}`);
  return { path, branch };
}

export function removeWorktree(repoDir: string, path: string): void {
  git(repoDir, ['worktree', 'remove', '--force', path]);
  if (existsSync(path)) {
    // git gave up (long paths): delete with the extended prefix ourselves.
    try {
      rmSync(longPath(path), { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  git(repoDir, ['worktree', 'prune']);
}

export interface CommitResult {
  commit: string | null;
  files: number;
}

export function commitAll(worktree: string, message: string): CommitResult {
  const add = git(worktree, ['add', '-A']);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const staged = git(worktree, ['diff', '--cached', '--name-only']);
  const files = staged.stdout ? staged.stdout.split('\n').filter(Boolean).length : 0;
  if (files === 0) return { commit: null, files: 0 };
  const res = git(worktree, [...IDENTITY, 'commit', '-m', message]);
  if (res.code !== 0) throw new Error(`git commit failed: ${res.stderr || res.stdout}`);
  return { commit: git(worktree, ['rev-parse', 'HEAD']).stdout, files };
}

// Merge a task branch into the run's integration branch. Conflicts abort and
// surface as a retryable failure: the task is redone on the new base.
export function mergeIntoIntegration(
  integrationWorktree: string,
  taskBranch: string,
  taskId: string,
): { merged: boolean; conflict: boolean; detail: string } {
  const res = git(integrationWorktree, [
    ...IDENTITY,
    'merge',
    '--no-ff',
    '-m',
    `dag: merge ${taskId}`,
    taskBranch,
  ]);
  if (res.code === 0) return { merged: true, conflict: false, detail: res.stdout };
  git(integrationWorktree, ['merge', '--abort']);
  const conflict = /CONFLICT|conflict/i.test(res.stdout + res.stderr);
  return { merged: false, conflict, detail: (res.stderr || res.stdout).slice(0, 500) };
}

export function writeWorktreeNote(path: string, text: string): void {
  try {
    writeFileSync(join(path, '.dag-note.txt'), text, 'utf8');
  } catch {
    // best effort
  }
}
