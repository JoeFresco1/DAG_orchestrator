import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan } from './compile.js';
import { validatePlan } from './validation.js';
import { DEFAULT_SIZING, outputConcerns, sizingBudget, taskBrief, taskSize } from './sizing.js';
import { fixture } from './planning.test.js';
import type { PlanningManifest } from './contracts.js';
import { assertPlanningRequirementsPreserved } from './contracts.js';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function oversize(p: PlanningManifest, chars: number): void {
  p.tasks[0]!.objective = 'x'.repeat(chars);
}

test('the documented default budget is small enough to force splitting', () => {
  assert.deepEqual(DEFAULT_SIZING, { maxSpecChars: 800, maxAcceptancePerTask: 2, maxOutputConcerns: 1 });
});

test('an ordinary bounded task carries no sizing findings', () => {
  const p = fixture();
  assert.equal(validatePlan(p).valid, true);
  assert.ok(taskSize(p, p.tasks[0]!).chars <= 800);
  assert.ok(taskBrief(p.tasks[0]!, p).includes('Implement callable runtime'));
});

test('a 2600 character brief is rejected with the exact measurement and a split correction', () => {
  const p = fixture(); oversize(p, 2600);
  const finding = validatePlan(p).findings.find(f => f.rule === 'scope.oversized')!;
  assert.ok(finding); assert.equal(finding.blocking, true); assert.deepEqual(finding.tasks, ['task_runtime']);
  assert.match(finding.message, /26\d\d characters, over the 800 character budget/);
  assert.match(finding.correction, /Split this task/);
  assert.ok(finding.evidence.some(e => e.startsWith('brief characters: ')));
  assert.throws(() => compilePlan(p), /scope\.oversized/);
});

test('fourteen acceptance criteria on one task are rejected before ownership is reasoned about', () => {
  const p = fixture();
  for (let i = 0; i < 13; i++) {
    const id = `extra-${i}`;
    p.criteria.push({ id, text: `Extra criterion ${i}`, stage: 'local', owner: 'task_runtime', contributors: ['task_runtime'], checks: ['runtime'] });
    p.tasks[0]!.acceptance.push(id);
  }
  const finding = validatePlan(p).findings.find(f => f.rule === 'scope.acceptance')!;
  assert.ok(finding); assert.equal(finding.blocking, true);
  assert.match(finding.message, /owns 14 acceptance criteria, over the 2 criteria budget/);
  assert.equal(finding.references.length, 14);
});

test('two owned output concerns are rejected; test files are verification, not outputs', () => {
  const p = fixture();
  p.tasks[0]!.files!.push({ path: 'runtime-extra.ts', role: 'implementation' }, { path: 'runtime.test.ts', role: 'test' });
  const finding = validatePlan(p).findings.find(f => f.rule === 'scope.concerns')!;
  assert.ok(finding); assert.deepEqual(finding.references, ['runtime.ts', 'runtime-extra.ts']);
  assert.deepEqual(outputConcerns(p.tasks[0]!), ['runtime.ts', 'runtime-extra.ts']);
  assert.match(finding.message, /owns 2 output concerns, over the 1 concern budget/);
  p.tasks[0]!.files = [{ path: 'runtime.ts', role: 'implementation' }, { path: 'runtime.test.ts', role: 'test' }];
  assert.ok(validatePlan(p).findings.every(f => f.rule !== 'scope.concerns'));
});

test('a plan can declare its own budget and malformed budgets fail closed', () => {
  const p = fixture(); oversize(p, 2600);
  assert.ok(validatePlan(p).valid === false);
  p.sizing = { maxSpecChars: 4000 };
  assert.equal(validatePlan(p).valid, true);
  assert.equal(sizingBudget(p).maxSpecChars, 4000);
  assert.equal(sizingBudget(p).maxAcceptancePerTask, DEFAULT_SIZING.maxAcceptancePerTask);
  assert.equal(validatePlan({ ...p, sizing: { maxSpecChars: 0 } }).valid, false);
  assert.equal(validatePlan({ ...p, sizing: { maxOutputConcerns: -1 } }).valid, false);
  assert.equal(validatePlan({ ...p, sizing: { maxSpecChars: 1.5 } }).valid, false);
});

test('exact 800-character and two-criterion boundaries pass; one more fails', () => {
  const p = fixture(), task = p.tasks[0]!;
  p.criteria.push({ id: 'second', text: 'Second case works', stage: 'local', owner: task.id, contributors: [task.id], checks: ['runtime'] });
  task.acceptance.push('second');
  task.objective = 'x'.repeat(800 - taskSize(p, task).chars + task.objective.length);
  assert.equal(taskSize(p, task).chars, 800);
  assert.equal(validatePlan(p).valid, true);
  task.objective += 'x';
  assert.ok(validatePlan(p).findings.some(f => f.rule === 'scope.oversized'));
  task.objective = 'Runtime';
  p.criteria.push({ id: 'third', text: 'Third case works', stage: 'local', owner: task.id, contributors: [task.id], checks: ['runtime'] });
  task.acceptance.push('third');
  assert.ok(validatePlan(p).findings.some(f => f.rule === 'scope.acceptance'));
  assert.throws(() => compilePlan(p), /scope.acceptance/);
});

test('long input/output contracts cannot bypass the brief budget', () => {
  for (const kind of ['input', 'output'] as const) {
    const p = fixture();
    if (kind === 'input') p.tasks[1]!.inputs![0]!.contract = 'x'.repeat(801);
    else p.tasks[0]!.provides![0]!.contract = 'x'.repeat(801);
    assert.ok(validatePlan(p).findings.some(f => f.rule === 'scope.oversized'));
    assert.throws(() => compilePlan(p), /scope.oversized/);
  }
});

test('related output files share one concern; independent outputs still block compilation', () => {
  const p = fixture(), task = p.tasks[0]!;
  task.files![0]!.concern = 'Callable runtime';
  task.files!.push({ path: 'runtime-helper.ts', role: 'implementation', concern: 'Callable runtime' },
    { path: 'runtime.test.ts', role: 'test' });
  assert.deepEqual(outputConcerns(task), ['Callable runtime']);
  assert.equal(validatePlan(p).valid, true);
  // Related files alone do not require exceptional semantic review.
  const standalone = structuredClone(p);
  standalone.tasks = [standalone.tasks[0]!]; standalone.tasks[0]!.requirements = [];
  standalone.criteria = standalone.criteria.filter(c => c.owner === task.id).map(c => ({ ...c, requirement: undefined }));
  standalone.requirements = []; standalone.semanticReview = { mode: 'auto' };
  assert.equal(validatePlan(standalone).valid, true);
  assert.equal(validatePlan(standalone).semanticRequired, false);
  task.files!.push({ path: 'cache.ts', role: 'generated', concern: 'Cache storage' });
  const finding = validatePlan(p).findings.find(f => f.rule === 'scope.concerns')!;
  assert.deepEqual(finding.references, ['runtime.ts', 'runtime-helper.ts', 'cache.ts']);
  assert.throws(() => compilePlan(p), /scope.concerns/);
  for (const concern of ['', ' ', null, 42]) {
    const malformed = structuredClone(p);
    (malformed.tasks[0]!.files![0] as unknown as { concern: unknown }).concern = concern;
    assert.ok(validatePlan(malformed).findings.some(f => f.rule === 'contract.invalid'));
  }
  task.files!.find(f => f.role === 'test')!.concern = 'Hidden output';
  assert.ok(validatePlan(p).findings.some(f => f.rule === 'contract.invalid'));
});

test('fifty small tasks compile without a task-count cap', () => {
  const p: PlanningManifest = { version: 2, id: 'many-small', title: 'Many small behaviors', sources: [], requirements: [], criteria: [], tasks: [], semanticReview: { mode: 'off' } };
  for (let i = 0; i < 50; i++) {
    const id = `task_small_${i}`, check = { id: 'verify', program: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1000 };
    p.tasks.push({ id, title: `Behavior ${i}`, objective: `Implement behavior ${i}`, reviewBoundary: `Behavior ${i} only`, requirements: [], acceptance: [`criterion-${i}`], checks: [check], files: [{ path: `behavior-${i}.ts`, role: 'implementation' }] });
    p.criteria.push({ id: `criterion-${i}`, text: `Behavior ${i} passes`, stage: 'local', owner: id, contributors: [id], checks: ['verify'] });
  }
  assert.equal(validatePlan(p).valid, true);
  assert.equal(Object.keys(compilePlan(p).tasks).length, 50);
});

test('splitting a 2600-character fourteen-criterion unit retains every original obligation', () => {
  const check = { id: 'verify', program: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1000 };
  const ids = Array.from({ length: 14 }, (_, i) => `original-${i}`);
  const original: PlanningManifest = { version: 2, id: 'split', title: 'Split original scope', sources: [], semanticReview: { mode: 'off' },
    requirements: [{ id: 'feature', title: 'Feature', description: 'Every original obligation remains required', acceptance: ids }],
    criteria: ids.map(id => ({ id, text: `Verify ${id}`, requirement: 'feature', owner: 'task_big', stage: 'local', contributors: ['task_big'], checks: ['verify'] })),
    tasks: [{ id: 'task_big', title: 'Big unit', objective: 'x'.repeat(2600), reviewBoundary: 'All fourteen cases', requirements: ['feature'], acceptance: ids, checks: [check] }] };
  const rules = validatePlan(original).findings.map(f => f.rule);
  assert.ok(rules.includes('scope.oversized')); assert.ok(rules.includes('scope.acceptance'));
  const split = structuredClone(original); split.tasks = [];
  for (let i = 0; i < 7; i++) {
    const id = `task_part_${i}`, acceptance = ids.slice(i * 2, i * 2 + 2);
    split.tasks.push({ id, title: `Part ${i}`, objective: `Implement behavior ${i}`, reviewBoundary: `Only cases ${acceptance.join(', ')}`, requirements: ['feature'], acceptance, checks: [check], files: [{ path: `part-${i}.ts`, role: 'implementation' }] });
    for (const criterion of split.criteria.filter(c => acceptance.includes(c.id))) { criterion.owner = id; criterion.contributors = [id]; }
  }
  assert.doesNotThrow(() => assertPlanningRequirementsPreserved(original, split));
  assert.equal(validatePlan(split).valid, true);
  assert.equal(Object.keys(compilePlan(split).tasks).length, 7);
  assert.deepEqual(split.tasks.flatMap(t => t.acceptance), ids);
});

test('legacy CLI validation and compilation reject oversized tasks without creating a run', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-sizing-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = fixture(); oversize(p, 2600);
  const planFile = join(dir, 'plan.json'), runFile = join(dir, 'run.json');
  writeFileSync(planFile, JSON.stringify(p));
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  for (const action of ['validate', 'compile']) {
    const result = spawnSync(process.execPath, [cli, 'plan', action, '--profile', 'lean', '--plan', planFile, '--file', runFile, '--json'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(JSON.parse(result.stdout).findings.some((f: { rule: string }) => f.rule === 'scope.oversized'));
    assert.equal(existsSync(runFile), false);
  }
});
