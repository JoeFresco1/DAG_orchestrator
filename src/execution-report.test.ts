import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executionReport } from './execution-report.js';
import { newRun, addTask, saveRun } from './store.js';
import type { PlanningManifest } from './planning/contracts.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fixture() {
  const run = newRun('Measured execution');
  const tasks = ['active', 'write', 'resource', 'held', 'consumer', 'gated', 'free'].map(name => addTask(run, { id: `task_${name}`, title: name, spec: '', cmd: 'worker' }));
  const [active, write, resource, held, consumer, gated, free] = tasks;
  active!.status = 'running'; consumer!.deps = [held!.id]; gated!.gate = { question: 'Approve?', options: [], approved: null };
  const manifest: PlanningManifest = { version: 2, id: 'plan', title: 'Plan', sources: [], criteria: [], requirements: [], capacities: { cpu: 1 },
    tasks: tasks.map(task => ({ id: task.id, title: task.title, objective: 'Implement', reviewBoundary: 'Behavior', requirements: [], acceptance: ['unused'],
      checks: [{ id: 'check', program: 'check', args: [], timeoutMs: 1000 }], files: [{ path: `${task.id}.ts`, role: 'implementation' }] })) };
  manifest.tasks[0]!.files = [{ path: 'src', role: 'implementation' }]; manifest.tasks[0]!.resources = { cpu: 1 };
  manifest.tasks[1]!.files = [{ path: 'src/new.ts', role: 'implementation' }]; manifest.tasks[2]!.resources = { cpu: 1 };
  run.planning = { manifest, revision: 'revision', definitions: {} };
  run.planningState = { revision: 'revision', evidence: {}, failures: {}, holds: { [held!.id]: [] } };
  return { run, active: active!, write: write!, resource: resource!, held: held!, consumer: consumer!, gated: gated!, free: free! };
}
test('execution report distinguishes dependencies, holds, ownership, resources, approval and slots without changing state', () => {
  const { run, write, resource, held, consumer, gated, free } = fixture(), before = JSON.stringify(run);
  const report = executionReport(run, { now: 0, concurrency: 2 });
  const codes = (id: string): string[] => report.waitReasons[id]!.map(r => r.code);
  assert.ok(codes(write.id).includes('write-conflict')); assert.ok(codes(resource.id).includes('resources'));
  assert.ok(codes(held.id).includes('planning-hold')); assert.ok(codes(consumer.id).includes('dependencies'));
  assert.ok(codes(consumer.id).includes('planning-hold')); assert.ok(codes(gated.id).includes('approval'));
  assert.deepEqual(report.launchableTaskIds, [free.id]); assert.equal(report.admissibleReadyWidth, 1); assert.equal(report.readySetWidth, 4);
  assert.ok(executionReport(run, { now: 0, concurrency: 1 }).waitReasons[free.id]!.some(r => r.code === 'concurrency'));
  assert.equal(JSON.stringify(run), before);
});
test('launchable width accounts for competition among otherwise ready tasks and exhausted durable budgets', () => {
  const { run, active, write, resource, held, free } = fixture(); active.status = 'completed'; run.planningState!.holds = {};
  run.tasks[resource.id]!.executionBudget = { version: 1, firstDispatchAt: new Date(0).toISOString(), deadlineAt: new Date(500).toISOString(),
    limit: 1, used: 1, infrastructureRetries: {} };
  run.planning!.manifest.tasks.find(t => t.id === held.id)!.files = [{ path: 'src/new.ts', role: 'implementation' }];
  const report = executionReport(run, { now: 1000, concurrency: 4 });
  assert.ok(report.launchableTaskIds.includes(write.id)); assert.ok(!report.launchableTaskIds.includes(held.id));
  assert.ok(report.launchableTaskIds.includes(free.id));
  assert.deepEqual(report.waitReasons[resource.id]!.map(r => r.code), ['implementation-budget', 'deadline']);
  assert.equal(executionReport(run, { now: 1000, scope: [free.id] }).launchableWidth, 1);
});
test('acceptance throughput measures registered criteria and complete requirements instead of task completions', () => {
  const run = newRun('Acceptance'), a = addTask(run, { id: 'task_a', title: 'a', spec: '', cmd: 'worker' }), b = addTask(run, { id: 'task_b', title: 'b', spec: '', cmd: 'worker' });
  a.status = 'completed'; a.attempts = 1; a.startedAt = new Date(0).toISOString(); a.finishedAt = new Date(3_600_000).toISOString();
  a.milestones = { implementedAt: new Date(1000).toISOString(), checkedAt: new Date(2000).toISOString(), reviewedAt: new Date(3000).toISOString(), integratedAt: new Date(4000).toISOString() };
  a.phaseHistory = [{ attempt: 1, phase: 'run', startedAt: new Date(0).toISOString(), finishedAt: new Date(1000).toISOString(), durationMs: 1000, outcome: 'pass' },
    { attempt: 1, phase: 'review', startedAt: new Date(2000).toISOString(), finishedAt: new Date(3000).toISOString(), durationMs: 1000, outcome: 'protocol' }];
  const criterion = (id: string, owner: string) => ({ id, text: id, stage: 'local' as const, owner, contributors: [owner], checks: ['check'] });
  run.planning = { revision: 'rev', definitions: {}, manifest: { version: 2, id: 'plan', title: 'Plan', sources: [], tasks: [],
    criteria: [criterion('a', a.id), criterion('b', b.id)], requirements: [{ id: 'one', title: 'One', description: 'One', acceptance: ['a'] },
      { id: 'combined', title: 'Combined', description: 'Both', acceptance: ['a', 'b'] }] } };
  run.planningState = { revision: 'rev', failures: {}, holds: {}, evidence: { a: { revision: 'rev', taskId: a.id, attempt: 1, checks: ['check'], sourceDigest: 'source' } } };
  const report = executionReport(run, { now: 3_600_000 });
  assert.equal(report.acceptance.criteria, 1); assert.equal(report.acceptance.requirements, 1);
  assert.equal(report.acceptance.criteriaPerHour, 1); assert.deepEqual(report.acceptance.missingCriteria, ['b']);
  assert.deepEqual(report.acceptance.missingRequirements, ['combined']); assert.equal(report.timeToFirstIntegratedMs, 4000);
  assert.equal(report.phases.run!.totalMs, 1000); assert.equal(report.phases.review!.outcomes.protocol, 1);
  assert.equal(report.milestones.integrated, 1);
  a.attempts = 2; assert.equal(executionReport(run, { now: 3_600_000 }).acceptance.criteria, 0);
});
test('published receipt reporting rejects stale attempts and status JSON preserves established summary fields', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-report-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = newRun('Receipts'), task = addTask(run, { id: 'task_a', title: 'a', spec: '', cmd: 'worker' }); task.attempts = 1;
  task.integrationReceipt = join(dir, 'receipt.json');
  const receipt = { version: 1, stage: 'published', taskId: task.id, runId: run.id, attempt: 1, attemptId: `${run.id}/${task.id}/1`, candidateCommit: 'a'.repeat(40), verification: { passed: true } };
  writeFileSync(task.integrationReceipt, JSON.stringify(receipt));
  assert.deepEqual(executionReport(run).integration.publishedReceiptTasks, [task.id]);
  writeFileSync(task.integrationReceipt, JSON.stringify({ ...receipt, attempt: 2 }));
  assert.equal(executionReport(run).integration.receiptErrors.length, 1);
  const file = join(dir, 'dag.run.json'); saveRun(run, file);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'status', '--file', file, '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
  for (const key of ['runId', 'rev', 'total', 'counts', 'ready', 'blocked', 'stuck', 'execution']) assert.ok(Object.hasOwn(data, key));
});
