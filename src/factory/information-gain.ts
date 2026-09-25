/**
 * Pure information-gain ranking for optional review actions. The caller still
 * admits and launches work through the existing review budget and DAG runner.
 */
import { isFactoryEvidenceRef, type FactoryEvidenceRef } from './contracts.js';
import { REVIEW_BUDGET_DIMENSIONS, type ReviewBudgetAction, type ReviewBudgetAmounts } from './review-budget.js';

export interface InformationGainAction extends ReviewBudgetAction {
  /** Stable review capability key, used to learn from comparable inspections. */
  reviewType: string;
  /** Expected fraction of the action's risk estimate that can be resolved (0..1). */
  expectedInformationGain: number;
}

/** A completed review outcome tied to content-addressed, recorded evidence. */
export interface InformationGainObservation {
  actionId: string;
  unit: string;
  reviewType: string;
  expectedRiskReduction: number;
  expectedInformationGain: number;
  observedRiskReduction: number;
  observedInformationGain: number;
  actualCost: ReviewBudgetAmounts;
  evidence: readonly FactoryEvidenceRef[];
}

export interface RankedInformationGainAction {
  action: InformationGainAction;
  /** Risk reduction × information gain × empirical yield / estimated cost. */
  priority: number;
  empiricalYield: number;
  comparableObservations: number;
}

export interface InformationGainRanking {
  schemaVersion: 1;
  actions: RankedInformationGainAction[];
}

/**
 * Rank optional reviews by expected risk reduction per estimated cost. Past
 * outcomes for the same unit and review type discount actions that have
 * repeatedly yielded little new information. With no matching history, the
 * action's supplied estimate is used unchanged.
 */
export function rankReviewActionsByInformationGain(
  actions: readonly InformationGainAction[],
  history: readonly InformationGainObservation[] = [],
): InformationGainRanking {
  validateHistory(history);
  validateActions(actions);

  const observations = new Map<string, InformationGainObservation[]>();
  for (const item of history) {
    const key = comparisonKey(item.unit, item.reviewType);
    const matching = observations.get(key) ?? [];
    matching.push(item);
    observations.set(key, matching);
  }

  const ranked = actions.map((action) => {
    const prior = observations.get(comparisonKey(action.unit, action.reviewType)) ?? [];
    const empiricalYield = prior.length
      ? prior.reduce((sum, item) => sum + observationYield(item), 0) / prior.length
      : 1;
    const benefit = action.expectedRiskReduction * action.expectedInformationGain * empiricalYield;
    const cost = estimateCost(action.estimatedCost);
    return {
      action,
      priority: cost === 0 ? (benefit > 0 ? Number.POSITIVE_INFINITY : 0) : benefit / cost,
      empiricalYield,
      comparableObservations: prior.length,
    };
  }).sort((a, b) => b.priority - a.priority ||
    b.action.expectedRiskReduction - a.action.expectedRiskReduction ||
    compareStable(a.action.id, b.action.id));

  return { schemaVersion: 1, actions: ranked };
}

function observationYield(item: InformationGainObservation): number {
  const riskYield = item.expectedRiskReduction === 0
    ? (item.observedRiskReduction === 0 ? 1 : 0)
    : Math.min(1, item.observedRiskReduction / item.expectedRiskReduction);
  const informationYield = item.expectedInformationGain === 0
    ? (item.observedInformationGain === 0 ? 1 : 0)
    : Math.min(1, item.observedInformationGain / item.expectedInformationGain);
  return riskYield * informationYield;
}

// Cost dimensions share an action-wide budget estimate. Summing positive
// dimensions gives a stable relative cost proxy; budget admission remains the
// review-budget manager's responsibility.
function estimateCost(cost: ReviewBudgetAmounts): number {
  return REVIEW_BUDGET_DIMENSIONS.reduce((sum, dimension) => sum + (cost[dimension] ?? 0), 0);
}

function comparisonKey(unit: string, reviewType: string): string {
  return JSON.stringify([unit, reviewType]);
}

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateActions(actions: readonly InformationGainAction[]): void {
  const ids = new Set<string>();
  for (const action of actions) {
    if (!action || typeof action.id !== 'string' || !action.id.trim() || ids.has(action.id)) {
      throw new Error(`information-gain action IDs must be non-empty and unique: ${action?.id}`);
    }
    ids.add(action.id);
    if (typeof action.unit !== 'string' || !action.unit.trim()) throw new Error(`action ${action.id} must name a unit`);
    if (typeof action.reviewType !== 'string' || !action.reviewType.trim()) throw new Error(`action ${action.id} must name a reviewType`);
    if (!Number.isFinite(action.expectedRiskReduction) || action.expectedRiskReduction < 0) {
      throw new Error(`expectedRiskReduction for ${action.id} must be finite and non-negative`);
    }
    validateFraction(action.expectedInformationGain, `expectedInformationGain for ${action.id}`);
    validateAmounts(action.estimatedCost, `estimated cost for ${action.id}`);
  }
}

function validateHistory(history: readonly InformationGainObservation[]): void {
  const ids = new Set<string>();
  for (const item of history) {
    if (!item || typeof item.actionId !== 'string' || !item.actionId.trim() || ids.has(item.actionId)) {
      throw new Error(`information-gain observation IDs must be non-empty and unique: ${item?.actionId}`);
    }
    ids.add(item.actionId);
    if (typeof item.unit !== 'string' || !item.unit.trim() || typeof item.reviewType !== 'string' || !item.reviewType.trim()) {
      throw new Error(`observation ${item.actionId} must name a unit and reviewType`);
    }
    for (const [field, value] of Object.entries({
      expectedRiskReduction: item.expectedRiskReduction,
      observedRiskReduction: item.observedRiskReduction,
    })) {
      if (!Number.isFinite(value) || value! < 0) throw new Error(`${field} for ${item.actionId} must be finite and non-negative`);
    }
    validateFraction(item.expectedInformationGain, `expectedInformationGain for ${item.actionId}`);
    validateFraction(item.observedInformationGain, `observedInformationGain for ${item.actionId}`);
    validateAmounts(item.actualCost, `actual cost for ${item.actionId}`);
    if (!Array.isArray(item.evidence) || item.evidence.length === 0 || !item.evidence.every(isFactoryEvidenceRef)) {
      throw new Error(`observation ${item.actionId} requires valid recorded evidence references`);
    }
  }
}

function validateAmounts(amounts: ReviewBudgetAmounts, label: string): void {
  if (!amounts || typeof amounts !== 'object') throw new Error(`${label} must be an object`);
  for (const [key, value] of Object.entries(amounts)) {
    if (!(REVIEW_BUDGET_DIMENSIONS as readonly string[]).includes(key)) throw new Error(`unknown ${label} dimension: ${key}`);
    if (!Number.isFinite(value) || value! < 0) throw new Error(`${label} ${key} must be finite and non-negative`);
  }
}

function validateFraction(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite number from 0 to 1`);
}
