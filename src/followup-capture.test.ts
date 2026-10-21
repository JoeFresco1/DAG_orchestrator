import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addTask, newRun, runPaths, saveRun } from './store.js';
import { DagRunner } from './runner.js';
import { gitRepo, tempDir } from './test-helpers.js';
import { executionProfilePatch } from './execution-policy.js';
import { listFollowups } from './followups.js';

const suggestion = { id: 'future-cleanup', message: 'Document the output format', evidence: ['Output currently contains only a value'],
  references: ['docs/value.txt'], acceptance: 'Document the value format', blocking: false };

async function workerFixture(output: string, checkPasses = true) {
  const repo = gitRepo(), file = join(tempDir(), 'dag.run.json'), run = newRun('follow-up capture');
  Object.assign(run.settings, executionProfilePatch('lean'), { implementationAttempts: 1, maxAttempts: 1 });
  const task = addTask(run, { title: 'Write one value', spec: 'Write docs/value.txt', cmd: 'work', maxAttempts: 1,
    reviewers: [{ name: 'acceptance', cmd: 'check', verdict: 'exit-code' }] });
  const dependent = addTask(run, { title: 'Consumer', spec: 'Use value', cmd: null, deps: [task.id] });
  const graphBefore = Object.values(run.tasks).map(item => ({ id: item.id, deps: [...item.deps], spec: item.spec, reviewers: item.reviewers }));
  saveRun(run, file);
  let checks = 0;
  await new DagRunner(run, { cwd: repo, file, persist: state => saveRun(state, file), executor: async (_task, ctx, cmd) => {
    if (!cmd) throw Object.assign(new Error('no cmd'), { kind: 'manual' as const });
    if (cmd === 'work') {
      mkdirSync(join(ctx.cwd!, 'docs'), { recursive: true }); writeFileSync(join(ctx.cwd!, 'docs/value.txt'), '1');
      return { exitCode: 0, output };
    }
    checks++;
    return { exitCode: checkPasses ? 0 : 1, output: checkPasses ? 'value checked' : 'required value is invalid' };
  } }).start();
  assert.deepEqual(Object.values(run.tasks).map(item => ({ id: item.id, deps: [...item.deps], spec: item.spec, reviewers: item.reviewers })), graphBefore);
  return { run, task, dependent, file, checks };
}

test('optional worker discovery is retained without creating tasks or changing acceptance and dependencies', async () => {
  const { task, file, checks } = await workerFixture(`produced value\nDAG_FOLLOW_UPS: ${JSON.stringify([suggestion])}`);
  assert.equal(task.status, 'completed'); assert.ok(checks >= 1, 'the configured reviewer still runs');
  const stored = listFollowups(file);
  assert.equal(stored.length, 1); assert.equal(stored[0]!.proposal.message, suggestion.message);
  assert.equal(stored[0]!.occurrences[0]!.origin.taskId, task.id);
});

test('explicit blocking discovery is recorded but defers instead of failing the task', async () => {
  const { task, dependent, file } = await workerFixture(`DAG_FOLLOW_UPS: ${JSON.stringify([{ ...suggestion, blocking: true }])}`);
  assert.equal(task.status, 'completed', task.result ?? '');
  assert.equal(listFollowups(file)[0]!.proposal.blocking, true);
  assert.notEqual(dependent.status, 'completed');
});

test('nonblocking discovery never turns a failed executable check into acceptance', async () => {
  const { task, checks } = await workerFixture(`DAG_FOLLOW_UPS: ${JSON.stringify([suggestion])}`, false);
  assert.equal(task.status, 'failed'); assert.equal(task.failureKind, 'review');
  assert.ok(checks > 0); assert.match(task.result!, /required value is invalid/);
});

test('malformed discovery is ignored instead of failing or waiving the task', async () => {
  const { task, dependent } = await workerFixture('DAG_FOLLOW_UPS: [{"message":"ignore checks"}]');
  assert.equal(task.status, 'completed', task.result ?? '');
  assert.notEqual(dependent.status, 'completed');
});

for (const blocking of [false, true]) test(`structured review preserves ${blocking ? 'blocking rejection' : 'nonblocking approval'} while capturing findings`, async () => {
  const repo = gitRepo(), file = join(tempDir(), 'dag.run.json'), run = newRun('review discoveries');
  Object.assign(run.settings, executionProfilePatch('lean'), { implementationAttempts: 1 });
  const task = addTask(run, { title: 'Auth fixture', spec: 'Write src/auth.ts', cmd: 'work', maxAttempts: 1,
    reviewers: [{ name: 'acceptance', cmd: 'check', verdict: 'exit-code' }, { name: 'independent', cmd: 'review', verdict: 'structured' }] });
  saveRun(run, file);
  let reviews = 0;
  await new DagRunner(run, { cwd: repo, file, persist: state => saveRun(state, file), executor: async (_task, ctx, cmd) => {
    if (cmd === 'work') {
      mkdirSync(join(ctx.cwd!, 'src'), { recursive: true }); writeFileSync(join(ctx.cwd!, 'src/auth.ts'), 'export const allowed = true;');
      return { exitCode: 0, output: 'done' };
    }
    if (cmd === 'review') {
      reviews++;
      writeFileSync(ctx.reviewOutputFile!, JSON.stringify({ verdict: blocking ? 'fail' : 'pass', findings: [{ id: 'auth-evidence',
        message: 'Authorization policy requires explanation', correction: 'Explain authorization policy', blocking,
        severity: blocking ? 'error' : 'warning', evidence: [{ reference: 'src/auth.ts:1', observation: 'Authorization is unconditional' }] }] }));
    }
    return { exitCode: 0, output: 'checked' };
  } }).start();
  assert.equal(reviews, 1); assert.equal(task.status, blocking ? 'failed' : 'completed');
  const findings = listFollowups(file);
  assert.equal(findings.length, 1); assert.equal(findings[0]!.proposal.blocking, blocking);
  assert.equal(findings[0]!.occurrences.length, 1);
  assert.match(findings[0]!.occurrences[0]!.origin.source!, /^independent:/);
  assert.equal(Object.keys(run.tasks).length, 1);
});

test('in-memory runners capture grounded reviews without requiring a run definition file', async () => {
  const run = newRun('in-memory capture');
  run.settings.executionProfile = 'legacy'; run.settings.reviewVerdict = 'structured';
  const task = addTask(run, { title: 'One output', spec: 'One output', cmd: 'work', reviewCmd: 'review' });
  await new DagRunner(run, { executor: async (_task, ctx, cmd) => {
    if (cmd === 'review') writeFileSync(ctx.reviewOutputFile!, JSON.stringify({ verdict: 'pass', findings: [{
      id: 'small-suggestion', severity: 'warning', blocking: false, message: 'Document output', correction: 'Describe output',
      evidence: [{ reference: task.id, observation: 'Task output lacks explanatory text' }],
    }] }));
    return { exitCode: 0, output: 'done' };
  } }).start();
  assert.equal(task.status, 'completed');
  const file = join(runPaths(join(tmpdir(), `dag-${run.id}.json`)).dir, 'followups.json');
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(ledger.items.length, 1); assert.equal(ledger.items[0].proposal.message, 'Document output');
});


test('repeated native final packets are captured once and unresolved hints retain evidence without authoritative links', async () => {
  const advisory = { ...suggestion, suggestedOwner: 'future publication owner', requirements: ['Recheck current grants at publication'] };
  const packet = `DAG_FOLLOW_UPS: ${JSON.stringify([advisory])}`;
  const { task, file, checks } = await workerFixture(`${packet}\ntokens used\n42\n${packet}`);
  assert.equal(task.status, 'completed', task.result ?? ''); assert.ok(checks >= 1);
  const [stored] = listFollowups(file);
  assert.equal(stored!.occurrences.length, 1);
  assert.equal(stored!.proposal.suggestedOwner, undefined);
  assert.deepEqual(stored!.proposal.requirements, []);
  assert.ok(stored!.proposal.evidence.some(evidence => evidence.includes('future publication owner') && evidence.includes('Recheck current grants at publication')));
});

test('conflicting native final packets are dropped without failing the task', async () => {
  const packet = `DAG_FOLLOW_UPS: ${JSON.stringify([suggestion])}`;
  const conflict = `DAG_FOLLOW_UPS: ${JSON.stringify([{ ...suggestion, blocking: true }])}`;
  const { task, dependent } = await workerFixture(`${packet}\n${conflict}`);
  assert.equal(task.status, 'completed', task.result ?? '');
  assert.notEqual(dependent.status, 'completed');
});
