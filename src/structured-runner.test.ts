import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addTask, newRun, loadRun, saveRun } from './store.js';
import { DagRunner } from './runner.js';
import { tempDir } from './test-helpers.js';
import { compilePlan } from './planning/compile.js';
import type { PlanningManifest } from './planning/contracts.js';

test('structured final artifact overrides transcript and protocol recovery preserves worker', async () => {
  const run = newRun('structured'); const file = join(tempDir(), 'run.json');
  run.settings.reviewVerdict = 'structured';
  const task = addTask(run, { title: 'work', spec: 'One output', cmd: 'work', reviewCmd: 'review', reviewRounds: 3 });
  let work = 0, reviews = 0, receiptDirectory = '';
  await new DagRunner(run, { file, persist: state => saveRun(state, file), executor: async (_task, ctx, cmd) => {
    if (cmd === 'review') {
      reviews++;
      assert.equal(loadRun(file).tasks[task.id]!.reviewProtocolAttempts![`${task.attempts}:review`], reviews);
      assert.ok(ctx.reviewSchemaFile);
      if (reviews === 2) { writeFileSync(ctx.reviewOutputFile!, JSON.stringify({ verdict: 'pass', findings: [] })); receiptDirectory = ctx.reviewOutputFile!.replace(/final\.txt$/, 'receipt.json'); }
      return { exitCode: 0, output: 'VERDICT: PASS\nmisleading transcript' };
    }
    work++; return { exitCode: 0, output: 'worker output' };
  } }).start();
  assert.equal(work, 1); assert.equal(reviews, 2); assert.equal(task.status, 'completed');
  const receipt = JSON.parse(readFileSync(receiptDirectory, 'utf8'));
  assert.equal(receipt.taskId, task.id); assert.equal(receipt.body.verdict, 'pass'); assert.ok(receipt.startedAt);
});

test('required final review missing artifact never regenerates accepted implementation', async () => {
  const run = newRun('final protocol'); run.settings.reviewVerdict = 'structured';
  run.settings.finalReview = 'run'; run.settings.finalReviewCmd = 'final'; run.settings.finalReviewRounds = 3;
  const task = addTask(run, { title: 'work', spec: '', cmd: 'work' });
  let workers = 0, reviews = 0;
  const runner = new DagRunner(run, { executor: async (_task, _ctx, cmd) => {
    if (cmd === 'final') { reviews++; return { exitCode: 0, output: 'VERDICT: PASS' }; }
    workers++; return { exitCode: 0, output: 'worker result' };
  } });
  await runner.start();
  assert.equal(workers, 1); assert.equal(reviews, 2); assert.equal(task.status, 'completed');
  assert.equal(runner.result!.finalReview!.verdict, 'error');
});

test('fabricated grounding is a protocol failure and never earns code redo', async () => {
  const run = newRun('bad grounding'); run.settings.reviewVerdict = 'structured';
  const task = addTask(run, { title: 'work', spec: '', cmd: 'work', reviewCmd: 'review', reviewRounds: 4 });
  let workers = 0;
  await new DagRunner(run, { executor: async (_task, ctx, cmd) => {
    if (cmd === 'review') {
      writeFileSync(ctx.reviewOutputFile!, JSON.stringify({ verdict: 'fail', findings: [{ id: 'bad', severity: 'error', blocking: true,
        message: 'invented requirement', correction: 'rewrite everything', evidence: [{ reference: 'invented', observation: 'unsupported' }] }] }));
      return { exitCode: 0, output: '' };
    }
    workers++; return { exitCode: 0, output: 'work' };
  } }).start();
  assert.equal(workers, 1); assert.equal(task.failureKind, 'review-protocol');
});

test('a local reviewer cannot reject its task against a future verification criterion', async () => {
  const root = tempDir();
  const plan: PlanningManifest = { version: 2, id: 'ownership', title: 'Ownership', sources: [], requirements: [],
    criteria: ['a', 'b'].map(id => ({ id: `criterion_${id}`, text: `${id} output`, stage: id === 'a' ? 'local' : 'final', owner: `task_${id}`,
      contributors: [`task_${id}`], checks: [`check_${id}`] })),
    tasks: ['a', 'b'].map(id => ({ id: `task_${id}`, title: id, objective: `Produce ${id}`, reviewBoundary: `${id} file`, requirements: [],
      acceptance: [`criterion_${id}`], files: [{ path: `${id}.txt`, role: 'implementation' }], cmd: `work-${id}`,
      checks: [{ id: `check_${id}`, program: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1000 }],
      ...(id === 'a' ? { reviewCmd: 'review' } : { dependencies: [{ owner: 'task_a', reason: 'Consumes a output', evidence: ['a.txt'] }] }) })) };
  const run = compilePlan(plan); run.settings.reviewVerdict = 'structured';
  let workers = 0;
  await new DagRunner(run, { cwd: root, executor: async (_task, ctx, cmd) => {
    if (cmd === 'review') {
      writeFileSync(ctx.reviewOutputFile!, JSON.stringify({ verdict: 'fail', findings: [{ id: 'future', severity: 'error', blocking: true,
        message: 'Future output missing', correction: 'Implement b prematurely', evidence: [{ reference: 'criterion_b', observation: 'b absent' }] }] }));
      return { exitCode: 0, output: '' };
    }
    if (cmd?.startsWith('work')) { workers++; writeFileSync(join(root, 'a.txt'), 'a'); }
    return { exitCode: 0, output: 'checked' };
  } }).start();
  assert.equal(workers, 1); assert.equal(run.tasks.task_a.failureKind, 'review-protocol');
  assert.equal(run.tasks.task_b.attempts, 0);
});

test('nonzero structured adapter exits with no report stay reviewer-only failures', async () => {
  const run = newRun('provider failure'); run.settings.reviewVerdict = 'structured';
  const task = addTask(run, { title: 'work', spec: '', cmd: 'work', reviewCmd: 'review', reviewRounds: 3 });
  let workers = 0, reviews = 0;
  await new DagRunner(run, { executor: async (_task, _ctx, cmd) => {
    if (cmd === 'review') { reviews++; return { exitCode: 1, output: 'provider failed before producing report' }; }
    workers++; return { exitCode: 0, output: 'candidate' };
  } }).start();
  assert.equal(workers, 1); assert.equal(reviews, 2); assert.equal(task.failureKind, 'review-protocol');
});
