import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diagnoseBeforeWork, diagnosticBoundary, diagnosticRepairProfile, validateDiagnosis, restoreFrozenBaseline,
  rejectedWorkAttemptIds, pinAttemptProfile, readAttemptProfile, launchDiagnosis } from './core.mjs';

const valid = { category: 'implementation', cause: 'The output denominator excludes missing observations.',
  evidence: ['existing denominator regression failed'], action: 'repair_in_scope',
  repair: 'Correct the denominator in the owned implementation.', verification: ['run declared denominator test'] };
function setup() {
  return { controllerRoot: mkdtempSync(join(tmpdir(), 'dag-diagnostics-')), cwd: process.cwd(), runId: 'run_test',
    taskId: 'task_test', unit: { key: 'unit_test', files: ['src/owned.ts'], acceptance: [{ program: 'node', args: ['test.js'] }] },
    events: [], rejectedAttempts: [1, 2, 3], policy: { diagnostics: { enabled: true, afterRejections: 3 } } };
}
test('diagnosis is triggered after three failures, with bounded interval validation', () => {
  assert.equal(diagnosticBoundary(2), 0); assert.equal(diagnosticBoundary(3), 3);
  assert.equal(diagnosticBoundary(4), 3); assert.equal(diagnosticBoundary(6), 6);
  assert.throws(() => diagnosticBoundary(3, 0));
});
test('diagnostic repair keeps the last tier once, never skips availability or adds budget', () => {
  const workers = [{ model: 'luna', attempts: 3 }, { model: 'sol-medium', attempts: 3 }, { model: 'sol-high', attempts: 4 }];
  for (const [boundary, model] of [[3, 'luna'], [6, 'sol-medium'], [9, 'sol-high']]) {
    assert.equal(diagnosticRepairProfile({ workers }, { boundary, freshRepair: true }, {}).model, model);
  }
  const current = { model: 'sol-medium' };
  assert.equal(diagnosticRepairProfile({ workers }, { freshRepair: false }, current), current);
  assert.throws(() => diagnosticRepairProfile({ workers, unavailableModels: { luna: true } }, { boundary: 3, freshRepair: true }, {}), /unavailable/);
  assert.throws(() => diagnosticRepairProfile({ workers }, { boundary: 12, freshRepair: true }, {}), /cannot extend/);
});
test('same evidence launches exactly one fresh diagnostic; one repair before normal ladder', async () => {
  const input = setup(); let launches = 0;
  const launch = async ({ prompt }) => { launches++; assert.match(prompt, /Read-only/); return valid; };
  assert.equal((await diagnoseBeforeWork({ ...input, launch })).freshRepair, true);
  assert.equal((await diagnoseBeforeWork({ ...input, rejectedAttempts: [1, 2, 3, 4], launch })).freshRepair, false);
  assert.equal(launches, 1);
  await diagnoseBeforeWork({ ...input, rejectedAttempts: [1, 2, 3, 4, 5, 6], launch });
  assert.equal(launches, 2);
});
test('malformed output and authority-changing proposals fail closed', () => {
  assert.throws(() => validateDiagnosis({ ...valid, ownedFiles: ['anywhere'] }));
  assert.throws(() => validateDiagnosis({ ...valid, evidence: [] }));
  for (const category of ['contract_or_ownership', 'environment', 'resource', 'unknown']) {
    assert.throws(() => validateDiagnosis({ ...valid, category }));
    assert.doesNotThrow(() => validateDiagnosis({ ...valid, category, action: 'hold' }));
  }
});
test('a changed accepted contract cannot reuse an old diagnostic authorization', async () => {
  const input = setup(); let launches = 0;
  mkdirSync(join(input.controllerRoot, 'docs/build'), { recursive: true });
  const path = join(input.controllerRoot, 'docs/build/contract-lock.json');
  writeFileSync(path, '{"contract":"revision1"}');
  const launch = async () => { launches++; return valid; };
  await diagnoseBeforeWork({ ...input, launch });
  writeFileSync(path, '{"contract":"revision2"}');
  await diagnoseBeforeWork({ ...input, launch });
  assert.equal(launches, 2);
});
test('contract blocker holds before implementation or escalation; persists evidence', async () => {
  const input = setup(); let launches = 0;
  const launch = async () => { launches++; return { ...valid, category: 'contract_or_ownership', action: 'hold' }; };
  await assert.rejects(diagnoseBeforeWork({ ...input, launch }), /DIAGNOSTIC_HOLD/);
  await assert.rejects(diagnoseBeforeWork({ ...input, launch }), /DIAGNOSTIC_HOLD/);
  assert.equal(launches, 1);
});
test('provider failures and interrupted diagnosis are not repeatedly relaunched', async () => {
  const input = setup(); let launches = 0;
  const launch = async () => { launches++; throw new Error('usage limit'); };
  await assert.rejects(diagnoseBeforeWork({ ...input, launch }), /usage limit/);
  await assert.rejects(diagnoseBeforeWork({ ...input, launch }), /already attempted/);
  assert.equal(launches, 1);
  const dir = join(input.controllerRoot, '.dag-build/diagnostics/run_test/task_test');
  const record = readdirSync(dir).find((name) => /^3-/.test(name));
  assert.equal(JSON.parse(readFileSync(join(dir, record))).status, 'failed');
});
test('unfailed tasks and disabled policy do not consume diagnostic budget', async () => {
  const input = setup(), launch = async () => { throw new Error('must not launch'); };
  assert.equal(await diagnoseBeforeWork({ ...input, rejectedAttempts: [1, 2], launch }), null);
  assert.equal(await diagnoseBeforeWork({ ...input, policy: {}, launch }), null);
});
test('frozen-file recovery restores only the accepted Git baseline, never adopts new policy', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dag-frozen-recovery-'));
  const git = (...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(cwd, 'contract.md'), 'accepted\n'); git('add', '.'); git('commit', '-m', 'baseline');
  const expected = createHash('sha256').update('accepted\n').digest('hex');
  writeFileSync(join(cwd, 'contract.md'), 'weakened\n');
  assert.deepEqual(restoreFrozenBaseline(cwd, { 'contract.md': expected }), ['contract.md']);
  assert.equal(readFileSync(join(cwd, 'contract.md'), 'utf8').replace(/\r\n/g, '\n'), 'accepted\n');
  writeFileSync(join(cwd, 'contract.md'), 'preserve me\n');
  assert.throws(() => restoreFrozenBaseline(cwd, { 'contract.md': 'wronghash' }), /does not match/);
  assert.equal(readFileSync(join(cwd, 'contract.md'), 'utf8'), 'preserve me\n');
  assert.throws(() => restoreFrozenBaseline(cwd, { '../outside.md': expected }), /escapes/);
});
test('routing notes and duplicate rejection events do not inflate failures; quota failures are excluded', () => {
  const event = (type, message) => ({ taskId: 'task_x', type, message });
  const events = [event('task-start', 'using harness codex'), event('task-review', 'reviewer rejected the work: orphan event'),
    event('task-start', 'attempt 1 (cycle 1/3)'), event('task-start', 'falling back to codex'),
    event('task-review', 'reviewer rejected the work: actual defect'), event('task-fail', 'failed (review): reviewer rejected the work'),
    event('task-start', 'attempt 2 (cycle 2/3)'), event('task-review', 'reviewer rejected the work: usage limit'),
    event('task-start', 'attempt 3 (cycle 3/3)'), event('task-fail', 'failed (timeout): infrastructure')];
  assert.deepEqual(rejectedWorkAttemptIds(events, 'task_x'), [1]);
});
test('reviewers use the actual diagnostic-guided worker profile across independent sessions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dag-profile-pin-'));
  const identity = { runId: 'run_test', taskId: 'task_test', attempt: 4, contractRevision: 'revision_a' };
  const actual = { harness: 'codex', model: 'gpt-6-luna', variant: 'xhigh' };
  pinAttemptProfile(directory, identity, actual);
  assert.deepEqual(readAttemptProfile(directory, identity), actual);
  assert.throws(() => pinAttemptProfile(directory, identity, { ...actual, model: 'gpt-6.1-sol' }), /already pinned/);
  assert.throws(() => readAttemptProfile(directory, { ...identity, contractRevision: 'revision_b' }), /another contract/);
  assert.throws(() => readAttemptProfile(directory, { ...identity, attempt: 5 }), /ENOENT/);
});
test('diagnostic identity and rejection history cannot escape sidecar or double-count', async () => {
  const input = setup(), launch = async () => { throw new Error('must not launch'); };
  await assert.rejects(diagnoseBeforeWork({ ...input, taskId: '../other', launch }), /identity/);
  await assert.rejects(diagnoseBeforeWork({ ...input, rejectedAttempts: [1, 1, 2], launch }), /distinct/);
});
test('the diagnostic process cannot have an unlimited timeout', () => {
  assert.throws(() => launchDiagnosis({ timeoutMs: 0 }), /timeout/);
  assert.throws(() => launchDiagnosis({ timeoutMs: 300001 }), /timeout/);
});
