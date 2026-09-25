import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkCertificationValidity,
  createCertification,
  invalidateCertification,
  loadCertification,
  saveCertification,
  validateCertification,
  type CertificationInput,
} from './certification.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40);

function input(overrides: Partial<CertificationInput> = {}): CertificationInput {
  return {
    runId: 'run-one',
    commit,
    specificationGraphHash: digest('spec-graph'),
    architectureGraphHash: digest('architecture-graph'),
    testStateHash: digest('test-state'),
    deterministicChecks: [{ id: 'typecheck', status: 'pass', evidence: [{ uri: 'logs/typecheck.txt', sha256: digest('typecheck:0') }] }],
    reviewEvidence: [{ id: 'review:1', reviewer: 'architecture', verdict: 'pass', evidence: [{ uri: 'reviews/1.json', sha256: digest('review') }] }],
    acceptedRisks: [{ id: 'risk:1', description: 'Legacy import remains', severity: 'medium', rationale: 'Scheduled for a later migration', evidence: [{ uri: 'risks/1.json', sha256: digest('risk') }] }],
    residualFindings: [{ id: 'finding:1', severity: 'medium', description: 'Legacy import path', acceptedRiskId: 'risk:1', evidence: [{ uri: 'findings/1.json', sha256: digest('finding') }] }],
    criticalFlowCoverage: 1,
    weightedRiskCoverage: 0.96,
    ...overrides,
  };
}

test('certification ID is reproducible independent of evidence ordering', () => {
  const first = createCertification(input());
  const reverseOrder = createCertification(input({
    deterministicChecks: [...input().deterministicChecks].reverse(),
    reviewEvidence: [...input().reviewEvidence].reverse(),
  }));
  assert.equal(first.status, 'certified');
  assert.equal(first.id, reverseOrder.id);
  validateCertification(first);
});

test('failed checks or reviews, incomplete critical flows, and open critical/high findings do not certify', () => {
  assert.equal(createCertification(input({ deterministicChecks: [{ id: 'tests', status: 'fail', evidence: [] }] })).status, 'uncertified');
  assert.equal(createCertification(input({ reviewEvidence: [{ id: 'review', reviewer: 'security', verdict: 'fail', evidence: [] }] })).status, 'uncertified');
  assert.equal(createCertification(input({ criticalFlowCoverage: 0.9 })).status, 'uncertified');
  assert.equal(createCertification(input({ residualFindings: [{ id: 'f', severity: 'high', description: 'open issue', evidence: [] }] })).status, 'uncertified');
});

test('explicitly accepted critical risk remains visible without blocking certification', () => {
  const acceptedRisk = { id: 'risk:critical', description: 'Known legacy boundary', severity: 'critical' as const, rationale: 'Operator accepted pending replacement', evidence: [] };
  const certification = createCertification(input({
    acceptedRisks: [acceptedRisk],
    residualFindings: [{ id: 'finding:critical', severity: 'critical', description: 'Legacy boundary can fail', acceptedRiskId: acceptedRisk.id, evidence: [] }],
  }));
  assert.equal(certification.status, 'certified');
  assert.equal(certification.residualFindings[0]?.acceptedRiskId, acceptedRisk.id);
});

test('persists a schema-v1 certificate in the run sidecar without embedding it in the run', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dag-certification-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runFile = path.join(root, 'runs', 'dag.run.json');
  const certification = createCertification(input());
  const file = saveCertification(runFile, certification);
  assert.match(file.replace(/\\/g, '/'), /dag\.run\.d\/factory\/certification-v1\.json$/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 1);
  assert.deepEqual(loadCertification(runFile, 'run-one'), certification);
  assert.throws(() => loadCertification(runFile, 'another-run'), /belongs to run/);
});

test('validity compares commit, requirement graph, architecture graph, and test state', () => {
  const certification = createCertification(input());
  const current = {
    commit,
    specificationGraphHash: digest('spec-graph'),
    architectureGraphHash: digest('architecture-graph'),
    testStateHash: digest('test-state'),
  };
  assert.deepEqual(checkCertificationValidity(certification, current), { valid: true, reasons: [] });
  const changed = checkCertificationValidity(certification, { ...current, architectureGraphHash: digest('changed-architecture'), testStateHash: digest('changed-tests') });
  assert.equal(changed.valid, false);
  assert.deepEqual(changed.reasons, ['architecture graph changed', 'deterministic test state changed']);
});

test('explicit invalidation is durable and cannot be reversed by matching anchors', () => {
  const certification = createCertification(input());
  const invalidated = invalidateCertification(certification, 'review evidence withdrawn');
  const validity = checkCertificationValidity(invalidated, {
    commit,
    specificationGraphHash: digest('spec-graph'),
    architectureGraphHash: digest('architecture-graph'),
    testStateHash: digest('test-state'),
  });
  assert.equal(invalidated.status, 'invalidated');
  assert.deepEqual(validity.reasons, ['review evidence withdrawn']);
  validateCertification(invalidated);
  assert.throws(() => invalidateCertification(certification, ' '), /cannot be empty/);
});

test('rejects unsupported versions, invalid hashes, and dangling accepted-risk links', () => {
  assert.throws(() => createCertification(input({ specificationGraphHash: 'abc' })), /SHA-256/);
  assert.throws(() => createCertification(input({ residualFindings: [{ id: 'f', severity: 'low', description: 'finding', acceptedRiskId: 'missing', evidence: [] }] })), /unknown accepted risk/);
  assert.throws(() => validateCertification({ ...createCertification(input()), schemaVersion: 2 }), /unsupported certification schema/);
});
