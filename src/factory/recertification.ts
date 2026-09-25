/** Incremental certification planning and completion on top of existing review policy. */
import { createReviewPlan, type ReviewPlan, type ReviewRouterEvidence } from './review-router.js';
import type { Reviewer } from '../review-policy.js';
import type { FactoryEvidenceRef } from './contracts.js';
import type { ReviewUnit } from './review-units.js';
import {
  createCertification,
  type Certification,
  type CertificationCurrentState,
  type CertificationEvidence,
  type CertificationInput,
  type DeterministicCheck,
  type ReviewEvidence,
} from './certification.js';
import {
  invalidateCertificationClaims,
  validateCertificationClaims,
  type CertificationClaim,
  type CertificationInvalidationResult,
} from './certification-invalidation.js';
import type { ImpactSet } from './impact.js';

export interface RecertificationReviewUnit extends ReviewUnit {
  /** Evidence consumed by the existing risk-based review router. */
  routing: ReviewRouterEvidence;
}

export interface RecertificationPlan {
  schemaVersion: 1;
  baselineCertificationId: Certification['id'];
  invalidation: CertificationInvalidationResult;
  /** Existing deterministic check scheduler inputs, scoped to invalid claims. */
  deterministicTargets: Array<{ claimId: string; units: string[]; tests: string[] }>;
  /** Existing reviewer plans, generated only for units touching invalid claims. */
  reviewPlans: Array<{ unit: string; claims: string[]; plan: ReviewPlan }>;
  carriedForwardClaimIds: string[];
  estimatedReviewActions: number;
}

export interface RecertificationClaimResult {
  claimId: string;
  deterministicChecks: DeterministicCheck[];
  reviewEvidence: ReviewEvidence[];
}

export interface CompleteRecertificationInput {
  baseline: Certification;
  claims: CertificationClaim[];
  plan: RecertificationPlan;
  current: CertificationCurrentState;
  results: RecertificationClaimResult[];
  criticalFlowCoverage: number;
  weightedRiskCoverage: number;
  acceptedRisks?: CertificationInput['acceptedRisks'];
  residualFindings?: CertificationInput['residualFindings'];
}

/**
 * Invalidate claim scopes and route only overlapping review units through the
 * repository's normal review router. Callers can submit the emitted targets
 * as ordinary work to the existing DAG scheduler; this module executes none.
 */
export function createRecertificationPlan(options: {
  baseline: Certification;
  claims: CertificationClaim[];
  impact: ImpactSet;
  reviewUnits: RecertificationReviewUnit[];
  reviewers: Reviewer[];
}): RecertificationPlan {
  if (options.baseline.status !== 'certified') throw new Error('recertification requires a certified baseline');
  validateCertificationClaims(options.claims);
  const invalidation = invalidateCertificationClaims(options.claims, options.impact);
  const invalidated = new Set(invalidation.invalidatedClaimIds);
  const scopes = new Map(options.claims
    .filter((claim) => invalidated.has(claim.id))
    .map((claim) => [claim.id, new Set(claim.covers)]));
  const targeted = options.reviewUnits.map((unit) => {
    const members = new Set([unit.nucleus, ...unit.inbound, ...unit.outbound, ...unit.lateral, ...unit.tests, ...unit.contracts]);
    const claimIds = [...scopes].filter(([, scope]) => [...scope].some((id) => members.has(id)))
      .map(([id]) => id).sort();
    if (claimIds.length === 0) return null;
    return { unit: unit.nucleus, claims: claimIds, plan: createReviewPlan(unit.routing, options.reviewers) };
  }).filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.unit.localeCompare(b.unit));

  const deterministicTargets = [...scopes].map(([claimId, scope]) => ({
    claimId,
    units: [...scope].sort(),
    tests: options.impact.affected_tests.filter((test) => scope.has(test)).sort(),
  })).sort((a, b) => a.claimId.localeCompare(b.claimId));
  for (const claimId of scopes.keys()) {
    if (!targeted.some((item) => item.claims.includes(claimId) && item.plan.reviewRequired &&
      item.plan.reviewers.some((reviewer) => reviewer.selected && reviewer.stage !== 'deterministic'))) {
      throw new Error(`invalidated claim ${claimId} has no scheduled agent review unit`);
    }
  }
  return {
    schemaVersion: 1,
    baselineCertificationId: options.baseline.id,
    invalidation,
    deterministicTargets,
    reviewPlans: targeted,
    carriedForwardClaimIds: invalidation.unaffectedClaimIds.filter((id) => options.claims.some((claim) => claim.id === id && claim.status === 'valid')),
    estimatedReviewActions: deterministicTargets.length + targeted.reduce((count, item) =>
      count + item.plan.reviewers.filter((reviewer) => reviewer.selected && reviewer.stage !== 'deterministic').length, 0),
  };
}

/**
 * Carry forward checks/reviews whose evidence belongs to unaffected claims,
 * replace affected claim evidence with fresh passing results, then create a
 * new immutable certificate. A failed or missing result produces no snapshot.
 */
export function completeRecertification(input: CompleteRecertificationInput): {
  certification: Certification;
  claims: CertificationClaim[];
} {
  const { baseline, plan } = input;
  if (baseline.id !== plan.baselineCertificationId || baseline.status !== 'certified') {
    throw new Error('recertification plan does not match a certified baseline');
  }
  validateCertificationClaims(input.claims);
  const invalidatedIds = new Set(plan.invalidation.invalidatedClaimIds);
  const resultByClaim = new Map<string, RecertificationClaimResult>();
  for (const result of input.results) {
    if (!invalidatedIds.has(result.claimId)) throw new Error(`unexpected recertification result for claim ${result.claimId}`);
    if (resultByClaim.has(result.claimId)) throw new Error(`duplicate recertification result for claim ${result.claimId}`);
    resultByClaim.set(result.claimId, result);
    if (!result.deterministicChecks.length || result.deterministicChecks.some((check) => check.status !== 'pass')) {
      throw new Error(`claim ${result.claimId} requires passing deterministic checks`);
    }
    if (!result.reviewEvidence.length || result.reviewEvidence.some((review) => review.verdict !== 'pass')) {
      throw new Error(`claim ${result.claimId} requires passing agent review evidence`);
    }
  }
  for (const id of invalidatedIds) if (!resultByClaim.has(id)) throw new Error(`missing recertification result for claim ${id}`);

  const invalidatedEvidence = new Set(input.claims.filter((claim) => invalidatedIds.has(claim.id))
    .flatMap((claim) => claim.evidence.map(evidenceKey)));
  const unaffectedEvidence = new Set(input.claims.filter((claim) => !invalidatedIds.has(claim.id) && claim.status === 'valid')
    .flatMap((claim) => claim.evidence.map(evidenceKey)));
  const carry = (evidence: CertificationEvidence[]): CertificationEvidence[] => evidence.filter((ref) => {
    const key = evidenceKey(ref);
    return unaffectedEvidence.has(key) && !invalidatedEvidence.has(key);
  });
  const checks = baseline.deterministicChecks.map((check) => ({ ...check, evidence: carry(check.evidence) }))
    .filter((check) => check.evidence.length > 0);
  const reviews = baseline.reviewEvidence.map((review) => ({ ...review, evidence: carry(review.evidence) }))
    .filter((review) => review.evidence.length > 0);
  for (const result of resultByClaim.values()) {
    checks.push(...result.deterministicChecks);
    reviews.push(...result.reviewEvidence);
  }
  const dedupChecks = uniqueById(checks, 'deterministic check');
  const dedupReviews = uniqueById(reviews, 'review evidence');
  const nextInput: CertificationInput = {
    runId: baseline.runId,
    commit: input.current.commit,
    specificationGraphHash: input.current.specificationGraphHash,
    architectureGraphHash: input.current.architectureGraphHash,
    testStateHash: input.current.testStateHash,
    deterministicChecks: dedupChecks,
    reviewEvidence: dedupReviews,
    acceptedRisks: input.acceptedRisks ?? baseline.acceptedRisks,
    residualFindings: input.residualFindings ?? baseline.residualFindings,
    criticalFlowCoverage: input.criticalFlowCoverage,
    weightedRiskCoverage: input.weightedRiskCoverage,
  };
  const certification = createCertification(nextInput);
  if (certification.status !== 'certified') throw new Error('recertification evidence does not meet certification criteria');
  const claims = input.claims.map((claim) => {
    const result = resultByClaim.get(claim.id);
    if (!result) return claim;
    const evidence: FactoryEvidenceRef[] = [
      ...result.deterministicChecks.flatMap((check) => check.evidence.map((ref) => ({ ...ref, kind: 'command' as const }))),
      ...result.reviewEvidence.flatMap((review) => review.evidence.map((ref) => ({ ...ref, kind: 'review' as const }))),
    ].map((ref) => ({ ...ref, id: `evidence:v1:${ref.sha256}` as FactoryEvidenceRef['id'] }));
    const { invalidation: _invalidation, ...validClaim } = claim;
    return {
      ...validClaim,
      evidence: uniqueEvidence(evidence),
      provenance: { certificationId: certification.id, runId: certification.runId, commit: certification.commit },
      status: 'valid' as const,
    };
  });
  validateCertificationClaims(claims);
  return { certification, claims };
}

function evidenceKey(ref: { uri: string; sha256: string }): string { return `${ref.uri}\0${ref.sha256}`; }
function uniqueById<T extends { id: string }>(items: T[], label: string): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw new Error(`conflicting ${label} ID during recertification: ${item.id}`);
    byId.set(item.id, item);
  }
  return [...byId.values()];
}
function uniqueEvidence<T extends { uri: string; sha256: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [evidenceKey(item), item])).values()];
}
