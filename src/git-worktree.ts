import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

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

// A run file is not always dag.run.json: derive what to keep out of the
// snapshot from the file the runner is actually using.
export interface SnapshotExcludes {
  // Paths relative to the repo root, e.g. "dag.run.json", "dag.run.d".
  file: string;
  dir: string;
  // Any archived run history that lives inside the repo.
  archived: string;
}

export function snapshotExcludes(runFile: string, repoDir: string): SnapshotExcludes {
  const rel = relative(repoDir, runFile).replace(/\\/g, '/');
  const safe = rel.startsWith('..') ? runFile.replace(/\\/g, '/') : rel;
  return {
    file: safe,
    dir: safe.endsWith('.json') ? `${safe.slice(0, -'.json'.length)}.d` : `${safe}.d`,
    archived: 'dag.runs',
  };
}

export function isDirty(dir: string, excludes?: SnapshotExcludes): boolean {
  const res = git(dir, ['status', '--porcelain']);
  const skip = excludes ?? { file: 'dag.run.json', dir: 'dag.run.d', archived: 'dag.runs' };
  // Our own artifacts don't count as "dirty" for snapshot purposes.
  const lines = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !l.includes(skip.file) &&
        !l.includes(skip.dir) &&
        !l.includes(skip.archived),
    );
  return lines.length > 0;
}

export function headCommit(dir: string): string {
  // `rev-parse HEAD` prints "HEAD" and exits 128 in a repo with no commits;
  // the exit code is what tells us the commit exists.
  const res = git(dir, ['rev-parse', '--verify', 'HEAD']);
  return res.code === 0 ? res.stdout : '';
}

export function currentBranch(dir: string): string {
  return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
}

const IDENTITY = ['-c', 'user.name=dag-orchestrator', '-c', 'user.email=dag@localhost'];
// The tool's own bookkeeping commits must never run the user's hooks: husky /
// lint-staged / commitlint would fail them, and a failed commit here loses the
// agent's work (the worktree is removed right after).
const NO_HOOKS = ['-c', 'core.hooksPath='];

// Commit the current working tree (tracked + untracked, minus run artifacts)
// without touching the caller's index or branch: a throwaway index file feeds
// `write-tree`, and `commit-tree` parents it on HEAD.
export function snapshotCommit(repoDir: string, excludes?: SnapshotExcludes): string {
  const skip = excludes ?? { file: 'dag.run.json', dir: 'dag.run.d', archived: 'dag.runs' };
  const tmpIndex = join(tmpdir(), `dag-index-${process.pid}-${Date.now()}`);
  try {
    const env = { GIT_INDEX_FILE: tmpIndex };
    const head = headCommit(repoDir);
    if (head) {
      if (git(repoDir, ['read-tree', head], env).code !== 0) git(repoDir, ['read-tree', '--empty'], env);
    } else {
      // Unborn HEAD (fresh `git init`): start from an empty index instead of
      // asking git to read a commit that does not exist yet.
      git(repoDir, ['read-tree', '--empty'], env);
    }
    // Add from the repo root, so a run file in a subdirectory still snapshots
    // the whole tree rather than only that subdirectory.
    const add = git(
      repoDir,
      [
        'add',
        '-A',
        '--',
        '.',
        `:(exclude)${skip.dir}`,
        `:(exclude)${skip.file}`,
        `:(exclude)${skip.file}.bak`,
        `:(exclude)${skip.file}.lock`,
        `:(exclude)${skip.archived}`,
      ],
      env,
    );
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr}`);
    const tree = git(repoDir, ['write-tree'], env).stdout;
    const args = [...IDENTITY, 'commit-tree', tree];
    if (head) args.push('-p', head);
    args.push('-m', 'dag: working-tree snapshot');
    const commit = git(repoDir, args).stdout;
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
  excludes?: SnapshotExcludes,
): { path: string; branch: string; base: string } {
  const branch = `dag/${runId}`;
  const path = join(worktreeRoot(repoDir, runId), 'integration');
  if (existsSync(join(path, '.git'))) {
    // Reuse an earlier attempt's worktree — but only if it still belongs to
    // this repo and branch. A leftover directory from a deleted repo would
    // otherwise run agents in a checkout whose git dir no longer exists.
    const usable =
      git(path, ['rev-parse', '--verify', 'HEAD']).code === 0 &&
      git(repoDir, ['rev-parse', '--verify', branch]).code === 0;
    if (usable) {
      return { path, branch, base: git(path, ['rev-parse', 'HEAD']).stdout };
    }
    git(repoDir, ['worktree', 'remove', '--force', path]);
    rmSync(longPath(path), { recursive: true, force: true });
  }
  // A previous process may have died leaving this path registered (or the temp
  // directory cleaned): prune stale registrations before re-adding.
  git(repoDir, ['worktree', 'prune']);
  mkdirSync(path, { recursive: true });
  rmSync(path, { recursive: true, force: true });
  let resolvedBase =
    base ?? (isDirty(repoDir, excludes) ? snapshotCommit(repoDir, excludes) : headCommit(repoDir));
  if (!resolvedBase) {
    // Unborn HEAD with nothing to snapshot: give the run a root commit so a
    // branch can exist. Without this, `worktree add` fails on a fresh repo.
    resolvedBase = snapshotCommit(repoDir, excludes);
  }
  const existing = git(repoDir, ['rev-parse', '--verify', branch]).code === 0;
  const args = existing
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, resolvedBase];
  const res = git(repoDir, args);
  if (res.code !== 0) {
    // One more prune, in case another process registered it in between.
    git(repoDir, ['worktree', 'prune']);
    const retry = git(repoDir, ['worktree', 'add', '-b', branch, path, resolvedBase]);
    if (retry.code !== 0) {
      throw new Error(`worktree add failed: ${retry.stderr || retry.stdout}`);
    }
  }
  return { path, branch, base: git(path, ['rev-parse', 'HEAD']).stdout };
}

// Task ids come from a JSON map key, so they are untrusted input for a path.
function safeTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId) || taskId === '.' || taskId === '..') {
    throw new Error(`unsafe task id for a worktree path: ${JSON.stringify(taskId)}`);
  }
  return taskId;
}

export function createTaskWorktree(
  repoDir: string,
  runId: string,
  taskId: string,
  fromBranch: string,
): { path: string; branch: string } {
  // Flat ref: git refs are a directory tree, so `dag/<run>` and
  // `dag/<run>/<task>` cannot coexist. Task branches live under dag-task/.
  const safe = safeTaskId(taskId);
  const branch = `dag-task/${runId}-${safe}`;
  const path = join(worktreeRoot(repoDir, runId), safe);
  // A hard kill leaves the worktree registered; without a prune the add below
  // fails with "branch already used by worktree" and the task dies on resume.
  git(repoDir, ['worktree', 'prune']);
  rmSync(path, { recursive: true, force: true });
  // -B resets an existing branch, so retries start from the current base.
  let res = git(repoDir, ['worktree', 'add', '--force', '-B', branch, path, fromBranch]);
  if (res.code !== 0) {
    git(repoDir, ['worktree', 'prune']);
    res = git(repoDir, ['worktree', 'add', '--force', '-B', branch, path, fromBranch]);
  }
  if (res.code !== 0) throw new Error(`worktree add failed: ${res.stderr || res.stdout}`);
  return { path, branch };
}

export function removeWorktree(repoDir: string, path: string): void {
  const res = git(repoDir, ['worktree', 'remove', '--force', path]);
  if (res.code !== 0 && existsSync(path)) {
    // Only the long-path fallback: git gave up on a path it still lists as one
    // of its own worktrees. Never recursively delete a directory git does not
    // recognize as ours.
    const listed = git(repoDir, ['worktree', 'list', '--porcelain']).stdout;
    const known = listed
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .some((l) => samePath(l.slice('worktree '.length).trim(), path));
    if (known) {
      try {
        rmSync(longPath(path), { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
  git(repoDir, ['worktree', 'prune']);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
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
  const res = git(worktree, [...IDENTITY, ...NO_HOOKS, 'commit', '-m', message]);
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
    ...NO_HOOKS,
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
