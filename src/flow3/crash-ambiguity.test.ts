import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { DagRunner, type Executor } from '../runner.js';
import { gitRepo } from '../test-helpers.js';
import { loadRun, retryTask, saveRun } from '../store.js';
import { compileFlowPlan } from './graph.js';
import type { FlowNode } from './contracts.js';

const ok = { exitCode: 0, output: 'ok' };
const node = (id: string): FlowNode => ({
  id,
  goal: `Implement ${id}`,
  depends_on: [],
  touches: [`${id}.txt`],
  creates: [],
  relies_on: [],
  cmd: 'work',
  verify: `verify-${id}`,
});

function fixture() {
  const repo = gitRepo();
  const file = join(repo, 'dag.run.json');
  const { run } = compileFlowPlan({
    version: 3,
    title: 'crash ambiguity',
    nodes: [node('a')],
    settings: { waveChecks: ['wave'], finalChecks: ['full'], repairRounds: 0 },
  });
  run.flowState ??= { version: 3, repairRound: 0, checkpoints: [], issues: [] };
  run.flowState.reservedCents = 125;
  return { repo, file, run };
}

function resume(file: string, ...args: string[]) {
  const cli = resolve(process.cwd(), 'src/cli.ts');
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'resume', '--file', file, ...args, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as { requeued: string[]; ambiguous?: string[]; resolved?: string[] };
}

function recoveredRunner(f: ReturnType<typeof fixture>, executor: Executor) {
  return new DagRunner(f.run, { cwd: f.repo, file: f.file, executor, persist: run => saveRun(run, f.file) });
}

test('resume requeues a pre-dispatch attempt and keeps its charged attempt and budget history', async () => {
  const f = fixture();
  const task = f.run.tasks.a;
  task.status = 'running';
  task.attempts = 7;
  task.attemptsInCycle = 1;
  task.pid = 24680;
  task.dispatchHistory = [{
    attempt: 7,
    attemptId: 'attempt-before-dispatch',
    disposition: 'not-dispatched',
    createdAt: '2026-11-08T00:00:00.000Z',
  }];
  saveRun(f.run, f.file);

  const report = resume(f.file);
  assert.deepEqual(report.requeued, ['a']);
  assert.deepEqual(report.ambiguous, []);
  const recovered = loadRun(f.file);
  assert.equal(recovered.tasks.a.status, 'pending');
  assert.equal(recovered.tasks.a.attempts, 7);
  assert.equal(recovered.tasks.a.attemptsInCycle, 1);
  assert.equal(recovered.flowState?.reservedCents, 125);

  const calls: string[] = [];
  const runner = recoveredRunner({ ...f, run: recovered }, async (_task, _ctx, cmd) => {
    if (cmd === 'work') calls.push(cmd);
    return ok;
  });
  await runner.start();
  assert.deepEqual(calls, ['work']);
  assert.equal(recovered.tasks.a.status, 'completed');
  assert.equal(recovered.tasks.a.attempts, 8);
  assert.equal(recovered.tasks.a.attemptsInCycle, 2);
  assert.equal(recovered.flowState?.reservedCents, 125);
});

test('a dispatched work command without a captured outcome is not retried automatically', async () => {
  const f = fixture();
  f.run.tasks.a.maxAttempts = 4;
  let workCalls = 0;
  let attemptId: string | undefined;
  const runner = recoveredRunner(f, async (_task, ctx, cmd) => {
    if (cmd === 'work') {
      workCalls++;
      attemptId = ctx.env?.DAG_ATTEMPT_ID;
      throw new Error('connection ended after request dispatch');
    }
    return ok;
  });

  await runner.start();
  const task = f.run.tasks.a;
  const dispatch = task.dispatchHistory?.at(-1);
  assert.equal(workCalls, 1);
  assert.equal(task.status, 'failed');
  assert.equal(task.failureKind, 'manual');
  assert.equal(task.attempts, 1);
  assert.equal(task.attemptsInCycle, 1);
  assert.equal(dispatch?.disposition, 'ambiguous');
  assert.equal(dispatch?.attemptId, attemptId);
  assert.ok(dispatch?.dispatchedAt);
  assert.match(dispatch?.commandDigest ?? '', /^[a-f0-9]{64}$/);
});

test('legacy interrupted Flow 3 attempts without dispatch records fail closed as ambiguous', () => {
  const f = fixture();
  const task = f.run.tasks.a;
  task.status = 'running';
  task.attempts = 2;
  task.attemptsInCycle = 1;
  task.startedAt = '2026-11-08T00:00:00.000Z';
  saveRun(f.run, f.file);

  const report = resume(f.file);
  assert.deepEqual(report.requeued, []);
  assert.deepEqual(report.ambiguous, ['a']);
  const recovered = loadRun(f.file);
  assert.equal(recovered.tasks.a.status, 'failed');
  assert.equal(recovered.tasks.a.attempts, 2);
  assert.equal(recovered.tasks.a.attemptsInCycle, 1);
  assert.equal(recovered.tasks.a.dispatchHistory?.[0].recoveredAsAmbiguous, 'legacy-missing-dispatch-record');
});

test('ambiguous dispatched work is held by resume and only reruns after an audited resolution', async () => {
  const f = fixture();
  const task = f.run.tasks.a;
  task.status = 'running';
  task.attempts = 4;
  task.attemptsInCycle = 1;
  task.pid = 13579;
  task.dispatchHistory = [{
    attempt: 4,
    attemptId: 'attempt-dispatched',
    commandDigest: 'abc123',
    disposition: 'ambiguous',
    createdAt: '2026-11-08T00:00:00.000Z',
    dispatchedAt: '2026-11-08T00:00:01.000Z',
  }];
  saveRun(f.run, f.file);

  const report = resume(f.file);
  assert.deepEqual(report.requeued, []);
  assert.deepEqual(report.ambiguous, ['a']);
  let recovered = loadRun(f.file);
  assert.equal(recovered.tasks.a.status, 'failed');
  assert.equal(recovered.tasks.a.failureKind, 'manual');
  assert.equal(recovered.tasks.a.attempts, 4);
  assert.equal(recovered.tasks.a.attemptsInCycle, 1);
  assert.equal(recovered.flowState?.reservedCents, 125);
  assert.throws(() => retryTask(recovered, 'a'), /resolve it with dag resume/);

  const commands: string[] = [];
  await recoveredRunner({ ...f, run: recovered }, async (_task, _ctx, cmd) => {
    commands.push(cmd ?? '');
    return ok;
  }).start();
  assert.equal(commands.includes('work'), false, 'FlowRunner startup must not dispatch unresolved work');
  assert.equal(recovered.tasks.a.status, 'failed');
  assert.equal(recovered.tasks.a.attempts, 4);

  const resolved = resume(f.file, '--resolve-ambiguous', 'a', '--resolution', 'safe-to-repeat', '--reason', 'confirmed the operation can be safely repeated');
  assert.deepEqual(resolved.resolved, ['a']);
  assert.deepEqual(resolved.ambiguous, []);
  recovered = loadRun(f.file);
  assert.equal(recovered.tasks.a.status, 'pending');
  assert.equal(recovered.tasks.a.attempts, 4);
  assert.equal(recovered.tasks.a.attemptsInCycle, 1);
  assert.equal(recovered.tasks.a.dispatchHistory?.[0].disposition, 'resolved');
  assert.equal(recovered.tasks.a.dispatchHistory?.[0].resolution, 'safe-to-repeat');
  assert.match(recovered.tasks.a.dispatchHistory?.[0].resolutionReason ?? '', /confirmed/);
  assert.equal(recovered.flowState?.reservedCents, 125);

  let workCalls = 0;
  await recoveredRunner({ ...f, run: recovered }, async (_task, _ctx, cmd) => {
    if (cmd === 'work') workCalls++;
    return ok;
  }).start();
  assert.equal(workCalls, 1);
  assert.equal(recovered.tasks.a.status, 'completed');
  assert.equal(recovered.tasks.a.attempts, 5);
  assert.equal(recovered.tasks.a.attemptsInCycle, 2);
  assert.equal(recovered.tasks.a.dispatchHistory?.[0].disposition, 'resolved');
  assert.equal(recovered.tasks.a.dispatchHistory?.[1].disposition, 'captured');
  assert.match(recovered.tasks.a.dispatchHistory?.[1].outputDigest ?? '', /^[a-f0-9]{64}$/);
  assert.equal(recovered.flowState?.reservedCents, 125);
});
