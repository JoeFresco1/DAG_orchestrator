import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DefectHypothesis } from './hypotheses.js';
import type { CodeGraphIndex } from './code-graph.js';
import type { NormalizedObservation } from './observations.js';
import type { CodeEdgeType } from './graph-model.js';

export type PreverificationStatus = 'rejected' | 'plausible';
export type PreverificationCheckState = 'invalid' | 'evidence' | 'unresolved';

export interface PreverificationCheck {
  question: string;
  state: PreverificationCheckState;
  detail: string;
}

/** A source location explicitly cited by an observation. Lines are 1-based. */
export interface HypothesisReference {
  path: string;
  line?: number;
  symbol?: string;
}

/** Evidence emitted by a deterministic compiler, test, or static-analysis run. */
export interface DeterministicEvidence {
  id: string;
  conclusion: 'supports' | 'contradicts';
  summary: string;
  /** Optional anchors scope evidence to a hypothesis or a particular source. */
  hypothesisId?: string;
  path?: string;
  symbol?: string;
  /** Evidence must name the analyzer/test that produced it. */
  source: 'typecheck' | 'test' | 'static-analysis' | 'guard';
}

export interface PreverificationOptions {
  rootDir: string;
  observations?: readonly NormalizedObservation[];
  /** A graph built from the same repository snapshot as rootDir. */
  codeGraph?: CodeGraphIndex;
  references?: readonly HypothesisReference[];
  /** Explicit caller/callee assertions; graph omissions remain unresolved. */
  callers?: readonly { caller: string; callee: string }[];
  /** Claimed dependency identities checked only against a complete graph. */
  claimedDependencies?: readonly string[];
  evidence?: readonly DeterministicEvidence[];
  /** Opt in only when codeGraph covers the entire repository under review. */
  graphIsComplete?: boolean;
}

export interface PreverificationResult {
  schemaVersion: 1;
  hypothesisId: string;
  status: PreverificationStatus;
  checks: PreverificationCheck[];
  /** Stable IDs of deterministic evidence retained for the later verifier. */
  evidenceIds: string[];
}

const PATH_EDGES = new Set<CodeEdgeType>(['calls', 'imports', 'uses', 'inherits', 'implements', 'reads', 'writes', 'publishes', 'subscribes', 'serializes', 'deserializes', 'tests']);

/**
 * Challenge a hypothesis with cheap, deterministic repository facts. Only a
 * concrete contradiction rejects it; absent or partial evidence stays open.
 * This is a policy helper and deliberately does not schedule work or mutate a
 * Run, so verification continues through the existing DAG runner.
 */
export function preverifyHypothesis(
  hypothesis: Pick<DefectHypothesis, 'id' | 'claim'>,
  options: PreverificationOptions,
): PreverificationResult {
  const checks: PreverificationCheck[] = [];
  // The caller supplies only this hypothesis's linked observations.
  const observations = options.observations ?? [];
  const references: HypothesisReference[] = [
    ...(options.references ?? []),
    ...observations.flatMap((observation) => observation.files.map((file) => ({ path: file }))),
  ];
  const uniqueReferences = [...new Map(references.map((ref) => [JSON.stringify(ref), ref])).values()];
  const root = path.resolve(options.rootDir);

  for (const reference of uniqueReferences) {
    const absolute = resolveRepoPath(root, reference.path);
    if (!absolute) {
      checks.push({ question: 'does the cited path exist?', state: 'invalid', detail: `unsafe or non-repository path: ${reference.path}` });
      continue;
    }
    if (!existsSync(absolute)) {
      checks.push({ question: 'does the cited path exist?', state: 'invalid', detail: `cited path does not exist: ${reference.path}` });
      continue;
    }
    if (!isFile(absolute)) {
      checks.push({ question: 'does the cited path exist?', state: 'invalid', detail: `cited path is not a file: ${reference.path}` });
      continue;
    }
    const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
    checks.push({ question: 'does the cited path exist?', state: 'evidence', detail: `file exists: ${reference.path}` });
    if (reference.line !== undefined) {
      const valid = Number.isSafeInteger(reference.line) && reference.line > 0 && reference.line <= lines.length;
      checks.push({ question: 'does the referenced line exist?', state: valid ? 'evidence' : 'invalid', detail: valid
        ? `${reference.path}:${reference.line} exists`
        : `${reference.path}:${reference.line} is outside the 1-${lines.length} line range` });
    }
    if (reference.symbol) checkSymbol(reference.symbol, reference.path, options.codeGraph, options.graphIsComplete === true, checks);
  }

  for (const observation of observations) {
    for (const symbol of observation.symbols) checkSymbol(symbol, undefined, options.codeGraph, options.graphIsComplete === true, checks);
    for (const dependency of observation.dependencies) checkDependency(dependency, options.codeGraph, options.graphIsComplete === true, checks);
    for (const executionPath of observation.executionPaths) checkPath(executionPath, options.codeGraph, options.graphIsComplete === true, checks);
  }
  for (const dependency of options.claimedDependencies ?? []) checkDependency(dependency, options.codeGraph, options.graphIsComplete === true, checks);
  for (const { caller, callee } of options.callers ?? []) checkCaller(caller, callee, options.codeGraph, options.graphIsComplete === true, checks);

  const evidence = (options.evidence ?? []).filter((item) => !item.hypothesisId || item.hypothesisId === hypothesis.id);
  for (const item of evidence) {
    const scoped = item.path || item.symbol ? ` (${[item.path, item.symbol].filter(Boolean).join('#')})` : '';
    checks.push({ question: `${item.source} evidence`, state: item.conclusion === 'contradicts' ? 'invalid' : 'evidence', detail: `${item.id}: ${item.summary}${scoped}` });
  }

  return {
    schemaVersion: 1,
    hypothesisId: hypothesis.id,
    status: checks.some((check) => check.state === 'invalid') ? 'rejected' : 'plausible',
    checks: uniqueChecks(checks),
    evidenceIds: [...new Set(evidence.map((item) => item.id))].sort(),
  };
}

/** Return whether one entity can reach another through known typed code edges. */
export function codeGraphReachable(index: CodeGraphIndex, from: string, to: string): boolean | undefined {
  const entities = new Set<string>(index.graph.entities.map((entity) => entity.id));
  if (!entities.has(from) || !entities.has(to)) return undefined;
  if (from === to) return true;
  const adjacency = new Map<string, string[]>();
  for (const edge of index.graph.edges) {
    if (!PATH_EDGES.has(edge.type)) continue;
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const seen = new Set([from]);
  const queue = [from];
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of adjacency.get(queue[head]!) ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return false;
}

function checkSymbol(symbol: string, sourcePath: string | undefined, index: CodeGraphIndex | undefined, complete: boolean, checks: PreverificationCheck[]): void {
  if (!index) {
    checks.push({ question: 'does the cited symbol exist?', state: 'unresolved', detail: `no code graph available for ${symbol}` });
    return;
  }
  const normalized = symbol.replaceAll('\\', '/');
  const candidates = index.graph.entities.filter((entity) => ['symbol', 'function', 'class', 'contract'].includes(entity.kind));
  const matches = candidates.filter((entity) => entity.id === symbol || entity.title === symbol ||
    entity.title.endsWith(`::${symbol}`) || entity.id.endsWith(`#${symbol}`));
  const scoped = sourcePath ? matches.filter((entity) => entity.sourcePath === sourcePath.replaceAll('\\', '/')) : matches;
  if (scoped.length) {
    checks.push({ question: 'does the cited symbol exist?', state: 'evidence', detail: `symbol found: ${symbol}` });
  } else if (complete && (!sourcePath || index.files.some((file) => file.path === normalized || file.path === sourcePath.replaceAll('\\', '/')))) {
    checks.push({ question: 'does the cited symbol exist?', state: 'invalid', detail: `symbol not found in indexed source: ${symbol}` });
  } else {
    checks.push({ question: 'does the cited symbol exist?', state: 'unresolved', detail: `symbol is absent from the available graph: ${symbol}` });
  }
}

function checkDependency(dependency: string, index: CodeGraphIndex | undefined, complete: boolean, checks: PreverificationCheck[]): void {
  if (!index) {
    checks.push({ question: 'does the claimed dependency exist?', state: 'unresolved', detail: `no code graph available for ${dependency}` });
    return;
  }
  const exists = index.graph.entities.some((entity) => entity.id === dependency || entity.title === dependency || entity.sourcePath === dependency);
  if (exists) checks.push({ question: 'does the claimed dependency exist?', state: 'evidence', detail: `dependency found: ${dependency}` });
  else checks.push({ question: 'does the claimed dependency exist?', state: complete ? 'invalid' : 'unresolved', detail: `${complete ? 'dependency absent from complete graph' : 'dependency absent from partial graph'}: ${dependency}` });
}

function checkCaller(caller: string, callee: string, index: CodeGraphIndex | undefined, complete: boolean, checks: PreverificationCheck[]): void {
  const label = `${caller} calls ${callee}`;
  if (!index) {
    checks.push({ question: 'is the claimed caller real?', state: 'unresolved', detail: `no code graph available: ${label}` });
    return;
  }
  const exists = index.graph.edges.some((edge) => edge.type === 'calls' && matchesEntity(edge.from, caller, index) && matchesEntity(edge.to, callee, index));
  const endpointsExist = index.graph.entities.some((entity) => matchesEntity(entity.id, caller, index)) && index.graph.entities.some((entity) => matchesEntity(entity.id, callee, index));
  const state = exists ? 'evidence' : complete && endpointsExist ? 'invalid' : 'unresolved';
  checks.push({ question: 'is the claimed caller real?', state, detail: exists ? `call edge found: ${label}` : `${complete && endpointsExist ? 'no call edge in complete graph' : 'call relationship unresolved'}: ${label}` });
}

function checkPath(pathIds: string[], index: CodeGraphIndex | undefined, complete: boolean, checks: PreverificationCheck[]): void {
  if (!index || pathIds.length < 2 || !pathIds.every((id) => isGraphEntityId(id))) {
    checks.push({ question: 'is the execution path reachable?', state: 'unresolved', detail: 'path lacks graph entity IDs or a code graph' });
    return;
  }
  const steps = pathIds.slice(0, -1).map((from, i) => codeGraphReachable(index, from, pathIds[i + 1]!));
  const missing = steps.findIndex((reachable) => reachable === false);
  if (missing >= 0) checks.push({ question: 'is the execution path reachable?', state: complete ? 'invalid' : 'unresolved', detail: `${complete ? 'no graph path' : 'no path in partial graph'} from ${pathIds[missing]} to ${pathIds[missing + 1]}` });
  else if (steps.every((reachable) => reachable === true)) checks.push({ question: 'is the execution path reachable?', state: 'evidence', detail: `all ${steps.length} path steps are reachable` });
  else checks.push({ question: 'is the execution path reachable?', state: 'unresolved', detail: 'one or more path endpoints are missing from the graph' });
}

function matchesEntity(id: string, reference: string, index: CodeGraphIndex): boolean {
  const entity = index.graph.entities.find((item) => item.id === id);
  return id === reference || entity?.title === reference || entity?.title.endsWith(`::${reference}`) || id.endsWith(`#${reference}`);
}
function isGraphEntityId(value: string): boolean { return value.startsWith('code:v1:'); }
function resolveRepoPath(root: string, candidate: string): string | undefined {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return absolute;
}
function isFile(file: string): boolean { try { return statSync(file).isFile(); } catch { return false; } }
function uniqueChecks(checks: PreverificationCheck[]): PreverificationCheck[] {
  return [...new Map(checks.map((check) => [`${check.question}\0${check.state}\0${check.detail}`, check])).values()];
}
