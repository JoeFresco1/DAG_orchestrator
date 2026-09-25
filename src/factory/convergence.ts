/**
 * Evidence-based exit policy for factory review campaigns. This module only
 * evaluates and persists a decision; all review work remains ordinary work in
 * the existing DAG runner.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteJson, readJsonFileWithBackup, runPaths } from '../store.js';
import {
  checkCertificationValidity,
  createCertification,
  invalidateCertification,
  validateCertification,
  type Certification,
  type CertificationCurrentState,
  type CertificationInput,
  type CertificationValidity,
} from './certification.js';
import {
  REVIEW_BUDGET_DIMENSIONS,
  createReviewBudget,
  remainingReviewBudget,
  type ReviewBudgetAmounts,
  type ReviewBudgetDimension,
  type ReviewBudgetState,
} from './review-budget.js';
import { isFactoryEvidenceRef, type FactoryEvidenceRef } from './contracts.js';
import type { ConfidenceEffortPoint, ConfidenceFrontier, ConfidenceFrontierClaimResult } from './confidence-frontier.js';

export type ConvergenceSeverity = 'critical' | 'high' | 'medium' | 'low';

/** Policy thresholds are mandatory so a campaign cannot converge by defaults. */
export interface ConvergencePolicy {
  /** Number of recent, completed, meaningful units required to establish a quiet window. */
  minimumMeaningfulReviewUnits: number;
  /** Upper bound for normalized weighted residual risk, from 0 to 1. */
  maximumWeightedResidualRisk: number;
  /** Minimum release-impact-weighted confidence across unresolved frontier claims. */
  minimumReleaseConfidence: number;
  /** Maximum verified novel defects per 1,000 requests in the quiet window. */
  maximumNovelVerifiedDefectsPer1000Requests: number;
  /** Require this many requests in the window before treating its yield as meaningful. */
  minimumRequestsForYield: number;
  /** Certification must cover at least this fraction of weighted risk, from 0 to 1. */
  minimumWeightedRiskCoverage: number;
  /** Certification must cover at least this fraction of critical flows, from 0 to 1. */
  minimumCriticalFlowCoverage: number;
  /** Named critical E2E flows that must each have passing certification evidence. */
  requiredCriticalFlowIds: string[];
  /** Deterministic checks that must be present and passing in the certification. */
  requiredDeterministicCheckIds: string[];
  /** Minimum remaining allowance needed to fund another review unit. At least one value must be positive. */
  minimumRemainingBudget: ReviewBudgetAmounts;
}

export type ConvergenceConfidenceSnapshot = Pick<
  ConfidenceFrontier,
  'schemaVersion' | 'initialResidualRisk' | 'residualRisk' | 'unresolvedClaims' | 'effortCurve'
> & {
  /** Evidence supporting both the frontier risk and claim-confidence measurements. */
  evidence: FactoryEvidenceRef[];
};

export interface ConvergenceFinding {
  id: string;
  severity: ConvergenceSeverity;
  status: 'open' | 'resolved' | 'accepted';
  /** Open critical findings block convergence even if a reviewer has not verified them yet. */
  verified: boolean;
  evidence: FactoryEvidenceRef[];
}

export interface ConvergenceDiscovery {
  id: string;
  severity: ConvergenceSeverity;
  verified: boolean;
  /** False means this is corroboration of an already-known issue, not novel yield. */
  novel: boolean;
  evidence: FactoryEvidenceRef[];
}

export interface ConvergenceReviewUnit {
  id: string;
  completedAt: string;
  status: 'completed' | 'incomplete';
  /** Caller marks whether this unit performed meaningful review of its intended scope. */
  meaningful: boolean;
  requestCount: number;
  evidence: FactoryEvidenceRef[];
  /** Findings first surfaced by this unit; each ID may appear only once in the campaign history. */
  newFindings: ConvergenceDiscovery[];
}

export interface CriticalFlowCertification {
  flowId: string;
  certified: boolean;
  evidence: FactoryEvidenceRef[];
}

export interface ConvergenceAssessment {
  runId: string;
  /** Existing certification and anchors let convergence reject stale or invalidated states. */
  certification: Certification;
  currentCertificationState: CertificationCurrentState;
  confidenceFrontier: ConvergenceConfidenceSnapshot;
  /** Budget ledger produced by the existing review-budget policy. */
  budget: {
    state: ReviewBudgetState;
    evidence: FactoryEvidenceRef[];
  };
  criticalFlows: CriticalFlowCertification[];
  findings: ConvergenceFinding[];
  reviewUnits: ConvergenceReviewUnit[];
}

export type ConvergenceCriterionId =
  | 'open-critical-findings'
  | 'meaningful-review-window'
  | 'quiet-high-severity-window'
  | 'weighted-residual-risk'
  | 'release-confidence'
  | 'novel-finding-yield'
  | 'certification-current'
  | 'critical-flow-coverage'
  | 'required-critical-flows'
  | 'deterministic-checks'
  | 'weighted-risk-coverage'
  | 'certification-evidence'
  | 'frontier-evidence'
  | 'budget-for-next-review'
  | 'verified-finding-evidence';

export interface ConvergenceCriterion {
  id: ConvergenceCriterionId;
  passed: boolean;
  actual: unknown;
  threshold: unknown;
  detail: string;
}

export type RemainingReviewBudget = Record<ReviewBudgetDimension, number | null>;

export interface ConvergenceSummary {
  openCriticalFindingIds: string[];
  meaningfulReviewUnitIds: string[];
  newVerifiedHighFindingIds: string[];
  windowRequestCount: number;
  novelVerifiedFindingCount: number;
  verifiedNovelDefectsPer1000Requests: number | null;
  weightedResidualRisk: number;
  releaseConfidence: number;
  certificationId: Certification['id'];
  certificationValid: boolean;
  certificationValidityReasons: string[];
  remainingBudget: RemainingReviewBudget;
}

export interface ConvergenceDecision {
  schemaVersion: 1;
  id: `convergence:v1:${string}`;
  runId: string;
  evaluatedAt: string;
  status: 'stop' | 'continue' | 'escalate';
  policy: ConvergencePolicy;
  /** Full normalized input snapshot makes every decision independently reviewable. */
  assessment: ConvergenceAssessment;
  summary: ConvergenceSummary;
  criteria: ConvergenceCriterion[];
  reasons: string[];
  evidence: {
    references: FactoryEvidenceRef[];
    certificationId: Certification['id'];
    certificationValidity: CertificationValidity;
    reviewWindowUnitIds: string[];
  };
  escalation?: {
    kind: 'human-review' | 'increase-budget';
    reason: string;
    failedCriteria: ConvergenceCriterionId[];
  };
}

const CONVERGENCE_ID = /^convergence:v1:([a-f0-9]{64})$/;
const FILE_PREFIX = 'convergence-v1-';

/**
 * Evaluate whether review has measurably converged, should continue, or must
 * stop for escalation. Only quality criteria can produce `stop`; low yield is
 * evaluated over the same N-unit window as the high-severity quiet period.
 */
export function evaluateConvergence(
  assessmentInput: ConvergenceAssessment,
  policyInput: ConvergencePolicy,
  evaluatedAt = new Date().toISOString(),
): ConvergenceDecision {
  const policy = normalizePolicy(policyInput);
  const assessment = normalizeAssessment(assessmentInput);
  const date = normalizeDate(evaluatedAt, 'evaluatedAt');
  const certificationValidity = checkCertificationValidity(
    assessment.certification,
    assessment.currentCertificationState,
  );
  const frontier = assessment.confidenceFrontier;
  const releaseConfidence = calculateReleaseConfidence(frontier);
  const remaining = remainingReviewBudget(assessment.budget.state);
  const remainingBudget = toSerializableBudget(remaining);
  const enoughBudget = REVIEW_BUDGET_DIMENSIONS.every((dimension) =>
    policy.minimumRemainingBudget[dimension] === undefined ||
    remaining[dimension] >= policy.minimumRemainingBudget[dimension]!,
  );
  const eligibleUnits = assessment.reviewUnits.filter(isEligibleMeaningfulUnit);
  const reviewWindow = eligibleUnits.slice(-policy.minimumMeaningfulReviewUnits);
  const windowRequestCount = reviewWindow.reduce((sum, unit) => sum + unit.requestCount, 0);
  const windowDiscoveries = reviewWindow.flatMap((unit) => unit.newFindings);
  const novelVerified = uniqueById(windowDiscoveries.filter((finding) => finding.verified && finding.novel));
  const highSeverity = uniqueById(windowDiscoveries.filter((finding) =>
    finding.verified && finding.novel && (finding.severity === 'high' || finding.severity === 'critical')),
  );
  const yieldPer1000 = windowRequestCount > 0
    ? round(novelVerified.length * 1000 / windowRequestCount)
    : null;
  const openCriticalFindingIds = assessment.findings
    .filter((finding) => finding.status === 'open' && finding.severity === 'critical')
    .map((finding) => finding.id)
    .sort(compareStable);
  const malformedMeaningfulUnits = assessment.reviewUnits.filter((unit) =>
    unit.status === 'completed' && unit.meaningful && !isEligibleMeaningfulUnit(unit),
  );
  const verifiedFindingsHaveEvidence = assessment.reviewUnits.every((unit) =>
    unit.newFindings.every((finding) => !finding.verified || finding.evidence.length > 0),
  );
  const requiredFlows = new Map(assessment.criticalFlows.map((flow) => [flow.flowId, flow]));
  const missingOrUncertifiedFlows = policy.requiredCriticalFlowIds.filter((id) => {
    const flow = requiredFlows.get(id);
    return !flow || !flow.certified || flow.evidence.length === 0;
  });
  const checkById = new Map(assessment.certification.deterministicChecks.map((check) => [check.id, check]));
  const missingOrFailedChecks = policy.requiredDeterministicCheckIds.filter((id) => {
    const check = checkById.get(id);
    return !check || check.status !== 'pass' || check.evidence.length === 0;
  });
  const deterministicChecksClean = assessment.certification.deterministicChecks.length > 0 &&
    assessment.certification.deterministicChecks.every((check) => check.status === 'pass' && check.evidence.length > 0) &&
    missingOrFailedChecks.length === 0;
  const allCertificationEvidencePresent = assessment.certification.reviewEvidence.length > 0 &&
    assessment.certification.reviewEvidence.every((item) => item.verdict === 'pass' && item.evidence.length > 0) &&
    assessment.certification.deterministicChecks.every((item) => item.evidence.length > 0) &&
    missingOrUncertifiedFlows.length === 0;
  const windowReady = reviewWindow.length === policy.minimumMeaningfulReviewUnits && malformedMeaningfulUnits.length === 0;
  const yieldReady = windowReady && windowRequestCount >= policy.minimumRequestsForYield && yieldPer1000 !== null;

  const criteria: ConvergenceCriterion[] = [
    criterion('open-critical-findings', openCriticalFindingIds.length === 0, openCriticalFindingIds, 0,
      openCriticalFindingIds.length === 0 ? 'no open critical findings remain' : 'open critical findings block convergence'),
    criterion('meaningful-review-window', windowReady,
      { eligibleUnits: reviewWindow.length, requiredUnits: policy.minimumMeaningfulReviewUnits, malformedUnits: malformedMeaningfulUnits.map((unit) => unit.id) },
      { units: policy.minimumMeaningfulReviewUnits, completed: true, meaningful: true, evidenceRequired: true },
      windowReady ? 'enough evidenced meaningful review units are available' : 'not enough evidenced meaningful review units are available'),
    criterion('quiet-high-severity-window', windowReady && highSeverity.length === 0,
      { findingIds: highSeverity.map((finding) => finding.id), units: reviewWindow.length },
      { newVerifiedHighSeverityFindings: 0, units: policy.minimumMeaningfulReviewUnits },
      !windowReady
        ? 'there is no sufficiently evidenced review window for the high-severity check'
        : highSeverity.length === 0
          ? 'the measured window has no new verified high-severity findings'
          : 'new verified high-severity findings remain in the measured window'),
    criterion('weighted-residual-risk', frontier.residualRisk <= policy.maximumWeightedResidualRisk,
      frontier.residualRisk, policy.maximumWeightedResidualRisk,
      frontier.residualRisk <= policy.maximumWeightedResidualRisk ? 'weighted residual risk is within policy' : 'weighted residual risk exceeds policy'),
    criterion('release-confidence', releaseConfidence >= policy.minimumReleaseConfidence,
      releaseConfidence, policy.minimumReleaseConfidence,
      releaseConfidence >= policy.minimumReleaseConfidence ? 'release confidence meets policy' : 'release confidence is below policy'),
    criterion('novel-finding-yield', yieldReady && yieldPer1000! <= policy.maximumNovelVerifiedDefectsPer1000Requests,
      { per1000Requests: yieldPer1000, novelVerifiedFindings: novelVerified.length, requests: windowRequestCount, sampleReady: yieldReady },
      { maximumPer1000Requests: policy.maximumNovelVerifiedDefectsPer1000Requests, minimumRequests: policy.minimumRequestsForYield },
      !yieldReady ? 'finding yield has too few evidenced review units or requests to measure' : yieldPer1000! <= policy.maximumNovelVerifiedDefectsPer1000Requests ? 'verified novel finding yield is within policy' : 'verified novel finding yield exceeds policy'),
    criterion('certification-current', assessment.certification.status === 'certified' && certificationValidity.valid,
      { status: assessment.certification.status, valid: certificationValidity.valid, reasons: certificationValidity.reasons },
      { status: 'certified', currentAnchors: true },
      assessment.certification.status === 'certified' && certificationValidity.valid ? 'certification is current' : 'certification is uncertified, invalidated, or stale'),
    criterion('critical-flow-coverage', assessment.certification.criticalFlowCoverage >= policy.minimumCriticalFlowCoverage,
      assessment.certification.criticalFlowCoverage, policy.minimumCriticalFlowCoverage,
      assessment.certification.criticalFlowCoverage >= policy.minimumCriticalFlowCoverage ? 'critical-flow coverage meets policy' : 'critical-flow coverage is below policy'),
    criterion('required-critical-flows', missingOrUncertifiedFlows.length === 0,
      { certified: policy.requiredCriticalFlowIds.filter((id) => !missingOrUncertifiedFlows.includes(id)), missingOrUncertified: missingOrUncertifiedFlows },
      policy.requiredCriticalFlowIds,
      missingOrUncertifiedFlows.length === 0 ? 'all required critical E2E flows have passing evidence' : 'one or more required critical E2E flows lack passing evidence'),
    criterion('deterministic-checks', deterministicChecksClean,
      { checks: assessment.certification.deterministicChecks.map(({ id, status, evidence }) => ({ id, status, evidenceCount: evidence.length })), missingOrFailedRequired: missingOrFailedChecks },
      { allChecks: 'pass with evidence', requiredIds: policy.requiredDeterministicCheckIds },
      deterministicChecksClean ? 'all deterministic checks are clean and evidenced' : 'deterministic checks are missing, failing, skipped, or lack evidence'),
    criterion('weighted-risk-coverage', assessment.certification.weightedRiskCoverage >= policy.minimumWeightedRiskCoverage,
      assessment.certification.weightedRiskCoverage, policy.minimumWeightedRiskCoverage,
      assessment.certification.weightedRiskCoverage >= policy.minimumWeightedRiskCoverage ? 'weighted-risk coverage meets policy' : 'weighted-risk coverage is below policy'),
    criterion('certification-evidence', allCertificationEvidencePresent,
      { reviews: assessment.certification.reviewEvidence.map((item) => ({ id: item.id, verdict: item.verdict, evidenceCount: item.evidence.length })), deterministicChecks: assessment.certification.deterministicChecks.length, criticalFlowsMissing: missingOrUncertifiedFlows },
      { passingReviewEvidence: true, deterministicEvidence: true, criticalFlowEvidence: true },
      allCertificationEvidencePresent ? 'certification review and check evidence is present' : 'certification is missing review, deterministic, or critical-flow evidence'),
    criterion('frontier-evidence', frontier.evidence.length > 0,
      frontier.evidence.length, 'at least one evidence reference',
      frontier.evidence.length > 0 ? 'confidence frontier measurements have evidence' : 'confidence frontier measurements lack evidence'),
    criterion('verified-finding-evidence', verifiedFindingsHaveEvidence,
      assessment.reviewUnits.flatMap((unit) => unit.newFindings.filter((finding) => finding.verified && finding.evidence.length === 0).map((finding) => finding.id)).sort(compareStable),
      'every verified discovery has evidence',
      verifiedFindingsHaveEvidence ? 'verified discoveries have evidence' : 'one or more verified discoveries have no evidence'),
    criterion('budget-for-next-review', enoughBudget, remainingBudget, policy.minimumRemainingBudget,
      enoughBudget ? 'remaining budget can fund the configured review reserve' : 'remaining budget is below the configured review reserve'),
  ];

  const qualityCriteria = criteria.filter((item) => item.id !== 'budget-for-next-review');
  const failedQuality = qualityCriteria.filter((item) => !item.passed);
  const converged = failedQuality.length === 0;
  const status: ConvergenceDecision['status'] = converged ? 'stop' : enoughBudget ? 'continue' : 'escalate';
  const budgetCriterion = criteria.find((item) => item.id === 'budget-for-next-review')!;
  const reasons = failedQuality.map((item) => item.detail);
  if (status === 'escalate' && !budgetCriterion.passed) reasons.push(budgetCriterion.detail);
  const highOrCritical = openCriticalFindingIds.length > 0 || highSeverity.length > 0 ||
    !certificationValidity.valid || assessment.certification.status !== 'certified' || missingOrUncertifiedFlows.length > 0;
  const escalation = status === 'escalate' ? {
    kind: highOrCritical ? 'human-review' as const : 'increase-budget' as const,
    reason: highOrCritical
      ? 'budget cannot safely continue review while critical findings, high-severity discoveries, or certification blockers remain'
      : 'remaining budget is below the configured reserve before measurable convergence was reached',
    failedCriteria: criteria.filter((item) => !item.passed).map((item) => item.id),
  } : undefined;

  const summary: ConvergenceSummary = {
    openCriticalFindingIds,
    meaningfulReviewUnitIds: reviewWindow.map((unit) => unit.id),
    newVerifiedHighFindingIds: highSeverity.map((finding) => finding.id).sort(compareStable),
    windowRequestCount,
    novelVerifiedFindingCount: novelVerified.length,
    verifiedNovelDefectsPer1000Requests: yieldPer1000,
    weightedResidualRisk: frontier.residualRisk,
    releaseConfidence,
    certificationId: assessment.certification.id,
    certificationValid: certificationValidity.valid,
    certificationValidityReasons: certificationValidity.reasons,
    remainingBudget,
  };
  const evidence = {
    references: gatherEvidenceReferences(assessment),
    certificationId: assessment.certification.id,
    certificationValidity,
    reviewWindowUnitIds: reviewWindow.map((unit) => unit.id),
  };
  const decisionWithoutId = {
    schemaVersion: 1 as const,
    runId: assessment.runId,
    evaluatedAt: date,
    status,
    policy,
    assessment,
    summary,
    criteria,
    reasons,
    evidence,
    ...(escalation ? { escalation } : {}),
  };
  const id = `convergence:v1:${hash(canonicalJson(decisionWithoutId))}` as const;
  return { ...decisionWithoutId, id };
}

/** Persist an immutable decision artifact under this run's factory sidecar. */
export function saveConvergenceDecision(runFile: string, decision: ConvergenceDecision): string {
  validateConvergenceDecision(decision);
  const path = convergenceDecisionPath(runFile, decision.id);
  atomicWriteJson(path, decision);
  return path;
}

/** Evaluate and persist a decision without editing the DAG run definition/state. */
export function evaluateAndSaveConvergence(
  runFile: string,
  assessment: ConvergenceAssessment,
  policy: ConvergencePolicy,
  evaluatedAt?: string,
): ConvergenceDecision {
  const decision = evaluateConvergence(assessment, policy, evaluatedAt);
  saveConvergenceDecision(runFile, decision);
  return decision;
}

/** Load a decision by its content-derived ID and verify both its gates and evidence identity. */
export function loadConvergenceDecision(
  runFile: string,
  id: ConvergenceDecision['id'],
  expectedRunId?: string,
): ConvergenceDecision | null {
  const raw = readJsonFileWithBackup<unknown>(convergenceDecisionPath(runFile, id));
  if (raw === null) return null;
  validateConvergenceDecision(raw);
  if (raw.id !== id) throw new Error('convergence decision filename does not match its ID');
  if (expectedRunId !== undefined && raw.runId !== expectedRunId) {
    throw new Error(`convergence decision belongs to run ${raw.runId}, expected ${expectedRunId}`);
  }
  return raw;
}

/** Recompute the policy result from the stored snapshot to reject edited decisions. */
export function validateConvergenceDecision(value: unknown): asserts value is ConvergenceDecision {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !CONVERGENCE_ID.test(value.id)) {
    throw new Error('unsupported convergence decision schema or ID');
  }
  const decision = value as unknown as ConvergenceDecision;
  const rebuilt = evaluateConvergence(decision.assessment, decision.policy, decision.evaluatedAt);
  if (canonicalJson(rebuilt) !== canonicalJson(decision)) {
    throw new Error('convergence decision does not match its policy and evidence snapshot');
  }
}

function normalizePolicy(input: ConvergencePolicy): ConvergencePolicy {
  if (!isRecord(input)) throw new Error('convergence policy must be an object');
  for (const [name, value] of Object.entries({
    maximumWeightedResidualRisk: input.maximumWeightedResidualRisk,
    minimumReleaseConfidence: input.minimumReleaseConfidence,
    minimumWeightedRiskCoverage: input.minimumWeightedRiskCoverage,
    minimumCriticalFlowCoverage: input.minimumCriticalFlowCoverage,
  })) validateFraction(value, name);
  for (const [name, value] of Object.entries({
    maximumNovelVerifiedDefectsPer1000Requests: input.maximumNovelVerifiedDefectsPer1000Requests,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  }
  for (const [name, value] of Object.entries({
    minimumMeaningfulReviewUnits: input.minimumMeaningfulReviewUnits,
    minimumRequestsForYield: input.minimumRequestsForYield,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  const requiredCriticalFlowIds = normalizeIds(input.requiredCriticalFlowIds, 'required critical flow IDs');
  const requiredDeterministicCheckIds = normalizeIds(input.requiredDeterministicCheckIds, 'required deterministic check IDs');
  if (requiredCriticalFlowIds.length === 0) throw new Error('at least one required critical flow must be configured');
  if (requiredDeterministicCheckIds.length === 0) throw new Error('at least one required deterministic check must be configured');
  const minimumRemainingBudget = normalizeAmounts(input.minimumRemainingBudget, 'minimum remaining budget');
  if (Object.values(minimumRemainingBudget).every((amount) => amount === 0)) {
    throw new Error('minimum remaining budget must reserve a positive amount in at least one dimension');
  }
  return {
    minimumMeaningfulReviewUnits: input.minimumMeaningfulReviewUnits,
    maximumWeightedResidualRisk: input.maximumWeightedResidualRisk,
    minimumReleaseConfidence: input.minimumReleaseConfidence,
    maximumNovelVerifiedDefectsPer1000Requests: input.maximumNovelVerifiedDefectsPer1000Requests,
    minimumRequestsForYield: input.minimumRequestsForYield,
    minimumWeightedRiskCoverage: input.minimumWeightedRiskCoverage,
    minimumCriticalFlowCoverage: input.minimumCriticalFlowCoverage,
    requiredCriticalFlowIds,
    requiredDeterministicCheckIds,
    minimumRemainingBudget,
  };
}

function normalizeAssessment(input: ConvergenceAssessment): ConvergenceAssessment {
  if (!isRecord(input) || typeof input.runId !== 'string' || !input.runId.trim()) throw new Error('convergence assessment requires a runId');
  validateCertification(input.certification);
  const certification = normalizeCertification(input.certification);
  const currentCertificationState = normalizeCurrentState(input.currentCertificationState);
  const confidenceFrontier = normalizeConfidenceSnapshot(input.confidenceFrontier);
  const budgetState = normalizeBudgetState(input.budget?.state);
  const budgetEvidence = normalizeEvidence(input.budget?.evidence, 'budget evidence');
  const criticalFlows = normalizeFlows(input.criticalFlows);
  const findings = normalizeFindings(input.findings);
  const reviewUnits = normalizeReviewUnits(input.reviewUnits, new Set(findings.map((finding) => finding.id)));
  return {
    runId: input.runId.trim(),
    certification,
    currentCertificationState,
    confidenceFrontier,
    budget: { state: budgetState, evidence: budgetEvidence },
    criticalFlows,
    findings,
    reviewUnits,
  };
}

function normalizeCertification(input: Certification): Certification {
  const certificationInput: CertificationInput = {
    runId: input.runId,
    commit: input.commit,
    specificationGraphHash: input.specificationGraphHash,
    architectureGraphHash: input.architectureGraphHash,
    testStateHash: input.testStateHash,
    deterministicChecks: input.deterministicChecks,
    reviewEvidence: input.reviewEvidence,
    acceptedRisks: input.acceptedRisks,
    residualFindings: input.residualFindings,
    criticalFlowCoverage: input.criticalFlowCoverage,
    weightedRiskCoverage: input.weightedRiskCoverage,
  };
  const normalized = createCertification(certificationInput);
  return input.status === 'invalidated'
    ? invalidateCertification(normalized, input.invalidationReason!)
    : normalized;
}

function normalizeCurrentState(input: CertificationCurrentState): CertificationCurrentState {
  if (!isRecord(input)) throw new Error('current certification state is required');
  return {
    commit: input.commit,
    specificationGraphHash: input.specificationGraphHash,
    architectureGraphHash: input.architectureGraphHash,
    testStateHash: input.testStateHash,
  };
}

function normalizeConfidenceSnapshot(input: ConvergenceConfidenceSnapshot): ConvergenceConfidenceSnapshot {
  if (!isRecord(input) || input.schemaVersion !== 1) throw new Error('unsupported confidence frontier snapshot');
  validateFraction(input.initialResidualRisk, 'initialResidualRisk');
  validateFraction(input.residualRisk, 'residualRisk');
  if (!Array.isArray(input.unresolvedClaims) || !Array.isArray(input.effortCurve)) throw new Error('confidence frontier arrays are required');
  const claims = input.unresolvedClaims.map((item) => {
    if (!isRecord(item) || !isRecord(item.claim)) throw new Error('invalid unresolved frontier claim');
    const claim = item.claim;
    if (typeof claim.id !== 'string' || !claim.id.trim() || typeof claim.claim !== 'string' || !claim.claim.trim() || claim.status !== 'unresolved') {
      throw new Error('invalid unresolved frontier claim');
    }
    validateFraction(claim.releaseImpact, `releaseImpact for ${claim.id}`);
    validateFraction(claim.confidence, `confidence for ${claim.id}`);
    validateFraction(item.potentialReleaseImpact, `potentialReleaseImpact for ${claim.id}`);
    const expected = round(claim.releaseImpact * (1 - claim.confidence));
    if (item.potentialReleaseImpact <= 0 || Math.abs(expected - item.potentialReleaseImpact) > 0.001) {
      throw new Error(`frontier impact does not match claim ${claim.id}`);
    }
    return { claim: { ...claim }, potentialReleaseImpact: item.potentialReleaseImpact };
  }).sort((a, b) => compareStable(a.claim.id, b.claim.id));
  assertUnique(claims.map(({ claim }) => claim.id), 'frontier claim IDs');
  const effortCurve = input.effortCurve.map(normalizeEffortPoint);
  if (effortCurve.length === 0) throw new Error('confidence frontier effort curve must have an initial point');
  const first = effortCurve[0]!;
  const last = effortCurve[effortCurve.length - 1]!;
  if (first.cumulativeEffort !== 0 || first.riskReduction !== 0 || first.actionId !== null ||
    first.marginalRiskReduction !== null || Math.abs(first.residualRisk - input.initialResidualRisk) > 0.001 ||
    Math.abs(last.residualRisk - input.residualRisk) > 0.001) {
    throw new Error('confidence frontier effort curve does not match its risk measurements');
  }
  for (let index = 1; index < effortCurve.length; index++) {
    const previous = effortCurve[index - 1]!;
    const current = effortCurve[index]!;
    if (current.cumulativeEffort < previous.cumulativeEffort || current.riskReduction < previous.riskReduction ||
      current.riskReduction > input.initialResidualRisk + 0.001 ||
      current.residualRisk > previous.residualRisk + 0.001 ||
      Math.abs(current.residualRisk - round(Math.max(0, input.initialResidualRisk - current.riskReduction))) > 0.001) {
      throw new Error('confidence frontier effort curve must be monotonic');
    }
  }
  return {
    schemaVersion: 1,
    initialResidualRisk: input.initialResidualRisk,
    residualRisk: input.residualRisk,
    unresolvedClaims: claims,
    effortCurve,
    evidence: normalizeEvidence(input.evidence, 'confidence frontier evidence'),
  };
}

function normalizeEffortPoint(input: ConfidenceEffortPoint): ConfidenceEffortPoint {
  if (!isRecord(input)) throw new Error('invalid confidence frontier effort point');
  if (!Number.isFinite(input.cumulativeEffort) || input.cumulativeEffort < 0) throw new Error('cumulativeEffort must be finite and non-negative');
  validateFraction(input.residualRisk, 'effort-curve residualRisk');
  validateFraction(input.riskReduction, 'effort-curve riskReduction');
  if (input.marginalRiskReduction !== null) {
    if (!Number.isFinite(input.marginalRiskReduction) || input.marginalRiskReduction < 0) throw new Error('marginalRiskReduction must be non-negative');
  }
  if (input.actionId !== null && (typeof input.actionId !== 'string' || !input.actionId.trim())) throw new Error('effort-curve actionId must be a string or null');
  return { ...input };
}

function normalizeBudgetState(input: ReviewBudgetState): ReviewBudgetState {
  if (!isRecord(input) || !isRecord(input.config) || !isRecord(input.spent) || !Array.isArray(input.entries)) {
    throw new Error('invalid review budget state');
  }
  const initialized = createReviewBudget(input.config);
  const spent = {} as Record<ReviewBudgetDimension, number>;
  for (const dimension of REVIEW_BUDGET_DIMENSIONS) {
    const value = input.spent[dimension];
    if (!Number.isFinite(value) || value < 0) throw new Error(`spent ${dimension} must be finite and non-negative`);
    spent[dimension] = value;
  }
  const seen = new Set<string>();
  const entries = input.entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.actionId !== 'string' || !entry.actionId.trim() || seen.has(entry.actionId)) {
      throw new Error('review budget action IDs must be non-empty and unique');
    }
    seen.add(entry.actionId);
    if (typeof entry.completed !== 'boolean' || !Array.isArray(entry.covered) || entry.covered.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new Error(`invalid review budget entry ${entry.actionId}`);
    }
    const usage = normalizeAmounts(entry.usage, `usage for ${entry.actionId}`);
    const covered = entry.completed ? [...new Set(entry.covered)].sort(compareStable) : [];
    return { actionId: entry.actionId, usage, completed: entry.completed, covered };
  }).sort((a, b) => compareStable(a.actionId, b.actionId));
  const entryTotals = {} as Record<ReviewBudgetDimension, number>;
  for (const dimension of REVIEW_BUDGET_DIMENSIONS) entryTotals[dimension] = 0;
  for (const entry of entries) for (const dimension of REVIEW_BUDGET_DIMENSIONS) entryTotals[dimension] += entry.usage[dimension] ?? 0;
  for (const dimension of REVIEW_BUDGET_DIMENSIONS) {
    if (Math.abs(entryTotals[dimension] - spent[dimension]) > 1e-8) {
      throw new Error(`review budget spent ${dimension} does not match its usage ledger`);
    }
  }
  return { ...initialized, config: { ...initialized.config, limits: { ...initialized.config.limits } }, spent, entries };
}

function normalizeFlows(input: CriticalFlowCertification[]): CriticalFlowCertification[] {
  if (!Array.isArray(input)) throw new Error('critical flow certifications must be an array');
  const flows = input.map((flow) => {
    if (!isRecord(flow) || typeof flow.flowId !== 'string' || !flow.flowId.trim() || typeof flow.certified !== 'boolean') {
      throw new Error('invalid critical flow certification');
    }
    return { flowId: flow.flowId, certified: flow.certified, evidence: normalizeEvidence(flow.evidence, `critical flow ${flow.flowId} evidence`) };
  }).sort((a, b) => compareStable(a.flowId, b.flowId));
  assertUnique(flows.map((flow) => flow.flowId), 'critical flow IDs');
  return flows;
}

function normalizeFindings(input: ConvergenceFinding[]): ConvergenceFinding[] {
  if (!Array.isArray(input)) throw new Error('convergence findings must be an array');
  const findings = input.map((finding) => {
    if (!isRecord(finding) || typeof finding.id !== 'string' || !finding.id.trim() ||
      !['critical', 'high', 'medium', 'low'].includes(finding.severity) ||
      !['open', 'resolved', 'accepted'].includes(finding.status) || typeof finding.verified !== 'boolean') {
      throw new Error('invalid convergence finding');
    }
    return { id: finding.id, severity: finding.severity, status: finding.status, verified: finding.verified, evidence: normalizeEvidence(finding.evidence, `finding ${finding.id} evidence`) };
  }).sort((a, b) => compareStable(a.id, b.id));
  assertUnique(findings.map((finding) => finding.id), 'convergence finding IDs');
  return findings;
}

function normalizeReviewUnits(input: ConvergenceReviewUnit[], findingIds: Set<string>): ConvergenceReviewUnit[] {
  if (!Array.isArray(input)) throw new Error('review units must be an array');
  const units = input.map((unit) => {
    if (!isRecord(unit) || typeof unit.id !== 'string' || !unit.id.trim() ||
      !['completed', 'incomplete'].includes(unit.status) || typeof unit.meaningful !== 'boolean' ||
      !Number.isSafeInteger(unit.requestCount) || unit.requestCount < 0 || !Array.isArray(unit.newFindings)) {
      throw new Error('invalid convergence review unit');
    }
    const discoveries = unit.newFindings.map((finding) => {
      if (!isRecord(finding) || typeof finding.id !== 'string' || !finding.id.trim() || !findingIds.has(finding.id) ||
        !['critical', 'high', 'medium', 'low'].includes(finding.severity) ||
        typeof finding.verified !== 'boolean' || typeof finding.novel !== 'boolean') {
        throw new Error(`invalid discovery in review unit ${unit.id}`);
      }
      return { id: finding.id, severity: finding.severity, verified: finding.verified, novel: finding.novel, evidence: normalizeEvidence(finding.evidence, `discovery ${finding.id} evidence`) };
    }).sort((a, b) => compareStable(a.id, b.id));
    return {
      id: unit.id,
      completedAt: normalizeDate(unit.completedAt, `completedAt for ${unit.id}`),
      status: unit.status,
      meaningful: unit.meaningful,
      requestCount: unit.requestCount,
      evidence: normalizeEvidence(unit.evidence, `review unit ${unit.id} evidence`),
      newFindings: discoveries,
    };
  }).sort((a, b) => compareStable(a.completedAt, b.completedAt) || compareStable(a.id, b.id));
  assertUnique(units.map((unit) => unit.id), 'review unit IDs');
  const discoveredIds = units.flatMap((unit) => unit.newFindings.map((finding) => finding.id));
  assertUnique(discoveredIds, 'new discovery IDs');
  return units;
}

function normalizeEvidence(input: FactoryEvidenceRef[], label: string): FactoryEvidenceRef[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  const evidence = input.map((item) => {
    if (!isFactoryEvidenceRef(item)) throw new Error(`${label} contains an invalid evidence reference`);
    return { ...item };
  });
  const unique = new Map(evidence.map((item) => [canonicalJson(item), item]));
  return [...unique.values()].sort((a, b) =>
    compareStable(a.id, b.id) || compareStable(a.uri, b.uri) || compareStable(a.kind, b.kind) || compareStable(a.sha256, b.sha256),
  );
}

function normalizeAmounts(input: ReviewBudgetAmounts, label: string): ReviewBudgetAmounts {
  if (!isRecord(input)) throw new Error(`${label} must be an object`);
  const result: ReviewBudgetAmounts = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(REVIEW_BUDGET_DIMENSIONS as readonly string[]).includes(key)) throw new Error(`unknown ${label} dimension: ${key}`);
    if (!Number.isFinite(value) || value! < 0) throw new Error(`${label} ${key} must be finite and non-negative`);
    result[key as ReviewBudgetDimension] = value;
  }
  return result;
}

function normalizeIds(input: string[], label: string): string[] {
  if (!Array.isArray(input) || input.some((id) => typeof id !== 'string' || !id.trim())) throw new Error(`${label} must be non-empty strings`);
  const ids = input.map((id) => id.trim()).sort(compareStable);
  assertUnique(ids, label);
  return ids;
}

function isEligibleMeaningfulUnit(unit: ConvergenceReviewUnit): boolean {
  return unit.status === 'completed' && unit.meaningful && unit.requestCount > 0 && unit.evidence.length > 0 &&
    unit.newFindings.every((finding) => !finding.verified || finding.evidence.length > 0);
}

function calculateReleaseConfidence(frontier: ConvergenceConfidenceSnapshot): number {
  const claims: ConfidenceFrontierClaimResult[] = frontier.unresolvedClaims;
  const totalImpact = claims.reduce((sum, item) => sum + item.claim.releaseImpact, 0);
  if (totalImpact === 0) return 1;
  return round(claims.reduce((sum, item) => sum + item.claim.releaseImpact * item.claim.confidence, 0) / totalImpact);
}

function gatherEvidenceReferences(assessment: ConvergenceAssessment): FactoryEvidenceRef[] {
  const references = [
    ...assessment.confidenceFrontier.evidence,
    ...assessment.budget.evidence,
    ...assessment.criticalFlows.flatMap((flow) => flow.evidence),
    ...assessment.findings.flatMap((finding) => finding.evidence),
    ...assessment.reviewUnits.flatMap((unit) => [
      ...unit.evidence,
      ...unit.newFindings.flatMap((finding) => finding.evidence),
    ]),
    ...assessment.certification.deterministicChecks.flatMap((check) => check.evidence.map((item) => certificationEvidenceRef(item.uri, item.sha256, 'command'))),
    ...assessment.certification.reviewEvidence.flatMap((review) => review.evidence.map((item) => certificationEvidenceRef(item.uri, item.sha256, 'review'))),
    ...assessment.certification.acceptedRisks.flatMap((risk) => risk.evidence.map((item) => certificationEvidenceRef(item.uri, item.sha256, 'external'))),
    ...assessment.certification.residualFindings.flatMap((finding) => finding.evidence.map((item) => certificationEvidenceRef(item.uri, item.sha256, 'external'))),
  ];
  return normalizeEvidence(references, 'decision evidence references');
}

function certificationEvidenceRef(uri: string, sha256: string, kind: FactoryEvidenceRef['kind']): FactoryEvidenceRef {
  return { id: `evidence:v1:${sha256}`, kind, uri, sha256 };
}

function toSerializableBudget(input: Record<ReviewBudgetDimension, number>): RemainingReviewBudget {
  return Object.fromEntries(REVIEW_BUDGET_DIMENSIONS.map((dimension) => [
    dimension,
    Number.isFinite(input[dimension]) ? input[dimension] : null,
  ])) as RemainingReviewBudget;
}

function convergenceDecisionPath(runFile: string, id: ConvergenceDecision['id']): string {
  const match = CONVERGENCE_ID.exec(id);
  if (!match?.[1]) throw new Error('invalid convergence decision ID');
  return join(runPaths(runFile).factory, `${FILE_PREFIX}${match[1]}.json`);
}

function criterion(
  id: ConvergenceCriterionId,
  passed: boolean,
  actual: unknown,
  threshold: unknown,
  detail: string,
): ConvergenceCriterion {
  return { id, passed, actual, threshold, detail };
}

function validateFraction(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite number from 0 to 1`);
}

function normalizeDate(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function assertUnique(values: string[], label: string): void {
  if (values.some((value) => !value) || new Set(values).size !== values.length) throw new Error(`${label} must be non-empty and unique`);
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function compareStable(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
