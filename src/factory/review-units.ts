import type { CodeGraphIndex } from './code-graph.js';
import type { CodeEntity, CodeEdgeType } from './graph-model.js';

/** A bounded, graph-derived packet of code identities for one review. */
export interface ReviewUnit {
  nucleus: string;
  inbound: string[];
  outbound: string[];
  lateral: string[];
  tests: string[];
  contracts: string[];
}

export interface ReviewUnitOptions {
  /** Hard cap for all distinct entities in a unit, including its nucleus. */
  maxContextEntities?: number;
  /** Per-role cap for direct inbound and outbound dependencies. */
  maxNeighbors?: number;
  /** Per shared hub cap while discovering lateral neighbors. */
  maxLateralPerHub?: number;
  /** Restrict which code kinds can become review nuclei. */
  nucleusKinds?: readonly CodeEntity['kind'][];
  /** Approximate context cap, measured from serialized entity metadata. */
  maxContextChars?: number;
}

// These relationships represent dependency or behavior flow. Structural
// containment/declaration edges are intentionally omitted to avoid pulling an
// entire module into every symbol review.
const DEPENDENCY_EDGES = new Set<CodeEdgeType>([
  'imports', 'uses', 'calls', 'inherits', 'implements', 'reads', 'writes',
  'publishes', 'subscribes', 'serializes', 'deserializes',
]);
const CONTRACT_KINDS = new Set<CodeEntity['kind']>([
  'contract', 'api', 'schema', 'database_model', 'queue', 'event',
]);
const DEFAULT_NUCLEUS_KINDS: CodeEntity['kind'][] = ['file', 'symbol', 'function', 'class', 'api'];

/**
 * Create at most one review unit per eligible nucleus. Neighborhood lookup is
 * indexed once; lateral expansion is capped per shared hub, so a high-degree
 * node produces linear-many bounded units rather than pairwise edge reviews.
 */
export function generateReviewUnits(index: CodeGraphIndex, options: ReviewUnitOptions = {}): ReviewUnit[] {
  const maxContextEntities = positiveInt(options.maxContextEntities, 24, 'maxContextEntities');
  const maxNeighbors = positiveInt(options.maxNeighbors, 8, 'maxNeighbors');
  const maxLateralPerHub = positiveInt(options.maxLateralPerHub, 8, 'maxLateralPerHub');
  const maxContextChars = positiveInt(options.maxContextChars, 12000, 'maxContextChars');
  const nucleusKinds = new Set(options.nucleusKinds ?? DEFAULT_NUCLEUS_KINDS);
  const entities = new Map<string, CodeEntity>(index.graph.entities.map((entity) => [entity.id, entity]));
  const inbound = new Map<string, Set<string>>();
  const outbound = new Map<string, Set<string>>();
  const tests = new Map<string, Set<string>>();

  const add = (map: Map<string, Set<string>>, key: string, value: string): void => {
    let values = map.get(key);
    if (!values) map.set(key, (values = new Set()));
    values.add(value);
  };
  for (const edge of index.graph.edges) {
    if (edge.type === 'tests') {
      add(tests, edge.to, edge.from);
      add(tests, edge.from, edge.to);
      continue;
    }
    if (!DEPENDENCY_EDGES.has(edge.type)) continue;
    add(outbound, edge.from, edge.to);
    add(inbound, edge.to, edge.from);
  }

  const ordered = (map: Map<string, Set<string>>): Map<string, string[]> => new Map(
    [...map].map(([id, values]) => [id, [...values].sort((a, b) => a.localeCompare(b))]),
  );
  // Sort each adjacency list once. A star hub can be shared by many nuclei;
  // sorting its full neighbor list inside each unit would reintroduce O(d²).
  const inboundOrder = ordered(inbound);
  const outboundOrder = ordered(outbound);
  const testOrder = ordered(tests);
  const sorted = (map: Map<string, string[]>, id: string): string[] => map.get(id) ?? [];
  const nuclei = index.graph.entities
    .filter((entity) => nucleusKinds.has(entity.kind))
    .sort((a, b) => a.id.localeCompare(b.id));

  return nuclei.map((nucleus) => {
    const incoming = sorted(inboundOrder, nucleus.id).slice(0, maxNeighbors);
    const outgoing = sorted(outboundOrder, nucleus.id).slice(0, maxNeighbors);
    const lateralCandidates = new Set<string>();
    // Share a direct dependency/source or consumer with the nucleus. Work per
    // hub is bounded even when that hub has thousands of adjacent entities.
    for (const hub of incoming) {
      for (const peer of sorted(outboundOrder, hub).slice(0, maxLateralPerHub)) {
        if (peer !== nucleus.id) lateralCandidates.add(peer);
      }
    }
    for (const hub of outgoing) {
      for (const peer of sorted(inboundOrder, hub).slice(0, maxLateralPerHub)) {
        if (peer !== nucleus.id) lateralCandidates.add(peer);
      }
    }
    for (const id of [...incoming, ...outgoing]) lateralCandidates.delete(id);

    const unit: ReviewUnit = {
      nucleus: nucleus.id,
      inbound: [],
      outbound: [],
      lateral: [],
      tests: [],
      contracts: [],
    };
    const selected = new Set<string>([nucleus.id]);
    let chars = entityCost(nucleus);
    const addRole = (role: keyof Omit<ReviewUnit, 'nucleus'>, candidates: string[], roleCap: number): void => {
      for (const id of candidates) {
        if (unit[role].length >= roleCap || selected.has(id)) continue;
        const entity = entities.get(id);
        if (!entity || selected.size >= maxContextEntities) continue;
        const cost = entityCost(entity);
        if (chars + cost > maxContextChars) continue;
        selected.add(id);
        chars += cost;
        unit[role].push(id);
      }
    };

    addRole('inbound', incoming, maxNeighbors);
    addRole('outbound', outgoing, maxNeighbors);
    addRole('lateral', [...lateralCandidates].sort((a, b) => a.localeCompare(b)), maxNeighbors);

    // Tests and contracts are selected only when directly attached to context
    // already admitted, and share the same entity/character budget.
    const contextIds = [...selected];
    const testIds = uniqueSorted(contextIds.flatMap((id) => sorted(testOrder, id).slice(0, maxNeighbors)))
      .filter((id) => entities.get(id)?.kind === 'test' || isTestEntity(entities.get(id)));
    addRole('tests', testIds, maxNeighbors);
    const contractIds = uniqueSorted(contextIds.flatMap((id) => [
      ...sorted(inboundOrder, id).slice(0, maxNeighbors),
      ...sorted(outboundOrder, id).slice(0, maxNeighbors),
    ])).filter((id) => CONTRACT_KINDS.has(entities.get(id)?.kind ?? 'symbol'));
    addRole('contracts', contractIds, maxNeighbors);
    return unit;
  });
}

function entityCost(entity: CodeEntity): number {
  // Count the serialized graph record, which is the data this module can
  // actually budget without source-content measurements from a compiler.
  return JSON.stringify(entity).length + 8;
}

function isTestEntity(entity: CodeEntity | undefined): boolean {
  return entity?.kind === 'file' && /(?:^|\/)(?:__tests__\/|test\/|tests\/)|\.(?:test|spec)\.[cm]?tsx?$/.test(entity.title);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
