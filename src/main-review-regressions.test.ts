import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { addTask, loadRun, newRun, runPaths, saveRun } from './store.js';
import { DagRunner } from './runner.js';
import { gitRepo, tempDir } from './test-helpers.js';
import { compilePlan } from './planning/compile.js';
import { recordPlanningFailure } from './planning/runtime.js';
import type { PlanningFinding, PlanningManifest } from './planning/contracts.js';

const directories: string[] = [];
const fixture = (git = false): string => {
  const directory = git ? gitRepo() : tempDir();
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('nonzero preparation is non-blocking and the task still runs and lands', async () => {
  const root = fixture(true), run = newRun('Preparation failure');
  run.settings.worktree = 'task';
  run.settings.worktreePrepareCmd = 'prepare';
  const task = addTask(run, { title: 'Task', spec: '', cmd: 'work', planCmd: '' });
  const commands: string[] = [];
  await new DagRunner(run, { cwd: root, executor: async (_task, _ctx, cmd) => {
    commands.push(cmd!);
    return { output: cmd === 'prepare' ? 'Dependency installation failed' : 'work done', exitCode: cmd === 'prepare' ? 9 : 0 };
  } }).start();
  assert.deepEqual(commands, ['prepare', 'work']);
  assert.equal(task.status, 'completed');
});

test('nonzero planner stops work and preserves bounded fallback', async () => {
  const run = newRun('Planner failure');
  const task = addTask(run, { title: 'Task', spec: '', cmd: 'work', planCmd: 'plan', maxAttempts: 2 });
  const commands: string[] = [];
  await new DagRunner(run, { cwd: fixture(), executor: async (_task, _ctx, cmd) => {
    commands.push(cmd!);
    return { output: 'Cannot produce a plan', exitCode: 9 };
  } }).start();
  assert.deepEqual(commands, ['plan', 'plan']);
  assert.equal(task.status, 'failed');
  assert.equal(task.failureKind, 'plan');
  assert.equal(task.plan, null);
  assert.equal(task.attempts, 2);
});

for (const mode of ['run', 'per-task'] as const) {
  test(`${mode} final review rejects nonzero exit even with PASS output`, async () => {
    const run = newRun('Final review failure');
    if (mode === 'per-task') run.settings.worktree = 'task';
    run.settings.finalReview = mode;
    run.settings.finalReviewCmd = 'final-review';
    const task = addTask(run, { title: 'Task', spec: '', cmd: 'work', planCmd: '' });
    const runner = new DagRunner(run, { cwd: fixture(mode === 'per-task'), executor: async (_task, _ctx, cmd) => ({
      output: cmd === 'final-review' ? 'VERDICT: PASS' : 'done', exitCode: cmd === 'final-review' ? 9 : 0,
    }) });
    await runner.start();
    assert.equal(runner.result!.finalReview!.verdict, 'fail');
    assert.match(task.finalReview?.reason ?? runner.result!.finalReview!.reason, /(?:exit|reject)/);
    if (mode === 'per-task') assert.equal(task.status, 'failed');
  });
}

test('CLI reports isolation refusal as nonzero with the unfinished requested task', () => {
  const root = fixture(), file = join(root, 'dag.run.json'), run = newRun('Isolation refusal');
  run.settings.executionProfile = 'lean';
  const task = addTask(run, { title: 'Task', spec: '', cmd: 'node -e "process.exit(0)"', planCmd: '' });
  saveRun(run, file);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)),
    'run', '--file', file, '--worktree', 'task', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.stopped, true);
  assert.deepEqual(output.unfinished, [task.id]);
  assert.equal(loadRun(file).tasks[task.id].status, 'pending');
});

test('modern missing or incomplete checkpoints refuse replay; a valid backup remains usable', () => {
  const file = join(fixture(), 'dag.run.json'), run = newRun('State loss');
  const task = addTask(run, { title: 'Task', spec: '', cmd: 'work' });
  task.status = 'completed'; task.attempts = 1; task.attemptsInCycle = 1;
  saveRun(run, file);
  const state = runPaths(file).state;
  const good = readFileSync(state, 'utf8');
  rmSync(state);
  assert.throws(() => loadRun(file), /modern execution state/);
  writeFileSync(state, '{broken');
  assert.throws(() => loadRun(file), /modern execution state/);
  writeFileSync(`${state}.bak`, good);
  assert.equal(loadRun(file).tasks[task.id].status, 'completed');
  rmSync(`${state}.bak`);
  writeFileSync(state, JSON.stringify({ tasks: {} }));
  assert.throws(() => loadRun(file), /modern execution state/);
  writeFileSync(state, JSON.stringify({ tasks: { [task.id]: {} } }));
  assert.throws(() => loadRun(file), /modern execution state/);
});

test('genuine legacy single-file runs still migrate their completed state', () => {
  const file = join(fixture(), 'dag.run.json');
  writeFileSync(file, JSON.stringify({ storageVersion: 1, id: 'run_legacy', objective: 'Legacy',
    tasks: { task_done: { title: 'Done', spec: '', status: 'completed', attempts: 1, attemptsInCycle: 1 } } }));
  const run = loadRun(file);
  assert.equal(run.tasks.task_done.status, 'completed');
  assert.equal(run.tasks.task_done.attempts, 1);
  assert.ok(existsSync(runPaths(file).state));
});

test('chain planning respects autoPlan and explicit task planning policy', async () => {
  for (const scenario of [
    { auto: false, plan: null, chain: null, expected: 1 },
    { auto: false, plan: 'custom-plan', chain: null, expected: 2 },
    { auto: true, plan: '', chain: null, expected: 1 },
    { auto: true, plan: null, chain: [], expected: 1 },
    { auto: true, plan: null, chain: null, expected: 2 },
  ]) {
    const run = newRun('Planning policy');
    run.settings.autoPlan = scenario.auto;
    run.settings.harnessChain = [{ harness: 'codex' }];
    const task = addTask(run, { title: 'Task', spec: '', cmd: 'work', planCmd: scenario.plan, harnessChain: scenario.chain });
    const commands: string[] = [];
    await new DagRunner(run, { cwd: fixture(), executor: async (_task, _ctx, cmd) => {
      commands.push(cmd!); return { output: 'done', exitCode: 0 };
    } }).start();
    assert.equal(task.status, 'completed');
    assert.equal(commands.length, scenario.expected, JSON.stringify(scenario));
    if (scenario.plan) assert.equal(commands[0], scenario.plan);
    if (scenario.chain) assert.deepEqual(commands, ['work']);
  }
});

test('documented scope findings establish a hold while unsupported rules remain rejected', () => {
  const plan: PlanningManifest = { version: 2, id: 'plan', title: 'Plan', sources: [], requirements: [],
    criteria: [{ id: 'criterion', text: 'Works', stage: 'local', owner: 'task_one', contributors: ['task_one'], checks: ['check'] }],
    tasks: [{ id: 'task_one', title: 'Task', objective: 'One behavior', reviewBoundary: 'One behavior', requirements: [],
      acceptance: ['criterion'], checks: [{ id: 'check', program: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 1000 }] }],
    semanticReview: { mode: 'off' } };
  for (const rule of ['scope.oversized', 'scope.acceptance', 'scope.concerns']) {
    const run = compilePlan(plan);
    const finding: PlanningFinding = { id: rule, rule, tasks: ['task_one'], references: ['task_one'],
      evidence: ['Two independent behaviors in this task'], severity: 'error', blocking: true,
      message: 'Task scope needs splitting', correction: 'Separate the behaviors' };
    assert.equal(recordPlanningFailure(run, 'task_one', [finding], 'attempt:1'), false);
    assert.equal(recordPlanningFailure(run, 'task_one', [finding], 'attempt:2'), true);
    assert.deepEqual(run.planningState!.holds.task_one, [finding]);
    assert.equal(recordPlanningFailure(run, 'task_one', [{ ...finding, rule: 'unknown' }], 'attempt:3'), false);
  }
});

test('scheduler keeps failure status while draining independent jobs and blocking dependents', () => {
  for (const outcomes of [[7], [7, 0], [0]]) {
    const root = fixture(), files: string[] = [];
    for (const code of outcomes) {
      const file = join(root, `run-${files.length}.json`), run = newRun('Scheduled run');
      run.settings.executionProfile = 'lean';
      addTask(run, { title: 'Task', spec: '', cmd: `node -e "process.exit(${code})"`, planCmd: '' });
      saveRun(run, file); files.push(file);
    }
    const script = `import {addJob,runScheduler,loadSchedule} from ${JSON.stringify(new URL('./scheduler.js', import.meta.url).href)};
      const files=${JSON.stringify(files)};let first;
      for(const [i,file] of files.entries()){const job=addJob({name:'job-'+i,file,at:null,after:null,args:{}});first??=job.id;}
      ${outcomes[0] ? "addJob({name:'dependent',file:files[0],at:null,after:first,args:{}});" : ''}
      const code=await runScheduler({drain:true,pollMs:10});
      console.log('RESULT:'+JSON.stringify({code,jobs:loadSchedule().jobs}));process.exit(code);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true,
      timeout: 20000, env: { ...process.env, DAG_SCHEDULE: join(root, 'schedule.json'),
        DAG_REGISTRY: join(root, 'registry.json'), USERPROFILE: root, HOME: root } });
    assert.equal(result.status, outcomes.some(code => code !== 0) ? 1 : 0, result.stderr);
    const line = result.stdout.split(/\r?\n/).find(item => item.startsWith('RESULT:'));
    assert.ok(line, result.stdout);
    const data = JSON.parse(line.slice(7));
    assert.deepEqual(data.jobs.slice(0, outcomes.length).map((job: { status: string }) => job.status),
      outcomes.map(code => code ? 'failed' : 'done'));
    if (outcomes[0]) assert.equal(data.jobs.at(-1).status, 'blocked');
  }
});
