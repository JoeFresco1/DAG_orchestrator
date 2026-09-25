import type { CodeEntity, FactoryGraphEntityId } from './graph-model.js';
import type { CodeGraphIndex } from './code-graph.js';

/** Deterministic measurements supplied by static analysis or recorded history. */
export interface RiskEvidence {
  loc?: number;
  cyclomaticComplexity?: number;
  coverage?: number;
  authenticationSensitivity?: number;
  authorizationSensitivity?: number;
  persistence?: boolean;
  concurrency?: boolean;
  externalIntegrations?: number;
  schemaOwnership?: boolean;
  deterministicFailures?: number;
  recentChurn?: number;
  generatedCode?: boolean;
  verifiedDefects?: number;
  regressionRate?: number;
  unresolvedUncertainty?: number;
}

export interface RiskSignals extends RiskEvidence {
  fanIn: number;
  fanOut: number;
  dependents: number;
  centrality: number;
  publicApi: boolean;
  tested: boolean;
}

export interface RiskScore {
  unit: CodeGraphEntityId;
  impact: number;
  defect_probability: number;
  uncertainty: number;
  risk_score: number;
  /** Values used by the scorer. Graph-derived values are always present. */
  signals: RiskSignals;
  /** Weighted normalized contribution by sub-score, on the 0..1 scale. */
  sub_scores: {
    impact: Record<string, number>;
    defect_probability: Record<string, number>;
    uncertainty: Record<string, number>;
  };
  /** Signal names which were unavailable and therefore omitted from scoring. */
  missing_signals: string[];
}

export interface RankRiskOptions {
  /** Optional deterministic evidence keyed by code graph entity ID. */
  evidence?: Partial<Record<CodeGraphEntityId, RiskEvidence>>;
  /** Restrict ranking to these reviewable code entities. Defaults to all non-module, non-test entities. */
  units?: CodeGraphEntityId[];
}

export type CodeGraphEntityId = FactoryGraphEntityId<'code'>;

type Metric = { name: string; value: number | boolean | undefined; weight: number; normalize?: (value: number) => number };
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const threshold = (value: number, scale: number): number => clamp01(value / scale);

/**
 * Score reviewable units from graph structure and optional static/history evidence.
 * Missing measurements are omitted from their sub-score and reported explicitly;
 * they are not silently interpreted as zero. No LLM or wall-clock data is used.
 */
export function rankReviewableUnits(index: CodeGraphIndex, options: RankRiskOptions = {}): RiskScore[] {
  const entities = new Map(index.graph.entities.map((entity) => [entity.id, entity]));
  const eligible: CodeGraphEntityId[] = options.units
    ? [...new Set(options.units)].filter((id) => {
      const entity = entities.get(id);
      return entity !== undefined && entity.kind !== 'module' && entity.kind !== 'test';
    })
    : index.graph.entities.filter((entity) => entity.kind !== 'module' && entity.kind !== 'test').map((entity) => entity.id as CodeGraphEntityId);
  const edges = index.graph.edges;
  const relevantEdges = edges.filter((edge) => edge.type !== 'contains' && edge.type !== 'declares' && edge.type !== 'tests');

  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const edge of relevantEdges) {
    add(incoming, edge.to, edge.from);
    add(outgoing, edge.from, edge.to);
  }
  const apiTargets = new Set(edges.filter((edge) => edge.type === 'uses' && entities.get(edge.to)?.kind === 'api').map((edge) => edge.from));
  const testedTargets = new Set(edges.filter((edge) => edge.type === 'tests').map((edge) => edge.to));
  const writesTargets = new Set(edges.filter((edge) => edge.type === 'writes').map((edge) => edge.to));
  const schemaEntities = new Set(index.graph.entities.filter((entity) => ['schema', 'database_model', 'data'].includes(entity.kind)).map((entity) => entity.id));
  const persistenceOwners = new Set(edges.filter((edge) => edge.type === 'writes' && schemaEntities.has(edge.to)).map((edge) => edge.from));
  const undirected = new Map<string, Set<string>>();
  for (const edge of relevantEdges) { add(undirected, edge.from, edge.to); add(undirected, edge.to, edge.from); }
  const centrality = calculateCentrality(entities, undirected);

  return eligible.map((unit) => {
    const entity = entities.get(unit)!;
    const supplied = options.evidence?.[unit] ?? {};
    const fanIn = incoming.get(unit)?.size ?? 0;
    const fanOut = outgoing.get(unit)?.size ?? 0;
    const dependents = reverseReachable(unit, incoming);
    const inferredPersistence = persistenceOwners.has(unit) || (schemaEntities.has(unit) && writesTargets.has(unit));
    const persistence = supplied.persistence ?? (inferredPersistence || schemaEntities.has(unit) ? true : undefined);
    const publicApi = apiTargets.has(unit) || entity.kind === 'api';
    const tested = testedTargets.has(unit);
    const signals: RiskSignals = {
      ...supplied,
      fanIn, fanOut, dependents, centrality: centrality.get(unit) ?? 0,
      publicApi, tested,
      ...(persistence === undefined ? {} : { persistence }),
    };

    const impactMetrics: Metric[] = [
      { name: 'fan_in', value: fanIn, weight: 2, normalize: (value) => threshold(value, 10) },
      { name: 'dependents', value: dependents, weight: 2, normalize: (value) => threshold(value, 12) },
      { name: 'centrality', value: centrality.get(unit) ?? 0, weight: 2, normalize: (value) => clamp01(value * Math.max(1, entities.size)) },
      { name: 'public_api', value: publicApi, weight: 2 },
      { name: 'persistence', value: persistence, weight: 1.5 },
      { name: 'external_integrations', value: supplied.externalIntegrations, weight: 1.5, normalize: (value) => threshold(value, 3) },
      { name: 'schema_ownership', value: supplied.schemaOwnership ?? (schemaEntities.has(unit) ? true : undefined), weight: 1.5 },
      { name: 'authentication_sensitivity', value: supplied.authenticationSensitivity, weight: 2 },
      { name: 'authorization_sensitivity', value: supplied.authorizationSensitivity, weight: 2 },
      { name: 'concurrency', value: supplied.concurrency, weight: 1.5 },
    ];
    const defectMetrics: Metric[] = [
      { name: 'loc', value: supplied.loc, weight: 1, normalize: (value) => threshold(value, 500) },
      { name: 'cyclomatic_complexity', value: supplied.cyclomaticComplexity, weight: 2, normalize: (value) => threshold(value, 20) },
      { name: 'fan_out', value: fanOut, weight: 1.5, normalize: (value) => threshold(value, 10) },
      { name: 'low_coverage', value: supplied.coverage, weight: 2, normalize: (value) => 1 - clamp01(value) },
      { name: 'untested', value: tested ? 0 : 1, weight: 1.5 },
      { name: 'deterministic_failures', value: supplied.deterministicFailures, weight: 2, normalize: (value) => threshold(value, 3) },
      { name: 'recent_churn', value: supplied.recentChurn, weight: 1, normalize: (value) => threshold(value, 20) },
      { name: 'verified_defects', value: supplied.verifiedDefects, weight: 2, normalize: (value) => threshold(value, 3) },
      { name: 'regression_rate', value: supplied.regressionRate, weight: 2 },
    ];
    const uncertaintyMetrics: Metric[] = [
      { name: 'coverage_unknown', value: supplied.coverage === undefined ? 1 : 0, weight: 2 },
      { name: 'history_unknown', value: supplied.verifiedDefects === undefined && supplied.regressionRate === undefined ? 1 : 0, weight: 1.5 },
      { name: 'unresolved_uncertainty', value: supplied.unresolvedUncertainty, weight: 2 },
      { name: 'generated_code', value: supplied.generatedCode, weight: 0.5 },
    ];
    const score = (metrics: Metric[]) => aggregate(metrics);
    const impact = score(impactMetrics);
    const defectProbability = score(defectMetrics);
    const uncertainty = score(uncertaintyMetrics);
    return {
      unit, impact: impact.value, defect_probability: defectProbability.value,
      uncertainty: uncertainty.value,
      risk_score: impact.value * defectProbability.value * uncertainty.value,
      signals,
      sub_scores: { impact: impact.contributions, defect_probability: defectProbability.contributions, uncertainty: uncertainty.contributions },
      missing_signals: [...new Set([...impact.missing, ...defectProbability.missing, ...uncertainty.missing])].sort(),
    };
  }).sort((a, b) => b.risk_score - a.risk_score || a.unit.localeCompare(b.unit));
}

function aggregate(metrics: Metric[]): { value: number; contributions: Record<string, number>; missing: string[] } {
  let weightedSum = 0; let totalWeight = 0;
  const contributions: Record<string, number> = {};
  const missing: string[] = [];
  for (const metric of metrics) {
    if (metric.value === undefined) { missing.push(metric.name); continue; }
    const raw = typeof metric.value === 'boolean' ? Number(metric.value) : metric.value;
    if (!Number.isFinite(raw)) { missing.push(metric.name); continue; }
    const normalized = clamp01(metric.normalize ? metric.normalize(raw) : raw);
    weightedSum += normalized * metric.weight;
    totalWeight += metric.weight;
    contributions[metric.name] = normalized * metric.weight / metrics.reduce((sum, item) => sum + (item.value === undefined ? 0 : item.weight), 0);
  }
  return { value: totalWeight ? weightedSum / totalWeight : 0, contributions, missing };
}

function add(map: Map<string, Set<string>>, from: string, to: string): void {
  const values = map.get(from) ?? new Set<string>(); values.add(to); map.set(from, values);
}
function reverseReachable(start: string, incoming: Map<string, Set<string>>): number {
  const seen = new Set<string>(); const queue = [...(incoming.get(start) ?? [])];
  while (queue.length) { const next = queue.shift()!; if (next === start || seen.has(next)) continue; seen.add(next); queue.push(...(incoming.get(next) ?? [])); }
  return seen.size;
}
function calculateCentrality(entities: Map<string, CodeEntity>, adjacency: Map<string, Set<string>>): Map<string, number> {
  const degree = new Map<string, number>();
  for (const id of entities.keys()) degree.set(id, adjacency.get(id)?.size ?? 0);
  const max = Math.max(1, ...degree.values());
  return new Map([...degree].map(([id, value]) => [id, value / max]));
}
