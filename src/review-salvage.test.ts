import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DagRunner } from './runner.js';
import { git } from './git-worktree.js';
import { gitRepo, make } from './test-helpers.js';
import type { Run, Task } from './types.js';

test('review rejections preserve each attempt without merging rejected code', async () => {
  const repo = gitRepo();
  try {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.settings.worktree = 'task';
    a.cmd = 'implement';
    a.reviewCmd = 'review';
    a.reviewRounds = 1;
    a.maxAttempts = 2;
    const runner = new DagRunner(run, {
      cwd: repo,
      executor: async (task, ctx, cmd) => {
        if (cmd === 'review') return { output: 'VERDICT: FAIL: evidence missing', exitCode: 0 };
        assert.ok(ctx.cwd);
        writeFileSync(join(ctx.cwd, 'candidate.txt'), `attempt ${task.attempts}\n`);
        return { output: 'candidate implemented', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(a.status, 'failed');
    assert.equal(a.failureKind, 'review');
    for (const attempt of [1, 2]) {
      const ref = `refs/dag-salvage/${run.id}-${a.id}-attempt-${attempt}`;
      assert.equal(git(repo, ['show', `${ref}:candidate.txt`]).stdout, `attempt ${attempt}`);
    }
    assert.notEqual(git(repo, ['show', `dag/${run.id}:candidate.txt`]).code, 0);
    assert.equal(git(repo, ['status', '--porcelain']).stdout, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
