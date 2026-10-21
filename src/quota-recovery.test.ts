import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { compilePlan } from './planning/compile.js';
import { executionProfilePatch } from './execution-policy.js';
import { DagRunner, shellExecutor, type Executor } from './runner.js';
import { gitRepo, make } from './test-helpers.js';
import { saveRun, loadRun, runPaths, readLock, attemptLogPath } from './store.js';
import { claimQuotaContinuations, importStoppedQuotaPause, quotaVerificationDeadline } from './quota-recovery.js';
import { git } from './git-worktree.js';
import { codexStdin, codexWorkArgs } from './codex-transport.js';

const SESSION = '01a14064-3416-77b1-9448-c2b09bc757aa';
test('stopped quota migration preserves remaining active time after the original deadline expires', () => {
  const repo = gitRepo(), file = join(repo, 'dag.run.json'), { run } = make(['work']);
  const task = Object.values(run.tasks)[0]!;
  const pausedAt = new Date(Date.now() - 3_600_000).toISOString();
  Object.assign(task, { status: 'pending', failureKind: 'killed', attempts: 1, attemptsInCycle: 1,
    commit: git(repo, ['rev-parse', 'HEAD']).stdout, finishedAt: pausedAt,
    executionBudget: { version: 1, firstDispatchAt: new Date(Date.parse(pausedAt) - 480_000).toISOString(),
      deadlineAt: new Date(Date.parse(pausedAt) + 2_220_000).toISOString(), limit: 1, used: 1, infrastructureRetries: {} } });
  saveRun(run, file);
  mkdirSync(join(runPaths(file).dir, 'logs'), { recursive: true });
  writeFileSync(attemptLogPath(file, task.id, 1), `session id: ${SESSION}\n`);
  writeFileSync(join(runPaths(file).dir, 'pilot-status.json'), JSON.stringify({ status: 'quota_paused', updatedAt: pausedAt }));
  const budget = structuredClone(task.executionBudget);
  importStoppedQuotaPause(run, file, 'Recorded old supervisor quota pause');
  const [resumed] = claimQuotaContinuations(run, file, repo);
  assert.ok(resumed!.deadline - Date.now() > 2_219_000);
  assert.ok(resumed!.deadline - Date.now() <= 2_220_000);
  assert.deepEqual(task.executionBudget, budget);
  const verificationDeadline = quotaVerificationDeadline(run, file, task)!;
  assert.ok(verificationDeadline <= resumed!.deadline);
  assert.ok(verificationDeadline > Date.now());
  const directory = join(runPaths(file).dir, 'quota-pauses');
  const path = join(directory, readdirSync(directory)[0]!);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  const priorIdentity = { revision: record.revision, definition: record.tasks[task.id].definition };
  task.spec += ' approved amendment boundary';
  assert.throws(() => quotaVerificationDeadline(run, file, task), /unexpired active-time allowance/);
  assert.equal(quotaVerificationDeadline(run, file, task, priorIdentity), verificationDeadline);
  assert.throws(() => quotaVerificationDeadline(run, file, task, { ...priorIdentity, revision: 'unrelated' }), /unexpired active-time allowance/);
  assert.throws(() => quotaVerificationDeadline(run, file, task, { ...priorIdentity, definition: 'unrelated' }), /unexpired active-time allowance/);
  record.claimedAt = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(path, JSON.stringify(record));
  assert.throws(() => quotaVerificationDeadline(run, file, task), /unexpired active-time allowance/);
});
test('native Codex resume remains a subcommand after injected sandbox options', () => {
  const result = codexStdin('codex', codexWorkArgs('codex', ['exec', '-m', 'gpt-6-luna', 'resume', SESSION, 'continue saved work']));
  assert.deepEqual(result, { args: ['exec', '--sandbox', 'workspace-write', '-m', 'gpt-6-luna', 'resume', SESSION, '-'], prompt: 'continue saved work' });
});

for (const verificationOnly of [false, true]) test(`quota continuation preserves partial source and attempt${verificationOnly ? ' after implementation' : ' within implementation'}`, async () => {
  const repo = gitRepo(), file = join(repo, 'dag.run.json');
  const run = compilePlan({ version: 2, id: 'quota', title: 'Quota continuation', sources: [], requirements: [], semanticReview: { mode: 'off' },
    criteria: [{ id: 'C', text: 'Complete source exists', stage: 'local', owner: 'task_work', contributors: ['task_work'], checks: ['check'] }],
    tasks: [{ id: 'task_work', title: 'Work', objective: 'Complete source', reviewBoundary: 'One file', requirements: [], acceptance: ['C'], files: [{ path: 'owned.txt', role: 'implementation' }],
      cmd: 'codex exec {spec}', reviewCmd: 'review', maxAttempts: 1,
      checks: [{ id: 'check', program: process.execPath, args: ['-e', "if(require('fs').readFileSync('owned.txt','utf8')!=='complete')process.exit(1)"], timeoutMs: 10000 }] }] });
  Object.assign(run.settings, executionProfilePatch('lean'), { implementationAttempts: 1 }); saveRun(run, file);
  let first = true, implementationCalls = 0, resumedCalls = 0, blocked = false;
  const native = shellExecutor(repo);
  const executor: Executor = async (task, context, command) => {
    if (command?.startsWith('codex exec')) {
      implementationCalls++;
      if (first) {
        context.onOutput(`session id: ${SESSION}\n`);
        writeFileSync(join(context.cwd!, 'owned.txt'), verificationOnly ? 'complete' : 'partial');
        if (!verificationOnly) { blocked = true; return new Promise((_resolve, reject) => context.registerKill(() => reject(new Error('quota stop')))); }
        return { exitCode: 0, output: '' };
      }
      resumedCalls++;
      assert.match(command, new RegExp(`resume ${SESSION}`));
      assert.ok(command.includes(`--cd "${context.cwd!.replaceAll('\\', '/')}"`));
      assert.equal(readFileSync(join(context.cwd!, 'owned.txt'), 'utf8'), 'partial');
      writeFileSync(join(context.cwd!, 'owned.txt'), 'complete');
      return { exitCode: 0, output: '' };
    }
    if (command === 'review') {
      if (first && verificationOnly) { blocked = true; return new Promise((_resolve, reject) => context.registerKill(() => reject(new Error('quota stop')))); }
      writeFileSync(context.reviewOutputFile!, JSON.stringify({ verdict: 'pass', findings: [] }));
      return { exitCode: 0, output: '' };
    }
    return native(task, context, command);
  };
  const options = { cwd: repo, file, executor, persist: (state: typeof run) => saveRun(state, file), reviewEvidence: () => ({ graphSignals: { securitySensitive: true } }) };
  const runner = new DagRunner(run, options), active = runner.start();
  for (let i = 0; i < 200 && !blocked; i++) await delay(25);
  assert.equal(blocked, true, JSON.stringify({ task: run.tasks.task_work.result, events: run.events.slice(-6), summary: runner.result }));
  await delay(50); // drain the original worker's session header into its attempt log
  const budget = structuredClone(run.tasks.task_work.executionBudget);
  await runner.stop('quota'); await active;
  const paused = loadRun(file), task = paused.tasks.task_work;
  assert.equal(task.status, 'pending'); assert.equal(task.failureKind, 'killed'); assert.ok(task.commit);
  assert.deepEqual(task.executionBudget, budget);
  const pauseFile = join(runPaths(file).dir, 'quota-pauses', readdirSync(join(runPaths(file).dir, 'quota-pauses'))[0]!);
  const record = readFileSync(pauseFile, 'utf8');
  const changed = structuredClone(paused); changed.tasks.task_work.attempts++;
  assert.throws(() => claimQuotaContinuations(changed, file, repo), /checkpoint mismatch/);
  assert.equal(readFileSync(pauseFile, 'utf8'), record, 'invalid admission must not consume the pause');
  for (const mutate of [
    (state: typeof paused) => { state.tasks.task_work.commit = '0'.repeat(40); },
    (state: typeof paused) => { state.tasks.task_work.status = 'failed'; },
    (state: typeof paused) => { state.tasks.task_work.status = 'completed'; },
    (state: typeof paused) => { state.tasks.task_work.executionBudget!.used = 0; },
    (state: typeof paused) => { state.tasks.task_work.spec += 'changed acceptance'; },
  ]) {
    const invalid = structuredClone(paused); mutate(invalid);
    assert.throws(() => claimQuotaContinuations(invalid, file, repo), /checkpoint mismatch/);
  }
  const corrupt = JSON.parse(record); corrupt.tasks.task_work.remainingMs = -1;
  writeFileSync(pauseFile, JSON.stringify(corrupt));
  assert.throws(() => claimQuotaContinuations(paused, file, repo), /checkpoint mismatch/);
  writeFileSync(pauseFile, record);

  assert.throws(() => importStoppedQuotaPause(paused, file, 'invent pause'), /ENOENT/);
  first = false;
  await new DagRunner(paused, { ...options, quotaRecovery: true }).start();
  assert.equal(paused.tasks.task_work.status, 'completed', paused.tasks.task_work.result ?? '');
  assert.equal(paused.tasks.task_work.attempts, 1); assert.equal(paused.tasks.task_work.attemptsInCycle, 1);
  assert.deepEqual(paused.tasks.task_work.executionBudget, budget);
  assert.equal(implementationCalls, verificationOnly ? 1 : 2); assert.equal(resumedCalls, verificationOnly ? 0 : 1);
  assert.equal(git(repo, ['show', `dag/${run.id}:owned.txt`]).stdout, 'complete');
  await assert.rejects(new DagRunner(paused, { ...options, quotaRecovery: true }).start(), /unconsumed quota pause/);
  assert.equal(readLock(file), null);
});
