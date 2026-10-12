import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DagRunner } from '../runner.js';
import { atomicWriteJson, editTask, setTasks, removeTask, loadRun, runPaths, saveRun } from '../store.js';
import { startFactory, normalizeFactoryGoal, upgradeFactoryGoal, type StructuredFactoryGoalV2 } from '../factory/controller.js';
import { digest, type PlanningManifest, type PlanningCheck, type PlanningFinding } from './contracts.js';
import { compilePlan, renderPlanningTask, checkCommand } from './compile.js';
import { validatePlan, admitPlanningTask } from './validation.js';
import { missingPlanningAcceptance, planningRefusal, recordPlanningFailure, recordPlanningAcceptance } from './runtime.js';
import { reviewPlan, validatePlanningReview, reviewCorrectionCycle } from './review.js';
import { amendPlan, migratePlan } from './amend.js';

test('explicit legacy migration preserves accepted objects and attempt history without fabricating check receipts', t => {
  const dir = root(t), plan = fixture(), run = compilePlan(plan);
  delete run.planning; delete run.planningState;
  run.tasks.task_runtime!.status = 'completed';
  run.tasks.task_runtime!.spec = 'Historical specification retained verbatim';
  run.tasks.task_runtime!.attempts = 3;
  run.tasks.task_cli!.attempts = 2; run.tasks.task_cli!.attemptsInCycle = 2;
  run.tasks.task_cli!.result = 'Retained rejection';
  const historical = JSON.stringify(run.tasks.task_runtime);
  const file = join(dir, 'dag.run.json'); saveRun(run, file);
  migratePlan(file, plan, 'User-authorized stopped migration');
  const migrated = loadRun(file);
  assert.equal(JSON.stringify(migrated.tasks.task_runtime), historical);
  assert.equal(migrated.tasks.task_cli!.attempts, 2);
  assert.equal(migrated.tasks.task_cli!.attemptsInCycle, 2);
  assert.equal(migrated.tasks.task_cli!.result, 'Retained rejection');
  assert.deepEqual(migrated.planningState!.evidence, {});
  assert.equal(planningRefusal(migrated, dir, runPaths(file).dir), null);
  const successor = structuredClone(plan); successor.tasks[1]!.objective = 'Clarify remaining CLI boundary';
  amendPlan(file, successor, 'Refine only pending task');
  assert.equal(planningRefusal(loadRun(file), dir, runPaths(file).dir), null);
  assert.equal(JSON.stringify(loadRun(file).tasks.task_runtime), historical);
  migrated.tasks.task_runtime!.result = 'Altered historical evidence';
  assert.match(planningRefusal(migrated, dir)!, /Imported historical acceptance changed/);
  const intact = loadRun(file); intact.planning!.manifest.tasks[0]!.checks[0]!.args = ['-e', 'process.exit(0);'];
  intact.planning!.revision = digest(intact.planning!.manifest); intact.planningState!.revision = intact.planning!.revision;
  assert.match(planningRefusal(intact, dir)!, /Imported historical acceptance changed/);
});

test('legacy migration refuses lost work, active tasks and missing approval; torn writes refuse dispatch', t => {
  const dir = root(t), plan = fixture(), run = compilePlan(plan), file = join(dir, 'dag.run.json');
  delete run.planning; delete run.planningState;
  run.tasks.task_runtime!.status = 'running'; saveRun(run, file);
  assert.throws(() => migratePlan(file, plan, 'migrate'), /Stop and recover/);
  run.tasks.task_runtime!.status = 'completed'; saveRun(run, file);
  const risky = structuredClone(plan); risky.semanticReview = { mode: 'required' };
  assert.throws(() => migratePlan(file, risky, 'migrate'), /approval/);
  const lost = structuredClone(plan); lost.tasks = lost.tasks.filter(t => t.id !== 'task_runtime');
  assert.throws(() => migratePlan(file, lost, 'migrate'), /Invalid migration|retain/);
  mkdirSync(runPaths(file).dir, { recursive: true });
  atomicWriteJson(join(runPaths(file).dir, 'planning-migration.json'), { stage: 'validated', revision: digest(plan) });
  assert.match(planningRefusal(run, dir, runPaths(file).dir)!, /Interrupted canonical migration/);
});

const check = (id: string, script = 'process.exit(0)'): PlanningCheck => ({ id, program: process.execPath, args: ['-e', script], timeoutMs: 10_000 });
export function fixture(): PlanningManifest {
  return { version: 2, id: 'runtime-cli', title: 'Runtime and CLI', sources: [], semanticReview: { mode: 'off' },
    requirements: [{ id: 'feature', title: 'Usable CLI', description: 'Runtime and actual CLI behavior', acceptance: ['runtime-ready', 'cli-works'] }],
    criteria: [
      { id: 'runtime-ready', text: 'Runtime is callable', requirement: 'feature', stage: 'local', owner: 'task_runtime', contributors: ['task_runtime'], checks: ['runtime'] },
      { id: 'cli-works', text: 'User can execute the CLI end to end', requirement: 'feature', stage: 'final', owner: 'task_cli', contributors: ['task_runtime', 'task_cli'], checks: ['cli'], requires: ['runtime'] },
    ], tasks: [
      { id: 'task_runtime', title: 'Runtime', objective: 'Implement callable runtime', reviewBoundary: 'Runtime only; CLI is owned downstream', requirements: ['feature'], acceptance: ['runtime-ready'],
        checks: [check('runtime')], files: [{ path: 'runtime.ts', role: 'implementation' }], provides: [{ id: 'runtime', contract: 'Callable runtime v1', interface: { id: 'runtime', version: '1' }, check: check('ready') }], cmd: 'worker-runtime' },
      { id: 'task_cli', title: 'CLI', objective: 'Bind production CLI', reviewBoundary: 'CLI integration', requirements: ['feature'], acceptance: ['cli-works'], checks: [check('cli')],
        inputs: [{ capability: 'runtime', contract: 'Requires callable runtime', interface: { id: 'runtime', version: '1' } }], files: [{ path: 'cli.ts', role: 'implementation' }], cmd: 'worker-cli' },
    ] };
}
function root(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dag-plan-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
function rules(p: PlanningManifest): string[] { return validatePlan(p).findings.map(f => f.rule); }

test('local acceptance stays achievable and every original criterion retains its owner', () => {
  const p = fixture(), run = compilePlan(p), rendered = renderPlanningTask(p, p.tasks[0]!);
  assert.deepEqual(run.tasks.task_cli.deps, ['task_runtime']);
  assert.match(rendered, /Acceptance owned by this task:\n- runtime-ready/);
  assert.match(rendered, /Deferred integration\/final obligations/);
  assert.match(rendered, /cli-works.*verification owner: task_cli/);
  assert.equal(validatePlan(p).valid, true);
  p.criteria = p.criteria.filter(c => c.id !== 'cli-works');
  assert.ok(rules(p).includes('coverage.missing'));
});

test('future acceptance, missing and ambiguous producers, conflicting interfaces and cycles are actionable', () => {
  const future = fixture(); future.criteria[1]!.stage = 'local'; future.criteria[1]!.owner = 'task_runtime';
  future.tasks[0]!.acceptance.push('cli-works'); future.tasks[1]!.acceptance = ['runtime-ready'];
  assert.ok(rules(future).includes('acceptance.future'));
  const missing = fixture(); missing.tasks[0]!.provides = []; assert.ok(rules(missing).includes('capability.missing'));
  const ambiguous = fixture(); ambiguous.tasks[1]!.provides = structuredClone(ambiguous.tasks[0]!.provides); assert.ok(rules(ambiguous).includes('capability.ambiguous'));
  ambiguous.tasks[1]!.inputs![0]!.owner = 'task_runtime'; assert.equal(validatePlan(ambiguous).valid, true);
  const incompatible = fixture(); incompatible.tasks[1]!.inputs![0]!.interface!.version = '2'; assert.ok(rules(incompatible).includes('interface.incompatible'));
  const conflict = fixture(); conflict.tasks[0]!.interfaces = [{ id: 'wire', version: '1' }]; conflict.tasks[1]!.interfaces = [{ id: 'wire', version: '2' }]; assert.ok(rules(conflict).includes('interface.conflict'));
  const cyclic = fixture(); cyclic.tasks[0]!.dependencies = [{ owner: 'task_cli', reason: 'Bad ordering', evidence: ['fixture'] }]; assert.ok(rules(cyclic).includes('dependency.cycle'));
  const unknown = fixture(); unknown.tasks[0]!.dependencies = [{ owner: 'task_unknown', reason: '', evidence: [] }]; assert.ok(rules(unknown).includes('dependency.unknown')); assert.ok(rules(unknown).includes('dependency.unexplained'));
});

test('baseline evidence, commands, resources and persisted shape fail closed', t => {
  const dir = root(t), p = fixture(); writeFileSync(join(dir, 'baseline.ts'), 'runtime');
  p.tasks[1]!.inputs = [{ capability: 'runtime', contract: 'Already implemented', baseline: { path: 'baseline.ts', sha256: digest('runtime') }, check: check('baseline') }];
  p.criteria[1]!.contributors = ['task_cli'];
  assert.equal(validatePlan(p, dir).valid, true);
  writeFileSync(join(dir, 'baseline.ts'), 'changed'); assert.ok(validatePlan(p, dir).findings.some(f => f.rule === 'input.unavailable'));
  p.tasks[0]!.resources = { browser: 2 }; p.capacities = { browser: 1 }; assert.ok(rules(p).includes('resource.unachievable'));
  assert.equal(validatePlan({ version: 9 }).valid, false);
  p.tasks[0]!.checks[0]!.timeoutMs = 0; assert.equal(validatePlan(p).valid, false);
});

test('write/resource exclusion never invents semantic ordering or serializes disjoint work', () => {
  const p = fixture(); p.tasks[1]!.inputs = []; p.criteria[1]!.contributors = ['task_cli']; p.criteria[1]!.requires = [];
  assert.deepEqual(validatePlan(p).dependencies.task_cli, []);
  assert.equal(admitPlanningTask(p, 'task_cli', ['task_runtime']), true);
  p.tasks[1]!.files = structuredClone(p.tasks[0]!.files);
  assert.equal(admitPlanningTask(p, 'task_cli', ['task_runtime']), false);
  assert.deepEqual(validatePlan(p).dependencies.task_cli, []);
  p.tasks[1]!.files = []; p.capacities = { browser: 1 }; p.tasks.forEach(t => t.resources = { browser: 1 });
  assert.equal(admitPlanningTask(p, 'task_cli', ['task_runtime']), false);
});

test('real runner accepts foundation before downstream and rejects missing final behavior', async t => {
  const dir = root(t), p = fixture();
  p.tasks[0]!.cmd = `"${process.execPath}" -e "require('fs').writeFileSync('runtime.txt','ready')"`;
  p.tasks[0]!.checks = [check('runtime', "if(!require('fs').existsSync('runtime.txt'))process.exit(1)")];
  p.tasks[0]!.provides![0]!.check = check('ready', "if(!require('fs').existsSync('runtime.txt'))process.exit(1)");
  p.tasks[1]!.cmd = `"${process.execPath}" -e "process.exit(0)"`;
  p.tasks[1]!.checks = [check('cli', "if(!require('fs').existsSync('cli.txt'))process.exit(1)")];
  const run = compilePlan(p); run.settings.maxAttempts = 1;
  const runner = new DagRunner(run, { cwd: dir }); await runner.start();
  assert.equal(run.tasks.task_runtime.status, 'completed'); assert.equal(run.tasks.task_cli.status, 'failed');
  assert.deepEqual(missingPlanningAcceptance(run), ['cli-works']); assert.ok(runner.result!.failed.length || runner.result!.unfinished.length);
  assert.equal(run.planningState!.evidence['runtime-ready']!.checks[0], 'runtime');
});

test('direct runner refuses invalid plans and changed compiled definitions before worker dispatch', async t => {
  const dir = root(t), run = compilePlan(fixture()); let calls = 0;
  run.tasks.task_cli.deps = [];
  const runner = new DagRunner(run, { cwd: dir, executor: async () => { calls++; return { exitCode: 0, output: '' }; } });
  await runner.start(); assert.equal(calls, 0); assert.match(runner.result!.planningError!, /changed|dependencies/);
  const file = join(dir, 'dag.run.json'); saveRun(run, file); const loaded = loadRun(file);
  assert.equal(loaded.planning?.revision, run.planning?.revision); assert.match(planningRefusal(loaded, dir)!, /changed/);
  loaded.planningState = undefined; assert.match(planningRefusal(loaded, dir)!, /checkpoint/);
});

test('factory v2 compiles actual acceptance ownership and cannot advance past missing final behavior', async t => {
  const dir = root(t), file = join(dir, 'factory.json'), planning = fixture();
  const goal: StructuredFactoryGoalV2 = { schemaVersion: 2, goal: { id: 'factory', title: 'Feature', description: 'Feature behavior' }, planning,
    phases: { review: { command: 'fixture' }, verification: { command: 'fixture' }, rootCause: { command: 'fixture' }, remediation: { command: 'fixture' }, regression: { command: 'fixture' }, recertification: { reviewCmd: 'fixture' } }, coverage: { criticalFlow: 1, weightedRisk: 1 } };
  assert.deepEqual(normalizeFactoryGoal(goal).requirements[0]!.acceptanceCriteria, planning.criteria.map(c => c.text));
  const result = await startFactory(goal, file, { cwd: dir, executor: async (task) => ({ output: 'checked', exitCode: task.id === 'task_cli' ? 1 : 0 }) });
  assert.equal(loadRun(file).tasks.task_runtime.status, 'completed'); assert.equal(result.state.stage, 'implementation');
  const graph = JSON.parse(readFileSync(join(runPaths(file).factory, 'graph-model-v1.json'), 'utf8'));
  assert.equal(graph.links.filter((l: { type: string }) => l.type === 'verified_by').length, 2);
});

test('semantic review requires grounded findings, source identity and risk-based approval', async t => {
  const dir = root(t), p = fixture(); p.semanticReview = { mode: 'auto', command: { program: 'fixture', args: ['{contextFile}'], timeoutMs: 1000 } };
  assert.equal(validatePlan(p).semanticRequired, true);
  const receipt = await reviewPlan(p, dir, async task => {
    const { contextDigest } = JSON.parse(readFileSync(JSON.parse(task.spec).contextFile, 'utf8'));
    return { exitCode: 0, output: `DAG_PLAN_REVIEW: ${JSON.stringify({ version: 1, revision: digest(p), contextDigest, reviewer: 'independent-fixture', verdict: 'pass', findings: [] })}` };
  });
  assert.equal(receipt.verdict, 'pass');
  const run = compilePlan(p); assert.match(planningRefusal(run, dir)!, /review required/); run.planning!.review = receipt; assert.equal(planningRefusal(run, dir), null);
  assert.throws(() => validatePlanningReview({ ...receipt, verdict: 'fail', findings: [] }, p), /contradicts/);
  assert.throws(() => validatePlanningReview({ ...receipt, findings: [{ blocking: true, confidence: 0.9 }] }, p), /evidence/);
  const finding: PlanningFinding = { id: 'file-contract', rule: 'scope.ambiguous', tasks: [p.tasks[0]!.id], references: [p.tasks[0]!.files![0]!.path], evidence: ['The registered file contradicts the task boundary'], severity: 'error', blocking: true, message: 'Correct the owned file contract', correction: 'Reconcile the task with its registered file' };
  assert.equal(validatePlanningReview({ ...receipt, verdict: 'fail', findings: [finding] }, p).verdict, 'fail');
  assert.equal(validatePlanningReview({ ...receipt, verdict: 'fail', findings: [{ ...finding, references: [`${finding.references[0]}:11`, `${finding.references[0]}#boundary`] }] }, p).verdict, 'fail');
  assert.throws(() => validatePlanningReview({ ...receipt, verdict: 'fail', findings: [{ ...finding, references: ['unregistered.md'] }] }, p), /registered/);
});

test('semantic correction cycle is bounded and revalidates corrected plans', async t => {
  const dir = root(t), p = fixture(); p.semanticReview = { mode: 'required', command: { program: 'fixture', args: ['{contextFile}'], timeoutMs: 1000 } };
  let corrections = 0;
  const result = await reviewCorrectionCycle(p, dir, async plan => { corrections++; return plan; }, async task => {
    const context = JSON.parse(readFileSync(JSON.parse(task.spec).contextFile, 'utf8'));
    const f: PlanningFinding = { id: 'scope', rule: 'scope.ambiguous', tasks: ['task_cli'], references: ['cli-works'], evidence: ['CLI repair responsibility is not bounded'], severity: 'error', blocking: true, message: 'Bound repair ownership', correction: 'Move implementation obligations upstream' };
    return { exitCode: 0, output: `DAG_PLAN_REVIEW: ${JSON.stringify({ version: 1, revision: digest(context.plan), contextDigest: context.contextDigest, reviewer: 'fixture', verdict: 'fail', findings: [f] })}` };
  });
  assert.equal(corrections, 2); assert.equal(result.reviews.length, 3);
});

test('matching evidence-backed planning defects hold consumers and preserve remaining attempts', async t => {
  const dir = root(t), p = fixture(); p.tasks[0]!.maxAttempts = 5;
  const f: PlanningFinding = { id: 'scope', rule: 'scope.ambiguous', tasks: ['task_runtime'], references: ['runtime-ready'], evidence: ['Reproduced missing boundary'], severity: 'error', blocking: true, message: 'Unachievable boundary', correction: 'Amend boundary' };
  const run = compilePlan(p); let calls = 0;
  const runner = new DagRunner(run, { cwd: dir, executor: async () => { calls++; return { exitCode: 1, output: `DAG_PLANNING_FINDINGS: ${JSON.stringify([f])}` }; } });
  await runner.start(); assert.equal(calls, 2); assert.equal(run.tasks.task_runtime.attemptsInCycle, 2);
  assert.equal(run.tasks.task_runtime.maxAttempts, 5); assert.ok(run.planningState!.holds.task_runtime);
  assert.equal(run.tasks.task_cli.attempts, 0); assert.ok(runner.result!.failed.length || runner.result!.unfinished.length);
  assert.equal(recordPlanningFailure(run, 'task_cli', [{ ...f, evidence: [] }]), false);
});

test('stopped amendments preserve completed work and interrupted journals refuse dispatch', async t => {
  const dir = root(t), file = join(dir, 'dag.run.json'), p = fixture(), run = compilePlan(p);
  run.tasks.task_runtime.status = 'completed'; run.tasks.task_runtime.attempts = 2;
  recordPlanningAcceptance(run, run.tasks.task_runtime, digest('accepted runtime'));
  run.tasks.task_cli.attempts = 1; run.tasks.task_cli.attemptsInCycle = 1;
  saveRun(run, file);
  const updated = structuredClone(p); updated.tasks[1]!.reviewBoundary += '; final verification only';
  amendPlan(file, updated, 'Correct final boundary');
  const loaded = loadRun(file); assert.equal(loaded.tasks.task_runtime.attempts, 2); assert.equal(loaded.tasks.task_cli.attemptsInCycle, 1);
  assert.equal(loaded.tasks.task_runtime.status, 'completed');
  atomicWriteJson(join(runPaths(file).dir, 'planning-amendment.json'), { stage: 'validated', revision: digest(updated) });
  assert.match(planningRefusal(loaded, dir, runPaths(file).dir)!, /Interrupted/);
  amendPlan(file, updated, 'Resume interrupted amendment');
  assert.equal(planningRefusal(loadRun(file), dir, runPaths(file).dir), null);
  const changedAccepted = structuredClone(updated); changedAccepted.tasks[0]!.objective = 'Different implementation';
  assert.throws(() => amendPlan(file, changedAccepted, 'invalid'), /accepted work/);
  assert.ok(existsSync(join(runPaths(file).dir, 'planning-amendment.json')));
});

test('managed definitions reject shadow edits while execution budgets remain editable', () => {
  const run = compilePlan(fixture());
  assert.throws(() => editTask(run, 'task_runtime', { spec: 'weakened' }), /authoritative/);
  assert.throws(() => setTasks(run, { cmd: 'changed' }, { all: true }), /authoritative/);
  assert.throws(() => removeTask(run, 'task_cli'), /amend/);
  editTask(run, 'task_runtime', { maxAttempts: 7 });
  assert.equal(run.tasks.task_runtime.maxAttempts, 7);
});

test('amendment cannot drop original criteria and recovers torn persisted definitions from its journal', t => {
  const dir = root(t), file = join(dir, 'dag.run.json'), p = fixture(), run = compilePlan(p);
  run.tasks.task_runtime.attempts = 2; run.tasks.task_runtime.attemptsInCycle = 2;
  saveRun(run, file);
  const dropped = structuredClone(p); dropped.criteria.pop(); dropped.requirements[0]!.acceptance.pop();
  dropped.tasks.pop();
  assert.throws(() => amendPlan(file, dropped, 'Drop final acceptance'), /loses original acceptance/);
  const updated = structuredClone(p); updated.tasks[1]!.objective += '; bounded CLI';
  const journalFile = join(runPaths(file).dir, 'planning-amendment.json');
  atomicWriteJson(journalFile, { version: 1, stage: 'validated', revision: digest(updated), previousRun: run, previousRunDigest: digest(run) });
  // Simulate the definition having been written before the matching state checkpoint.
  const definition = JSON.parse(readFileSync(file, 'utf8')); definition.tasks.task_extra = { ...definition.tasks.task_cli, id: 'task_extra' };
  atomicWriteJson(file, definition);
  assert.throws(() => loadRun(file), /checkpoint|state|task/i);
  amendPlan(file, updated, 'Resume interrupted amendment');
  assert.equal(loadRun(file).tasks.task_runtime.attemptsInCycle, 2);
  assert.equal(planningRefusal(loadRun(file), dir, runPaths(file).dir), null);
});

test('reviewer findings also hold repeated planning failures without draining the worker budget', async t => {
  const dir = root(t), p = fixture(); p.tasks[0]!.reviewCmd = 'review-fixture'; p.tasks[0]!.maxAttempts = 5;
  const f: PlanningFinding = { id: 'scope', rule: 'scope.ambiguous', tasks: ['task_runtime'], references: ['runtime-ready'], evidence: ['A local check demands downstream behavior'], severity: 'error', blocking: true, message: 'Unachievable local boundary', correction: 'Move downstream acceptance' };
  const run = compilePlan(p);
  await new DagRunner(run, { cwd: dir, executor: async (_task, _ctx, cmd) => ({ exitCode: 0, output: cmd === 'review-fixture' ? `DAG_PLANNING_FINDINGS: ${JSON.stringify([f])}` : 'implemented' }) }).start();
  assert.equal(run.tasks.task_runtime.attemptsInCycle, 2);
  assert.ok(run.planningState!.holds.task_runtime);
});

test('workers cannot change pinned specifications to pass their own acceptance', async t => {
  const dir = root(t), p = fixture(); writeFileSync(join(dir, 'SPEC.md'), 'Original requirement');
  p.sources = [{ path: 'SPEC.md', sha256: digest('Original requirement') }];
  const run = compilePlan(p); run.tasks.task_runtime.maxAttempts = 1;
  await new DagRunner(run, { cwd: dir, executor: async () => { writeFileSync(join(dir, 'SPEC.md'), 'Weakened'); return { exitCode: 0, output: 'success' }; } }).start();
  assert.equal(run.tasks.task_runtime.status, 'failed'); assert.match(run.tasks.task_runtime.result!, /inputs changed/);
  assert.deepEqual(missingPlanningAcceptance(run), ['runtime-ready', 'cli-works']);
});

test('task acceptance checks verify the final artifact after review commands run', async t => {
  const dir = root(t), p = fixture(); p.tasks[0]!.reviewCmd = 'review-fixture'; p.tasks[0]!.maxAttempts = 1;
  const run = compilePlan(p); let artifact = 'valid';
  const local = checkCommand(p.tasks[0]!.checks[0]!);
  await new DagRunner(run, { cwd: dir, executor: async (_task, _ctx, cmd) => {
    if (cmd === 'review-fixture') { artifact = 'broken'; return { exitCode: 0, output: 'VERDICT: PASS' }; }
    return { exitCode: cmd === local && artifact === 'broken' ? 1 : 0, output: artifact };
  } }).start();
  assert.equal(run.tasks.task_runtime.status, 'failed');
  assert.equal(run.planningState!.evidence['runtime-ready'], undefined);
  assert.match(run.tasks.task_runtime.result!, /Task-local acceptance check failed/);
});

test('factory v2 retains the existing full certification workflow and generated phase authority', async t => {
  const dir = root(t), file = join(dir, 'dag.run.json'), p = fixture();
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'tsconfig.json'), '{"include":["src/**/*.ts"]}');
  writeFileSync(join(dir, '.gitignore'), 'dag.run*\n');
  for (const task of p.tasks) {
    task.files![0]!.path = `src/${task.id}.ts`;
    writeFileSync(join(dir, task.files![0]!.path), `export const ${task.id} = true;\n`);
  }
  for (const args of [['init'], ['config', 'user.name', 'Planning Test'], ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-m', 'source']]) execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  p.semanticReview = { mode: 'auto', command: { program: 'fixture', args: ['{contextFile}'], timeoutMs: 1000 } };
  const planningReview = await reviewPlan(p, dir, async task => {
    const context = JSON.parse(readFileSync(JSON.parse(task.spec).contextFile, 'utf8'));
    return { exitCode: 0, output: `DAG_PLAN_REVIEW: ${JSON.stringify({ version: 1, revision: digest(p), contextDigest: context.contextDigest, reviewer: 'independent-test-review', verdict: 'pass', findings: [] })}` };
  });
  const goal: StructuredFactoryGoalV2 = { schemaVersion: 2, goal: { id: 'certified-plan', title: 'Feature', description: 'Feature behavior' }, planning: p,
    planningReview,
    phases: { review: { command: 'review' }, verification: { command: 'verify' }, rootCause: { command: 'root' }, remediation: { command: 'repair' }, regression: { command: 'regression' }, recertification: { reviewCmd: 'recertify' } }, coverage: { criticalFlow: 1, weightedRisk: 1 } };
  const result = await startFactory(goal, file, { cwd: dir, executor: async (task, _ctx, cmd) => ({ exitCode: 0, output: task.title.startsWith('Factory review:') ? JSON.stringify({ observations: [], reviewedFiles: p.tasks.flatMap(t => t.files!.map(f => f.path)) }) : cmd === 'recertify' ? 'VERDICT: PASS' : 'checked' }) });
  assert.equal(result.state.stage, 'complete', result.summary);
  assert.equal(result.certification?.status, 'certified');
  const run = loadRun(file); assert.ok(Object.keys(run.planning!.generated!).length);
  assert.equal(planningRefusal(run, dir), null);
  assert.deepEqual(missingPlanningAcceptance(run), []);
});

test('explicit factory upgrade preserves original requirements and project certification checks', () => {
  const p = fixture();
  const normalized = normalizeFactoryGoal({ schemaVersion: 2, planning: p, goal: { id: 'feature', title: 'Feature', description: 'Feature' },
    phases: { review: { command: 'review' }, verification: { command: 'verify' }, rootCause: { command: 'root' }, remediation: { command: 'repair' }, regression: { command: 'regression' }, recertification: { reviewCmd: 'recertify' } }, coverage: { criticalFlow: 1, weightedRisk: 1 } });
  delete normalized.planning; normalized.checks = [{ id: 'certification', title: 'Complete project check', cmd: 'project-check' }];
  const upgraded = upgradeFactoryGoal(normalized, p), goal = normalizeFactoryGoal(upgraded);
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal((upgraded as unknown as { implementation?: unknown }).implementation, undefined);
  assert.deepEqual(goal.requirements, normalized.requirements);
  assert.equal(goal.checks[0]!.cmd, 'project-check');
  const weakened = structuredClone(p); weakened.criteria[1]!.text = 'Accept incomplete feature';
  assert.throws(() => upgradeFactoryGoal(normalized, weakened), /loses original requirement/);
  const duplicated = structuredClone(normalized); duplicated.requirements[0]!.acceptanceCriteria.push(p.criteria[0]!.text);
  assert.throws(() => upgradeFactoryGoal(duplicated, p), /loses original requirement/);
});

test('structured check argv remains literal through ordinary runner template expansion', async t => {
  const dir = root(t), p = fixture(); p.tasks = [p.tasks[0]!]; p.criteria = [p.criteria[0]!]; p.requirements[0]!.acceptance = ['runtime-ready'];
  p.tasks[0]!.cmd = undefined; p.tasks[0]!.provides = [];
  p.tasks[0]!.checks[0]!.args = ['-e', 'if(process.argv[1]!=="{deps}"||process.argv[2]!=="$(literal)")process.exit(1)', '{deps}', '$(literal)'];
  const run = compilePlan(p); await new DagRunner(run, { cwd: dir }).start();
  assert.equal(run.tasks.task_runtime.status, 'completed', run.tasks.task_runtime.result!);
});

test('correcting deferred verification ownership preserves already accepted foundational work', t => {
  const dir = root(t), file = join(dir, 'dag.run.json'), p = fixture(), run = compilePlan(p);
  run.tasks.task_runtime.status = 'completed'; run.tasks.task_runtime.attempts = 1;
  recordPlanningAcceptance(run, run.tasks.task_runtime, digest('accepted foundation')); saveRun(run, file);
  const updated = structuredClone(p); updated.criteria[1]!.owner = 'task_verifier';
  updated.criteria.push({ id: 'cli-local', text: 'CLI handler implements its local interface', requirement: 'feature', stage: 'local', owner: 'task_cli', contributors: ['task_cli'], checks: ['cli'] });
  updated.requirements[0]!.acceptance.push('cli-local'); updated.tasks[1]!.acceptance = ['cli-local'];
  updated.tasks.push({ id: 'task_verifier', title: 'End-to-end verifier', objective: 'Verify complete feature', reviewBoundary: 'Final acceptance only', requirements: ['feature'], acceptance: ['cli-works'], checks: [check('cli')],
    dependencies: [{ owner: 'task_cli', reason: 'Verify the completed CLI', evidence: ['cli-works'] }], inputs: structuredClone(updated.tasks[1]!.inputs) });
  amendPlan(file, updated, 'Separate local CLI work from final verification');
  const loaded = loadRun(file); assert.equal(loaded.tasks.task_runtime.status, 'completed');
  assert.equal(loaded.tasks.task_runtime.attempts, 1);
  assert.match(loaded.tasks.task_runtime.spec, /verification owner: task_verifier/);
  assert.equal(planningRefusal(loaded, dir, runPaths(file).dir), null);
});

test('an unrelated amendment cannot release a grounded planning hold or reset its attempt budget', t => {
  const dir = root(t), file = join(dir, 'dag.run.json'), p = fixture(), run = compilePlan(p);
  const f: PlanningFinding = { id: 'scope', rule: 'scope.ambiguous', tasks: ['task_cli'], references: ['cli-works'], evidence: ['The final boundary includes an unassigned runtime repair'], severity: 'error', blocking: true, message: 'Unbounded final repair', correction: 'Assign runtime repair ownership' };
  run.tasks.task_cli.maxAttempts = 5; run.tasks.task_cli.attempts = 2; run.tasks.task_cli.attemptsInCycle = 2;
  recordPlanningFailure(run, 'task_cli', [f], 'attempt:1'); recordPlanningFailure(run, 'task_cli', [f], 'attempt:2');
  saveRun(run, file); const updated = structuredClone(p); updated.title += ' (clarified heading)';
  amendPlan(file, updated, 'Clarify plan heading');
  const loaded = loadRun(file); assert.ok(loaded.planningState!.holds.task_cli);
  assert.equal(loaded.tasks.task_cli.maxAttempts, 5); assert.equal(loaded.tasks.task_cli.attemptsInCycle, 2);
  assert.equal(planningRefusal(loaded, dir, runPaths(file).dir), null);
});

test('successive amendments retain evidence accepted under the immediately preceding contract', t => {
  const dir = root(t), file = join(dir, 'dag.run.json'), p = fixture();
  saveRun(compilePlan(p), file);
  const expanded = structuredClone(p);
  expanded.criteria.push({ id: 'cli-local', text: 'CLI implements its local interface', requirement: 'feature', stage: 'local', owner: 'task_cli', contributors: ['task_cli'], checks: ['cli'] });
  expanded.requirements[0]!.acceptance.push('cli-local'); expanded.tasks[1]!.acceptance.push('cli-local');
  amendPlan(file, expanded, 'Add explicit CLI interface verification');
  const accepted = loadRun(file);
  for (const task of Object.values(accepted.tasks)) {
    task.status = 'completed'; task.attempts = 1;
    recordPlanningAcceptance(accepted, task, digest('verified output'));
  }
  saveRun(accepted, file);
  const clarified = structuredClone(expanded); clarified.title += ' (clarified)';
  amendPlan(file, clarified, 'Clarify project title');
  const loaded = loadRun(file);
  assert.deepEqual(missingPlanningAcceptance(loaded), []);
  assert.equal(planningRefusal(loaded, dir, runPaths(file).dir), null);
});

test('amendment recompiles every authoritative execution field without resetting budgets', t => {
  const dir = root(t), file = join(dir, 'dag.run.json'), p = fixture(), run = compilePlan(p);
  run.tasks.task_cli.planCmd = 'unregistered-plan'; run.tasks.task_cli.prepareCmd = 'unregistered-prepare';
  run.tasks.task_cli.maxAttempts = 7; run.tasks.task_cli.attempts = 2; run.tasks.task_cli.attemptsInCycle = 2;
  saveRun(run, file);
  const updated = structuredClone(p); updated.tasks[1]!.objective += '; corrected scope';
  amendPlan(file, updated, 'Correct pending task contract');
  const loaded = loadRun(file);
  assert.equal(planningRefusal(loaded, dir, runPaths(file).dir), null);
  assert.equal(loaded.tasks.task_cli.planCmd, null); assert.equal(loaded.tasks.task_cli.prepareCmd, null);
  assert.equal(loaded.tasks.task_cli.maxAttempts, 7); assert.equal(loaded.tasks.task_cli.attemptsInCycle, 2);
});

test('skipping a required final verifier cannot certify a managed run, while scoped local work can pass', async t => {
  const dir = root(t), run = compilePlan(fixture()); run.tasks.task_cli.status = 'skipped';
  const runner = new DagRunner(run, { cwd: dir, executor: async () => ({ exitCode: 0, output: 'verified' }) });
  await runner.start(); assert.equal(run.tasks.task_runtime.status, 'completed');
  assert.ok(runner.result!.failed.includes('task_cli')); assert.deepEqual(missingPlanningAcceptance(run), ['cli-works']);
  const local = compilePlan(fixture()), scoped = new DagRunner(local, { cwd: dir, executor: async () => ({ exitCode: 0, output: 'verified' }) });
  await scoped.start(new Set(['task_runtime'])); assert.deepEqual(scoped.result!.completed, ['task_runtime']); assert.deepEqual(scoped.result!.failed, []);
  assert.deepEqual(missingPlanningAcceptance(local), ['cli-works']);
});

test('observed missing prerequisite holds the consumer before spending further worker attempts', async t => {
  const dir = root(t), p = fixture(), probe = check('actual-runtime', 'process.exit(1)');
  p.tasks[1]!.inputs![0]!.check = probe; p.tasks[1]!.maxAttempts = 5;
  const run = compilePlan(p); let consumerCalls = 0;
  const runner = new DagRunner(run, { cwd: dir, executor: async (_task, _ctx, cmd) => {
    if (cmd === 'worker-cli') consumerCalls++;
    return { exitCode: cmd === checkCommand(probe) ? 1 : 0, output: cmd === checkCommand(probe) ? 'Production runtime is not callable' : 'verified' };
  } });
  await runner.start(); assert.equal(consumerCalls, 0);
  assert.ok(run.planningState!.holds.task_cli);
  assert.equal(run.tasks.task_cli.attemptsInCycle, 2); assert.equal(run.tasks.task_cli.maxAttempts, 5);
  assert.equal(run.planningState!.holds.task_cli![0]!.references[0], 'runtime');
});
