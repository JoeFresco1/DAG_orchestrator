/**
 * Advisory view of unresolved release-confidence claims and review returns.
 * This is a pure factory projection: scheduling and persistence remain owned
 * by the existing DAG runner and factory artifact stores.
 */

export type ConfidenceClaimStatus = 'unresolved' | 'resolved' | 'accepted' | 'rejected';

/** A claim's maximum release-confidence influence and remaining uncertainty. */
export interface ConfidenceFrontierClaim {
  id: string;
  claim: string;
  status: ConfidenceClaimStatus;
  /** Maximum normalized change to release confidence if this claim is settled (0..1). */
  releaseImpact: number;
  /** Current confidence in the claim; unresolved fraction is 1 - confidence (0..1). */
  confidence: number;
}

/** Candidate review effort directed at one or more claims. */
export interface ConfidenceFrontierAction {
  id: string;
  unit: string;
  reviewType: string;
  claimIds: string[];
  /** Estimated effort in caller-defined units (requests, tokens, dollars, etc.). */
  estimatedEffort: number;
  /** Expected fraction of the addressed uncertainty this review can resolve. */
  expectedInformationGain: number;
}

/** A completed review measurement used to estimate diminishing returns. */
export interface ConfidenceFrontierObservation {
  actionId: string;
  unit: string;
  reviewType: string;
  effort: number;
  /** Absolute normalized release-risk reduction observed (0..1). */
  observedRiskReduction: number;
}

export interface ConfidenceFrontierClaimResult {
  claim: ConfidenceFrontierClaim;
  /** Remaining release-confidence change this unresolved claim could cause. */
  potentialReleaseImpact: number;
}

export interface RankedConfidenceFrontierAction {
  action: ConfidenceFrontierAction;
  /** Expected release-impact reduction per effort unit, discounted by past yield. */
  priority: number;
  expectedRiskReduction: number;
  empiricalYield: number;
  comparableObservations: number;
  unresolvedClaimIds: string[];
}

export interface ConfidenceEffortPoint {
  cumulativeEffort: number;
  residualRisk: number;
  riskReduction: number;
  /** Marginal absolute risk reduction per effort since the preceding point. */
  marginalRiskReduction: number | null;
  actionId: string | null;
}

export interface ConfidenceFrontier {
  schemaVersion: 1;
  unresolvedClaims: ConfidenceFrontierClaimResult[];
  actions: RankedConfidenceFrontierAction[];
  effortCurve: ConfidenceEffortPoint[];
  initialResidualRisk: number;
  residualRisk: number;
}

/**
 * Build a confidence frontier from current claims, optional review choices,
 * and completed review outcomes. Claims with no remaining uncertainty have no
 * frontier impact. Repeated low-yield reviews lose priority against reviews
 * that address material unresolved claims.
 */
export function buildConfidenceFrontier(
  claims: readonly ConfidenceFrontierClaim[],
  actions: readonly ConfidenceFrontierAction[] = [],
  history: readonly ConfidenceFrontierObservation[] = [],
  initialResidualRisk = 1,
): ConfidenceFrontier {
  validateFraction(initialResidualRisk, 'initialResidualRisk');
  validateClaims(claims);
  validateActions(actions, new Set(claims.map((claim) => claim.id)));
  validateHistory(history);

  const unresolvedClaims = claims
    .filter((claim) => claim.status === 'unresolved')
    .map((claim) => ({
      claim,
      potentialReleaseImpact: round(claim.releaseImpact * (1 - claim.confidence)),
    }))
    .filter((item) => item.potentialReleaseImpact > 0)
    .sort((a, b) => b.potentialReleaseImpact - a.potentialReleaseImpact || compareStable(a.claim.id, b.claim.id));
  const byId = new Map(unresolvedClaims.map((item) => [item.claim.id, item]));

  const historyByReview = new Map<string, ConfidenceFrontierObservation[]>();
  for (const observation of history) {
    const key = reviewKey(observation.unit, observation.reviewType);
    const matches = historyByReview.get(key) ?? [];
    matches.push(observation);
    historyByReview.set(key, matches);
  }

  const rankedActions = actions.map((action) => {
    const unresolvedClaimIds = action.claimIds.filter((id) => byId.has(id)).sort(compareStable);
    const potential = unresolvedClaimIds.reduce((sum, id) => sum + byId.get(id)!.potentialReleaseImpact, 0);
    const expectedRiskReduction = round(potential * action.expectedInformationGain);
    const prior = historyByReview.get(reviewKey(action.unit, action.reviewType)) ?? [];
    const empiricalYield = prior.length
      ? prior.reduce((sum, item) => sum + item.observedRiskReduction / Math.max(item.effort, Number.EPSILON), 0) /
        prior.length / Math.max(expectedRiskReduction / action.estimatedEffort, Number.EPSILON)
      : 1;
    const boundedYield = Math.max(0, Math.min(1, empiricalYield));
    const priority = action.estimatedEffort === 0
      ? (expectedRiskReduction > 0 ? Number.POSITIVE_INFINITY : 0)
      : expectedRiskReduction * boundedYield / action.estimatedEffort;
    return {
      action,
      priority: round(priority),
      expectedRiskReduction,
      empiricalYield: round(boundedYield),
      comparableObservations: prior.length,
      unresolvedClaimIds,
    };
  }).sort((a, b) => b.priority - a.priority || b.expectedRiskReduction - a.expectedRiskReduction || compareStable(a.action.id, b.action.id));

  const effortCurve = buildEffortCurve(history, initialResidualRisk);
  return {
    schemaVersion: 1,
    unresolvedClaims,
    actions: rankedActions,
    effortCurve,
    initialResidualRisk: round(initialResidualRisk),
    residualRisk: effortCurve[effortCurve.length - 1]!.residualRisk,
  };
}

function buildEffortCurve(
  history: readonly ConfidenceFrontierObservation[],
  initialResidualRisk: number,
): ConfidenceEffortPoint[] {
  const points: ConfidenceEffortPoint[] = [{
    cumulativeEffort: 0,
    residualRisk: round(initialResidualRisk),
    riskReduction: 0,
    marginalRiskReduction: null,
    actionId: null,
  }];
  // The caller supplies completed observations in their recorded order.
  const ordered = history;
  let cumulativeEffort = 0;
  let riskReduction = 0;
  for (const observation of ordered) {
    const previousReduction = riskReduction;
    cumulativeEffort += observation.effort;
    riskReduction = Math.min(initialResidualRisk, riskReduction + observation.observedRiskReduction);
    const observedReduction = riskReduction - previousReduction;
    points.push({
      cumulativeEffort: round(cumulativeEffort),
      residualRisk: round(Math.max(0, initialResidualRisk - riskReduction)),
      riskReduction: round(riskReduction),
      marginalRiskReduction: observation.effort === 0 ? null : round(observedReduction / observation.effort),
      actionId: observation.actionId,
    });
  }
  return points;
}

function validateClaims(claims: readonly ConfidenceFrontierClaim[]): void {
  const ids = new Set<string>();
  for (const claim of claims) {
    if (!claim || typeof claim.id !== 'string' || !claim.id.trim() || ids.has(claim.id)) {
      throw new Error(`confidence claim IDs must be non-empty and unique: ${claim?.id}`);
    }
    ids.add(claim.id);
    if (typeof claim.claim !== 'string' || !claim.claim.trim()) throw new Error(`claim ${claim.id} must have text`);
    if (!['unresolved', 'resolved', 'accepted', 'rejected'].includes(claim.status)) throw new Error(`invalid status for claim ${claim.id}`);
    validateFraction(claim.releaseImpact, `releaseImpact for ${claim.id}`);
    validateFraction(claim.confidence, `confidence for ${claim.id}`);
  }
}

function validateActions(actions: readonly ConfidenceFrontierAction[], claimIds: Set<string>): void {
  const ids = new Set<string>();
  for (const action of actions) {
    if (!action || typeof action.id !== 'string' || !action.id.trim() || ids.has(action.id)) {
      throw new Error(`confidence action IDs must be non-empty and unique: ${action?.id}`);
    }
    ids.add(action.id);
    if (typeof action.unit !== 'string' || !action.unit.trim() || typeof action.reviewType !== 'string' || !action.reviewType.trim()) {
      throw new Error(`action ${action.id} must name a unit and reviewType`);
    }
    if (!Array.isArray(action.claimIds) || action.claimIds.length === 0 || action.claimIds.some((id) => !claimIds.has(id))) {
      throw new Error(`action ${action.id} must reference known claims`);
    }
    if (new Set(action.claimIds).size !== action.claimIds.length) throw new Error(`action ${action.id} has duplicate claim IDs`);
    if (!Number.isFinite(action.estimatedEffort) || action.estimatedEffort < 0) throw new Error(`estimatedEffort for ${action.id} must be finite and non-negative`);
    validateFraction(action.expectedInformationGain, `expectedInformationGain for ${action.id}`);
  }
}

function validateHistory(history: readonly ConfidenceFrontierObservation[]): void {
  const ids = new Set<string>();
  for (const item of history) {
    if (!item || typeof item.actionId !== 'string' || !item.actionId.trim() || ids.has(item.actionId)) {
      throw new Error(`confidence observation IDs must be non-empty and unique: ${item?.actionId}`);
    }
    ids.add(item.actionId);
    if (typeof item.unit !== 'string' || !item.unit.trim() || typeof item.reviewType !== 'string' || !item.reviewType.trim()) {
      throw new Error(`observation ${item.actionId} must name a unit and reviewType`);
    }
    if (!Number.isFinite(item.effort) || item.effort < 0) throw new Error(`effort for ${item.actionId} must be finite and non-negative`);
    validateFraction(item.observedRiskReduction, `observedRiskReduction for ${item.actionId}`);
  }
}

function validateFraction(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite number from 0 to 1`);
}
function reviewKey(unit: string, reviewType: string): string { return JSON.stringify([unit, reviewType]); }
function compareStable(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
