import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, type PlanningManifest } from './contracts.js';
import { validatePlan } from './validation.js';
import { compilePlan } from './compile.js';

function plan(ids = ['task_a', 'task_b', 'task_c']): PlanningManifest {
  const check = { id: 'verify', program: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1000 };
  return { version: 2, id: 'admission', title: 'Admission', sources: [], requirements: [],
    criteria: ids.map(id => ({ id: `criterion-${id}`, text: `${id} works`, stage: 'local', owner: id, contributors: [id], checks: ['verify'] })),
    tasks: ids.map(id => ({ id, title: id, objective: `Implement ${id}`, reviewBoundary: `${id} only`, requirements: [],
      acceptance: [`criterion-${id}`], checks: [structuredClone(check)], cmd: 'worker',
      files: [{ path: `${id}.ts`, role: 'implementation' }] })) };
}

for (const length of [1, 2, 3]) test(`${length}-node dependency cycle explains every edge before compilation`, () => {
  const p = plan(['task_a', 'task_b', 'task_c'].slice(0, length));
  p.tasks.forEach((task, index) => {
    task.dependencies = [{ owner: p.tasks[(index + 1) % length]!.id, reason: `Needs output ${index}`, evidence: [`contract-${index}`] }];
  });
  const report = validatePlan(p), cycle = report.findings.find(f => f.rule === 'dependency.cycle')!;
  assert.equal(report.valid, false);
  assert.deepEqual(cycle.tasks, p.tasks.map(t => t.id));
  assert.deepEqual(cycle.references, [...p.tasks.map(t => t.id), p.tasks[0]!.id]);
  assert.deepEqual(cycle.evidence, p.tasks.map((task, index) =>
    `${task.id} -> ${p.tasks[(index + 1) % length]!.id}: Needs output ${index}; evidence: ["contract-${index}"]`));
  assert.match(cycle.message, length === 1 ? /Self-dependency cycle: task_a -> task_a/ : /Execution dependency cycle:/);
  assert.throws(() => compilePlan(p), /dependency\.cycle/);
});

test('inferred capability edges participate in concrete cycle diagnostics', () => {
  const p = plan(['task_a', 'task_b']);
  p.tasks.forEach((task, index) => {
    task.provides = [{ id: `cap-${index}`, contract: `Output ${index}`, check: task.checks[0]! }];
    task.inputs = [{ capability: `cap-${1 - index}`, contract: `Consume ${1 - index}` }];
  });
  const cycle = validatePlan(p).findings.find(f => f.rule === 'dependency.cycle')!;
  assert.deepEqual(cycle.references, ['task_a', 'task_b', 'task_a']);
  assert.match(cycle.evidence[0]!, /Requires capability cap-1/);
  assert.match(cycle.evidence[1]!, /Requires capability cap-0/);
});

test('ordinary producer inputs, composed acceptance and related files need no automatic semantic gate', () => {
  const p = plan(['task_a', 'task_b']);
  p.tasks[0]!.files = [{ path: 'a.ts', role: 'implementation', concern: 'Output a' },
    { path: 'a-helper.ts', role: 'implementation', concern: 'Output a' }];
  p.tasks[0]!.provides = [{ id: 'a', contract: 'Output a', interface: { id: 'a', version: '1' }, check: p.tasks[0]!.checks[0]! }];
  p.tasks[1]!.inputs = [{ capability: 'a', contract: 'Output a', interface: { id: 'a', version: '1' } }];
  p.criteria[1]!.stage = 'integration'; p.criteria[1]!.contributors = ['task_a', 'task_b'];
  for (const mode of [undefined, 'auto', 'off'] as const) {
    p.semanticReview = mode ? { mode } : undefined;
    assert.equal(validatePlan(p).valid, true);
    assert.equal(validatePlan(p).semanticRequired, false);
  }
  p.semanticReview = { mode: 'required' };
  assert.equal(validatePlan(p).semanticRequired, true);
  p.semanticReview = { mode: 'auto' }; p.tasks[1]!.inputs![0]!.interface!.version = '2';
  assert.equal(validatePlan(p).valid, false);
  assert.ok(validatePlan(p).findings.some(f => f.rule === 'interface.incompatible'));
});

test('one normalized graph retains multiple pinned specifications and detects cross-spec cycles', t => {
  const root = mkdtempSync(join(tmpdir(), 'dag-multi-spec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = plan(['task_a', 'task_b']);
  p.sources = ['a.md', 'b.md'].map(path => { writeFileSync(join(root, path), path); return { path, sha256: digest(path) }; });
  p.criteria.forEach((criterion, index) => { criterion.source = p.sources[index]!.path; });
  assert.equal(validatePlan(p, root).valid, true);
  p.tasks[0]!.dependencies = [{ owner: 'task_b', reason: 'Needs b specification output', evidence: ['b.md'] }];
  p.tasks[1]!.dependencies = [{ owner: 'task_a', reason: 'Needs a specification output', evidence: ['a.md'] }];
  const report = validatePlan(p, root);
  assert.equal(report.valid, false);
  assert.deepEqual(report.findings.find(f => f.rule === 'dependency.cycle')!.references, ['task_a', 'task_b', 'task_a']);
  writeFileSync(join(root, 'b.md'), 'changed');
  assert.ok(validatePlan(p, root).findings.some(f => f.rule === 'input.unavailable' && f.references.includes('b.md')));
});
