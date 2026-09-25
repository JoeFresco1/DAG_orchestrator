import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { FactoryEntityId, FactoryEvidenceRef } from './contracts.js';
import type { ImpactSet } from './impact.js';
import { invalidateCertificationClaims, validateCertificationClaims } from './certification-invalidation.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const entity = (key: string) => `code:v1:${key}` as FactoryEntityId;
const requirement = (key: string) => `requirement:v1:${key}` as FactoryEntityId;
const evidence = (value: string): FactoryEvidenceRef => ({
  id: `evidence:v1:${digest(value)}`,
  kind: 'review',
  uri: `reviews/${value}.json`,
  sha256: digest(value),
});

function impact(overrides: Partial<ImpactSet> = {}): ImpactSet {
  return {
    schemaVersion: 1,
    change: 'CaseDTO.owner changed',
    changed_units: [entity('CaseDTO')],
    invalidated_units: [entity('CaseDTO'), entity('case-api'), entity('case-ui'), entity('case-create-test')],
    affected_paths: [],
    affected_requirements: [requirement('case-contract')],
    affected_tests: [entity('case-create-test')],
    invalidated_assumptions: [],
    required_reviews: ['contract', 'integration'],
    reproducibility_hash: digest('impact'),
    ...overrides,
  };
}

test('invalidates only claims intersecting semantic impact and preserves original evidence provenance', () => {
  const evidenceRef = evidence('case-api');
  const provenance = { certificationId: 'certification:v1:original', runId: 'baseline-run', commit: 'a'.repeat(40) };
  const claims = [
    { id: 'case-api-contract', covers: [entity('case-api')], evidence: [evidenceRef], provenance, status: 'valid' as const },
    { id: 'case-create-e2e', covers: [entity('case-create-test')], evidence: [evidence('case-e2e')], provenance, status: 'valid' as const },
    { id: 'auth-contract', covers: [entity('auth-api')], evidence: [evidence('auth')], provenance, status: 'valid' as const },
    { id: 'old-invalid', covers: [entity('CaseDTO')], evidence: [evidence('old')], provenance, status: 'invalidated' as const,
      invalidation: { impactHash: digest('earlier'), reason: 'earlier impact' } },
  ];
  const result = invalidateCertificationClaims(claims, impact());

  assert.deepEqual(result.invalidatedClaimIds, ['case-api-contract', 'case-create-e2e']);
  assert.deepEqual(result.unaffectedClaimIds, ['auth-contract', 'old-invalid']);
  assert.equal(result.claims[0]?.status, 'invalidated');
  assert.deepEqual(result.claims[0]?.evidence, [evidenceRef]);
  assert.deepEqual(result.claims[0]?.provenance, provenance);
  assert.deepEqual(result.claims[2], claims[2]);
  assert.deepEqual(result.claims[3], claims[3]);
  validateCertificationClaims(result.claims);
});

test('can invalidate requirement scoped claims and is unaffected by unrelated impact', () => {
  const claim = { id: 'case-requirement', covers: [requirement('case-contract')], evidence: [],
    provenance: { certificationId: 'certification:v1:original', runId: 'baseline-run', commit: 'b'.repeat(40) }, status: 'valid' as const };
  const result = invalidateCertificationClaims([claim], impact());
  assert.deepEqual(result.invalidatedClaimIds, [claim.id]);
  assert.deepEqual(invalidateCertificationClaims([claim], impact({
    changed_units: [entity('auth')], invalidated_units: [entity('auth')], affected_requirements: [], affected_tests: [],
  })).unaffectedClaimIds, [claim.id]);
});

test('rejects claims without precise scope or valid retained provenance', () => {
  assert.throws(() => validateCertificationClaims([{ id: 'unscoped', covers: [], evidence: [],
    provenance: { certificationId: 'c', runId: 'r', commit: 'c'.repeat(40) }, status: 'valid' }]), /cover at least one/);
  assert.throws(() => invalidateCertificationClaims([], impact({ reproducibility_hash: 'bad' })), /invalid semantic impact/);
});
