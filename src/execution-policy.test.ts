import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionProfilePatch, captureExecutionPolicy, installedBuildIdentity } from './execution-policy.js';
import { addTask, loadRun, newRun, saveRun, setSettings } from './store.js';
import { DEFAULT_SETTINGS, validateSettingsPatch } from './types.js';
import { settingsCmd, runCmd } from './commands/run.js';
import { initCmd } from './commands/projects.js';
import { planningCmd } from './commands/planning.js';

test('current preset persists while historical settings remain readable', () => {
  const run = newRun('policy');
  assert.equal(run.settings.autoPlan, true);
  assert.equal(run.settings.worktree, 'none');
  setSettings(run, executionProfilePatch('lean'));
  assert.equal(run.settings.autoPlan, false);
  assert.equal(run.settings.worktree, 'task');
  assert.equal(run.settings.timeoutMs, 900_000);
  assert.equal(run.settings.mergeRounds, 1);
  assert.equal(run.settings.finalReviewRounds, 0);
  const file = join(mkdtempSync(join(tmpdir(), 'dag-profile-')), 'run.json');
  saveRun(run, file);
  assert.deepEqual(loadRun(file).settings, run.settings);
  assert.equal(DEFAULT_SETTINGS.autoPlan, true);
  assert.equal(validateSettingsPatch(executionProfilePatch('lean')).length, 0);
  assert.throws(() => executionProfilePatch('unknown'), /legacy execution preset is retired/);
  assert.throws(() => executionProfilePatch('legacy'), /legacy execution preset is retired/);
  assert.ok(validateSettingsPatch({ executionProfile: 'unknown' }).length);
});

test('new CLI runs use the current policy without selecting a profile', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dag-current-cli-')), 'run.json');
  const original = console.log; console.log = () => {};
  try { initCmd(['--file', file, '--objective', 'Current default', '--retries', '1']); }
  finally { console.log = original; }
  const run = loadRun(file);
  assert.equal(run.settings.executionProfile, 'flow3');
  assert.equal(run.settings.worktree, 'task'); assert.equal(run.settings.autoPlan, false);
  assert.equal(run.settings.implementationAttempts, 2); // Initial implementation plus one requested retry.
});

test('canonical CLI compilation uses the current policy by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dag-current-plan-')), file = join(root, 'run.json'), plan = join(root, 'plan.json');
  writeFileSync(plan, JSON.stringify({ version: 2, id: 'current-plan', title: 'Current plan', sources: [], requirements: [],
    semanticReview: { mode: 'off' }, criteria: [{ id: 'criterion', text: 'Output exists', stage: 'local', owner: 'task_output', contributors: ['task_output'], checks: ['check'] }],
    tasks: [{ id: 'task_output', title: 'Output', objective: 'Produce output', reviewBoundary: 'One file', requirements: [], acceptance: ['criterion'],
      files: [{ path: 'output.txt', role: 'implementation' }], checks: [{ id: 'check', program: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1000 }], cmd: 'worker' }] }));
  const original = console.log; console.log = () => {};
  try { await planningCmd(['compile', '--file', file, '--plan', plan, '--cwd', root]); }
  finally { console.log = original; }
  assert.equal(loadRun(file).settings.executionProfile, 'flow3');
});

test('historical CLI execution refuses without mutating saved history', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dag-historical-policy-')), 'run.json');
  const run = newRun('Historical'); saveRun(run, file);
  const before = readFileSync(file, 'utf8');
  await assert.rejects(runCmd(['--file', file]), /retired execution policy/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(loadRun(file).settings.worktree, 'none');
});

test('CLI profile accepts explicit overrides and read-only inspection', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dag-profile-cli-')), 'run.json');
  saveRun(newRun('CLI policy'), file);
  const original = console.log;
  const outputs: string[] = [];
  console.log = value => { outputs.push(String(value)); };
  try {
    settingsCmd(['--file', file, '--profile', 'lean', '--timeout', '120', '--merge-rounds', '1']);
    const run = loadRun(file);
    assert.equal(run.settings.executionProfile, 'lean');
    assert.equal(run.settings.timeoutMs, 120_000);
    assert.equal(run.settings.mergeRounds, 1);
    const rev = run.rev;
    settingsCmd(['--file', file, '--json']);
    assert.equal(JSON.parse(outputs.at(-1)!).timeoutMs, 120_000);
    assert.equal(loadRun(file).rev, rev);
    settingsCmd(['--file', file, '--effective', '--json']);
    assert.equal(JSON.parse(outputs.at(-1)!).lastExecution, null);
    assert.equal(loadRun(file).rev, rev);
  } finally { console.log = original; }
});

test('execution audit records immutable policies and protocol counters survive storage', () => {
  const run = newRun('snapshot');
  setSettings(run, executionProfilePatch('lean'));
  const task = addTask(run, { title: 'one', spec: 'Implement one behavior', cmd: 'echo ok', reviewRounds: 3, repairRounds: 2 });
  task.reviewProtocolAttempts = { [`1:reviewer`]: 2 };
  run.executionPolicy = captureExecutionPolicy(run, 'controller-managed');
  const snapshot = run.executionPolicy;
  assert.equal(snapshot.mode, 'controller-managed');
  assert.equal(snapshot.tasks[task.id].reviewRounds, 0);
  assert.equal(snapshot.tasks[task.id].savedReviewRounds, 3);
  assert.equal(snapshot.tasks[task.id].repairRounds, 0);
  run.settings.timeoutMs = 123;
  assert.equal(snapshot.settings.timeoutMs, 900_000);
  const file = join(mkdtempSync(join(tmpdir(), 'dag-policy-')), 'run.json');
  saveRun(run, file);
  const loaded = loadRun(file);
  assert.deepEqual(loaded.executionPolicy, snapshot);
  assert.deepEqual(loaded.tasks[task.id].reviewProtocolAttempts, task.reviewProtocolAttempts);
  const build = installedBuildIdentity();
  assert.match(build.sha256, /^[0-9a-f]{64}$/);
  assert.equal(build.sha256, snapshot.build.sha256);
  assert.ok(build.moduleRoot);
  assert.equal(build.version, '0.1.0');
});

test('audit resolves inherited planning and harness attempt budgets', () => {
  const run = newRun('inherited');
  run.settings.harnessChain = [{ harness: 'opencode' }, { harness: 'codex' }];
  const task = addTask(run, { title: 'inherited', spec: 'One behavior', cmd: null });
  const policy = captureExecutionPolicy(run);
  assert.equal(policy.tasks[task.id].maxAttempts, 2);
  assert.match(policy.tasks[task.id].planCmd!, /opencode/);
  assert.equal(policy.tasks[task.id].savedPlanCmd, null);
  assert.equal(captureExecutionPolicy(run, 'controller-managed').tasks[task.id].maxAttempts, 1);
  setSettings(run, executionProfilePatch('lean'));
  assert.equal(captureExecutionPolicy(run).tasks[task.id].planCmd, null);
});
