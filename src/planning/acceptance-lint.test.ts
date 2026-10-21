import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, type PlanningManifest } from './contracts.js';
import { compilePlan } from './compile.js';
import { validatePlan } from './validation.js';
import { forwardReferenceFailure } from './acceptance-lint.js';
import { DagRunner, shellExecutor } from '../runner.js';
import { gitRepo, tempDir } from '../test-helpers.js';
import { saveRun } from '../store.js';
import { executionProfilePatch } from '../execution-policy.js';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function plan(): PlanningManifest {
  return { version: 2, id: 'lint', title: 'Lint', sources: [], requirements: [], semanticReview: { mode: 'off' },
    criteria: ['early', 'later'].map(id => ({ id, text: id, stage: 'local', owner: `task_${id}`, contributors: [`task_${id}`], checks: [id] })),
    tasks: ['early', 'later'].map(id => ({ id: `task_${id}`, title: id, objective: `Implement ${id}`, reviewBoundary: id, requirements: [], acceptance: [id],
      checks: [{ id, program: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1000 }],
      files: [{ path: `${id}.ts`, role: 'implementation' }], cmd: `worker-${id}`, maxAttempts: 4 })) };
}
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dag-lint-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}

test('literal acceptance files catch missing future dependencies even when stale bytes exist', t => {
  const dir = fixture(t), p = plan(); writeFileSync(join(dir, 'later.ts'), 'export const later = 1;');
  p.tasks[0]!.checks[0]!.args = ['--test', 'later.ts'];
  p.tasks[0]!.checks[0]!.kind = 'test'; p.tasks[0]!.checks[0]!.selectedTests = { pattern: '^# tests (\\d+)$' };
  const result = validatePlan(p, dir);
  assert.equal(result.valid, false); assert.ok(result.findings.some(f => f.rule === 'acceptance.future' && f.references.includes('later.ts')));
  p.tasks[0]!.dependencies = [{ owner: 'task_later', reason: 'Acceptance consumes later', evidence: ['later.ts'] }];
  assert.equal(validatePlan(p, dir).valid, true);
  const middle = structuredClone(p.tasks[1]!); middle.id = 'task_middle'; middle.acceptance = ['middle']; middle.files = [];
  middle.dependencies = [{ owner: 'task_later', reason: 'Middle consumes later', evidence: ['later.ts'] }];
  p.tasks.push(middle); p.criteria.push({ id: 'middle', text: 'Middle verified', stage: 'local', owner: 'task_middle', contributors: ['task_middle'], checks: ['later'] });
  p.tasks[0]!.dependencies = [{ owner: 'task_middle', reason: 'Early consumes middle', evidence: ['task_middle'] }];
  assert.equal(validatePlan(p, dir).valid, true);
});

test('recursive static imports resolve emitted js to planned ts without inventing dependencies', t => {
  const dir = fixture(t), p = plan(); mkdirSync(join(dir, 'tests'));
  p.sizing = { maxOutputConcerns: 2 }; // Isolate import tracing from the sizing rule.
  // This fixture deliberately owns one implementation plus a bridging module;
  // the decomposition budget is relaxed here so the lint rule under test stays isolated.
  writeFileSync(join(dir, 'tests/early.test.ts'), "import { bridge } from '../bridge.js'; void bridge;");
  writeFileSync(join(dir, 'bridge.ts'), "export { later as bridge } from './later.js';");
  p.tasks[0]!.files!.push({ path: 'tests/early.test.ts', role: 'test' }, { path: 'bridge.ts', role: 'implementation' });
  p.tasks[0]!.checks[0]!.args = ['--test', 'tests/early.test.ts'];
  p.tasks[0]!.checks[0]!.kind = 'test'; p.tasks[0]!.checks[0]!.selectedTests = { pattern: '^# tests (\\d+)$' };
  const report = validatePlan(p, dir), f = report.findings.find(f => f.rule === 'acceptance.future');
  assert.ok(f); assert.deepEqual(f.references, ['later.ts']); assert.match(f.evidence.join('\n'), /bridge.ts imports/);
  assert.deepEqual(report.dependencies.task_early, []);
});

test('CLI lint rejects the imported future file while the runner defers and dispatches workers', async t => {
  const dir = fixture(t), p = plan();
  writeFileSync(join(dir, 'early.ts'), "import './later.js';");
  p.tasks[0]!.checks[0]!.args = ['--test', 'early.ts'];
  p.tasks[0]!.checks[0]!.kind = 'test'; p.tasks[0]!.checks[0]!.selectedTests = { pattern: '^# tests (\\d+)$' };
  const path = join(dir, 'plan.json'); writeFileSync(path, JSON.stringify(p));
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'plan', 'validate', '--plan', path, '--cwd', dir, '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1, result.stderr); assert.ok(JSON.parse(result.stdout).findings.some((f: { rule: string }) => f.rule === 'acceptance.future'));
  const run = compilePlan(p); let calls = 0;
  const runner = new DagRunner(run, { cwd: dir, executor: async () => { calls++; return { exitCode: 0, output: 'worker' }; } });
  await runner.start();
  assert.equal(calls, 2, 'the runner defers planning validation instead of blocking dispatch');
  assert.equal(run.tasks.task_early.status, 'completed');
  assert.equal(run.tasks.task_later.status, 'completed');
  assert.ok(run.events.some(e => /planning validation deferred/.test(e.message)));
});

test('an exact pinned baseline is allowed; unpinned or changed files are not baseline evidence', t => {
  const dir = fixture(t), p = plan(); writeFileSync(join(dir, 'baseline.mjs'), 'export const x = 1;');
  p.tasks[0]!.checks[0]!.files = ['baseline.mjs'];
  assert.ok(validatePlan(p, dir).findings.some(f => f.rule === 'acceptance.input'));
  p.sources.push({ path: 'baseline.mjs', sha256: digest('export const x = 1;') });
  assert.equal(validatePlan(p, dir).valid, true);
  writeFileSync(join(dir, 'baseline.mjs'), 'changed'); assert.equal(validatePlan(p, dir).valid, false);
  const binary = Buffer.from([0xff, 0xfe, 0x00]); writeFileSync(join(dir, 'fixture.bin'), binary);
  p.sources = [{ path: 'fixture.bin', sha256: digest(binary) }]; p.tasks[0]!.checks[0]!.files = ['fixture.bin'];
  assert.equal(validatePlan(p, dir).valid, true);
});

test('explicit files cover dynamic commands and globs; unsupported tracing stays visible', t => {
  const dir = fixture(t), p = plan();
  p.tasks[0]!.checks[0]!.program = 'pnpm'; p.tasks[0]!.checks[0]!.args = ['test', 'tests/*.test.ts'];
  p.tasks[0]!.checks[0]!.kind = 'test'; p.tasks[0]!.checks[0]!.selectedTests = { pattern: '^Tests: (\\d+)$' };
  assert.ok(validatePlan(p, dir).findings.some(f => f.rule === 'acceptance.untraced' && !f.blocking));
  p.tasks[0]!.checks[0]!.files = ['later.ts'];
  assert.ok(validatePlan(p, dir).findings.some(f => f.rule === 'acceptance.future'));
  p.tasks[0]!.checks[0]!.files = ['../escape.ts']; assert.equal(validatePlan(p, dir).valid, false);
});

test('lint preserves parallel tasks and rejects blank objectives and absent executable checks', () => {
  const p = plan(), report = validatePlan(p); assert.equal(report.valid, true); assert.deepEqual(report.dependencies.task_early, []);
  p.tasks[0]!.checks[0]!.args = ['node_modules/tsx/dist/cli.mjs', '--label', 'later.ts'];
  assert.equal(validatePlan(p).valid, true);
  p.tasks[0]!.objective = ' '; assert.equal(validatePlan(p).valid, false);
  p.tasks[0]!.objective = 'Bounded'; p.tasks[0]!.checks = []; assert.equal(validatePlan(p).valid, false);
});

test('runtime missing file classification requires exact future ownership, not prose or package guesses', () => {
  const p = plan(), run = compilePlan(p), dir = tmpdir();
  assert.equal(forwardReferenceFailure(run, 'task_early', "Cannot find module './later.ts'", dir).length, 1);
  assert.equal(forwardReferenceFailure(run, 'task_early', "ENOENT: no such file or directory, open 'later.ts'", dir).length, 1);
  for (const text of ["Cannot find module 'not-owned-package'", "Cannot find package 'later.ts'", "Cannot find module 'later.ts'", 'The future module might be missing', "Cannot find module './early.ts'"])
    assert.deepEqual(forwardReferenceFailure(run, 'task_early', text, dir), []);
  run.tasks.task_later.status = 'completed'; assert.deepEqual(forwardReferenceFailure(run, 'task_early', "Cannot find module './later.ts'", dir), []);
});

test('runtime forward-reference output is a normal exit failure with no planning hold', async t => {
  const dir = fixture(t), run = compilePlan(plan()); run.settings.failOnNonZeroExit = true;
  run.tasks.task_early.maxAttempts = 1; run.tasks.task_early.reviewRounds = 3; run.tasks.task_early.repairRounds = 2;
  let calls = 0;
  const runner = new DagRunner(run, { cwd: dir, executor: async () => { calls++; return { exitCode: 1, output: "Cannot find module './later.ts'" }; } });
  await runner.start(new Set(['task_early']));
  assert.equal(calls, 1); assert.equal(run.tasks.task_early.attempts, 1);
  assert.equal(run.tasks.task_early.status, 'failed');
  assert.equal(run.tasks.task_early.failureKind, 'exit');
  assert.deepEqual(run.planningState!.holds, {});
  assert.equal(run.tasks.task_early.reviews, 0); assert.equal(run.tasks.task_early.repairs, 0);
});

test('reviewer forward-reference output is a normal review rejection within reviewRounds', async t => {
  const dir = fixture(t);
  // Recompile the authored review command so runtime authority remains exact.
  const p = plan(); p.tasks[0]!.reviewCmd = 'review-early';
  const reviewed = compilePlan(p); reviewed.tasks.task_early.reviewRounds = 1;
  let reviews = 0;
  const runner = new DagRunner(reviewed, { cwd: dir, executor: async (_task, _ctx, cmd) => {
    if (cmd === 'review-early') { reviews++; return { exitCode: 1, output: "Cannot find module './later.ts'" }; }
    return { exitCode: 0, output: 'passed' };
  } });
  await runner.start(new Set(['task_early']));
  assert.equal(reviews, 2);
  assert.equal(reviewed.tasks.task_early.status, 'failed');
  assert.equal(reviewed.tasks.task_early.failureKind, 'review');
  assert.deepEqual(reviewed.planningState!.holds, {});
});


test('runtime import scope does not attribute later shared-test imports to historical owners', t => {
  const dir = fixture(t), p = plan();
  for (const task of p.tasks) {
    task.files!.push({ path: 'shared.test.mjs', role: 'test' });
    task.checks[0]!.files = ['shared.test.mjs'];
  }
  p.tasks[1]!.dependencies = [{ owner: 'task_early', reason: 'Builds on prior scope', evidence: ['early.ts'] }];
  writeFileSync(join(dir, 'early.ts'), 'export const early = 1;');
  writeFileSync(join(dir, 'later.ts'), 'export const later = 2;');
  writeFileSync(join(dir, 'shared.test.mjs'), "import './early.js'; import './later.js';");
  assert.ok(validatePlan(p, dir).findings.some(f => f.tasks[0] === 'task_early' && f.references.includes('later.ts')));
  assert.equal(validatePlan(p, dir, { acceptanceImportTasks: new Set(['task_later']) }).valid, true);
  const future = structuredClone(p.tasks[1]!); future.id = 'task_future'; future.acceptance = ['future']; future.files = [{ path: 'future.ts', role: 'implementation' }];
  future.checks = [{ id: 'future', program: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1000 }];
  p.tasks.push(future); p.criteria.push({ id: 'future', text: 'Future behavior', stage: 'local', owner: future.id, contributors: [future.id], checks: ['future'] });
  writeFileSync(join(dir, 'future.ts'), 'export const future = 3;');
  writeFileSync(join(dir, 'shared.test.mjs'), "import './early.js'; import './later.js'; import './future.js';");
  assert.ok(validatePlan(p, dir, { acceptanceImportTasks: new Set(['task_later']) }).findings.some(f => f.tasks[0] === 'task_later' && f.references.includes('future.ts')));
  p.tasks[0]!.checks[0]!.files!.push('later.ts');
  assert.ok(validatePlan(p, dir, { acceptanceImportTasks: new Set() }).findings.some(f => f.tasks[0] === 'task_early' && f.references.includes('later.ts')), 'Explicit historical check references remain enforced');
  p.sources = [{ path: 'spec.md', sha256: digest('frozen specification') }]; writeFileSync(join(dir, 'spec.md'), 'changed specification');
  assert.ok(validatePlan(p, dir, { acceptanceImportTasks: new Set() }).findings.some(f => f.rule === 'input.unavailable'), 'Source pins remain enforced');
});

test('later shared acceptance growth passes native candidate checks without reverse dependencies', async () => {
  const repo = gitRepo(), file = join(tempDir(), 'dag.run.json'), p = plan();
  const shared = 'shared.test.mjs';
  for (const [index, task] of p.tasks.entries()) {
    const unit = index === 0 ? 'early' : 'later';
    task.files = [{ path: `${unit}.mjs`, role: 'implementation' }, { path: shared, role: 'test' }];
    task.checks = [{ id: unit, program: process.execPath, args: ['--test', '--test-name-pattern', unit, shared], files: [shared, `${unit}.mjs`], timeoutMs: 10000,
      kind: 'test', selectedTests: { pattern: '^(?:#|ℹ) pass (\\d+)$', allowEmpty: false } }];
  }
  p.tasks[1]!.dependencies = [{ owner: 'task_early', reason: 'Builds on earlier scope', evidence: ['early.mjs'] }];
  const run = compilePlan(p); Object.assign(run.settings, executionProfilePatch('lean'), { implementationAttempts: 1 }); saveRun(run, file);
  const launch: typeof spawn = ((file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    const env = { ...options?.env }; delete env.NODE_TEST_CONTEXT;
    return spawn(file, args, { ...options, env });
  }) as typeof spawn;
  const native = shellExecutor(repo, launch); let workers = 0;
  const first = `import test from 'node:test'; import assert from 'node:assert/strict'; import { early } from './early.mjs'; test('early', () => assert.equal(early, 1));`;
  await new DagRunner(run, { cwd: repo, file, persist: state => saveRun(state, file), executor: async (task, context, command) => {
    if (command?.startsWith('worker-')) {
      workers++; const later = task.id === 'task_later';
      writeFileSync(join(context.cwd!, later ? 'later.mjs' : 'early.mjs'), `export const ${later ? 'later = 2' : 'early = 1'};`);
      writeFileSync(join(context.cwd!, shared), first + (later ? `\nimport { later } from './later.mjs'; test('later', () => assert.equal(later, 2));` : ''));
      return { exitCode: 0, output: 'scope implemented' };
    }
    return native(task, context, command);
  } }).start();
  assert.equal(run.tasks.task_early.status, 'completed', run.tasks.task_early.result ?? '');
  assert.equal(run.tasks.task_later.status, 'completed', run.tasks.task_later.result ?? '');
  assert.equal(workers, 2); assert.deepEqual(run.tasks.task_early.deps, []); assert.deepEqual(run.tasks.task_later.deps, ['task_early']);
});
