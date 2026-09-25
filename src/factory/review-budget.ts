/**
 * Pure review-budget policy for the existing DAG runner. This module chooses
 * which ordinary review action is worth launching and accounts for its actual
 * resource use; it does not execute work or persist a parallel run state.
 */

export const REVIEW_BUDGET_DIMENSIONS = [
  'requests', 'tokens', 'usd', 'strong_model_requests', 'wall_clock_minutes',
] as const;

export type ReviewBudgetDimension = typeof REVIEW_BUDGET_DIMENSIONS[number];
export type ReviewBudgetAmounts = Partial<Record<ReviewBudgetDimension, number>>;

export interface ReviewRiskUnit {
  id: string;
  /** Non-negative exposure weight on a scale consistent across this inventory. */
  riskWeight: number;
  /** An unresolved critical risk unit cannot be silently skipped. */
  riskScore?: number;
}

export interface ReviewBudgetConfig {
  /** Omitted dimensions are unconstrained; zero is a hard zero allowance. */
  limits?: ReviewBudgetAmounts;
  /** Optional risk-weighted coverage objective, from 0 to 1. */
  minimumRiskCoverage?: number;
  /** Risk score at or above which budget exhaustion requires escalation. */
  highRiskThreshold?: number;
}

export interface ReviewBudgetAction {
  id: string;
  unit: string;
  riskScore: number;
  /** Estimated decrease in residual risk if this review is completed. */
  expectedRiskReduction: number;
  /** Estimated spend, used for admission and value-per-cost ordering. */
  estimatedCost: ReviewBudgetAmounts;
  /** Risk inventory expected to be inspected by this action. */
  covers?: readonly string[];
}

export interface ReviewBudgetEntry {
  actionId: string;
  usage: ReviewBudgetAmounts;
  completed: boolean;
  covered: string[];
}

export interface ReviewBudgetState {
  config: Required<Pick<ReviewBudgetConfig, 'highRiskThreshold'>> & ReviewBudgetConfig;
  spent: Record<ReviewBudgetDimension, number>;
  entries: ReviewBudgetEntry[];
}

export interface ReviewBudgetCoverage {
  inspectedRisk: number;
  totalRisk: number;
  percent: number | null;
  residualRisk: number;
  targetMet: boolean;
}

export interface ReviewBudgetDecision {
  status: 'schedule' | 'complete' | 'escalate';
  nextAction?: ReviewBudgetAction;
  reason: string;
  remaining: Record<ReviewBudgetDimension, number>;
  coverage: ReviewBudgetCoverage;
  escalation?: {
    kind: 'human-review' | 'increase-budget' | 'accept-residual-risk';
    reason: string;
    blockedActionIds: string[];
  };
}

const emptyAmounts = (): Record<ReviewBudgetDimension, number> => ({
  requests: 0,
  tokens: 0,
  usd: 0,
  strong_model_requests: 0,
  wall_clock_minutes: 0,
});

/** Create a fresh ledger. Limits are copied and validated to keep policy pure. */
export function createReviewBudget(config: ReviewBudgetConfig = {}): ReviewBudgetState {
  validateAmounts(config.limits ?? {}, 'budget limits');
  const minimumRiskCoverage = config.minimumRiskCoverage ?? 0;
  if (!Number.isFinite(minimumRiskCoverage) || minimumRiskCoverage < 0 || minimumRiskCoverage > 1) {
    throw new Error('minimumRiskCoverage must be a finite number from 0 to 1');
  }
  const highRiskThreshold = config.highRiskThreshold ?? 80;
  if (!Number.isFinite(highRiskThreshold) || highRiskThreshold < 0 || highRiskThreshold > 100) {
    throw new Error('highRiskThreshold must be a finite number from 0 to 100');
  }
  return {
    config: { ...config, limits: { ...config.limits }, minimumRiskCoverage, highRiskThreshold },
    spent: emptyAmounts(),
    entries: [],
  };
}

/** Remaining allowance by dimension; Infinity means that dimension is open. */
export function remainingReviewBudget(state: ReviewBudgetState): Record<ReviewBudgetDimension, number> {
  const remaining = emptyAmounts();
  for (const dimension of REVIEW_BUDGET_DIMENSIONS) {
    remaining[dimension] = state.config.limits?.[dimension] === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, state.config.limits[dimension]! - state.spent[dimension]);
  }
  return remaining;
}

/**
 * Record actual cost, even when it exceeds the estimate or configured cap.
 * This makes overruns visible and prevents accounting from hiding real spend.
 */
export function accountReviewUsage(
  state: ReviewBudgetState,
  action: Pick<ReviewBudgetAction, 'id' | 'covers'>,
  usage: ReviewBudgetAmounts,
  completed = true,
): ReviewBudgetState {
  if (!action.id) throw new Error('review action id must be non-empty');
  if (state.entries.some((entry) => entry.actionId === action.id)) {
    throw new Error(`review action already accounted: ${action.id}`);
  }
  validateAmounts(usage, 'actual review usage');
  const spent = { ...state.spent };
  for (const dimension of REVIEW_BUDGET_DIMENSIONS) spent[dimension] += usage[dimension] ?? 0;
  return {
    ...state,
    spent,
    entries: [...state.entries, {
      actionId: action.id,
      usage: { ...usage },
      completed,
      covered: completed ? [...new Set(action.covers ?? [])] : [],
    }],
  };
}

/**
 * Select the affordable review with the greatest expected residual-risk
 * reduction per normalized unit of remaining budget. Stable IDs break ties.
 */
export function chooseNextReviewAction(
  state: ReviewBudgetState,
  actions: readonly ReviewBudgetAction[],
  inventory: readonly ReviewRiskUnit[] = [],
): ReviewBudgetDecision {
  validateInventory(inventory);
  validateActions(actions);
  const remaining = remainingReviewBudget(state);
  const coverage = calculateBudgetCoverage(state, inventory);
  const completedIds = new Set(state.entries.map((entry) => entry.actionId));
  const pending = actions.filter((action) => !completedIds.has(action.id));
  const affordable = pending
    .filter((action) => canAfford(action.estimatedCost, remaining))
    .sort((a, b) => valueScore(b, remaining) - valueScore(a, remaining) ||
      b.expectedRiskReduction - a.expectedRiskReduction || a.id.localeCompare(b.id));
  const uncoveredHighRisk = inventory.filter((unit) =>
    (unit.riskScore ?? 0) >= state.config.highRiskThreshold && !isCovered(state, unit.id),
  );

  if (affordable.length) {
    const nextAction = affordable[0]!;
    return {
      status: 'schedule',
      nextAction,
      reason: `highest expected risk reduction per remaining budget unit among ${affordable.length} affordable review(s)`,
      remaining,
      coverage,
    };
  }

  if (pending.length === 0 && coverage.targetMet) {
    return { status: 'complete', reason: 'all proposed reviews are accounted for and the risk-coverage target is met', remaining, coverage };
  }

  const blockedActionIds = pending.map((action) => action.id).sort();
  const blockedCritical = uncoveredHighRisk.length > 0 || pending.some((action) => action.riskScore >= state.config.highRiskThreshold);
  const targetUnmet = !coverage.targetMet;
  const reason = blockedCritical
    ? `budget cannot fund review of ${uncoveredHighRisk.length || pending.length} high-risk item(s)`
    : targetUnmet
      ? `risk coverage target ${state.config.minimumRiskCoverage} is unmet at ${coverage.percent ?? 0}`
      : 'no affordable review actions remain';
  const kind = blockedCritical ? 'human-review' : targetUnmet ? 'increase-budget' : 'accept-residual-risk';
  return {
    status: 'escalate',
    reason,
    remaining,
    coverage,
    escalation: { kind, reason, blockedActionIds },
  };
}

export function calculateBudgetCoverage(
  state: ReviewBudgetState,
  inventory: readonly ReviewRiskUnit[],
): ReviewBudgetCoverage {
  const totalRisk = inventory.reduce((sum, unit) => sum + unit.riskWeight, 0);
  const coveredIds = new Set(state.entries.filter((entry) => entry.completed).flatMap((entry) => entry.covered));
  const inspectedRisk = inventory.reduce((sum, unit) => sum + (coveredIds.has(unit.id) ? unit.riskWeight : 0), 0);
  const percent = totalRisk > 0 ? inspectedRisk / totalRisk : null;
  const target = state.config.minimumRiskCoverage ?? 0;
  return {
    inspectedRisk,
    totalRisk,
    percent,
    residualRisk: totalRisk - inspectedRisk,
    targetMet: percent === null ? target === 0 : percent >= target,
  };
}

function isCovered(state: ReviewBudgetState, id: string): boolean {
  return state.entries.some((entry) => entry.completed && entry.covered.includes(id));
}

function canAfford(cost: ReviewBudgetAmounts, remaining: ReviewBudgetAmounts): boolean {
  return REVIEW_BUDGET_DIMENSIONS.every((dimension) =>
    (cost[dimension] ?? 0) <= (remaining[dimension] ?? Number.POSITIVE_INFINITY),
  );
}

function valueScore(action: ReviewBudgetAction, remaining: ReviewBudgetAmounts): number {
  const costs = REVIEW_BUDGET_DIMENSIONS
    .map((dimension) => action.estimatedCost[dimension] ?? 0)
    .filter((cost) => cost > 0);
  if (!costs.length) return action.expectedRiskReduction > 0 ? Number.POSITIVE_INFINITY : 0;
  const normalizedCost = REVIEW_BUDGET_DIMENSIONS.reduce((sum, dimension) => {
    const cost = action.estimatedCost[dimension] ?? 0;
    const available = remaining[dimension] ?? Number.POSITIVE_INFINITY;
    return sum + (cost === 0 ? 0 : Number.isFinite(available) && available > 0 ? cost / available : cost);
  }, 0);
  return normalizedCost > 0 ? action.expectedRiskReduction / normalizedCost : 0;
}

function validateAmounts(amounts: ReviewBudgetAmounts, label: string): void {
  for (const [key, value] of Object.entries(amounts)) {
    if (!(REVIEW_BUDGET_DIMENSIONS as readonly string[]).includes(key)) throw new Error(`unknown ${label} dimension: ${key}`);
    if (!Number.isFinite(value) || value! < 0) throw new Error(`${label} ${key} must be a finite non-negative number`);
  }
}

function validateInventory(inventory: readonly ReviewRiskUnit[]): void {
  const ids = new Set<string>();
  for (const unit of inventory) {
    if (!unit.id || ids.has(unit.id)) throw new Error(`risk unit IDs must be non-empty and unique: ${unit.id}`);
    ids.add(unit.id);
    if (!Number.isFinite(unit.riskWeight) || unit.riskWeight < 0) throw new Error(`riskWeight for ${unit.id} must be finite and non-negative`);
    if (unit.riskScore !== undefined && (!Number.isFinite(unit.riskScore) || unit.riskScore < 0 || unit.riskScore > 100)) {
      throw new Error(`riskScore for ${unit.id} must be a finite number from 0 to 100`);
    }
  }
}

function validateActions(actions: readonly ReviewBudgetAction[]): void {
  const ids = new Set<string>();
  for (const action of actions) {
    if (!action.id || ids.has(action.id)) throw new Error(`review action IDs must be non-empty and unique: ${action.id}`);
    ids.add(action.id);
    if (!action.unit) throw new Error(`review action ${action.id} must name a unit`);
    if (!Number.isFinite(action.riskScore) || action.riskScore < 0 || action.riskScore > 100) throw new Error(`riskScore for ${action.id} must be from 0 to 100`);
    if (!Number.isFinite(action.expectedRiskReduction) || action.expectedRiskReduction < 0) throw new Error(`expectedRiskReduction for ${action.id} must be finite and non-negative`);
    validateAmounts(action.estimatedCost, `estimated cost for ${action.id}`);
  }
}
