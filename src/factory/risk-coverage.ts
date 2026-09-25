/**
 * Risk and audit coverage for factory review campaigns.
 *
 * This module is intentionally a pure reporting/policy helper. It consumes
 * deterministic risk weights (for example `RiskScore.risk_score`, scaled by
 * LOC or another exposure measure) and review evidence, without changing DAG
 * storage or task execution.
 */

export type RiskCoverageKind = 'code' | 'dependency' | 'execution-path';

/** A measured unit in the campaign's risk inventory. `riskWeight` is expected
 * loss/exposure, not a percentage. Use a consistent scale across the inventory.
 */
export interface RiskCoverageUnit {
  id: string;
  kind: RiskCoverageKind;
  riskWeight: number;
  reviewed: boolean;
  /** Marks an execution path whose failure has high impact. */
  highImpact?: boolean;
  /** Marks risk exposed to authentication, authorization, secrets, or similar. */
  securitySensitive?: boolean;
}

export type AuditDimension =
  | 'files'
  | 'symbols'
  | 'dependencyEdges'
  | 'subsystems'
  | 'integrationBoundaries'
  | 'e2ePaths'
  | 'specialistPasses';

/** Total inventory and the identities with recorded review evidence. */
export interface AuditInventory {
  total: string[];
  reviewed: string[];
}

export type AuditEvidence = Partial<Record<AuditDimension, AuditInventory>>;

export interface AuditCoverageMetric {
  reviewed: number;
  total: number;
  /** Null means this dimension had no declared inventory. */
  percent: number | null;
}

export interface WeightedCoverageMetric {
  inspectedRisk: number;
  totalRisk: number;
  /** Null means there was no risk weight in this population. */
  percent: number | null;
}

export interface RiskCoverageReport {
  auditCoverage: Record<AuditDimension, AuditCoverageMetric>;
  riskCoverage: {
    /** Combined code, dependency, and execution-path risk. */
    weightedRisk: WeightedCoverageMetric;
    codeRisk: WeightedCoverageMetric;
    dependencyRisk: WeightedCoverageMetric;
    highImpactExecutionPaths: WeightedCoverageMetric;
    securitySensitiveRisk: WeightedCoverageMetric;
    /** Weighted risk that still has no inspection evidence. */
    residualRisk: {
      total: number;
      byKind: Record<RiskCoverageKind, number>;
      securitySensitive: number;
    };
  };
}

const AUDIT_DIMENSIONS: AuditDimension[] = [
  'files', 'symbols', 'dependencyEdges', 'subsystems',
  'integrationBoundaries', 'e2ePaths', 'specialistPasses',
];

/**
 * Calculate traditional audit counts alongside exposure-weighted risk
 * coverage. Duplicate IDs in an audit inventory count once; review IDs not
 * present in its declared total are ignored.
 */
export function calculateRiskCoverage(
  units: readonly RiskCoverageUnit[],
  audit: AuditEvidence = {},
): RiskCoverageReport {
  validateUnits(units);

  const auditCoverage = {} as Record<AuditDimension, AuditCoverageMetric>;
  for (const dimension of AUDIT_DIMENSIONS) {
    const inventory = audit[dimension];
    if (!inventory) {
      auditCoverage[dimension] = { reviewed: 0, total: 0, percent: null };
      continue;
    }
    const totalIds = new Set(inventory.total);
    const reviewedIds = new Set(inventory.reviewed);
    let reviewed = 0;
    for (const id of totalIds) if (reviewedIds.has(id)) reviewed += 1;
    auditCoverage[dimension] = {
      reviewed,
      total: totalIds.size,
      percent: totalIds.size ? reviewed / totalIds.size : null,
    };
  }

  const weightedRisk = weightedMetric(units);
  const codeRisk = weightedMetric(units.filter((unit) => unit.kind === 'code'));
  const dependencyRisk = weightedMetric(units.filter((unit) => unit.kind === 'dependency'));
  const highImpactExecutionPaths = weightedMetric(
    units.filter((unit) => unit.kind === 'execution-path' && unit.highImpact === true),
  );
  const securityUnits = units.filter((unit) => unit.securitySensitive === true);
  const securitySensitiveRisk = weightedMetric(securityUnits);
  const byKind: Record<RiskCoverageKind, number> = { code: 0, dependency: 0, 'execution-path': 0 };
  let residualTotal = 0;
  let residualSecurity = 0;
  for (const unit of units) {
    if (unit.reviewed) continue;
    byKind[unit.kind] += unit.riskWeight;
    residualTotal += unit.riskWeight;
    if (unit.securitySensitive) residualSecurity += unit.riskWeight;
  }

  return {
    auditCoverage,
    riskCoverage: {
      weightedRisk,
      codeRisk,
      dependencyRisk,
      highImpactExecutionPaths,
      securitySensitiveRisk,
      residualRisk: { total: residualTotal, byKind, securitySensitive: residualSecurity },
    },
  };
}

/**
 * Order review work to maximize risk reduction: unreviewed work comes first,
 * then highest exposure weight. Stable ID ordering makes schedules reproducible.
 */
export function prioritizeRiskCoverage<T extends RiskCoverageUnit>(units: readonly T[]): T[] {
  validateUnits(units);
  return [...units].sort((a, b) =>
    Number(a.reviewed) - Number(b.reviewed) ||
    b.riskWeight - a.riskWeight ||
    a.id.localeCompare(b.id),
  );
}

function weightedMetric(units: readonly RiskCoverageUnit[]): WeightedCoverageMetric {
  let totalRisk = 0;
  let inspectedRisk = 0;
  for (const unit of units) {
    totalRisk += unit.riskWeight;
    if (unit.reviewed) inspectedRisk += unit.riskWeight;
  }
  return { inspectedRisk, totalRisk, percent: totalRisk > 0 ? inspectedRisk / totalRisk : null };
}

function validateUnits(units: readonly RiskCoverageUnit[]): void {
  const ids = new Set<string>();
  for (const unit of units) {
    if (!unit.id || ids.has(unit.id)) throw new Error(`risk coverage unit IDs must be non-empty and unique: ${unit.id}`);
    ids.add(unit.id);
    if (!['code', 'dependency', 'execution-path'].includes(unit.kind)) {
      throw new Error(`unknown risk coverage kind for ${unit.id}: ${String(unit.kind)}`);
    }
    if (!Number.isFinite(unit.riskWeight) || unit.riskWeight < 0) {
      throw new Error(`riskWeight for ${unit.id} must be a finite non-negative number`);
    }
    if (typeof unit.reviewed !== 'boolean') throw new Error(`reviewed for ${unit.id} must be boolean`);
  }
}
