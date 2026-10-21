import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addTask, newRun, saveRun, loadRun } from './store.js';
import { DagRunner } from './runner.js';
import { gitRepo, tempDir } from './test-helpers.js';
import { git } from './git-worktree.js';

test('protocol recovery retries review alone and persists dispatch counters', async () => {
  const run = newRun('review recovery'), file = join(tempDir(), 'dag.run.json');
  const task = addTask(run, { title: 'work', spec: '', cmd: 'work', reviewCmd: 'review', reviewRounds: 3 });
  let work = 0, review = 0;
  const runner = new DagRunner(run, { file, persist: state => saveRun(state, file), executor: async (_task, _ctx, cmd) => {
    if (cmd === 'review') {
      review++;
      assert.equal(loadRun(file).tasks[task.id]!.reviewProtocolAttempts![`${task.attempts}:review`], review);
      return { output: review === 1 ? 'missing conclusion' : 'VERDICT: PASS', exitCode: 0 };
    }
    work++;
    return { output: 'candidate', exitCode: 0 };
  } });
  await runner.start();
  assert.equal(work, 1); assert.equal(review, 2); assert.equal(task.status, 'completed');
});

test('two malformed reviews quarantine gate without code or upstream repair', async () => {
  const run = newRun('protocol exhausted');
  const task = addTask(run, { title: 'work', spec: '', cmd: 'work', reviewCmd: 'review', reviewRounds: 3, maxAttempts: 4, repairRounds: 2 });
  let work = 0, reviews = 0;
  await new DagRunner(run, { executor: async (_task, _ctx, cmd) => {
    if (cmd === 'review') { reviews++; return { output: 'VERDICT: FAIL', exitCode: 0 }; }
    work++; return { output: 'candidate', exitCode: 0 };
  } }).start();
  assert.equal(work, 1); assert.equal(reviews, 2);
  assert.equal(task.failureKind, 'review-protocol'); assert.match(task.result!, /REVIEW_PROTOCOL_ERROR/);
  assert.equal(task.reviews, 0); assert.equal(task.repairs, 0);
});

test('lean reviewer source changes invalidate candidate acceptance', async () => {
  const repo = gitRepo(), run = newRun('read only review');
  run.settings.worktree = 'task'; run.settings.executionProfile = 'lean';
  const task = addTask(run, { title: 'work', spec: '', cmd: 'work', reviewCmd: 'review', reviewRounds: 2 });
  let workers = 0;
  await new DagRunner(run, { cwd: repo, executor: async (_task, ctx, cmd) => {
    if (cmd === 'review') { writeFileSync(join(ctx.cwd!, 'tracked.txt'), 'reviewer edit'); return { output: 'VERDICT: PASS', exitCode: 0 }; }
    workers++; writeFileSync(join(ctx.cwd!, 'tracked.txt'), 'worker candidate'); return { output: 'candidate', exitCode: 0 };
  } }).start();
  assert.equal(workers, 1); assert.equal(task.failureKind, 'review-protocol');
  assert.match(task.result!, /modified the candidate/);
  assert.equal(task.status, 'failed');
  assert.equal(run.events.some(event => event.type === 'task-done' && event.taskId === task.id), false);
  assert.ok(task.reviewSourceCommit);
  assert.equal(git(repo, ['show', `${task.reviewSourceCommit}:tracked.txt`]).stdout, 'worker candidate', 'the pre-review candidate remains recoverable');
});

test('lean review cannot bypass source isolation through a settings override', async () => {
  const run = newRun('isolation override'); run.settings.executionProfile = 'lean';
  run.settings.worktree = 'none';
  const task = addTask(run, { title: 'work', spec: '', cmd: 'work', reviewCmd: 'review' });
  let reviews = 0;
  await new DagRunner(run, { executor: async (_task, _ctx, cmd) => {
    if (cmd === 'review') reviews++;
    return { output: 'VERDICT: PASS', exitCode: 0 };
  } }).start();
  assert.equal(reviews, 0); assert.equal(task.failureKind, 'review-protocol');
  assert.match(task.result!, /isolated source workspace/);
});
