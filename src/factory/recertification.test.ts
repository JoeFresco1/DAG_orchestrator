import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { FactoryEntityId, FactoryEvidenceRef } from './contracts.js';
import { createCertification, type CertificationInput } from './certification.js';
import { createRecertificationPlan, completeRecertification, type RecertificationReviewUnit } from './recertification.js';
import type { ImpactSet } from './impact.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (key: string) => `code:v1:${key}` as FactoryEntityId;
const evidence = (name: string): FactoryEvidenceRef => ({ id: `evidence:v1:${hash(name)}`, kind: 'review', uri: `${name}.json`, sha256: hash(name) });

const baselineInput = (): CertificationInput => ({
  runId: 'run', commit: 'a'.repeat(40), specificationGraphHash: hash('spec'), architectureGraphHash: hash('arch'), testStateHash: hash('tests'),
  deterministicChecks: [
    { id: 'old-case-check', status: 'pass', evidence: [{ uri: 'case-old.json', sha256: hash('case-old') }] },
    { id: 'auth-check', status: 'pass', evidence: [{ uri: 'auth.json', sha256: hash('auth') }] },
  ],
  reviewEvidence: [
    { id: 'old-case-review', reviewer: 'local', verdict: 'pass', evidence: [{ uri: 'case-review-old.json', sha256: hash('case-review-old') }] },
    { id: 'auth-review', reviewer: 'security', verdict: 'pass', evidence: [{ uri: 'auth-review.json', sha256: hash('auth-review') }] },
  ],
  acceptedRisks: [], residualFindings: [], criticalFlowCoverage: 1, weightedRiskCoverage: 0.95,
});

function fixture() {
  const baseline = createCertification(baselineInput());
  const claims = [
    { id: 'case', covers: [code('case-api'), code('case-test')], evidence: [evidence('case-old'), evidence('case-review-old')], provenance: { certificationId: baseline.id, runId: 'run', commit: 'a'.repeat(40) }, status: 'valid' as const },
    { id: 'auth', covers: [code('auth-api')], evidence: [evidence('auth'), evidence('auth-review')], provenance: { certificationId: baseline.id, runId: 'run', commit: 'a'.repeat(40) }, status: 'valid' as const },
  ];
  const impact: ImpactSet = {
    schemaVersion: 1, change: 'case API changed', changed_units: [code('case-api')], invalidated_units: [code('case-api')], affected_paths: [],
    affected_requirements: [], affected_tests: [code('case-test')], invalidated_assumptions: [], required_reviews: ['integration'], reproducibility_hash: hash('impact'),
  };
  const routing = { unit: code('case-api'), title: 'Case API', changedFiles: ['src/case.ts'], diffLines: 12, workExitCode: 0 };
  const units: RecertificationReviewUnit[] = [
    { nucleus: code('case-api'), inbound: [], outbound: [], lateral: [], tests: [code('case-test')], contracts: [], routing },
    { nucleus: code('auth-api'), inbound: [], outbound: [], lateral: [], tests: [], contracts: [], routing: { ...routing, unit: code('auth-api'), title: 'Auth API', changedFiles: ['src/auth.ts'] } },
  ];
  const reviewers = [{ name: 'integration reviewer', cmd: 'review', verdict: 'marker' as const }];
  const plan = createRecertificationPlan({ baseline, claims, impact, reviewUnits: units, reviewers });
  return { baseline, claims, impact, plan };
}

test('plans deterministic checks and routed reviews only for invalidated claim scopes', () => {
  const { plan } = fixture();
  assert.deepEqual(plan.invalidation.invalidatedClaimIds, ['case']);
  assert.deepEqual(plan.carriedForwardClaimIds, ['auth']);
  assert.deepEqual(plan.deterministicTargets, [{ claimId: 'case', units: [code('case-api'), code('case-test')], tests: [code('case-test')] }]);
  assert.deepEqual(plan.reviewPlans.map(({ unit }) => unit), [code('case-api')]);
  assert.equal(plan.estimatedReviewActions, 2);
});

test('re-certifies only after every invalidated claim has passing checks and reviews, retaining unaffected evidence', () => {
  const { baseline, claims, plan } = fixture();
  const result = completeRecertification({
    baseline, claims, plan,
    current: { commit: 'b'.repeat(40), specificationGraphHash: hash('spec'), architectureGraphHash: hash('arch'), testStateHash: hash('new-tests') },
    results: [{ claimId: 'case',
      deterministicChecks: [{ id: 'case-check-v2', status: 'pass', evidence: [{ uri: 'case-new.json', sha256: hash('case-new') }] }],
      reviewEvidence: [{ id: 'case-review-v2', reviewer: 'integration reviewer', verdict: 'pass', evidence: [{ uri: 'case-review-new.json', sha256: hash('case-review-new') }] }],
    }],
    criticalFlowCoverage: 1, weightedRiskCoverage: 0.96,
  });
  assert.equal(result.certification.status, 'certified');
  assert.notEqual(result.certification.id, baseline.id);
  assert.deepEqual(result.certification.deterministicChecks.map((item) => item.id).sort(), ['auth-check', 'case-check-v2']);
  assert.deepEqual(result.certification.reviewEvidence.map((item) => item.id).sort(), ['auth-review', 'case-review-v2']);
  assert.equal(result.claims.find((claim) => claim.id === 'case')?.status, 'valid');
  assert.equal(result.claims.find((claim) => claim.id === 'case')?.provenance.certificationId, result.certification.id);
  assert.equal(result.claims.find((claim) => claim.id === 'auth')?.provenance.certificationId, baseline.id);
});

test('does not issue a certificate for missing or failing affected claim evidence', () => {
  const { baseline, claims, plan } = fixture();
  const args = { baseline, claims, plan, current: { commit: 'b'.repeat(40), specificationGraphHash: hash('spec'), architectureGraphHash: hash('arch'), testStateHash: hash('new-tests') }, criticalFlowCoverage: 1, weightedRiskCoverage: 0.96 };
  assert.throws(() => completeRecertification({ ...args, results: [] }), /missing recertification result/);
  assert.throws(() => completeRecertification({ ...args, results: [{ claimId: 'case', deterministicChecks: [{ id: 'failed', status: 'fail', evidence: [] }], reviewEvidence: [{ id: 'review', reviewer: 'agent', verdict: 'pass', evidence: [] }] }] }), /passing deterministic checks/);
  assert.throws(() => completeRecertification({ ...args, results: [{ claimId: 'case', deterministicChecks: [{ id: 'check', status: 'pass', evidence: [] }], reviewEvidence: [{ id: 'review', reviewer: 'agent', verdict: 'fail', evidence: [] }] }] }), /passing agent review evidence/);
});
