/** Deterministic semantic blast-radius analysis over the typed code graph. */
import { createHash } from 'node:crypto';
import type { FactoryEntityId } from './contracts.js';
import type { CodeEntity, CodeEdgeType } from './graph-model.js';
import { validateCodeGraphIndex, type CodeGraphIndex } from './code-graph.js';
import type { EvidenceBackedFact, ProjectMemory } from './project-memory.js';

export interface ImpactChange {
  /** Human-readable description retained in the report. */
  change: string;
  /** Code entity IDs and/or repository-relative source paths. */
  changed: string[];
}

export interface ImpactGraphPath {
  changed: FactoryEntityId;
  affected: FactoryEntityId;
  /** Ordered from changed code toward its consumers. */
  nodes: FactoryEntityId[];
  /** Typed edges in the graph's stored direction. */
  edges: Array<{ type: CodeEdgeType; from: FactoryEntityId; to: FactoryEntityId }>;
}

export interface InvalidatedAssumption {
  component: string;
  section: string;
  id: string;
  value: EvidenceBackedFact['value'];
  reason: string;
  evidence: EvidenceBackedFact['evidence'];
}

export interface ImpactSet {
  schemaVersion: 1;
  change: string;
  changed_units: FactoryEntityId[];
  invalidated_units: FactoryEntityId[];
  affected_paths: ImpactGraphPath[];
  affected_requirements: FactoryEntityId[];
  affected_tests: FactoryEntityId[];
  invalidated_assumptions: InvalidatedAssumption[];
  required_reviews: string[];
  /** Hash of the canonical report fields, excluding this hash. */
  reproducibility_hash: string;
}

export interface ImpactAnalysisOptions {
  graph: CodeGraphIndex;
  change: ImpactChange;
  /** Evidence-backed memory generated from a certified baseline. */
  projectMemory?: ProjectMemory;
}

/**
 * Resolve changed symbols/contracts or files, then walk only typed consumer
 * relationships. Edges in the code graph point from a consumer to its
 * dependency, so propagation walks incoming edges (and reverses them in the
 * returned path). `contains`/`declares` are intentionally excluded: ownership
 * alone does not make every sibling semantically affected.
 */
export function analyzeSemanticImpact(options: ImpactAnalysisOptions): ImpactSet {
  validateCodeGraphIndex(options.graph);
  if (!options.change.change.trim()) throw new Error('impact change description cannot be empty');
  if (options.change.changed.length === 0) throw new Error('impact analysis requires at least one changed symbol, contract, or file');

  const entities = new Map<string, CodeEntity>(options.graph.graph.entities.map((entity) => [entity.id, entity]));
  const byPath = new Map(options.graph.files.map((file) => [normalizePath(file.path), `code:v1:file/${file.path}` as FactoryEntityId]));
  const changed = new Set<FactoryEntityId>();
  for (const key of options.change.changed) {
    const id = entities.has(key) ? key as FactoryEntityId : byPath.get(normalizePath(key));
    if (!id) throw new Error(`unknown changed code entity or file: ${key}`);
    changed.add(id);
  }

  const sortedEdges = [...options.graph.graph.edges].sort((a, b) =>
    a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to));
  const incoming = new Map<string, typeof sortedEdges>();
  for (const edge of sortedEdges) {
    if (!isImpactEdge(edge.type)) continue;
    const list = incoming.get(edge.to) ?? [];
    list.push(edge);
    incoming.set(edge.to, list);
  }

  // Multi-source breadth-first search yields the shortest deterministic typed
  // witness path to every affected entity, independent of input ordering.
  const queue: FactoryEntityId[] = [...changed].sort();
  const paths = new Map<FactoryEntityId, ImpactGraphPath>();
  const depth = new Map<FactoryEntityId, number>(queue.map((id) => [id, 0]));
  while (queue.length) {
    const current = queue.shift()!;
    const currentDepth = depth.get(current)!;
    for (const edge of incoming.get(current) ?? []) {
      const consumer = edge.from as FactoryEntityId;
      if (changed.has(consumer)) continue;
      const nextDepth = currentDepth + 1;
      const knownDepth = depth.get(consumer);
      if (knownDepth !== undefined && knownDepth <= nextDepth) continue;
      const prior = paths.get(current);
      const root = prior?.changed ?? current;
      const nodes = [...(prior?.nodes ?? [current]), consumer];
      const edges = [...(prior?.edges ?? []), { type: edge.type, from: edge.from as FactoryEntityId, to: edge.to as FactoryEntityId }];
      paths.set(consumer, { changed: root, affected: consumer, nodes, edges });
      depth.set(consumer, nextDepth);
      queue.push(consumer);
    }
  }

  // Changed file paths represent source edits. Seed their declared entities as
  // well, so a normal TS source edit reaches callers while a stylesheet or
  // other declaration-free file remains local.
  const fileSeeds = [...changed].filter((id) => entities.get(id)?.kind === 'file');
  for (const fileId of fileSeeds) {
    const declarations = sortedEdges.filter((edge) => edge.type === 'declares' && edge.from === fileId).map((edge) => edge.to as FactoryEntityId);
    if (declarations.length) {
      const expanded = analyzeFromSeeds(options.graph, [...changed, ...declarations]);
      for (const [id, path] of expanded) if (!changed.has(id)) paths.set(id, path);
    }
  }

  const affectedIds = [...paths.keys()].sort();
  const affectedRequirements = options.graph.links
    .filter((link) => link.type === 'implemented_by' && (changed.has(link.to as FactoryEntityId) || paths.has(link.to as FactoryEntityId)))
    .map((link) => link.from as FactoryEntityId);
  const affectedTests = new Set<FactoryEntityId>();
  for (const edge of sortedEdges) {
    if (edge.type === 'tests' && (changed.has(edge.to as FactoryEntityId) || paths.has(edge.to as FactoryEntityId))) {
      affectedTests.add(edge.from as FactoryEntityId);
    }
  }

  const invalidatedAssumptions = memoryAssumptions(options.projectMemory).filter(({ fact }) =>
    fact.evidence.some((evidence) => {
      const evidencePath = normalizePath(evidence.path);
      if ([...changed].some((id) => entityPath(entities.get(id)) === evidencePath)) return true;
      if (evidence.symbol && [...changed].some((id) => {
        const item = entities.get(id);
        return item?.title.endsWith(`::${evidence.symbol}`) || item?.title.endsWith(`#${evidence.symbol}`);
      })) return true;
      return affectedIds.some((id) => entityPath(entities.get(id)) === evidencePath ||
        (evidence.symbol !== undefined && entityMatchesSymbol(entities.get(id), evidence.symbol)));
    })).map(({ component, section, fact }) => ({
      component, section, id: fact.id, value: fact.value,
      reason: `evidence intersects the semantic impact set from ${options.projectMemory!.reviewedAtCommit}`,
      evidence: fact.evidence,
    }));

  const invalidatedUnits = [...new Set([...changed, ...affectedIds])].sort();
  const impacted = invalidatedUnits.map((id) => entities.get(id)).filter((item): item is CodeEntity => !!item);
  const requiredReviews = requiredReviewsFor(impacted, affectedTests.size, paths.size);
  const report = {
    schemaVersion: 1 as const,
    change: options.change.change.trim(),
    changed_units: [...changed].sort(),
    invalidated_units: invalidatedUnits,
    affected_paths: [...paths.values()].sort((a, b) => a.affected.localeCompare(b.affected) || a.changed.localeCompare(b.changed)),
    affected_requirements: [...new Set(affectedRequirements)].sort(),
    affected_tests: [...affectedTests].sort(),
    invalidated_assumptions: invalidatedAssumptions.sort((a, b) => a.component.localeCompare(b.component) || a.section.localeCompare(b.section) || a.id.localeCompare(b.id)),
    required_reviews: requiredReviews,
  };
  return { ...report, reproducibility_hash: sha256(stableJson(report)) };
}

function analyzeFromSeeds(graph: CodeGraphIndex, seeds: FactoryEntityId[]): Map<FactoryEntityId, ImpactGraphPath> {
  const edges = [...graph.graph.edges].filter((edge) => isImpactEdge(edge.type))
    .sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to));
  const incoming = new Map<string, typeof edges>();
  for (const edge of edges) { const list = incoming.get(edge.to) ?? []; list.push(edge); incoming.set(edge.to, list); }
  const changed = new Set(seeds);
  const depth = new Map<FactoryEntityId, number>([...changed].map((id) => [id, 0]));
  const paths = new Map<FactoryEntityId, ImpactGraphPath>();
  const queue = [...changed].sort();
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of incoming.get(current) ?? []) {
      const consumer = edge.from as FactoryEntityId;
      if (changed.has(consumer)) continue;
      const nextDepth = depth.get(current)! + 1;
      if ((depth.get(consumer) ?? Infinity) <= nextDepth) continue;
      const previous = paths.get(current);
      paths.set(consumer, { changed: previous?.changed ?? current, affected: consumer,
        nodes: [...(previous?.nodes ?? [current]), consumer],
        edges: [...(previous?.edges ?? []), { type: edge.type, from: edge.from as FactoryEntityId, to: edge.to as FactoryEntityId }] });
      depth.set(consumer, nextDepth); queue.push(consumer);
    }
  }
  return paths;
}

function isImpactEdge(type: CodeEdgeType): boolean {
  return type === 'imports' || type === 'uses' || type === 'calls' || type === 'inherits' ||
    type === 'implements' || type === 'reads' || type === 'writes' || type === 'publishes' ||
    type === 'subscribes' || type === 'serializes' || type === 'deserializes' || type === 'tests';
}

function memoryAssumptions(memory?: ProjectMemory): Array<{ component: string; section: string; fact: EvidenceBackedFact }> {
  if (!memory) return [];
  const out: Array<{ component: string; section: string; fact: EvidenceBackedFact }> = [];
  for (const subsystem of Object.values(memory.subsystems).sort((a, b) => a.component.localeCompare(b.component))) {
    for (const section of ['contracts', 'known_invariants', 'critical_paths', 'entry_points'] as const) {
      for (const fact of subsystem[section]) out.push({ component: subsystem.component, section, fact });
    }
    for (const [key, fact] of Object.entries(subsystem.risk_profile).sort(([a], [b]) => a.localeCompare(b))) {
      out.push({ component: subsystem.component, section: `risk_profile.${key}`, fact });
    }
  }
  return out;
}

function entityPath(entity?: CodeEntity): string | undefined { return entity?.sourcePath ? normalizePath(entity.sourcePath) : undefined; }
function entityMatchesSymbol(entity: CodeEntity | undefined, symbol: string): boolean {
  return !!entity && (entity.title.endsWith(`::${symbol}`) || entity.title.endsWith(`#${symbol}`));
}
function normalizePath(value: string): string { return value.replace(/\\/g, '/').replace(/^\.\//, ''); }
function requiredReviewsFor(entities: CodeEntity[], tests: number, impactedCount: number): string[] {
  const reviews = new Set<string>();
  if (entities.some((entity) => ['schema', 'database_model', 'data', 'api', 'contract'].includes(entity.kind))) reviews.add('contract');
  if (tests > 0 || impactedCount > 1) reviews.add('integration');
  if (entities.some((entity) => /auth|permission|access.?control|identity/i.test(`${entity.title} ${entity.sourcePath ?? ''}`))) reviews.add('security');
  if (impactedCount > 0) reviews.add('dependency');
  return [...reviews].sort();
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
