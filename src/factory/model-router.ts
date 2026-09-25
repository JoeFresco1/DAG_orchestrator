/**
 * Risk, calibration, and budget aware selection for the existing harness chain.
 * The router only chooses among candidates supplied by the caller; execution,
 * retries, and fallback remain owned by DagRunner.
 */
import type { ReviewerCalibrationReport } from './reviewer-calibration.js';

export type ModelTier = 'cheap' | 'medium' | 'strong';
export type ModelReviewType = 'implementation' | 'local' | 'dependency' | 'integration' | 'security' | 'adjudication' | 'other';

export interface ModelRouteCandidate {
  harness: string;
  model?: string | null;
  variant?: string | null;
  /** Capability tier, generally derived from the configured chain order. */
  tier: ModelTier;
  /** Optional cost estimate in USD per request. */
  estimatedCost?: number;
}

export interface ModelRouteEvidence {
  taskTitle: string;
  taskSpec?: string;
  riskScore?: number;
  reviewType?: ModelReviewType | string;
  uncertainty?: number;
  /** A prior unresolved/rejected stage justifies escalation. */
  unresolved?: boolean;
  /** Set when deterministic evidence has already resolved the task. */
  deterministicResolved?: boolean;
  /** Maximum spend for this selection; omitted means no explicit cap. */
  remainingBudgetUsd?: number;
  /** A pinned explicit setting bypasses routing. */
  override?: { harness?: string | null; model?: string | null };
}

export interface ModelRouteDecision {
  schemaVersion: 1;
  candidate: ModelRouteCandidate | null;
  tier: ModelTier | 'deterministic' | 'human';
  reviewType: ModelReviewType;
  riskScore: number;
  uncertainty: number;
  reason: string;
  calibration: { precision: number | null; sampleSize: number };
  estimatedCost: number | null;
}

const TIERS: ModelTier[] = ['cheap', 'medium', 'strong'];
const SECURITY = /auth|security|credential|permission|secret|crypto|token/i;
const INTEGRATION = /api|contract|schema|database|migration|queue|event|integration/i;
const DEPENDENCY = /dependenc|impact|graph/i;
const DISPUTE = /disput|adjudicat|conflict|contradict/i;

/** Choose the least costly sufficiently capable configured chain candidate. */
export function routeModel(
  evidence: ModelRouteEvidence,
  candidates: readonly ModelRouteCandidate[],
  calibration?: ReviewerCalibrationReport,
): ModelRouteDecision {
  validate(evidence, candidates);
  const reviewType = normalizeReviewType(evidence.reviewType ?? inferReviewType(evidence.taskTitle, evidence.taskSpec));
  const riskScore = clamp(evidence.riskScore ?? inferRisk(evidence.taskTitle, evidence.taskSpec));
  const uncertainty = clamp(evidence.uncertainty ?? (evidence.unresolved ? 75 : 25));

  if (evidence.override?.harness || evidence.override?.model) {
    const selected = candidates.find((candidate) =>
      (!evidence.override?.harness || candidate.harness === evidence.override.harness) &&
      (!evidence.override?.model || candidate.model === evidence.override.model),
    ) ?? null;
    return decision(selected, selected?.tier ?? 'human', reviewType, riskScore, uncertainty,
      `explicit ${evidence.override.harness ? 'harness' : 'model'} override preserved`, null, 0);
  }

  if (evidence.deterministicResolved && riskScore < 60 && !evidence.unresolved) {
    return decision(null, 'deterministic', reviewType, riskScore, uncertainty,
      'deterministic evidence resolved this low-risk task; no model is needed', null, 0);
  }

  if (candidates.length === 0) {
    return decision(null, 'human', reviewType, riskScore, uncertainty,
      'no configured harness candidate can address the unresolved risk; human escalation is required', null, 0);
  }

  // Risk and uncertainty are independent reasons to escalate. A previously
  // rejected/disputed stage also escalates, while a pass does not trigger a
  // second, stronger model to repeat already resolved work.
  const targetIndex = evidence.unresolved || riskScore >= 85 || uncertainty >= 80 ? 2
    : riskScore >= 55 || uncertainty >= 55 ? 1 : 0;
  const eligible = candidates.map((candidate) => ({ candidate, calibration: calibrationFor(candidate, reviewType, calibration) }))
    .filter(({ candidate }) => TIERS.indexOf(candidate.tier) >= targetIndex)
    .filter(({ candidate }) => evidence.remainingBudgetUsd === undefined ||
      (candidate.estimatedCost ?? calibrationFor(candidate, reviewType, calibration).averageCost ?? 0) <= evidence.remainingBudgetUsd)
    .filter(({ calibration: score }) => score.precision === null || score.sampleSize < 3 || score.precision >= requiredPrecision(riskScore));

  eligible.sort((a, b) => (a.candidate.estimatedCost ?? a.calibration.averageCost ?? Number.POSITIVE_INFINITY) -
    (b.candidate.estimatedCost ?? b.calibration.averageCost ?? Number.POSITIVE_INFINITY) ||
    TIERS.indexOf(a.candidate.tier) - TIERS.indexOf(b.candidate.tier) ||
    a.candidate.harness.localeCompare(b.candidate.harness) || (a.candidate.model ?? '').localeCompare(b.candidate.model ?? ''));
  const selected = eligible[0];
  if (!selected) {
    const reason = riskScore >= 85 || evidence.unresolved
      ? 'no sufficiently capable candidate fits the remaining budget; human escalation is required'
      : 'no candidate meets the risk, calibration, and budget requirements; human escalation is required';
    return decision(null, 'human', reviewType, riskScore, uncertainty, reason, null, 0);
  }

  const calibrationText = selected.calibration.precision === null
    ? 'no adjudicated calibration data; conservative tier requirement applied'
    : `calibrated precision ${selected.calibration.precision.toFixed(2)} over ${selected.calibration.sampleSize} finding(s)`;
  const riskText = evidence.unresolved ? 'unresolved prior stage' : `risk ${riskScore}, uncertainty ${uncertainty}`;
  return decision(selected.candidate, selected.candidate.tier, reviewType, riskScore, uncertainty,
    `selected the lowest-cost sufficient ${selected.candidate.tier} candidate for ${reviewType} review (${riskText}; ${calibrationText})`,
    selected.calibration.precision, selected.calibration.sampleSize,
    selected.candidate.estimatedCost ?? selected.calibration.averageCost ?? null);
}

/** Infer a stable review type from task metadata when the caller has no label. */
export function inferReviewType(title: string, spec = ''): ModelReviewType {
  const text = `${title}\n${spec}`;
  if (DISPUTE.test(text)) return 'adjudication';
  if (SECURITY.test(text)) return 'security';
  if (INTEGRATION.test(text)) return 'integration';
  if (DEPENDENCY.test(text)) return 'dependency';
  if (/review|verify|audit|inspect/i.test(text)) return 'local';
  return 'implementation';
}

function calibrationFor(candidate: ModelRouteCandidate, reviewType: string, report?: ReviewerCalibrationReport): { precision: number | null; sampleSize: number; averageCost: number | null } {
  if (!report || !candidate.model) return { precision: null, sampleSize: 0, averageCost: null };
  const buckets = report.buckets.filter((bucket) => bucket.model === candidate.model && bucket.reviewType === reviewType);
  const sampleSize = buckets.reduce((sum, bucket) => sum + bucket.precisionSampleSize, 0);
  const costBuckets = buckets.filter((bucket) => bucket.averageCost !== null && bucket.reviews > 0);
  return {
    precision: sampleSize ? buckets.reduce((sum, bucket) => sum + (bucket.findingsVerified), 0) / sampleSize : null,
    sampleSize,
    averageCost: costBuckets.length ? costBuckets.reduce((sum, bucket) => sum + bucket.averageCost! * bucket.reviews, 0) /
      costBuckets.reduce((sum, bucket) => sum + bucket.reviews, 0) : null,
  };
}

function requiredPrecision(risk: number): number { return risk >= 85 ? 0.9 : risk >= 55 ? 0.75 : 0.6; }
function inferRisk(title: string, spec = ''): number {
  const text = `${title}\n${spec}`;
  return SECURITY.test(text) ? 90 : INTEGRATION.test(text) ? 65 : 25;
}
function normalizeReviewType(type: string): ModelReviewType {
  return (['implementation', 'local', 'dependency', 'integration', 'security', 'adjudication'] as string[]).includes(type)
    ? type as ModelReviewType : 'other';
}
function clamp(value: number): number { return Math.max(0, Math.min(100, value)); }
function decision(candidate: ModelRouteCandidate | null, tier: ModelRouteDecision['tier'], reviewType: ModelReviewType,
  riskScore: number, uncertainty: number, reason: string, precision: number | null, sampleSize: number, cost = candidate?.estimatedCost ?? null): ModelRouteDecision {
  return { schemaVersion: 1, candidate, tier, reviewType, riskScore, uncertainty, reason,
    calibration: { precision, sampleSize }, estimatedCost: cost };
}
function validate(evidence: ModelRouteEvidence, candidates: readonly ModelRouteCandidate[]): void {
  if (!evidence || typeof evidence.taskTitle !== 'string') throw new Error('model routing requires a task title');
  if (evidence.riskScore !== undefined && (!Number.isFinite(evidence.riskScore) || evidence.riskScore < 0 || evidence.riskScore > 100)) throw new Error('riskScore must be from 0 to 100');
  if (evidence.uncertainty !== undefined && (!Number.isFinite(evidence.uncertainty) || evidence.uncertainty < 0 || evidence.uncertainty > 100)) throw new Error('uncertainty must be from 0 to 100');
  if (evidence.remainingBudgetUsd !== undefined && (!Number.isFinite(evidence.remainingBudgetUsd) || evidence.remainingBudgetUsd < 0)) throw new Error('remainingBudgetUsd must be non-negative');
  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.harness || !TIERS.includes(candidate.tier)) throw new Error('each model route candidate needs a harness and valid tier');
    if (candidate.estimatedCost !== undefined && (!Number.isFinite(candidate.estimatedCost) || candidate.estimatedCost < 0)) throw new Error('estimatedCost must be non-negative');
    const key = `${candidate.harness}\0${candidate.model ?? ''}`;
    if (keys.has(key)) throw new Error(`duplicate model route candidate: ${candidate.harness}/${candidate.model ?? ''}`);
    keys.add(key);
  }
}
