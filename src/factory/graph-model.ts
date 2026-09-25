import { isFactoryEntityId, type FactoryEntityId, type FactoryEntityKind } from './contracts.js';

export type RequirementEntityKind = 'goal' | 'spec' | 'requirement' | 'acceptance_criterion';
export type CodeEntityKind =
  | 'module' | 'file' | 'symbol' | 'function' | 'class' | 'api' | 'contract'
  | 'data' | 'schema' | 'database_model' | 'queue' | 'event' | 'test'
  | 'configuration' | 'external_service' | 'execution_path';
export type ExecutionEntityKind = 'implementation_task' | 'review_task' | 'verification_task' | 'remediation_task';
export type DefectEntityKind = 'observation' | 'hypothesis' | 'defect' | 'dispute' | 'root_cause' | 'remediation';
export type FactoryGraphEntityId<K extends FactoryEntityKind> = `${K}:v1:${string}`;

interface EntityBase<T extends string> {
  id: FactoryEntityId;
  kind: T;
  title: string;
  description?: string;
  evidenceIds?: string[];
  sourcePath?: string;
  sourceHash?: string;
}

export type RequirementEntity = EntityBase<RequirementEntityKind>;
export type CodeEntity = EntityBase<CodeEntityKind>;
export type ExecutionEntity = EntityBase<ExecutionEntityKind>;
export type DefectEntity = EntityBase<DefectEntityKind>;

export interface FactoryEntityByGraph {
  requirement: RequirementEntity;
  code: CodeEntity;
  execution: ExecutionEntity;
  defect: DefectEntity;
}

export type RequirementEdgeType = 'parent_of' | 'specifies' | 'decomposes_to' | 'accepts';
export type CodeEdgeType =
  | 'contains' | 'declares' | 'imports' | 'uses' | 'calls' | 'inherits'
  | 'implements' | 'reads' | 'writes' | 'publishes' | 'subscribes'
  | 'serializes' | 'deserializes' | 'tests';
export type ExecutionEdgeType = 'depends_on' | 'verifies' | 'reviews' | 'remediates';
export type DefectEdgeType = 'corroborates' | 'supports' | 'explains' | 'disputes' | 'remediates';

export interface FactoryEdge<
  E extends string = string,
  F extends FactoryEntityId = FactoryEntityId,
  T extends FactoryEntityId = FactoryEntityId,
> {
  type: E;
  from: F;
  to: T;
}

export interface FactoryGraphEdgeByKind {
  requirement: FactoryEdge<RequirementEdgeType, FactoryGraphEntityId<'requirement'>, FactoryGraphEntityId<'requirement'>>;
  code: FactoryEdge<CodeEdgeType, FactoryGraphEntityId<'code'>, FactoryGraphEntityId<'code'>>;
  execution: FactoryEdge<ExecutionEdgeType, FactoryGraphEntityId<'execution'>, FactoryGraphEntityId<'execution'>>;
  defect: FactoryEdge<DefectEdgeType, FactoryGraphEntityId<'defect'>, FactoryGraphEntityId<'defect'>>;
}

export interface FactoryGraph<K extends FactoryEntityKind> {
  kind: K;
  entities: FactoryEntityByGraph[K][];
  edges: FactoryGraphEdgeByKind[K][];
}

export interface FactoryGraphModel {
  schemaVersion: 1;
  graphs: {
    requirement: FactoryGraph<'requirement'>;
    code: FactoryGraph<'code'>;
    execution: FactoryGraph<'execution'>;
    defect: FactoryGraph<'defect'>;
  };
  links: FactoryCrossGraphEdge[];
}

export interface GraphEdgeTypeByKind {
  requirement: RequirementEdgeType;
  code: CodeEdgeType;
  execution: ExecutionEdgeType;
  defect: DefectEdgeType;
}

export type FactoryCrossGraphEdge =
  | FactoryEdge<'implemented_by', FactoryGraphEntityId<'requirement'>, FactoryGraphEntityId<'code'>> // requirement -> symbol
  | FactoryEdge<'modified_by', FactoryGraphEntityId<'code'>, FactoryGraphEntityId<'execution'>> // code entity -> execution task
  | FactoryEdge<'produced', FactoryGraphEntityId<'execution'>, FactoryGraphEntityId<'defect'>> // execution task -> observation
  | FactoryEdge<'supports', FactoryGraphEntityId<'defect'>, FactoryGraphEntityId<'defect'>> // observation -> hypothesis or defect
  | FactoryEdge<'explained_by', FactoryGraphEntityId<'defect'>, FactoryGraphEntityId<'defect'>> // defect -> root cause
  | FactoryEdge<'repaired_by', FactoryGraphEntityId<'defect'>, FactoryGraphEntityId<'execution'>> // root cause -> remediation task
  | FactoryEdge<'involves', FactoryGraphEntityId<'code'>, FactoryGraphEntityId<'defect'>>; // code entity -> finding/defect

const CODE_ENTITY_KINDS = [
  'module', 'file', 'symbol', 'function', 'class', 'api', 'contract', 'data', 'schema',
  'database_model', 'queue', 'event', 'test', 'configuration', 'external_service', 'execution_path',
];

const ENTITY_KINDS: Record<FactoryEntityKind, readonly string[]> = {
  requirement: ['goal', 'spec', 'requirement', 'acceptance_criterion'],
  code: CODE_ENTITY_KINDS,
  execution: ['implementation_task', 'review_task', 'verification_task', 'remediation_task'],
  defect: ['observation', 'hypothesis', 'defect', 'dispute', 'root_cause', 'remediation'],
};

const INTERNAL_EDGE_RULES: Record<FactoryEntityKind, Record<string, [string[], string[]]>> = {
  requirement: {
    parent_of: [['goal', 'spec', 'requirement'], ['goal', 'spec', 'requirement']],
    specifies: [['spec'], ['requirement', 'acceptance_criterion']],
    decomposes_to: [['requirement'], ['requirement', 'acceptance_criterion']],
    accepts: [['acceptance_criterion'], ['requirement', 'code', 'execution_path']],
  },
  code: {
    contains: [['module', 'file'], ['module', 'file', 'symbol', 'function', 'class', 'api', 'contract', 'data', 'schema', 'database_model', 'queue', 'event', 'test', 'configuration', 'external_service', 'execution_path']],
    declares: [['file', 'module', 'class', 'symbol', 'function', 'contract'], ['symbol', 'function', 'class', 'api', 'contract', 'data', 'schema', 'database_model', 'queue', 'event', 'configuration', 'external_service']],
    imports: [['file'], ['file']],
    uses: [['symbol', 'function', 'class', 'contract', 'execution_path'], ['symbol', 'function', 'class', 'api', 'contract', 'data', 'schema', 'database_model', 'queue', 'event', 'external_service']],
    calls: [['symbol', 'function'], ['symbol', 'function', 'class']],
    inherits: [['class'], ['class']],
    implements: [['class'], ['class', 'contract']],
    reads: [['symbol', 'function'], ['data', 'schema', 'database_model', 'configuration']],
    writes: [['symbol', 'function'], ['data', 'schema', 'database_model']],
    publishes: [['symbol', 'function'], ['event', 'queue']],
    subscribes: [['symbol', 'function'], ['event', 'queue']],
    serializes: [['symbol', 'function'], ['data', 'schema', 'api']],
    deserializes: [['symbol', 'function'], ['data', 'schema', 'api']],
    tests: [['file', 'symbol', 'function', 'class', 'contract', 'execution_path'], ['file', 'symbol', 'function', 'class']],
  },
  execution: {
    depends_on: [['implementation_task', 'review_task', 'verification_task', 'remediation_task'], ['implementation_task', 'review_task', 'verification_task', 'remediation_task']],
    verifies: [['verification_task', 'review_task'], ['implementation_task', 'remediation_task']],
    reviews: [['review_task'], ['implementation_task', 'remediation_task']],
    remediates: [['remediation_task'], ['implementation_task', 'remediation_task']],
  },
  defect: {
    corroborates: [['observation'], ['observation']],
    supports: [['observation', 'hypothesis'], ['hypothesis', 'defect']],
    explains: [['root_cause'], ['defect']],
    disputes: [['dispute'], ['hypothesis', 'defect', 'root_cause']],
    remediates: [['remediation'], ['defect', 'root_cause']],
  },
};

const CROSS_EDGE_RULES: Record<FactoryCrossGraphEdge['type'], [FactoryEntityKind, string[], FactoryEntityKind, string[]]> = {
  implemented_by: ['requirement', ['requirement'], 'code', ['symbol']],
  modified_by: ['code', CODE_ENTITY_KINDS, 'execution', ['implementation_task', 'remediation_task']],
  produced: ['execution', ['implementation_task', 'review_task', 'verification_task', 'remediation_task'], 'defect', ['observation']],
  supports: ['defect', ['observation'], 'defect', ['hypothesis', 'defect']],
  explained_by: ['defect', ['defect'], 'defect', ['root_cause']],
  repaired_by: ['defect', ['root_cause'], 'execution', ['remediation_task']],
  involves: ['code', ['module', 'file', 'symbol', 'function', 'class', 'api', 'contract', 'data', 'schema', 'database_model', 'queue', 'event', 'execution_path'], 'defect', ['observation', 'hypothesis', 'defect', 'root_cause']],
};

export function createFactoryGraphModel(): FactoryGraphModel {
  return {
    schemaVersion: 1,
    graphs: {
      requirement: { kind: 'requirement', entities: [], edges: [] },
      code: { kind: 'code', entities: [], edges: [] },
      execution: { kind: 'execution', entities: [], edges: [] },
      defect: { kind: 'defect', entities: [], edges: [] },
    },
    links: [],
  };
}

/** Validate graph membership, ID namespaces, uniqueness, and edge endpoint types. */
export function validateFactoryGraphModel(value: unknown): asserts value is FactoryGraphModel {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.graphs) || !Array.isArray(value.links)) {
    throw new Error('invalid factory graph model: expected schemaVersion 1, graphs, and links');
  }

  const entities = new Map<string, { graph: FactoryEntityKind; kind: string }>();
  const graphs = value.graphs as Record<string, unknown>;
  for (const graphKind of ['requirement', 'code', 'execution', 'defect'] as const) {
    const graph = graphs[graphKind];
    if (!isRecord(graph) || graph.kind !== graphKind || !Array.isArray(graph.entities) || !Array.isArray(graph.edges)) {
      throw new Error(`invalid ${graphKind} graph`);
    }
    for (const rawEntity of graph.entities) {
      if (!isRecord(rawEntity) || !isFactoryEntityId(rawEntity.id) || !rawEntity.id.startsWith(`${graphKind}:v1:`) ||
        typeof rawEntity.kind !== 'string' || !ENTITY_KINDS[graphKind].includes(rawEntity.kind) || typeof rawEntity.title !== 'string' || !rawEntity.title.trim()) {
        const details = isRecord(rawEntity)
          ? ` (id=${String(rawEntity.id)}, kind=${String(rawEntity.kind)}, title=${String(rawEntity.title)})`
          : '';
        throw new Error(`invalid entity in ${graphKind} graph${details}`);
      }
      if (entities.has(rawEntity.id)) throw new Error(`duplicate entity id: ${rawEntity.id}`);
      entities.set(rawEntity.id, { graph: graphKind, kind: rawEntity.kind });
    }
  }

  const checkEdge = (raw: unknown, rules: Record<string, [string[], string[]]>, graph: FactoryEntityKind): void => {
    if (!isRecord(raw) || typeof raw.type !== 'string' || !rules[raw.type] || typeof raw.from !== 'string' || typeof raw.to !== 'string') {
      throw new Error(`invalid edge in ${graph} graph`);
    }
    const from = entities.get(raw.from);
    const to = entities.get(raw.to);
    const [fromKinds, toKinds] = rules[raw.type];
    if (!from || !to) throw new Error(`dangling edge reference: ${raw.from} -> ${raw.to}`);
    if (from.graph !== graph || to.graph !== graph || !fromKinds.includes(from.kind) || !toKinds.includes(to.kind)) {
      throw new Error(`ill-typed ${raw.type} edge: ${raw.from} -> ${raw.to}`);
    }
  };

  for (const graphKind of ['requirement', 'code', 'execution', 'defect'] as const) {
    const graph = graphs[graphKind] as { edges: unknown[] };
    for (const edge of graph.edges) checkEdge(edge, INTERNAL_EDGE_RULES[graphKind], graphKind);
  }

  for (const edge of value.links) {
    if (!isRecord(edge) || typeof edge.type !== 'string' || !(edge.type in CROSS_EDGE_RULES) ||
      typeof edge.from !== 'string' || typeof edge.to !== 'string') throw new Error('invalid cross-graph edge');
    const [fromGraph, fromKinds, toGraph, toKinds] = CROSS_EDGE_RULES[edge.type as FactoryCrossGraphEdge['type']];
    const from = entities.get(edge.from);
    const to = entities.get(edge.to);
    if (!from || !to) throw new Error(`dangling edge reference: ${edge.from} -> ${edge.to}`);
    if (from.graph !== fromGraph || to.graph !== toGraph || !fromKinds.includes(from.kind) || !toKinds.includes(to.kind)) {
      throw new Error(`ill-typed ${edge.type} edge: ${edge.from} -> ${edge.to}`);
    }
  }
}

export function serializeFactoryGraphModel(model: FactoryGraphModel): string {
  validateFactoryGraphModel(model);
  return JSON.stringify(model);
}

export function deserializeFactoryGraphModel(json: string): FactoryGraphModel {
  const model: unknown = JSON.parse(json);
  validateFactoryGraphModel(model);
  return model;
}

/** Return all simple traces from a requirement in deterministic breadth-first order. */
export function traceRequirement(model: FactoryGraphModel, requirementId: FactoryEntityId): FactoryEntityId[][] {
  validateFactoryGraphModel(model);
  if (!model.graphs.requirement.entities.some((entity) => entity.id === requirementId && entity.kind === 'requirement')) {
    throw new Error(`unknown requirement: ${requirementId}`);
  }
  const allEdges = [
    ...model.links,
    ...model.graphs.requirement.edges,
    ...model.graphs.code.edges,
    ...model.graphs.execution.edges,
    ...model.graphs.defect.edges,
  ].sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to));
  const paths: FactoryEntityId[][] = [];
  const queue: FactoryEntityId[][] = [[requirementId]];
  const maxDepth = model.graphs.requirement.entities.length + model.graphs.code.entities.length +
    model.graphs.execution.entities.length + model.graphs.defect.entities.length;
  while (queue.length) {
    const path = queue.shift()!;
    const current = path[path.length - 1]!;
    if (path.length > 1) paths.push(path);
    if (path.length >= maxDepth) continue;
    for (const edge of allEdges) {
      if (edge.from === current && !path.includes(edge.to)) queue.push([...path, edge.to]);
    }
  }
  return paths;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
