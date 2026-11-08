import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { attemptLogPath, loadRun, retryTask, saveRun } from '../store.js';
import { git } from '../git-worktree.js';
import { DagRunner, type Executor } from '../runner.js';
import { gitRepo } from '../test-helpers.js';
import { compileFlowPlan } from './graph.js';
import type { DispatchRecord } from '../types.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const node = {
  id: 'a',
  goal: 'Write the recovery fixture output',
  depends_on: [],
  touches: ['work-ran.txt'],
  creates: ['work-ran.txt'],
  relies_on: [],
  cmd: `node -e "require('fs').writeFileSync('work-ran.txt','yes')"`,
  verify: 'node -e "process.exit(0)"',
};

function fixture(title: string) {
  const repo = gitRepo();
  const file = join(repo, 'dag.run.json');
  const { run } = compileFlowPlan({
    version: 3,
    title,
    nodes: [node],
    settings: {
      waveChecks: ['node -e "process.exit(0)"'],
      finalChecks: ['node -e "process.exit(0)"'],
      repairRounds: 0,
    },
  });
  run.settings.finalReview = 'off';
  saveRun(run, file);
  return { repo, file, run };
}

function cli(file: string, command: 'resume' | 'run', ...args: string[]) {
  const entry = resolve(process.cwd(), 'dist/cli.js');
  const result = spawnSync(process.execPath, [entry, command, '--file', file, ...args, '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test('resume holds captured work without a candidate until explicit reconciliation', () => {
  const f = fixture('captured work crash recovery');
  const workerPath = join(f.repo, 'saved-worker');
  mkdirSync(workerPath);
  writeFileSync(join(workerPath, 'partial.txt'), 'preserved worker output\n');

  const task = f.run.tasks.a;
  task.status = 'running';
  task.attempts = 4;
  task.attemptsInCycle = 1;
  task.startedAt = '2026-11-08T00:00:00.000Z';
  task.nodeState = { ...task.nodeState, worker: workerPath };
  const captured: DispatchRecord = {
    attempt: 4,
    attemptId: 'attempt-captured-before-candidate',
    phase: 'work',
    commandDigest: digest(node.cmd),
    disposition: 'captured',
    createdAt: '2026-11-08T00:00:00.000Z',
    dispatchedAt: '2026-11-08T00:00:01.000Z',
    terminalAt: '2026-11-08T00:00:02.000Z',
    exitCode: 0,
    outputDigest: digest('captured work output'),
  };
  task.dispatchHistory = [captured];
  saveRun(f.run, f.file);

  const resumed = cli(f.file, 'resume');
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.deepEqual(JSON.parse(resumed.stdout).requeued, []);
  assert.deepEqual(JSON.parse(resumed.stdout).ambiguous, ['a']);

  let recovered = loadRun(f.file);
  assert.equal(recovered.tasks.a.status, 'failed');
  assert.equal(recovered.tasks.a.failureKind, 'manual');
  assert.equal(recovered.tasks.a.attempts, 4);
  assert.equal(recovered.tasks.a.attemptsInCycle, 1);
  assert.equal(recovered.tasks.a.nodeState?.candidate, undefined);
  assert.equal(recovered.tasks.a.nodeState?.worker, workerPath);
  assert.deepEqual(recovered.tasks.a.dispatchHistory?.[0], captured);
  assert.match(recovered.tasks.a.result ?? '', /captured, but no verified candidate was saved/);
  assert.match(recovered.tasks.a.result ?? '', /dag resume --resolve-ambiguous a/);
  assert.equal(readFileSync(join(workerPath, 'partial.txt'), 'utf8'), 'preserved worker output\n');

  // The normal run command must keep the held task from invoking the worker.
  cli(f.file, 'run');
  recovered = loadRun(f.file);
  assert.equal(recovered.tasks.a.status, 'failed');
  assert.equal(recovered.tasks.a.attempts, 4);
  assert.deepEqual(recovered.tasks.a.dispatchHistory?.[0], captured);

  const resolution = cli(f.file, 'resume', '--resolve-ambiguous', 'a', '--resolution', 'safe-to-repeat',
    '--reason', 'operator confirmed the command can be repeated');
  assert.equal(resolution.status, 0, resolution.stderr || resolution.stdout);
  assert.deepEqual(JSON.parse(resolution.stdout).resolved, ['a']);
  recovered = loadRun(f.file);
  assert.equal(recovered.tasks.a.status, 'pending');
  assert.equal(recovered.tasks.a.dispatchHistory?.[0].disposition, 'resolved');
  assert.equal(recovered.tasks.a.dispatchHistory?.[0].terminalAt, captured.terminalAt);
  assert.equal(recovered.tasks.a.dispatchHistory?.[0].exitCode, captured.exitCode);
  assert.equal(recovered.tasks.a.dispatchHistory?.[0].outputDigest, captured.outputDigest);

  const rerun = cli(f.file, 'run');
  assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
  recovered = loadRun(f.file);
  assert.equal(recovered.tasks.a.status, 'completed');
  assert.equal(recovered.tasks.a.attempts, 5);
  assert.equal(recovered.tasks.a.dispatchHistory?.[0].disposition, 'resolved');
  assert.equal(recovered.tasks.a.dispatchHistory?.[1].disposition, 'captured');
});

test('resume safely requeues a pre-dispatch attempt and run executes it', () => {
  const f = fixture('pre-dispatch recovery control');
  const task = f.run.tasks.a;
  task.status = 'running';
  task.attempts = 2;
  task.attemptsInCycle = 1;
  task.dispatchHistory = [{
    attempt: 2,
    attemptId: 'attempt-not-dispatched',
    phase: 'work',
    disposition: 'not-dispatched',
    createdAt: '2026-11-08T00:00:00.000Z',
  }];
  saveRun(f.run, f.file);

  const resumed = cli(f.file, 'resume');
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.deepEqual(JSON.parse(resumed.stdout).requeued, ['a']);
  assert.deepEqual(JSON.parse(resumed.stdout).ambiguous, []);
  assert.equal(loadRun(f.file).tasks.a.status, 'pending');

  const executed = cli(f.file, 'run');
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const recovered = loadRun(f.file);
  assert.equal(recovered.tasks.a.status, 'completed');
  assert.equal(recovered.tasks.a.dispatchHistory?.[0].disposition, 'not-dispatched');
  assert.equal(recovered.tasks.a.dispatchHistory?.[1].disposition, 'captured');
});

test('resume requeues captured non-zero work as a known failure, not ambiguous crash success', () => {
  const f = fixture('captured known failure recovery');
  const task = f.run.tasks.a;
  task.status = 'running';
  task.attempts = 1;
  task.attemptsInCycle = 1;
  task.dispatchHistory = [{
    attempt: 1,
    attemptId: 'attempt-known-failure',
    phase: 'work',
    disposition: 'captured',
    createdAt: '2026-11-08T00:00:00.000Z',
    dispatchedAt: '2026-11-08T00:00:01.000Z',
    terminalAt: '2026-11-08T00:00:02.000Z',
    exitCode: 23,
    outputDigest: digest('known failure'),
  }];
  saveRun(f.run, f.file);

  const resumed = cli(f.file, 'resume');
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.deepEqual(JSON.parse(resumed.stdout).requeued, ['a']);
  assert.deepEqual(JSON.parse(resumed.stdout).ambiguous, []);
  const recovered = loadRun(f.file).tasks.a;
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.failureKind, 'interrupted');
  assert.equal(recovered.dispatchHistory?.[0].disposition, 'captured');
  assert.equal(recovered.dispatchHistory?.[0].exitCode, 23);
});

test('a live command with a captured failing exit is salvaged and remains retryable', () => {
  const f = fixture('captured known failure salvage');
  f.run.tasks.a.cmd = `node -e "require('fs').writeFileSync('failed-output.txt','preserved');process.stdout.write('preserved');process.exit(23)"`;
  saveRun(f.run, f.file);

  const failed = cli(f.file, 'run', '--retries', '0');
  assert.notEqual(failed.status, 0, failed.stderr || failed.stdout);

  const recovered = loadRun(f.file);
  const task = recovered.tasks.a;
  const dispatch = task.dispatchHistory?.at(-1);
  assert.equal(task.status, 'failed');
  assert.equal(task.failureKind, 'exit');
  assert.equal(task.exitCode, 23);
  assert.equal(dispatch?.disposition, 'captured');
  assert.equal(dispatch?.exitCode, 23);
  assert.ok(task.branch?.startsWith(`dag-failed/${recovered.id}-a-`));
  assert.equal(git(f.repo, ['show-ref', '--verify', `refs/heads/${task.branch}`]).code, 0);
  assert.equal(git(f.repo, ['show', `${task.branch}:failed-output.txt`]).stdout, 'preserved');
  assert.ok(readFileSync(attemptLogPath(f.file, 'a', task.attempts), 'utf8').includes('preserved'));

  assert.deepEqual(retryTask(recovered, 'a'), ['a']);
  assert.equal(task.status, 'pending');
  assert.equal(task.dispatchHistory?.at(-1)?.disposition, 'captured');
});

test('a rejected repair keeps its repair hold instead of becoming captured-work ambiguity', async () => {
  const f = fixture('captured rejected repair');
  f.run.tasks.a.cmd = 'work';
  f.run.tasks.a.node!.verify = 'verify-a';
  saveRun(f.run, f.file);
  f.run.settings.flow3 = { ...f.run.settings.flow3, nodeRepairRounds: 1, repairCommand: 'repair' };
  let works = 0;
  let repairs = 0;
  const execute: Executor = async (_task, ctx, command) => {
    if (command === 'work') {
      works++;
      writeFileSync(join(ctx.cwd!, 'work-ran.txt'), 'before repair');
    }
    if (command === 'verify-a') return { exitCode: 1, output: 'AssertionError: contract defect' };
    if (command === 'repair') repairs++;
    return { exitCode: 0, output: 'ok' };
  };
  const run = () => new DagRunner(f.run, { cwd: f.repo, file: f.file, executor: execute, persist: state => saveRun(state, f.file) });

  await run().start();
  assert.equal(f.run.tasks.a.status, 'failed');
  assert.equal(f.run.tasks.a.dispatchHistory?.filter(record => record.disposition === 'captured').length, 2);
  assert.ok(f.run.tasks.a.nodeState?.repairContext);
  assert.ok(f.run.tasks.a.nodeState?.decision);

  retryTask(f.run, 'a');
  await run().start();
  assert.equal(works, 1);
  assert.equal(repairs, 1);
  assert.match(f.run.tasks.a.result ?? '', /cannot switch to implementation/);
  assert.doesNotMatch(f.run.tasks.a.result ?? '', /ambiguous external work/);
});
