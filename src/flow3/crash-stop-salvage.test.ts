import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { git } from '../git-worktree.js';
import type { Executor } from '../runner.js';
import { gitRepo } from '../test-helpers.js';
import { loadRun, saveRun } from '../store.js';
import { compileFlowPlan } from './graph.js';
import { FlowRunner } from './runner.js';

function fixture() {
  const repo = gitRepo();
  const file = join(repo, 'dag.run.json');
  const { run } = compileFlowPlan({
    version: 3,
    title: 'stop salvage',
    nodes: [{
      id: 'write',
      goal: 'Write an unverified file',
      depends_on: [],
      touches: ['work.txt'],
      creates: ['work.txt'],
      relies_on: [],
      cmd: 'write-work',
      verify: 'verify-work',
    }],
    settings: { waveChecks: [], finalChecks: [], repairRounds: 0 },
  });
  run.settings.finalReview = 'off';
  saveRun(run, file);
  return { repo, file, run };
}

function runner(f: ReturnType<typeof fixture>, executor: Executor) {
  return new FlowRunner(f.run, {
    cwd: f.repo,
    file: f.file,
    executor,
    persist: run => saveRun(run, f.file),
    stopGraceMs: 50,
  }, new Set());
}

test('stop preserves unverified source and recovery keeps it held until explicit reconciliation', async () => {
  const f = fixture();
  let workStarted!: () => void;
  const started = new Promise<void>(resolveStarted => { workStarted = resolveStarted; });
  let unblock!: () => void;
  const blocked = new Promise<void>(resolveBlocked => { unblock = resolveBlocked; });
  let killCalled = false;
  let workCalls = 0;
  const executor: Executor = async (_task, context, command) => {
    if (command === 'write-work') {
      workCalls++;
      writeFileSync(join(context.cwd!, 'work.txt'), 'exact unverified contents\n');
      context.registerKill(() => { killCalled = true; unblock(); });
      workStarted();
      await blocked;
      return { exitCode: 143, output: 'executor stopped' };
    }
    return { exitCode: 0, output: 'ok' };
  };

  const active = runner(f, executor);
  const running = active.start();
  await started;
  await active.stop();
  await running;

  assert.equal(killCalled, true, 'stop invokes the registered executor kill callback');
  const stoppedTask = f.run.tasks.write;
  assert.equal(stoppedTask.status, 'pending');
  assert.equal(stoppedTask.branch, null);
  assert.equal(stoppedTask.dispatchHistory?.at(-1)?.disposition, 'ambiguous');
  const workerPath = stoppedTask.nodeState?.worker;
  assert.ok(workerPath, 'the persisted task identifies the worker containing the edits');
  assert.equal(existsSync(join(workerPath, 'work.txt')), true);
  assert.equal(readFileSync(join(workerPath, 'work.txt'), 'utf8'), 'exact unverified contents\n');
  assert.equal(stoppedTask.failureKind, 'killed');
  assert.ok(stoppedTask.result?.includes(workerPath));
  const stoppedWorktrees = git(f.repo, ['worktree', 'list', '--porcelain']).stdout
    .split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length)));
  assert.ok(stoppedWorktrees.some(path => path.toLowerCase() === resolve(workerPath).toLowerCase()));

  // A fresh runner exercises the supported restart path. Ambiguous work stays
  // failed and held; it does not invoke the executor again or discard the path.
  const recoveredRun = loadRun(f.file);
  const recovered = runner({ ...f, run: recoveredRun }, executor);
  await recovered.start();
  const afterRecovery = loadRun(f.file).tasks.write;
  assert.deepEqual(recovered.result?.interrupted.ambiguous, ['write']);
  assert.equal(afterRecovery.status, 'failed');
  assert.equal(afterRecovery.failureKind, 'manual');
  assert.equal(afterRecovery.dispatchHistory?.at(-1)?.disposition, 'ambiguous');
  assert.equal(afterRecovery.nodeState?.worker, workerPath);
  assert.ok(afterRecovery.result?.includes(workerPath));
  assert.equal(readFileSync(join(workerPath, 'work.txt'), 'utf8'), 'exact unverified contents\n');
  assert.equal(workCalls, 1, 'recovery does not replay ambiguous work');
});

test('completed work still lands and successful worker worktrees are cleaned up', async () => {
  const f = fixture();
  const executor: Executor = async (_task, context, command) => {
    if (command === 'write-work') writeFileSync(join(context.cwd!, 'work.txt'), 'verified and landed\n');
    return { exitCode: 0, output: 'ok' };
  };

  const active = runner(f, executor);
  await active.start();

  const task = f.run.tasks.write;
  assert.equal(task.status, 'completed');
  assert.ok(task.branch);
  assert.ok(task.commit);
  assert.equal(git(f.repo, ['show', `dag/${f.run.id}:work.txt`]).stdout, 'verified and landed');
  assert.ok(task.nodeState?.worker);
  assert.equal(existsSync(task.nodeState.worker), false, 'the completed worker directory is removed');
  const worktrees = git(f.repo, ['worktree', 'list', '--porcelain']).stdout
    .split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length)));
  assert.deepEqual(worktrees.map(path => path.toLowerCase()), [resolve(f.repo).toLowerCase()]);
});
