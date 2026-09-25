import { createHash } from 'node:crypto';
import type { CodeGraphIndex } from './code-graph.js';

/** Unstructured reviewer or deterministic-tool output accepted by the factory. */
export interface RawObservation {
  id?: string;
  title?: string;
  summary?: string;
  description?: string;
  category?: string;
  files?: string[];
  symbols?: string[];
  dependencies?: string[];
  failureScenario?: string;
  executionPaths?: string[][];
  semanticEvidence?: string[];
  evidenceIds?: string[];
  reviewer?: string;
}

/** Canonical content shared by duplicate observations. */
export interface NormalizedObservation {
  id: string;
  duplicateGroupId: string;
  duplicateIndex: number;
  sourceId?: string;
  reviewer?: string;
  title: string;
  description: string;
  category: string;
  files: string[];
  symbols: string[];
  dependencies: string[];
  failureScenario: string;
  executionPaths: string[][];
  semanticEvidence: string[];
  semanticTerms: string[];
  evidenceIds: string[];
}

export interface CorroborationLink {
  type: 'corroborates';
  from: string;
  to: string;
}

export interface ObservationCluster {
  id: string;
  observationIds: string[];
  claim: string;
  score: number;
  features: {
    files: string[];
    symbols: string[];
    categories: string[];
    failureScenarios: string[];
    executionPaths: string[][];
    dependencies: string[];
    semanticTerms: string[];
  };
}

export interface ObservationAnalysis {
  observations: NormalizedObservation[];
  corroborates: CorroborationLink[];
  clusters: ObservationCluster[];
}

export interface ClusterOptions {
  /** Minimum pairwise relatedness to join findings. Defaults to 0.3. */
  threshold?: number;
  /** Optional TypeScript graph used to infer dependency proximity. */
  codeGraph?: Pick<CodeGraphIndex, 'graph'>;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'does', 'for', 'from',
  'has', 'have', 'if', 'in', 'into', 'is', 'it', 'its', 'may', 'might', 'not', 'of', 'on', 'or',
  'our', 'should', 'that', 'the', 'their', 'then', 'there', 'this', 'to', 'when', 'which', 'will', 'with',
]);
const SYNONYMS: Record<string, string> = {
  absent: 'missing',
  crash: 'failure',
  crashes: 'failure',
  fail: 'failure',
  fails: 'failure',
  failing: 'failure',
  null: 'missing',
  nullable: 'missing',
  unpopulated: 'missing',
  unset: 'missing',
};

/**
 * Normalize findings without losing repeats. Identical canonical findings get
 * distinct stable IDs and are linked as corroborating observations.
 */
export function normalizeObservations(raw: readonly RawObservation[]): {
  observations: NormalizedObservation[];
  corroborates: CorroborationLink[];
} {
  const prepared = raw.map((item) => {
    if (!isRecord(item)) throw new Error('observation must be an object');
    const title = cleanText(item.title ?? item.summary ?? '');
    const description = cleanText(item.description ?? '');
    const category = cleanLabel(item.category ?? '');
    const files = sortedStrings(item.files, normalizePath);
    const symbols = sortedStrings(item.symbols, normalizeIdentity);
    const dependencies = sortedStrings(item.dependencies, normalizeIdentity);
    const failureScenario = cleanText(item.failureScenario ?? '');
    const executionPaths = uniqueSortedPaths(item.executionPaths);
    const semanticEvidence = sortedStrings(item.semanticEvidence, cleanText);
    const semanticTerms = terms([title, description, failureScenario, ...semanticEvidence].join(' '));
    const evidenceIds = sortedStrings(item.evidenceIds, cleanText);
    const canonical = {
      title, description, category, files, symbols, dependencies, failureScenario,
      executionPaths, semanticEvidence, semanticTerms, evidenceIds,
    };
    return {
      canonical,
      key: hash(JSON.stringify(canonical)),
      sourceId: optionalText(item.id),
      reviewer: optionalText(item.reviewer),
    };
  });

  // Sort before assigning duplicate ordinals so output does not depend on the
  // order in which independent reviewers happened to finish.
  prepared.sort((a, b) => a.key.localeCompare(b.key) || (a.sourceId ?? '').localeCompare(b.sourceId ?? '') ||
    (a.reviewer ?? '').localeCompare(b.reviewer ?? ''));
  const counts = new Map<string, number>();
  const observations = prepared.map(({ canonical, key, sourceId, reviewer }) => {
    const duplicateIndex = (counts.get(key) ?? 0) + 1;
    counts.set(key, duplicateIndex);
    const id = `defect:v1:observation.${key}.${duplicateIndex}`;
    return {
      id,
      duplicateGroupId: `defect:v1:observation-group.${key}`,
      duplicateIndex,
      ...(sourceId ? { sourceId } : {}),
      ...(reviewer ? { reviewer } : {}),
      ...canonical,
    };
  });
  const groups = new Map<string, NormalizedObservation[]>();
  for (const observation of observations) {
    const group = groups.get(observation.duplicateGroupId) ?? [];
    group.push(observation);
    groups.set(observation.duplicateGroupId, group);
  }
  const corroborates: CorroborationLink[] = [];
  for (const group of groups.values()) {
    for (let index = 1; index < group.length; index++) {
      corroborates.push({ type: 'corroborates', from: group[0]!.id, to: group[index]!.id });
    }
  }
  return { observations, corroborates };
}

/**
 * Cluster normalized findings using shared code, graph proximity, failure
 * scenarios, categories, execution paths, and lexical semantic evidence.
 */
export function clusterObservations(
  observations: readonly NormalizedObservation[],
  options: ClusterOptions = {},
): ObservationCluster[] {
  const threshold = options.threshold ?? 0.3;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('threshold must be between 0 and 1');
  const sorted = [...observations].sort((a, b) => a.id.localeCompare(b.id));
  const parent = sorted.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const join = (a: number, b: number): void => {
    const left = root(a);
    const right = root(b);
    if (left !== right) parent[Math.max(left, right)] = Math.min(left, right);
  };
  const graphDistance = makeGraphDistances(options.codeGraph);
  const pairScores = new Map<string, number>();
  for (let left = 0; left < sorted.length; left++) {
    for (let right = left + 1; right < sorted.length; right++) {
      const score = relatedness(sorted[left]!, sorted[right]!, graphDistance);
      pairScores.set(`${left}:${right}`, score);
      if (score >= threshold) join(left, right);
    }
  }
  const groups = new Map<number, NormalizedObservation[]>();
  sorted.forEach((item, index) => {
    const key = root(index);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  });
  return [...groups.values()].map((group) => {
    const observationIds = group.map((item) => item.id).sort();
    const features = {
      files: union(group.flatMap((item) => item.files)),
      symbols: union(group.flatMap((item) => item.symbols)),
      categories: union(group.map((item) => item.category).filter(Boolean)),
      failureScenarios: union(group.map((item) => item.failureScenario).filter(Boolean)),
      executionPaths: uniqueSortedPaths(group.flatMap((item) => item.executionPaths)),
      dependencies: union(group.flatMap((item) => item.dependencies)),
      semanticTerms: union(group.flatMap((item) => item.semanticTerms)),
    };
    const pairValues: number[] = [];
    for (let left = 0; left < group.length; left++) for (let right = left + 1; right < group.length; right++) {
      const leftIndex = sorted.findIndex((item) => item.id === group[left]!.id);
      const rightIndex = sorted.findIndex((item) => item.id === group[right]!.id);
      pairValues.push(pairScores.get(`${Math.min(leftIndex, rightIndex)}:${Math.max(leftIndex, rightIndex)}`) ?? 1);
    }
    const score = group.length === 1 ? 1 : pairValues.reduce((sum, value) => sum + value, 0) / pairValues.length;
    const id = `defect:v1:hypothesis.${hash(observationIds.join('\n'))}`;
    return { id, observationIds, claim: candidateClaim(features), score: round(score), features };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Run normalization, corroboration linking, and clustering as one pure pass. */
export function analyzeObservations(raw: readonly RawObservation[], options: ClusterOptions = {}): ObservationAnalysis {
  const normalized = normalizeObservations(raw);
  return {
    observations: normalized.observations,
    corroborates: normalized.corroborates,
    clusters: clusterObservations(normalized.observations, options),
  };
}

function relatedness(a: NormalizedObservation, b: NormalizedObservation, distance: (a: string, b: string) => number): number {
  const sharedSymbols = overlap(a.symbols, b.symbols);
  const sharedFiles = overlap(a.files, b.files);
  const sharedDependencies = overlap(a.dependencies, b.dependencies);
  const scenario = scenarioSimilarity(a.failureScenario, b.failureScenario);
  const paths = pathSimilarity(a.executionPaths, b.executionPaths);
  const graph = graphRelatedness(a, b, distance);
  const semantic = jaccard(a.semanticTerms, b.semanticTerms);
  const categoryAgreement = a.category && b.category && a.category === b.category ? 1 : 0;
  const weights: number[] = [];
  const scores: number[] = [];
  const add = (weight: number, value: number): void => { weights.push(weight); scores.push(value); };
  add(0.14, sharedFiles);
  add(0.22, sharedSymbols);
  add(0.08, sharedDependencies);
  add(0.15, scenario);
  add(0.06, overlap(a.category ? [a.category] : [], b.category ? [b.category] : []));
  add(0.10, paths);
  add(0.17, semantic);
  add(0.08, graph);
  const weighted = scores.reduce((sum, value, index) => sum + value * weights[index]!, 0) /
    weights.reduce((sum, value) => sum + value, 0);
  // A direct shared code anchor or a distinctive shared semantic term is
  // strong evidence even when reviewers described different symptoms.
  const semanticAnchor = semantic > 0 ? Math.min(0.48, Math.sqrt(semantic) * 0.48) : 0;
  return Math.max(weighted, sharedSymbols ? 0.72 + categoryAgreement * 0.04 : 0,
    sharedDependencies ? 0.58 + categoryAgreement * 0.04 : 0,
    sharedFiles ? 0.44 + categoryAgreement * 0.04 : 0, scenario * 0.78,
    paths * 0.72, graph * 0.62, semanticAnchor);
}

function graphRelatedness(a: NormalizedObservation, b: NormalizedObservation, distance: (a: string, b: string) => number): number {
  const left = [...a.symbols, ...a.dependencies];
  const right = [...b.symbols, ...b.dependencies];
  let best = 0;
  for (const x of left) for (const y of right) {
    const hops = distance(x, y);
    if (hops === 0) best = Math.max(best, 1);
    else if (hops === 1) best = Math.max(best, 0.75);
    else if (hops === 2) best = Math.max(best, 0.4);
  }
  return best;
}

function makeGraphDistances(graph?: Pick<CodeGraphIndex, 'graph'>): (a: string, b: string) => number {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph?.graph.edges ?? []) {
    if (['contains', 'declares', 'tests'].includes(edge.type)) continue;
    addNeighbor(adjacency, edge.from, edge.to);
    addNeighbor(adjacency, edge.to, edge.from);
  }
  const cache = new Map<string, Map<string, number>>();
  return (from, to) => {
    if (from === to) return 0;
    let distances = cache.get(from);
    if (!distances) {
      distances = new Map([[from, 0]]);
      const queue = [from];
      for (let head = 0; head < queue.length; head++) {
        const current = queue[head]!;
        const nextDistance = distances.get(current)! + 1;
        if (nextDistance > 2) continue;
        for (const next of adjacency.get(current) ?? []) if (!distances.has(next)) {
          distances.set(next, nextDistance);
          queue.push(next);
        }
      }
      cache.set(from, distances);
    }
    return distances.get(to) ?? Infinity;
  };
}

function candidateClaim(features: ObservationCluster['features']): string {
  const symbol = features.symbols.map((value) => value.split(/[.#/]/).filter(Boolean).at(-1)).find(Boolean);
  const terms = features.semanticTerms.filter((term) => !STOP_WORDS.has(term));
  const noun = terms.find((term) => !['missing', 'failure', 'returns', 'return', 'allows', 'allow', 'asserts', 'assert'].includes(term));
  if (symbol && noun) return `${symbol} ${noun} behavior is inconsistent across its contract and execution paths.`;
  if (symbol) return `${symbol} has a recurring behavior that requires verification.`;
  if (noun) return `The ${noun} behavior is inconsistent across related observations.`;
  return 'Related observations indicate a candidate defect requiring verification.';
}

function scenarioSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const left = terms(a);
  const right = terms(b);
  return Math.max(left.join(' ') === right.join(' ') ? 1 : 0, jaccard(left, right));
}

function pathSimilarity(a: string[][], b: string[][]): number {
  if (a.some((left) => b.some((right) => left.join('\0') === right.join('\0')))) return 1;
  const left = new Set(a.flat());
  const right = new Set(b.flat());
  return jaccard([...left], [...right]);
}

function normalizePath(value: string): string {
  return cleanText(value).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/');
}

function normalizeIdentity(value: string): string {
  return cleanText(value).replace(/\\/g, '/');
}

function cleanLabel(value: string): string {
  return cleanText(value).toLocaleLowerCase('en-US');
}

function cleanText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function terms(value: string): string[] {
  return union((value.match(/[\p{L}\p{N}_$]+/gu) ?? [])
    .map((word) => SYNONYMS[word] ?? word)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word)));
}

function sortedStrings(values: string[] | undefined, normalize: (value: string) => string): string[] {
  return union((values ?? []).filter((value): value is string => typeof value === 'string').map(normalize).filter(Boolean));
}

function uniqueSortedPaths(paths: string[][] | undefined): string[][] {
  const normalized = (paths ?? []).map((path) => path.map(normalizeIdentity).filter(Boolean));
  const byKey = new Map(normalized.map((path) => [path.join('\0'), path]));
  return [...byKey].sort(([a], [b]) => a.localeCompare(b)).map(([, path]) => path);
}

function union(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function overlap(a: string[], b: string[]): number {
  return a.length === 0 || b.length === 0 ? 0 : jaccard(a, b);
}

function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const value of left) if (right.has(value)) common++;
  return common / (left.size + right.size - common);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function addNeighbor(adjacency: Map<string, Set<string>>, from: string, to: string): void {
  const neighbors = adjacency.get(from) ?? new Set<string>();
  neighbors.add(to);
  adjacency.set(from, neighbors);
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('observation source id and reviewer must be strings');
  const normalized = cleanText(value);
  return normalized || undefined;
}

function isRecord(value: unknown): value is RawObservation {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
