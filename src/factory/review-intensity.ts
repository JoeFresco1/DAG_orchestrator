/**
 * Inspectable review-depth policy. Scores are on a 0..100 scale and the
 * default bands intentionally mirror SPEC 18's initial, uncalibrated tiers.
 */
export type ReviewIntensityTier =
  | 'deterministic'
  | 'local'
  | 'contract'
  | 'subsystem'
  | 'specialist'
  | 'independent';

export type ReviewIntensityTrigger =
  | 'deterministic-finding'
  | 'contradiction'
  | 'changed-contract'
  | 'verified-defect';

export interface ReviewIntensityEvidence {
  /** Risk estimate before applying newly observed escalation signals. */
  riskScore: number;
  triggers?: Partial<Record<ReviewIntensityTrigger, number>>;
}

export interface ReviewIntensityBand {
  tier: ReviewIntensityTier;
  minimumScore: number;
  maximumScore: number;
  stages: readonly string[];
}

export interface ReviewIntensityDecision {
  policyVersion: 1;
  baseScore: number;
  score: number;
  tier: ReviewIntensityTier;
  reasons: string[];
  requiredStages: ReviewIntensityBand['stages'];
  policy: readonly ReviewIntensityBand[];
}

export const REVIEW_INTENSITY_POLICY: readonly ReviewIntensityBand[] = [
  { tier: 'deterministic', minimumScore: 0, maximumScore: 20, stages: ['deterministic'] },
  { tier: 'local', minimumScore: 21, maximumScore: 40, stages: ['deterministic', 'local'] },
  { tier: 'contract', minimumScore: 41, maximumScore: 60, stages: ['deterministic', 'local', 'dependency', 'integration'] },
  { tier: 'subsystem', minimumScore: 61, maximumScore: 75, stages: ['deterministic', 'local', 'dependency', 'integration', 'subsystem'] },
  { tier: 'specialist', minimumScore: 76, maximumScore: 89, stages: ['deterministic', 'local', 'dependency', 'integration', 'subsystem', 'security'] },
  { tier: 'independent', minimumScore: 90, maximumScore: 100, stages: ['deterministic', 'local', 'dependency', 'integration', 'subsystem', 'security', 'e2e', 'independent'] },
];

const TRIGGER_POLICY: Record<ReviewIntensityTrigger, { points: number; label: string }> = {
  'deterministic-finding': { points: 20, label: 'new deterministic finding' },
  contradiction: { points: 20, label: 'contradictory evidence' },
  'changed-contract': { points: 18, label: 'changed contract' },
  'verified-defect': { points: 25, label: 'verified defect' },
};

/** Apply fixed, inspectable escalation increments, then select one policy band. */
export function assignReviewIntensity(evidence: ReviewIntensityEvidence): ReviewIntensityDecision {
  if (!Number.isFinite(evidence.riskScore) || evidence.riskScore < 0 || evidence.riskScore > 100) {
    throw new Error('riskScore must be a finite number from 0 to 100');
  }
  const reasons: string[] = [];
  let score = evidence.riskScore;
  for (const trigger of Object.keys(TRIGGER_POLICY) as ReviewIntensityTrigger[]) {
    const count = evidence.triggers?.[trigger] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${trigger} count must be a non-negative integer`);
    if (!count) continue;
    const { points, label } = TRIGGER_POLICY[trigger];
    const increase = Math.min(100 - score, points * count);
    score += increase;
    reasons.push(`${label}${count === 1 ? '' : ` (${count})`} adds ${increase} risk points`);
  }
  score = Math.round(Math.min(100, score));
  const band = REVIEW_INTENSITY_POLICY.find((item) => score >= item.minimumScore && score <= item.maximumScore)!;
  if (evidence.riskScore <= 20 && reasons.length === 0) {
    reasons.push('base risk is at most 20 and no escalation evidence was supplied; deterministic checks are sufficient');
  } else if (!reasons.length) {
    reasons.push(`base risk ${Math.round(evidence.riskScore)} falls in the ${band.minimumScore}–${band.maximumScore} ${band.tier} policy band`);
  }
  return {
    policyVersion: 1,
    baseScore: evidence.riskScore,
    score,
    tier: band.tier,
    reasons,
    requiredStages: band.stages,
    policy: REVIEW_INTENSITY_POLICY,
  };
}
