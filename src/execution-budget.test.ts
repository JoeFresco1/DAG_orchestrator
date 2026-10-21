import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { addTask, loadRun, newRun, readEventTail, renewTaskExecutionBudget, saveRun, retryTask } from './store.js';
import { budgetFor, budgetRemaining, renewExecutionDeadline } from './execution-budget.js';
import { DagRunner } from './runner.js';
import { tempDir } from './test-helpers.js';
import { retryCmd } from './commands/run.js';

test('shared ledger survives manual cycle retry, persistence and fallback chains', () => {
  const run = newRun('shared budget'); run.settings.executionProfile = 'lean';
  const task = addTask(run, { title: 'worker', spec: '', cmd: 'work' });
  const ledger = budgetFor(task, run.settings); ledger.used = 3;
  task.status = 'failed'; task.attempts = 3;
  const file = join(tempDir(), 'run.json'); saveRun(run, file);
  const resumed = loadRun(file); retryTask(resumed, task.id);
  assert.equal(resumed.tasks[task.id]!.attemptsInCycle, 0);
  assert.equal(resumed.tasks[task.id]!.executionBudget!.used, 3);
  assert.equal(budgetRemaining(resumed.tasks[task.id]!), false);
});

test('explicit deadline renewal extends stopped work without resetting lifetime attempts', () => {
  const run = newRun('renew deadline'); run.settings.executionProfile = 'lean'; run.settings.taskDeadlineMs = 60_000;
  const task = addTask(run, { title: 'worker', spec: '', cmd: 'work' });
  const budget = budgetFor(task, run.settings, 1_000);
  budget.used = 1;
  budget.deadlineAt = new Date(2_000).toISOString();
  const renewed = renewExecutionDeadline(task, run.settings, 5_000);
  assert.equal(renewed.previous, new Date(2_000).toISOString());
  assert.equal(renewed.next, new Date(65_000).toISOString());
  assert.equal(budget.used, 1);
  assert.equal(budget.limit, 3);
  assert.equal(budget.firstDispatchAt, new Date(1_000).toISOString());
  assert.equal(budgetRemaining(task, 5_001), true);
});

test('plan-amended pending task with a prior budget failure can renew its deadline', () => {
  const run = newRun('renew amended task'); run.settings.executionProfile = 'lean'; run.settings.taskDeadlineMs = 60_000;
  const task = addTask(run, { title: 'worker', spec: '', cmd: 'work' });
  const budget = budgetFor(task, run.settings, 1_000);
  task.status = 'pending'; task.failureKind = 'budget'; task.attempts = 1;
  budget.used = 1; budget.deadlineAt = new Date(2_000).toISOString();

  renewTaskExecutionBudget(run, task.id, 'Retry after stopped plan amendment', 5_000);

  assert.equal(budget.deadlineAt, new Date(65_000).toISOString());
  assert.equal(budget.used, 1);
  assert.equal(task.attempts, 1);
});

test('budget renewal after checkpoint recovery initializes from lifetime attempts', () => {
  const run = newRun('recovered task without ledger'); run.settings.executionProfile = 'lean'; run.settings.taskDeadlineMs = 60_000;
  const task = addTask(run, { title: 'worker', spec: '', cmd: 'work' });
  task.status = 'pending'; task.failureKind = 'interrupted'; task.attempts = 2;

  renewTaskExecutionBudget(run, task.id, 'Restore interrupted checkpoint work', 5_000);

  assert.equal(task.executionBudget!.used, 2);
  assert.equal(task.executionBudget!.limit, 3);
  assert.equal(task.executionBudget!.deadlineAt, new Date(65_000).toISOString());
});

test('pre-ledger task history is charged rather than resetting on lean migration', () => {
  const run = newRun('migration'); const task = addTask(run, { title: 'worker', spec: '', cmd: 'work' });
  task.attempts = 3; task.startedAt = new Date().toISOString();
  assert.equal(budgetFor(task, run.settings).used, 3); assert.equal(budgetRemaining(task), false);
});

test('CLI recovery grants only explicitly requested attempts and preserves the durable history', () => {
  const run = newRun('interrupted recovery'); run.settings.executionProfile = 'lean'; run.settings.implementationAttempts = 3;
  const task = addTask(run, { title: 'worker', spec: '', cmd: 'work' });
  const ledger = budgetFor(task, run.settings, 1_000);
  task.status = 'pending'; task.failureKind = 'interrupted'; task.attempts = 3;
  ledger.used = 3; ledger.deadlineAt = new Date(2_000).toISOString();
  ledger.infrastructureRetries.transport = 2;
  const file = join(tempDir(), 'run.json'); saveRun(run, file);
  const args = ['--file', file, '--id', task.id, '--renew-budget', '--reason', 'Supervisor crashed during transport recovery'];
  assert.throws(() => retryCmd(args), /exhausted/);
  assert.throws(() => retryCmd([...args, '--additional-attempts', '-1']), /must be a number >= 0/);
  assert.throws(() => retryCmd([...args, '--additional-attempts', '0.5']), /safe integer/);
  assert.equal(loadRun(file).tasks[task.id]!.executionBudget!.limit, 3);

  retryCmd([...args, '--additional-attempts', '1', '--json']);
  const resumed = loadRun(file), recovered = resumed.tasks[task.id]!;
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.attempts, 3);
  assert.equal(recovered.executionBudget!.used, 3);
  assert.equal(recovered.executionBudget!.limit, 4);
  assert.equal(recovered.executionBudget!.firstDispatchAt, ledger.firstDispatchAt);
  assert.deepEqual(recovered.executionBudget!.infrastructureRetries, ledger.infrastructureRetries);
  assert.equal(resumed.settings.implementationAttempts, 3);
  assert.equal(budgetRemaining(recovered), true);
  assert.ok(readEventTail(file).some(e => e.message?.includes('attempt limit 3 -> 4') && e.message.includes('Supervisor crashed')));
});

test('budget recovery rejects live or completed work and missing reasons without mutation', () => {
  const run = newRun('recovery controls');
  const task = addTask(run, { title: 'worker', spec: '', cmd: 'work' });
  const ledger = budgetFor(task, run.settings, 1_000); ledger.used = 3;
  const before = JSON.stringify(ledger);
  for (const status of ['running', 'completed'] as const) {
    task.status = status;
    assert.throws(() => renewTaskExecutionBudget(run, task.id, 'recovery', 5_000, 1), /must be stopped/);
  }
  task.status = 'failed';
  assert.throws(() => renewTaskExecutionBudget(run, task.id, ' ', 5_000, 1), /explicit --reason/);
  assert.equal(JSON.stringify(ledger), before);
});

test('identical failures with unchanged artifacts stop before exhausting retries', async () => {
  const run = newRun('identical failure'); run.settings.executionProfile = 'lean'; run.settings.infrastructureRetries = 0;
  run.settings.failOnNonZeroExit = true;
  const task = addTask(run, { title: 'worker', spec: '', cmd: 'work', maxAttempts: 20 });
  let calls = 0;
  await new DagRunner(run, { executor: async () => { calls++; return { exitCode: 1, output: 'same broken operation' }; } }).start();
  assert.equal(calls, 2); assert.equal(task.status, 'failed'); assert.equal(task.executionBudget!.used, 2);
});

test('task deadline kills the current child phase without resetting elapsed budget', async () => {
  const run = newRun('deadline'); run.settings.executionProfile = 'lean'; run.settings.taskDeadlineMs = 35;
  const task = addTask(run, { title: 'worker', spec: '', cmd: 'work' });
  let kills = 0;
  await new DagRunner(run, { executor: async (_task, ctx) => {
    ctx.registerKill(() => { kills++; }); return new Promise(() => {});
  } }).start();
  assert.equal(kills, 1); assert.equal(task.status, 'failed'); assert.equal(task.failureKind, 'budget');
  assert.equal(task.executionBudget!.used, 1);
});

test('expired resumed task never dispatches an obsolete implementation', async () => {
  const run = newRun('expired'); run.settings.executionProfile = 'lean';
  const task = addTask(run, { title: 'worker', spec: '', cmd: 'work' });
  budgetFor(task, run.settings).deadlineAt = new Date(Date.now() - 1000).toISOString();
  let calls = 0;
  await new DagRunner(run, { executor: async () => { calls++; return { exitCode: 0, output: '' }; } }).start();
  assert.equal(calls, 0); assert.equal(task.failureKind, 'budget');
});

test('controller handoff cannot acquire fresh budgets behind an ordinary shared ledger', async () => {
  const run = newRun('handoff'); run.settings.executionProfile = 'lean';
  const task = addTask(run, { title: 'worker', spec: '', cmd: 'work' });
  budgetFor(task, run.settings).used = 1;
  let calls = 0;
  await new DagRunner(run, { controllerManaged: true, executor: async () => { calls++; return { exitCode: 0, output: '' }; } }).start();
  assert.equal(calls, 0); assert.equal(task.failureKind, 'budget'); assert.equal(task.executionBudget!.used, 1);
});

test('changing to legacy policy does not bypass an already exhausted durable ledger', async () => {
  const run = newRun('policy switch');
  const task = addTask(run, { title: 'worker', spec: '', cmd: 'work' });
  budgetFor(task, run.settings).used = 3; run.settings.executionProfile = 'legacy';
  let calls = 0;
  await new DagRunner(run, { executor: async () => { calls++; return { exitCode: 0, output: '' }; } }).start();
  assert.equal(calls, 0); assert.equal(task.failureKind, 'budget'); assert.equal(task.executionBudget!.used, 3);
});
