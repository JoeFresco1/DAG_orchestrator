import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBaseline, loadBaseline, promoteBaseline, validateBaseline, type BaselinePolicy } from './baseline.js';
import type { CertificationInput } from './certification.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const commit = 'b'.repeat(40);

function input(overrides: Partial<CertificationInput> = {}): CertificationInput {
  return {
    runId: 'run-baseline',
    commit,
    specificationGraphHash: digest('spec'),
    architectureGraphHash: digest('architecture'),
    testStateHash: digest('tests'),
    deterministicChecks: [
      { id: 'typecheck', status: 'pass', evidence: [{ uri: 'checks/typecheck.log', sha256: digest('typecheck') }] },
      { id: 'unit', status: 'pass', evidence: [{ uri: 'checks/unit.log', sha256: digest('unit') }] },
    ],
    reviewEvidence: [{ id: 'critical-paths', reviewer: 'reviewer', verdict: 'pass', evidence: [{ uri: 'reviews/critical.json', sha256: digest('review') }] }],
    acceptedRisks: [],
    residualFindings: [{ id: 'finding:known', severity: 'low', description: 'Known low-risk issue', evidence: [{ uri: 'findings/known.json', sha256: digest('finding') }] }],
    criticalFlowCoverage: 1,
    weightedRiskCoverage: 0.97,
    ...overrides,
  };
}

test('certifies only when required checks and configured risk thresholds pass', () => {
  const policy: BaselinePolicy = { requiredCheckIds: ['typecheck', 'unit'], minimumCriticalFlowCoverage: 1, minimumWeightedRiskCoverage: 0.95 };
  const passed = createBaseline(input(), policy);
  assert.equal(passed.status, 'certified');
  assert.deepEqual(passed.certification.residualFindings.map((finding) => finding.id), ['finding:known']);

  const missedThreshold = createBaseline(input({ weightedRiskCoverage: 0.8 }), policy);
  assert.equal(missedThreshold.status, 'refused');
  assert.match(missedThreshold.reasons.join('\n'), /weighted-risk coverage/);

  const failedCheck = createBaseline(input({ deterministicChecks: [{ id: 'typecheck', status: 'fail', evidence: [] }, { id: 'unit', status: 'pass', evidence: [] }] }), policy);
  assert.equal(failedCheck.status, 'refused');
  assert.match(failedCheck.reasons.join('\n'), /typecheck/);
});

test('missing configured checks and unaccepted critical findings refuse promotion', () => {
  const missing = createBaseline(input(), { requiredCheckIds: ['integration'] });
  assert.equal(missing.status, 'refused');
  assert.match(missing.reasons.join('\n'), /missing: integration/);
  const critical = createBaseline(input({ residualFindings: [{ id: 'critical-1', severity: 'critical', description: 'Unresolved critical defect', evidence: [] }] }));
  assert.equal(critical.status, 'refused');
  assert.match(critical.reasons.join('\n'), /unaccepted critical residual finding/);
});

test('persists failed attempts and refuses silent promotion with durable reasons', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dag-baseline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runFile = path.join(root, 'dag.run.json');
  const refused = promoteBaseline(runFile, input({ weightedRiskCoverage: 0.5 }));
  assert.equal(refused.status, 'refused');
  assert.ok(refused.reasons.length > 0);
  const file = path.join(root, 'dag.run.d', 'factory', 'baseline-v1.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'refused');
  assert.deepEqual(loadBaseline(runFile, 'run-baseline'), refused);
  assert.throws(() => loadBaseline(runFile, 'other-run'), /belongs to run/);
  validateBaseline(refused);
});

test('rejects tampered promotion outcomes and invalid threshold policy', () => {
  const baseline = createBaseline(input());
  assert.throws(() => validateBaseline({ ...baseline, status: 'refused' }), /status does not match/);
  assert.throws(() => createBaseline(input(), { minimumWeightedRiskCoverage: 1.1 }), /between 0 and 1/);
});
