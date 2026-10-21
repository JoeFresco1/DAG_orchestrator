import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DagRunner } from './runner.js';
import type { Executor } from './runner.js';
import { compilePlan } from './planning/compile.js';
import type { PlanningCheck, PlanningManifest } from './planning/contracts.js';
import { executionProfilePatch } from './execution-policy.js';
import { git } from './git-worktree.js';
import { loadRun, saveRun } from './store.js';
import { gitRepo } from './test-helpers.js';

function plan(exclusive: boolean, consumer: boolean): PlanningManifest {
  const ids = consumer ? ['alpha', 'beta', 'consumer'] : ['alpha', 'beta'];
  const check = (id: string): PlanningCheck => ({ id: `check-${id}`, program: process.execPath,
    args: ['-e', `const fs=require('fs');const names=${JSON.stringify(id === 'consumer' ? ['alpha', 'beta', 'consumer'] : [id])}; if(!names.every(n=>fs.existsSync('docs/'+n+'.txt')))process.exit(1);${exclusive ? "if(fs.existsSync('docs/alpha.txt')&&fs.existsSync('docs/beta.txt')){console.log('mutually exclusive outputs');process.exit(1)}" : ''}`], timeoutMs: 10_000 });
  return { version: 2, id: 'integration-fixture', title: 'Document composition', sources: [], semanticReview: { mode: 'off' },
    requirements: ids.map(id => ({ id: `requirement-${id}`, title: `${id} output`, description: `${id} output exists`, acceptance: [`criterion-${id}`] })),
    criteria: ids.map(id => ({ id: `criterion-${id}`, requirement: `requirement-${id}`, owner: `task_${id}`, text: `${id} output exists`, stage: 'local' as const, contributors: [`task_${id}`], checks: [`check-${id}`] })),
    tasks: ids.map(id => ({ id: `task_${id}`, title: `${id} document`, objective: `Write ${id} document`, reviewBoundary: `${id} only`,
      requirements: [`requirement-${id}`], acceptance: [`criterion-${id}`], checks: [check(id)],
      files: [{ path: `docs/${id}.txt`, role: 'implementation' as const }], cmd: `worker-${id}`,
      ...(id === 'consumer' ? { inputs: ['alpha', 'beta'].map(capability => ({ capability, contract: `${capability} exists` })) }
        : { provides: [{ id, contract: `${id} exists`, check: check(id) }] }) })) };
}

function executor(barrier: boolean, seen: string[]): Executor {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let producers = 0;
  return async (task, context, command) => {
    assert.ok(command);
    const name = task.id.replace('task_', '');
    const root = context.cwd!;
    if (command.startsWith('worker-')) {
      if (name === 'consumer') {
        assert.equal(readFileSync(join(root, 'docs/alpha.txt'), 'utf8'), 'alpha');
        assert.equal(readFileSync(join(root, 'docs/beta.txt'), 'utf8'), 'beta');
        seen.push('consumer observed both accepted producers');
      }
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, `docs/${name}.txt`), name);
      if (barrier && name !== 'consumer') { if (++producers === 2) release(); await gate; }
      return { exitCode: 0, output: 'document produced' };
    }
    const payload = command.match(/--file ["']([^"']+)["']/)?.[1];
    assert.ok(payload, `expected canonical check payload: ${command}`);
    const check = JSON.parse(readFileSync(payload, 'utf8')) as PlanningCheck;
    const result = spawnSync(check.program, check.args, { cwd: root, encoding: 'utf8', windowsHide: true });
    return { exitCode: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
  };
}

for (const valid of [true, false]) test(`explicitly unreviewed production task completes regardless of local check result (${valid ? 'pass' : 'fail'} deferred)`, async () => {
  const repo = gitRepo(), file = join(repo, 'dag.run.json');
  const manifest = plan(false, false);
  manifest.tasks = manifest.tasks.slice(0, 1);
  manifest.criteria = manifest.criteria.slice(0, 1);
  manifest.requirements = manifest.requirements.slice(0, 1);
  const task = manifest.tasks[0]!;
  task.files = [{ path: 'src/auth.ts', role: 'implementation' }];
  task.checks[0]!.args = ['-e', "if(require('fs').readFileSync('src/auth.ts','utf8')!=='export const authorized = true;')process.exit(1)"];
  task.provides = [];
  const run = compilePlan(manifest);
  Object.assign(run.settings, executionProfilePatch('lean'), { implementationAttempts: 1 });
  saveRun(run, file);
  const underlying = executor(false, []);
  const execute: Executor = (current, context, command) => {
    if (command?.startsWith('worker-')) {
      mkdirSync(join(context.cwd!, 'src'), { recursive: true });
      writeFileSync(join(context.cwd!, 'src/auth.ts'), valid ? 'export const authorized = true;' : 'broken');
      return Promise.resolve({ exitCode: 0, output: 'source written' });
    }
    return underlying(current, context, command);
  };
  await new DagRunner(run, { cwd: repo, file, persist: state => saveRun(state, file), executor: execute }).start();
  assert.equal(run.tasks.task_alpha!.status, 'completed');
  const accepted = git(repo, ['ls-tree', '-r', '--name-only', `dag/${run.id}`]).stdout;
  assert.ok(accepted.includes('src/auth.ts'));
  assert.ok(run.tasks.task_alpha!.integrationReceipt);
});

test('lean runner publishes both independent merges when composed acceptance is deferred', async () => {
  const repo = gitRepo(), file = join(repo, 'dag.run.json');
  const run = compilePlan(plan(true, false));
  Object.assign(run.settings, executionProfilePatch('lean'), { concurrency: 2, implementationAttempts: 1 });
  saveRun(run, file);
  await new DagRunner(run, { cwd: repo, file, persist: state => saveRun(state, file), executor: executor(true, []) }).start();
  assert.deepEqual(Object.values(run.tasks).filter(task => task.status !== 'completed').map(task => task.id), []);
  const acceptedFiles = git(repo, ['ls-tree', '-r', '--name-only', `dag/${run.id}`]).stdout;
  for (const id of ['alpha', 'beta']) assert.ok(acceptedFiles.includes(`docs/${id}.txt`));
});

test('external source edit after the checkpoint travels with the candidate (integrity gate deferred)', async () => {
  const repo = gitRepo(), file = join(repo, 'dag.run.json');
  const manifest = plan(false, false);
  manifest.tasks = manifest.tasks.slice(0, 1);
  manifest.criteria = manifest.criteria.slice(0, 1);
  manifest.requirements = manifest.requirements.slice(0, 1);
  const run = compilePlan(manifest);
  Object.assign(run.settings, executionProfilePatch('lean'), { implementationAttempts: 1 });
  saveRun(run, file);
  let source = '';
  const underlying = executor(false, []);
  const runner = new DagRunner(run, { cwd: repo, file, persist: state => saveRun(state, file),
    executor: (task, context, command) => {
      if (command?.startsWith('worker-')) source = context.cwd!;
      return underlying(task, context, command);
    } });
  // Inject an external source edit at the boundary after local checkpointing.
  const boundary = runner as unknown as { landWorktree: (...args: unknown[]) => Promise<unknown> };
  const land = boundary.landWorktree.bind(runner);
  boundary.landWorktree = (...args) => {
    writeFileSync(join(source, 'docs/alpha.txt'), 'changed after acceptance');
    return land(...args);
  };
  await runner.start();
  const task = run.tasks.task_alpha!;
  assert.equal(task.status, 'completed');
  assert.ok(git(repo, ['ls-tree', '-r', '--name-only', `dag/${run.id}`]).stdout.includes('docs/alpha.txt'));
});

test('review still runs when configured but receives no manufactured check evidence', async () => {
  const repo = gitRepo(), file = join(repo, 'dag.run.json');
  const manifest = plan(false, false);
  manifest.tasks = manifest.tasks.slice(0, 1); manifest.criteria = manifest.criteria.slice(0, 1); manifest.requirements = manifest.requirements.slice(0, 1);
  manifest.tasks[0]!.reviewCmd = 'review';
  const run = compilePlan(manifest); Object.assign(run.settings, executionProfilePatch('lean'), { implementationAttempts: 1 });
  saveRun(run, file); let reviews = 0;
  const underlying = executor(false, []);
  await new DagRunner(run, { cwd: repo, file, persist: state => saveRun(state, file),
    reviewEvidence: () => ({ graphSignals: { securitySensitive: true } }),
    executor: async (task, context, command) => {
      if (command !== 'review') return underlying(task, context, command);
      reviews++; assert.equal(context.reviewEvidenceFile, undefined);
      writeFileSync(context.reviewOutputFile!, JSON.stringify({ verdict: 'pass', findings: [] }));
      return { exitCode: 0, output: '' };
    } }).start();
  assert.equal(reviews, 1); assert.equal(run.tasks.task_alpha!.status, 'completed');
});

test('lean downstream consumer sees both independently accepted producer outputs', async () => {
  const repo = gitRepo(), file = join(repo, 'dag.run.json'), seen: string[] = [];
  const checkCounts: Record<string, number> = {};
  const run = compilePlan(plan(false, true));
  Object.assign(run.settings, executionProfilePatch('lean'), { concurrency: 2, implementationAttempts: 1 });
  saveRun(run, file);
  const underlying = executor(true, seen);
  await new DagRunner(run, { cwd: repo, file, persist: state => saveRun(state, file), executor: (task, context, command) => {
    const payload = command?.match(/--file ["']([^"']+)["']/)?.[1];
    if (payload) {
      const { id } = JSON.parse(readFileSync(payload, 'utf8')) as PlanningCheck;
      checkCounts[id] = (checkCounts[id] ?? 0) + 1;
    }
    return underlying(task, context, command);
  } }).start();
  assert.deepEqual(Object.values(run.tasks).map(task => [task.id, task.status, task.result]).filter(([, status]) => status !== 'completed'), []);
  assert.deepEqual(seen, ['consumer observed both accepted producers']);
  assert.deepEqual(checkCounts, {}, 'local checks and declared input probes are deferred, not executed');
  const acceptedFiles = git(repo, ['ls-tree', '-r', '--name-only', `dag/${run.id}`]).stdout;
  for (const id of ['alpha', 'beta', 'consumer']) assert.ok(acceptedFiles.includes(`docs/${id}.txt`));
});

test('published acceptance with failed state save stops dispatch and recovers without implementing again', async () => {
  const repo = gitRepo(), file = join(repo, 'dag.run.json');
  const manifest = plan(false, false);
  manifest.tasks = manifest.tasks.slice(0, 1);
  manifest.criteria = manifest.criteria.slice(0, 1);
  manifest.requirements = manifest.requirements.slice(0, 1);
  const run = compilePlan(manifest);
  Object.assign(run.settings, executionProfilePatch('lean'), { concurrency: 1, implementationAttempts: 3 });
  saveRun(run, file);
  let implementations = 0;
  const underlying = executor(false, []);
  const execute: Executor = (task, context, command) => {
    if (command?.startsWith('worker-')) implementations++;
    return underlying(task, context, command);
  };
  await new DagRunner(run, { cwd: repo, file, executor: execute, persist: state => {
    if (Object.values(state.tasks).some(task => task.status === 'completed')) throw new Error('state volume unavailable');
    saveRun(state, file);
  } }).start();
  assert.equal(implementations, 1, 'accepted publication must never enter implementation retry');
  assert.notEqual(run.tasks.task_alpha!.status, 'completed', 'dependency release requires durable completed state');
  const restored = loadRun(file);
  await new DagRunner(restored, { cwd: repo, file, executor: execute, persist: state => saveRun(state, file) }).start();
  assert.equal(implementations, 1);
  assert.equal(restored.tasks.task_alpha!.status, 'completed');
  assert.equal(restored.tasks.task_alpha!.attempts, 1);
});
