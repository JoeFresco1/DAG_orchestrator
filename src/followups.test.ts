import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './test-helpers.js';
import { addTask, loadRun, newRun, runPaths, saveRun } from './store.js';
import { listFollowups, proposeFollowups, triageFollowup } from './followups.js';

function fixture() {
  const file = join(tempDir(), 'dag.run.json'), run = newRun('Baseline and future API');
  const baseline = addTask(run, { title: 'Verify existing baseline', spec: 'Verify pinned code' });
  const producer = addTask(run, { title: 'Implement API', spec: 'Produce API', deps: [baseline.id] });
  saveRun(run, file);
  const proposal = { id: 'premature-api-gate', message: 'Baseline check demands the future API',
    evidence: ['Check output: missing API', 'API producer depends on baseline verification'],
    references: [baseline.id, producer.id], suggestedOwner: producer.id,
    acceptance: 'API acceptance runs after its existing producer', blocking: true };
  return { file, run, baseline, producer, proposal };
}

test('future API finding points to existing producers without waiving the baseline or adding tasks', () => {
  const { file, baseline, producer, proposal } = fixture();
  const before = JSON.stringify(loadRun(file)), definition = readFileSync(file, 'utf8');
  const [record] = proposeFollowups(file, [proposal], { taskId: baseline.id, stage: 'check', attempt: 1 });
  assert.deepEqual(record.candidateOwners, [baseline.id, producer.id].sort());
  triageFollowup(file, record.id, { disposition: 'blocker', owner: baseline.id, reason: 'Correct the acceptance placement through plan amendment' });
  triageFollowup(file, record.id, { disposition: 'existing-task', owner: producer.id, reason: 'Implementation already has a producer' });
  assert.equal(listFollowups(file)[0].decisions.length, 2);
  assert.equal(JSON.stringify(loadRun(file)), before);
  assert.equal(readFileSync(file, 'utf8'), definition);
});

test('capture is idempotent for retry delivery and retains new evidence across attempts', () => {
  const { file, baseline, proposal } = fixture(), origin = { taskId: baseline.id, stage: 'review', attempt: 1, source: 'reviewer:abc' };
  const [first] = proposeFollowups(file, [proposal], origin);
  proposeFollowups(file, [proposal], origin);
  const [again] = proposeFollowups(file, [{ ...proposal, message: 'Same cause with more detail', evidence: ['Fresh check output'] }], { ...origin, attempt: 2 });
  assert.equal(first.id, again.id); assert.equal(again.occurrences.length, 2);
  assert.equal(again.occurrences[0].proposal.evidence[0], 'Check output: missing API');
  assert.equal(listFollowups(file).length, 1);
});

test('malformed packet rejects atomically and triage requires reason, owner and acceptance', () => {
  const { file, proposal } = fixture();
  assert.throws(() => proposeFollowups(file, [proposal, { ...proposal, id: 'invalid', evidence: [] }], { stage: 'manual' }), /evidence/);
  assert.deepEqual(listFollowups(file), []);
  assert.throws(() => proposeFollowups(file, [proposal, proposal], { stage: 'manual' }), /Duplicate/);
  assert.throws(() => proposeFollowups(file, [{ ...proposal, requirements: ['invented'] }], { stage: 'manual' }), /requirement/);
  const [record] = proposeFollowups(file, [{ ...proposal, acceptance: undefined }], { stage: 'manual' });
  assert.throws(() => triageFollowup(file, record.id, { disposition: 'blocker', reason: 'Repair' }), /owner/);
  assert.throws(() => triageFollowup(file, record.id, { disposition: 'follow-up', reason: 'Optional' }), /acceptance/);
  assert.throws(() => triageFollowup(file, record.id, { disposition: 'dismissed', reason: '' }), /reason/);
  assert.equal(listFollowups(file)[0].decisions.length, 0);
});

test('coordinator duplicate links retain evidence and reject cycles', () => {
  const { file, proposal } = fixture();
  const [a, b] = proposeFollowups(file, [proposal, { ...proposal, id: 'other-report' }], { stage: 'manual' });
  triageFollowup(file, b.id, { disposition: 'dismissed', reason: 'Same underlying issue', duplicateOf: a.id });
  assert.throws(() => triageFollowup(file, a.id, { disposition: 'dismissed', reason: 'Cycle', duplicateOf: b.id }), /cycle/);
  assert.equal(listFollowups(file)[1].occurrences.length, 1);
});

test('corrupted or foreign-run ledger is never silently replaced', () => {
  const { file, proposal } = fixture();
  proposeFollowups(file, [proposal], { stage: 'manual' });
  const path = join(runPaths(file).dir, 'followups.json');
  writeFileSync(path, JSON.stringify({ version: 1, runId: 'other', items: [] }));
  assert.throws(() => proposeFollowups(file, [proposal], { stage: 'manual' }), /identity/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).runId, 'other');
});
