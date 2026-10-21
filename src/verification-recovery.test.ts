import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compilePlan, planningDefinition } from './planning/compile.js';
import { amendPlan } from './planning/amend.js';
import { executionProfilePatch } from './execution-policy.js';
import { DagRunner, shellExecutor, type Executor } from './runner.js';
import { gitRepo } from './test-helpers.js';
import { git } from './git-worktree.js';
import { saveRun, loadRun, readLock } from './store.js';

for (const amended of [false, true]) test(`verification recovery preserves the spent implementation allowance and publishes only checked saved source${amended ? ' after a committed amendment' : ''}`, async () => {
  const repo = gitRepo(), file = join(repo, 'dag.run.json');
  const cache = 'scripts/__pycache__/audit.cpython-314.pyc';
  const run = compilePlan({ version: 2, id: 'recover', title: 'Recover saved audit', sources: [], requirements: [], semanticReview: { mode: 'off' },
    criteria: [{ id: 'C-audit', text: 'Audit source exists', stage: 'local', owner: 'task_audit', contributors: ['task_audit'], checks: ['audit-check'] }],
    tasks: [{ id: 'task_audit', title: 'Audit', objective: 'Produce audit source', reviewBoundary: 'One script', requirements: [], acceptance: ['C-audit'],
      files: [{ path: 'scripts/audit.py', role: 'implementation' }], cmd: 'work', reviewCmd: 'review', maxAttempts: 1,
      checks: [{ id: 'audit-check', program: process.execPath, args: ['-e', "if(!require('fs').existsSync('scripts/audit.py')||process.env.PYTHONDONTWRITEBYTECODE!=='1'||!process.env.PYTHONPYCACHEPREFIX)process.exit(1)"], timeoutMs: 10000 }] }] });
  Object.assign(run.settings, executionProfilePatch('lean'), { implementationAttempts: 1 }); saveRun(run, file);
  const native = shellExecutor(repo); let workers = 0, reviews = 0, rejectFirstReview = true;
  const executor: Executor = async (task, context, command) => {
    if (command === 'work') {
      workers++; mkdirSync(join(context.cwd!, 'scripts/__pycache__'), { recursive: true });
      writeFileSync(join(context.cwd!, 'scripts/audit.py'), 'print("audit")\n');
      writeFileSync(join(context.cwd!, cache), 'generated cache');
      return { exitCode: 0, output: 'saved audit' };
    }
    if (command === 'review') {
      reviews++;
      writeFileSync(context.reviewOutputFile!, JSON.stringify(rejectFirstReview ? { verdict: 'fail', findings: [{
        id: 'incidental-cache', severity: 'error', blocking: true,
        message: 'Generated cache file is outside planned ownership',
        correction: 'Remove the incidental __pycache__ artifact from the candidate',
        evidence: [{ reference: 'scripts/audit.py', observation: 'Candidate also contains scripts/__pycache__/audit.cpython-314.pyc' }],
      }] } : { verdict: 'pass', findings: [] }));
      return { exitCode: 0, output: '' };
    }
    return native(task, context, command);
  };
  const options = { cwd: repo, file, persist: (state: typeof run) => saveRun(state, file), executor,
    reviewEvidence: () => ({ graphSignals: { securitySensitive: true } }) };
  await new DagRunner(run, options).start();
  assert.equal(run.tasks.task_audit.status, 'failed'); assert.equal(run.tasks.task_audit.failureKind, 'review');
  assert.match(run.tasks.task_audit.result!, /review rejected/);
  assert.equal(reviews, 1, 'the reviewer rejects the incidental cache before recovery');
  run.tasks.task_audit.executionBudget!.deadlineAt = '2000-01-01T00:00:00.000Z'; saveRun(run, file);
  const budget = structuredClone(run.tasks.task_audit.executionBudget);
  let restored = loadRun(file);
  await assert.rejects(new DagRunner(restored, { ...options, verificationRecovery: { taskId: 'task_audit', reason: 'invalid cleanup', removeGenerated: ['other/__pycache__/audit.cpython-314.pyc'] } }).start(), /owned source/);
  assert.equal(readLock(file), null);
  if (amended) {
    restored.tasks.task_audit.status = 'pending'; saveRun(restored, file);
    await assert.rejects(new DagRunner(restored, { ...options, verificationRecovery: { taskId: 'task_audit', reason: 'Unproven pending task' } }).start(), /committed planning amendment/);
    assert.equal(readLock(file), null);
    restored.tasks.task_audit.status = 'failed'; saveRun(restored, file);
    const manifest = structuredClone(restored.planning!.manifest);
    manifest.tasks[0]!.objective = 'Verify saved audit source after correcting its acceptance scope';
    amendPlan(file, manifest, 'Correct audit acceptance boundary without spending another implementation attempt');
    restored = loadRun(file);
    assert.equal(restored.tasks.task_audit.status, 'pending');
    assert.equal(restored.tasks.task_audit.attempts, 1);
    assert.deepEqual(restored.tasks.task_audit.executionBudget, budget);
    const journalPath = join(repo, 'dag.run.d/planning-amendment.json');
    const journalText = readFileSync(journalPath, 'utf8'), journal = JSON.parse(journalText);
    journal.previousRun.tasks.task_audit.executionBudget.implementationAttemptsUsed = 0;
    writeFileSync(journalPath, JSON.stringify(journal));
    await assert.rejects(new DagRunner(restored, { ...options, verificationRecovery: { taskId: 'task_audit', reason: 'Corrupt amendment proof' } }).start(), /committed planning amendment/);
    assert.equal(readLock(file), null);
    writeFileSync(journalPath, journalText);
    const unconsumed = structuredClone(restored);
    unconsumed.tasks.task_audit.attempts++;
    await assert.rejects(new DagRunner(unconsumed, { ...options, verificationRecovery: { taskId: 'task_audit', reason: 'Attempt changed since amendment' } }).start(), /committed planning amendment/);
    assert.equal(readLock(file), null);
  }
  const source = restored.tasks.task_audit.commit!;
  const successor = git(repo, ['-c', 'user.name=dag-test', '-c', 'user.email=dag@test', 'commit-tree', git(repo, ['rev-parse', `${source}^{tree}`]).stdout, '-p', source, '-m', 'Operator validation successor']).stdout;
  if (!amended) {
    const quotaDirectory = join(repo, 'dag.run.d/quota-pauses'); mkdirSync(quotaDirectory, { recursive: true });
    writeFileSync(join(quotaDirectory, 'expired.json'), JSON.stringify({ version: 1, id: 'expired', runId: restored.id,
      revision: restored.planning!.revision, claimedAt: '2000-01-01T00:00:00.000Z', tasks: { task_audit: {
        priorTask: structuredClone(restored.tasks.task_audit), definition: planningDefinition(restored.tasks.task_audit), remainingMs: 1000,
      } } }));
    await assert.rejects(new DagRunner(restored, { ...options, verificationRecovery: { taskId: 'task_audit',
      reason: 'Default must respect expired quota allowance', sourceCommit: successor, removeGenerated: [cache] } }).start(), /unexpired active-time allowance/);
    assert.equal(readLock(file), null); assert.deepEqual(restored.tasks.task_audit.executionBudget, budget); assert.equal(workers, 1);
  }
  rejectFirstReview = false;
  await new DagRunner(restored, { ...options, verificationRecovery: { taskId: 'task_audit', reason: 'Remove incidental cache and verify saved code', sourceCommit: successor, removeGenerated: [cache], extendTime: !amended } }).start();
  assert.equal(workers, 1); assert.equal(restored.tasks.task_audit.status, 'completed', JSON.stringify({ result: restored.tasks.task_audit.result, events: restored.events.slice(-8) })); assert.equal(reviews, 2, 'recovered source still receives a fresh agent review');
  assert.equal(restored.tasks.task_audit.attempts, 1); assert.deepEqual(restored.tasks.task_audit.executionBudget, budget);
  const accepted = git(repo, ['ls-tree', '-r', '--name-only', `dag/${run.id}`]).stdout;
  assert.ok(accepted.includes('scripts/audit.py')); assert.ok(!accepted.includes('__pycache__'));
  const recovery = JSON.parse(readFileSync(join(repo, 'dag.run.d/recoveries', readdirSync(join(repo, 'dag.run.d/recoveries'))[0]!), 'utf8'));
  assert.equal(recovery.priorTask.status, amended ? 'pending' : 'failed'); assert.equal(recovery.implementationAttemptsPreserved, 1);
  if (amended) assert.equal(recovery.amendmentRevision, restored.planning!.revision);
  else {
    assert.equal(recovery.timeException.originalDeadlineAt, budget!.deadlineAt);
    assert.equal(recovery.timeException.effectiveOldDeadlineAt, null);
    assert.equal(recovery.timeException.effectiveOldDeadlineKnown, false);
    assert.equal(recovery.timeException.reason, 'Remove incidental cache and verify saved code');
    assert.equal(recovery.timeException.verificationOnly, true);
    const granted = Date.parse(recovery.timeException.newDeadlineAt) - Date.parse(recovery.requestedAt);
    assert.ok(granted > 2_699_000 && granted <= 2_700_000);
  }
  await assert.rejects(new DagRunner(restored, { ...options, verificationRecovery: { taskId: 'task_audit', reason: 'Do not reopen accepted work' } }).start(), /stopped failed task/);
  assert.equal(readLock(file), null);
  assert.equal(restored.tasks.task_audit.status, 'completed');
});

test('approved fresh verification window accepts an amended attempt that exhausted time in integration without rerunning implementation', async () => {
  const repo = gitRepo(), file = join(repo, 'dag.run.json');
  const run = compilePlan({ version: 2, id: 'amended-time', title: 'Amended verification time', sources: [], requirements: [], semanticReview: { mode: 'off' },
    criteria: [{ id: 'C', text: 'Owned source passes', stage: 'local', owner: 'task_work', contributors: ['task_work'], checks: ['check'] }],
    tasks: [{ id: 'task_work', title: 'Work', objective: 'Write one file', reviewBoundary: 'One file', requirements: [], acceptance: ['C'], files: [{ path: 'owned.txt', role: 'implementation' }],
      cmd: 'work', reviewCmd: 'review', maxAttempts: 1, checks: [{ id: 'check', program: process.execPath,
        args: ['-e', "if(require('fs').readFileSync('owned.txt','utf8')!=='complete')process.exit(1)"], timeoutMs: 30000 }] }] });
  Object.assign(run.settings, executionProfilePatch('lean'), { implementationAttempts: 1 }); saveRun(run, file);
  let workers = 0, reviews = 0, exhaustReview = false, rejectFirstReview = true;
  const native = shellExecutor(repo);
  const executor: Executor = async (task, context, command) => {
    if (command === 'work') { workers++; writeFileSync(join(context.cwd!, 'owned.txt'), 'complete'); return { exitCode: 0, output: 'saved source needs acceptance correction' }; }
    if (command === 'review') {
      reviews++;
      if (exhaustReview) return new Promise((_resolve, reject) => context.registerKill(() => reject(Object.assign(new Error('execution time exhausted in candidate review'), { kind: 'budget' }))));
      writeFileSync(context.reviewOutputFile!, JSON.stringify(rejectFirstReview ? { verdict: 'fail', findings: [{
        id: 'boundary', severity: 'error', blocking: true, message: 'Current boundary rejects saved source',
        correction: 'Correct the acceptance boundary', evidence: [{ reference: 'owned.txt', observation: 'Saved source does not meet the corrected boundary' }],
      }] } : { verdict: 'pass', findings: [] }));
      return { exitCode: 0, output: '' };
    }
    return native(task, context, command);
  };
  const options = { cwd: repo, file, executor, persist: (state: typeof run) => saveRun(state, file), reviewEvidence: () => ({ graphSignals: { securitySensitive: true } }) };
  await new DagRunner(run, options).start(); assert.equal(run.tasks.task_work.status, 'failed'); assert.equal(run.tasks.task_work.failureKind, 'review');
  rejectFirstReview = false;
  const oldRevision = run.planning!.revision, oldDefinition = planningDefinition(run.tasks.task_work);
  const manifest = structuredClone(run.planning!.manifest); manifest.tasks[0]!.objective = 'Verify saved source against corrected boundary';
  amendPlan(file, manifest, 'Preserve source and correct acceptance boundary');
  let restored = loadRun(file);
  const quotaDirectory = join(repo, 'dag.run.d/quota-pauses'); mkdirSync(quotaDirectory, { recursive: true });
  writeFileSync(join(quotaDirectory, 'prior-claim.json'), JSON.stringify({ version: 1, id: 'prior-claim', runId: run.id, revision: oldRevision,
    claimedAt: new Date().toISOString(), tasks: { task_work: { priorTask: structuredClone(run.tasks.task_work), definition: oldDefinition, remainingMs: 12000 } } }));
  exhaustReview = true;
  await new DagRunner(restored, { ...options, verificationRecovery: { taskId: 'task_work', reason: 'Verify corrected boundary without implementation' } }).start();
  assert.equal(restored.tasks.task_work.status, 'failed'); assert.equal(restored.tasks.task_work.failureKind, 'budget'); assert.equal(reviews, 2);
  const budget = structuredClone(restored.tasks.task_work.executionBudget);
  await assert.rejects(new DagRunner(restored, { ...options, verificationRecovery: { taskId: 'task_work', reason: 'Default remains bounded' } }).start(), /unexpired active-time allowance/);
  assert.equal(readLock(file), null);
  exhaustReview = false; restored = loadRun(file);
  await new DagRunner(restored, { ...options, verificationRecovery: { taskId: 'task_work', reason: 'User approved a fresh verification-only window', extendTime: true } }).start();
  assert.equal(restored.tasks.task_work.status, 'completed', restored.tasks.task_work.result ?? '');
  assert.equal(workers, 1); assert.equal(reviews, 3); assert.equal(restored.tasks.task_work.attempts, 1);
  assert.deepEqual(restored.tasks.task_work.executionBudget, budget);
  assert.equal(git(repo, ['show', `dag/${run.id}:owned.txt`]).stdout, 'complete');
  const journal = readdirSync(join(repo, 'dag.run.d/recoveries')).map(name => JSON.parse(readFileSync(join(repo, 'dag.run.d/recoveries', name), 'utf8'))).find(record => record.timeException);
  assert.equal(journal.timeException.effectiveOldDeadlineAt, null); assert.equal(journal.timeException.verificationOnly, true);
});
