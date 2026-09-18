// Worktree isolation tests: snapshotting a dirty tree, creating and
// re-attaching integration/task worktrees, hook hygiene, branch naming, and
// merge-conflict detection.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  commitAll,
  createTaskWorktree,
  ensureIntegrationWorktree,
  git,
  mergeIntoIntegration,
  removeWorktree,
  snapshotCommit,
  snapshotExcludes,
} from './git-worktree.js';
import { tempDir, gitRepo } from './test-helpers.js';
describe('worktree isolation', () => {
  it('snapshots a dirty tree without touching the caller index or branch', () => {
    const repo = gitRepo();
    try {
      writeFileSync(join(repo, 'tracked.txt'), 'tracked\nuncommitted edit\n');
      writeFileSync(join(repo, 'untracked.txt'), 'brand new\n');
      const before = git(repo, ['rev-parse', 'HEAD']).stdout;
      const snapshot = snapshotCommit(repo);
      assert.notEqual(snapshot, before, 'snapshot is a new commit');
      assert.equal(git(repo, ['rev-parse', 'HEAD']).stdout, before, 'HEAD unchanged');
      assert.match(git(repo, ['status', '--porcelain']).stdout, /uncommitted edit|M tracked/, 'tree still dirty');
      assert.equal(git(repo, ['show', `${snapshot}:untracked.txt`]).stdout, 'brand new', 'untracked included');
      assert.match(git(repo, ['show', `${snapshot}:tracked.txt`]).stdout, /uncommitted edit/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('re-attaches a worktree whose registration outlived a hard kill', () => {
    const repo = gitRepo();
    try {
      const integration = ensureIntegrationWorktree(repo, 'run_kill');
      const task = createTaskWorktree(repo, 'run_kill', 'task_wip', integration.branch);
      writeFileSync(join(task.path, 'wip.txt'), 'agent work\n');
      // A hard kill (power loss, taskkill /F) leaves the directory gone but the
      // registration in .git/worktrees: the next add used to fail with
      // "cannot force update the branch ... used by worktree".
      rmSync(task.path, { recursive: true, force: true });
      assert.match(git(repo, ['worktree', 'list']).stdout, /task_wip/);
      const again = createTaskWorktree(repo, 'run_kill', 'task_wip', integration.branch);
      assert.ok(existsSync(join(again.path, '.git')));
      rmSync(integration.path, { recursive: true, force: true });
      const integration2 = ensureIntegrationWorktree(repo, 'run_kill');
      assert.ok(existsSync(join(integration2.path, '.git')));
      removeWorktree(repo, again.path);
      removeWorktree(repo, integration2.path);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('works in a repo that has no commits yet', () => {
    const dir = tempDir();
    try {
      git(dir, ['init', '-q']);
      writeFileSync(join(dir, 'first.txt'), 'no commits yet\n');
      const snapshot = snapshotCommit(dir);
      assert.ok(snapshot, 'snapshot of an unborn HEAD');
      assert.equal(git(dir, ['show', `${snapshot}:first.txt`]).stdout, 'no commits yet');
      const integration = ensureIntegrationWorktree(dir, 'run_unborn');
      const task = createTaskWorktree(dir, 'run_unborn', 'task_first', integration.branch);
      assert.ok(existsSync(join(task.path, 'first.txt')));
      removeWorktree(dir, task.path);
      removeWorktree(dir, integration.path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps run artifacts out of the snapshot for any --file name', () => {
    const repo = gitRepo();
    try {
      mkdirSync(join(repo, 'sub'), { recursive: true });
      const runFile = join(repo, 'sub', 'myrun.json');
      writeFileSync(runFile, '{}\n');
      writeFileSync(`${runFile}.lock`, '{"pid":1234}\n');
      mkdirSync(join(repo, 'sub', 'myrun.d', 'logs'), { recursive: true });
      writeFileSync(join(repo, 'sub', 'myrun.d', 'state.json'), '{}\n');
      mkdirSync(join(repo, 'dag.runs', 'run_old'), { recursive: true });
      writeFileSync(join(repo, 'dag.runs', 'run_old', 'dag.run.json'), '{}\n');
      writeFileSync(join(repo, 'sub', 'dirty.txt'), 'work\n');
      writeFileSync(join(repo, 'root-dirty.txt'), 'work\n');
      const excludes = snapshotExcludes(runFile, repo);
      const commit = snapshotCommit(repo, excludes);
      const tree = git(repo, ['ls-tree', '-r', '--name-only', commit]).stdout.split('\n');
      assert.ok(!tree.some((p) => /myrun|dag\.runs/.test(p)), tree.join(' '));
      // The snapshot is repo-wide, not limited to the run file's directory.
      assert.ok(tree.includes('root-dirty.txt'), tree.join(' '));
      assert.ok(tree.includes('sub/dirty.txt'), tree.join(' '));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ignores the user\'s git hooks when committing agent work', () => {
    const repo = gitRepo();
    try {
      const integration = ensureIntegrationWorktree(repo, 'run_hooks');
      const task = createTaskWorktree(repo, 'run_hooks', 'task_h', integration.branch);
      // Hooks that always fail: committing agent work must bypass them.
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
      writeFileSync(join(repo, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 1\n');
      writeFileSync(join(task.path, 'valuable.txt'), 'agent output\n');
      const saved = commitAll(task.path, 'dag: test');
      assert.ok(saved.commit, 'the work is committed even with failing hooks');
      assert.equal(git(task.path, ['show', `${saved.commit}:valuable.txt`]).stdout, 'agent output');
      removeWorktree(repo, task.path);
      removeWorktree(repo, integration.path);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('never deletes a directory git does not list as a worktree', () => {
    const repo = gitRepo();
    try {
      const plain = join(repo, 'plain-dir');
      mkdirSync(plain, { recursive: true });
      writeFileSync(join(plain, 'user-data.txt'), 'keep\n');
      removeWorktree(repo, plain);
      assert.ok(existsSync(join(plain, 'user-data.txt')));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('task branches never collide with the integration branch ref', () => {
    const repo = gitRepo();
    try {
      const integration = ensureIntegrationWorktree(repo, 'run_test');
      const task = createTaskWorktree(repo, 'run_test', 'task_abc', integration.branch);
      // The bug this guards: dag/<run> and dag/<run>/<task> cannot coexist.
      assert.ok(task.branch.startsWith('dag-task/'), task.branch);
      assert.equal(git(repo, ['rev-parse', '--verify', task.branch]).code, 0);
      assert.equal(git(repo, ['rev-parse', '--verify', integration.branch]).code, 0);
      removeWorktree(repo, task.path);
      removeWorktree(repo, integration.path);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('detects merge conflicts and merges clean work', () => {
    const repo = gitRepo();
    try {
      const integration = ensureIntegrationWorktree(repo, 'run_conflict');
      const t1 = createTaskWorktree(repo, 'run_conflict', 'task_one', integration.branch);
      const t2 = createTaskWorktree(repo, 'run_conflict', 'task_two', integration.branch);
      writeFileSync(join(t1.path, 'tracked.txt'), 'tracked\nfrom one\n');
      writeFileSync(join(t2.path, 'tracked.txt'), 'tracked\nfrom two\n');
      commitAll(t1.path, 'one');
      commitAll(t2.path, 'two');

      const first = mergeIntoIntegration(integration.path, t1.branch, 'task_one');
      assert.equal(first.merged, true, 'first merge is clean');
      const second = mergeIntoIntegration(integration.path, t2.branch, 'task_two');
      assert.equal(second.merged, false);
      assert.equal(second.conflict, true, 'second merge conflicts on the same file');
      // The integration worktree must not be left mid-merge.
      assert.equal(existsSync(join(integration.path, '.git', 'MERGE_HEAD')), false);
      removeWorktree(repo, t1.path);
      removeWorktree(repo, t2.path);
      removeWorktree(repo, integration.path);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
