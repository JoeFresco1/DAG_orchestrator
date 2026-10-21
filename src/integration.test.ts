import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, createTaskWorktree, ensureIntegrationWorktree, git, headCommit } from './git-worktree.js';
import { integrateVerifiedCandidate, reconcileIntegrationReceipt } from './integration.js';
import type { IntegrationOptions, IntegrationReceipt } from './integration.js';
import { gitRepo, tempDir } from './test-helpers.js';

function fixture(): IntegrationOptions {
  const repoDir = gitRepo();
  const runId = `candidate-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const integration = ensureIntegrationWorktree(repoDir, runId);
  const task = createTaskWorktree(repoDir, runId, 'producer', integration.branch);
  writeFileSync(join(task.path, 'producer.txt'), 'output');
  commitAll(task.path, 'producer output');
  return { repoDir, integrationWorktree: integration.path, integrationBranch: integration.branch,
    taskBranch: task.branch, taskId: 'producer', attempt: 1, attemptId: 'durable-attempt-1', runId,
    receiptFile: join(tempDir(), 'acceptance.json'), isCurrentAttempt: () => true,
    verify: async () => ({ passed: true, checks: [{ command: 'behavior', passed: true }] }) };
}

function accepted(options: IntegrationOptions): string {
  return git(options.repoDir, ['rev-parse', options.integrationBranch]).stdout;
}

test('clean textual merge that fails behavior leaves accepted head unchanged and preserves candidate', async () => {
  const options = fixture();
  const before = accepted(options);
  options.verify = async (candidate) => {
    assert.equal(readFileSync(join(candidate, 'producer.txt'), 'utf8'), 'output');
    assert.equal(accepted(options), before);
    return { passed: false, detail: 'behavior fails' };
  };
  assert.equal((await integrateVerifiedCandidate(options)).merged, false);
  assert.equal(accepted(options), before);
  const rejection = JSON.parse(readFileSync(`${options.receiptFile}.rejected.json`, 'utf8'));
  assert.equal(rejection.stage, 'rejected');
  assert.equal(rejection.verification.detail, 'behavior fails');
  assert.ok(git(options.repoDir, ['for-each-ref', '--format=%(refname)', 'refs/dag-candidates/']).stdout);
});

test('verified candidate publishes exact commit without changing user branch or index', async () => {
  const options = fixture();
  const userHead = headCommit(options.repoDir);
  const result = await integrateVerifiedCandidate(options);
  assert.equal(result.merged, true);
  assert.equal(accepted(options), result.commit);
  assert.equal(headCommit(options.repoDir), userHead);
  assert.equal(git(options.repoDir, ['status', '--porcelain']).stdout, '');
  assert.equal(git(options.integrationWorktree, ['symbolic-ref', '--quiet', 'HEAD']).code, 1);
  assert.equal(result.receipt?.stage, 'published');
});

test('second producer builds on previously accepted producer and sees both outputs', async () => {
  const options = fixture();
  const base = accepted(options);
  const second = createTaskWorktree(options.repoDir, options.runId!, 'second', base);
  writeFileSync(join(second.path, 'second.txt'), 'second output');
  commitAll(second.path, 'second output');
  assert.equal((await integrateVerifiedCandidate(options)).merged, true);
  const next: IntegrationOptions = { ...options, taskId: 'second', taskBranch: second.branch,
    receiptFile: join(tempDir(), 'second.json'), verify: async (candidate) => {
      assert.equal(readFileSync(join(candidate, 'producer.txt'), 'utf8'), 'output');
      assert.equal(readFileSync(join(candidate, 'second.txt'), 'utf8'), 'second output');
      return { passed: true };
    } };
  assert.equal((await integrateVerifiedCandidate(next)).merged, true);
  assert.equal(reconcileIntegrationReceipt(options)?.merged, true);
});

test('recovery finalizes publication intent without verifying or republishing', async () => {
  const options = fixture();
  await integrateVerifiedCandidate(options);
  const publishedHead = accepted(options);
  const receipt = JSON.parse(readFileSync(options.receiptFile, 'utf8')) as IntegrationReceipt;
  receipt.stage = 'intent';
  writeFileSync(options.receiptFile, JSON.stringify(receipt));
  options.verify = async () => { throw new Error('must not verify published acceptance again'); };
  const result = await integrateVerifiedCandidate(options);
  assert.equal(result.merged, true);
  assert.equal(result.receipt?.stage, 'published');
  assert.equal(accepted(options), publishedHead);
});

test('intent without publication is reverified against accepted history', async () => {
  const options = fixture();
  await integrateVerifiedCandidate(options);
  const receipt = JSON.parse(readFileSync(options.receiptFile, 'utf8')) as IntegrationReceipt;
  assert.equal(git(options.repoDir, ['update-ref', `refs/heads/${options.integrationBranch}`, receipt.expectedHead, receipt.candidateCommit]).code, 0);
  receipt.stage = 'intent';
  writeFileSync(options.receiptFile, JSON.stringify(receipt));
  let checks = 0;
  options.verify = async () => { checks++; return { passed: true }; };
  assert.equal((await integrateVerifiedCandidate(options)).merged, true);
  assert.equal(checks, 1);
});

test('candidate mutation and stale attempts cannot publish', async () => {
  const options = fixture();
  const before = accepted(options);
  options.verify = async (candidate) => { writeFileSync(join(candidate, 'producer.txt'), 'changed'); return { passed: true }; };
  assert.equal((await integrateVerifiedCandidate(options)).merged, false);
  assert.equal(accepted(options), before);
  let current = true;
  options.isCurrentAttempt = () => current;
  options.verify = async () => { current = false; return { passed: true }; };
  assert.equal((await integrateVerifiedCandidate(options)).merged, false);
  assert.equal(accepted(options), before);
});

test('cross-process accepted-head change rejects compare-and-swap publication', async () => {
  const options = fixture();
  const alternate = git(options.repoDir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree',
    `${headCommit(options.repoDir)}^{tree}`, '-p', headCommit(options.repoDir), '-m', 'other publisher']).stdout;
  options.verify = async () => {
    git(options.repoDir, ['update-ref', `refs/heads/${options.integrationBranch}`, alternate]);
    return { passed: true };
  };
  const result = await integrateVerifiedCandidate(options);
  assert.equal(result.merged, false);
  assert.equal(result.conflict, true);
  assert.equal(accepted(options), alternate);
});

test('receipt with different durable attempt identity fails closed', async () => {
  const options = fixture();
  await integrateVerifiedCandidate(options);
  options.attemptId = 'later-attempt';
  assert.throws(() => reconcileIntegrationReceipt(options), /stale/);
});

test('verification exceptions persist rejected candidate identity without publication', async () => {
  const options = fixture(), before = accepted(options);
  options.verify = async () => { throw new Error('prepare failed'); };
  const result = await integrateVerifiedCandidate(options);
  assert.equal(result.merged, false);
  assert.equal(accepted(options), before);
  const rejected = JSON.parse(readFileSync(`${options.receiptFile}.rejected.json`, 'utf8'));
  assert.equal(rejected.candidateCommit, result.commit);
  assert.match(rejected.verification.detail, /prepare failed/);
});

test('receipt corruption and policy changes fail closed on recovery', async () => {
  const options = fixture();
  options.evidence = { policyFingerprint: 'original', manifestFingerprint: 'manifest' };
  await integrateVerifiedCandidate(options);
  options.evidence = { policyFingerprint: 'changed' };
  assert.throws(() => reconcileIntegrationReceipt(options), /policyFingerprint/);
  options.evidence = { policyFingerprint: 'original' };
  const receipt = JSON.parse(readFileSync(options.receiptFile, 'utf8')) as IntegrationReceipt;
  receipt.verification.checks = [];
  writeFileSync(options.receiptFile, JSON.stringify(receipt));
  assert.throws(() => reconcileIntegrationReceipt(options), /Invalid/);
});

test('receipt finalization failure after CAS returns accepted result and recovers flushed intent', async (t) => {
  const options = fixture();
  const rename = fs.renameSync;
  let writes = 0;
  const mocked = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (++writes > 1) throw new Error('receipt finalization unavailable');
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await integrateVerifiedCandidate(options);
    assert.equal(result.merged, true);
    assert.equal(accepted(options), result.commit);
    assert.equal(JSON.parse(readFileSync(options.receiptFile, 'utf8')).stage, 'intent');
    assert.equal(reconcileIntegrationReceipt(options)?.merged, true);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(reconcileIntegrationReceipt(options)?.receipt?.stage, 'published');
});
