import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { FactoryEntityId } from './contracts.js';
import type { CodeGraphIndex } from './code-graph.js';
import type { CodeEdgeType, CodeEntity } from './graph-model.js';

export type ContextEvidenceKind =
  | 'request' | 'implementation' | 'caller' | 'callee' | 'interface' | 'schema'
  | 'test' | 'spec_clause' | 'diagnostic' | 'previous_finding' | 'invariant'
  | 'recent_change' | 'dependency_edge';

export interface ContextNote {
  id?: string;
  title?: string;
  content?: string;
  message?: string;
  sourcePath?: string;
  line?: number;
  symbolId?: FactoryEntityId;
}

export interface ContextProvenance {
  source: 'request' | 'code_graph' | 'source' | 'spec' | 'diagnostic' | 'finding' | 'memory' | 'change';
  uri: string;
  sha256?: string;
  entityId?: FactoryEntityId;
  lineStart?: number;
  lineEnd?: number;
  detail?: string;
}

export interface ContextEvidence {
  id: string;
  kind: ContextEvidenceKind;
  title: string;
  content: string;
  provenance: ContextProvenance[];
}

export interface ContextExpansion {
  requestedAt: string;
  entityIds: FactoryEntityId[];
  evidenceKinds: ContextEvidenceKind[];
  addedEvidenceIds: string[];
}

export interface ContextPacket {
  schemaVersion: 1;
  request: string;
  query: string[];
  targetIds: FactoryEntityId[];
  evidence: ContextEvidence[];
  omitted: { itemCount: number; charCount: number };
  expansions: ContextExpansion[];
  sha256: string;
}

export interface ContextCompilerOptions {
  index: CodeGraphIndex;
  rootDir: string;
  request: string;
  specPaths?: string[];
  diagnostics?: ContextNote[];
  previousFindings?: ContextNote[];
  invariants?: ContextNote[];
  recentChanges?: ContextNote[];
  maxEvidence?: number;
  maxChars?: number;
}

export interface ContextExpansionRequest {
  /** Graph entities explicitly requested by the reviewer. */
  entityIds?: FactoryEntityId[];
  /** Additional evidence classes requested after reviewing the first packet. */
  evidenceKinds?: ContextEvidenceKind[];
}

const INTERFACE_KINDS = new Set<CodeEntity['kind']>(['contract', 'api']);
const SCHEMA_KINDS = new Set<CodeEntity['kind']>(['schema', 'database_model', 'data']);
const RELATED_EDGES = new Set<CodeEdgeType>(['uses', 'inherits', 'implements', 'reads', 'writes', 'serializes', 'deserializes']);
const SYMBOL_KINDS = new Set<CodeEntity['kind']>(['symbol', 'function', 'class']);

/** Compile a bounded evidence packet using only deterministic graph and file inputs. */
export function compileContext(options: ContextCompilerOptions): ContextPacket {
  const maxEvidence = positiveInt(options.maxEvidence, 40, 'maxEvidence');
  const maxChars = positiveInt(options.maxChars, 24000, 'maxChars');
  const query = words(options.request);
  const entities = new Map<FactoryEntityId, CodeEntity>(options.index.graph.entities.map((entity) => [entity.id as FactoryEntityId, entity]));
  const edges = [...options.index.graph.edges].sort(edgeOrder);
  const targetIds = chooseTargets(options.index.graph.entities, query);
  const selected = new Set<FactoryEntityId>(targetIds);
  const add = (id: string): void => { if (entities.has(id as FactoryEntityId)) selected.add(id as FactoryEntityId); };
  const evidences: ContextEvidence[] = [];
  const push = (kind: ContextEvidenceKind, title: string, content: string, provenance: ContextProvenance[]): void => {
    const normalized = provenance.slice().sort(provenanceOrder);
    const identity = `${kind}\0${title}\0${content}\0${JSON.stringify(normalized)}`;
    evidences.push({ id: `context:v1:${hash(identity)}`, kind, title, content, provenance: normalized });
  };
  push('request', 'Review request', options.request.trim(), [{ source: 'request', uri: 'request://current', sha256: hash(options.request.trim()) }]);

  const targetSet = new Set<string>(targetIds);
  for (const edge of edges) {
    if (edge.type === 'calls' && targetSet.has(edge.to)) { add(edge.from); }
    if (edge.type === 'calls' && targetSet.has(edge.from)) { add(edge.to); }
    if (edge.type === 'tests' && targetSet.has(edge.to)) { add(edge.from); }
    if (RELATED_EDGES.has(edge.type) && (targetSet.has(edge.from) || targetSet.has(edge.to))) {
      const other = targetSet.has(edge.from) ? edge.to : edge.from;
      add(other);
    }
  }

  const byId = (id: string): CodeEntity | undefined => entities.get(id as FactoryEntityId);
  for (const id of [...selected].sort()) {
    const entity = byId(id);
    if (!entity) continue;
    const kind: ContextEvidenceKind = targetSet.has(id) ? 'implementation' :
      entity.kind === 'test' || isTestPath(entity.sourcePath ?? entity.title) ? 'test' :
        INTERFACE_KINDS.has(entity.kind) ? 'interface' : SCHEMA_KINDS.has(entity.kind) ? 'schema' : 'implementation';
    const source = sourceContent(options.rootDir, entity);
    const content = source?.text ?? `${entity.kind}: ${entity.title}${entity.description ? `\n${entity.description}` : ''}`;
    push(kind, entity.title, content, [{
      source: source ? 'source' : 'code_graph', uri: entity.sourcePath ?? `codegraph://${entity.id}`,
      ...(entity.sourceHash ? { sha256: entity.sourceHash } : source ? { sha256: source.sha256 } : {}),
      entityId: entity.id as FactoryEntityId, ...(source ? { lineStart: source.start, lineEnd: source.end } : {}),
    }]);
  }

  for (const edge of edges) {
    const fromSelected = targetSet.has(edge.from);
    const toSelected = targetSet.has(edge.to);
    if (!fromSelected && !toSelected) continue;
    let kind: ContextEvidenceKind | undefined;
    if (edge.type === 'calls') kind = fromSelected ? 'callee' : 'caller';
    else if (edge.type === 'tests') kind = 'test';
    else if (RELATED_EDGES.has(edge.type)) {
      const other = byId(fromSelected ? edge.to : edge.from);
      kind = other && INTERFACE_KINDS.has(other.kind) ? 'interface' : other && SCHEMA_KINDS.has(other.kind) ? 'schema' : undefined;
    }
    if (kind) push(kind, `${byId(edge.from)?.title ?? edge.from} ${edge.type} ${byId(edge.to)?.title ?? edge.to}`,
      `${edge.from} -[${edge.type}]-> ${edge.to}`, [{ source: 'code_graph', uri: `codegraph://${edge.from}`, entityId: edge.from as FactoryEntityId, detail: edge.type }]);
  }

  compileSpecClauses(options, query, targetIds, push);
  compileNotes(options.diagnostics ?? [], 'diagnostic', 'diagnostic', query, selected, byId, push);
  compileNotes(options.previousFindings ?? [], 'previous_finding', 'finding', query, selected, byId, push);
  compileNotes(options.invariants ?? [], 'invariant', 'memory', query, selected, byId, push);
  compileNotes(options.recentChanges ?? [], 'recent_change', 'change', query, selected, byId, push);

  const normalized = uniqueEvidence(evidences);
  const packet: ContextPacket = {
    schemaVersion: 1, request: options.request.trim(), query, targetIds: [...targetIds].sort(),
    evidence: [], omitted: { itemCount: 0, charCount: 0 }, expansions: [], sha256: '',
  };
  bound(packet, normalized, maxEvidence, maxChars);
  packet.sha256 = packetHash(packet);
  return packet;
}

/** Add explicitly requested entities/evidence while preserving prior packet evidence and expansion history. */
export function expandContext(
  options: ContextCompilerOptions,
  packet: ContextPacket,
  request: ContextExpansionRequest,
): ContextPacket {
  const entityIds = [...new Set(request.entityIds ?? [])].sort();
  const evidenceKinds = [...new Set(request.evidenceKinds ?? [])].sort();
  const expanded = compileContext(options);
  const entities = new Map(options.index.graph.entities.map((entity) => [entity.id, entity]));
  const additions: ContextEvidence[] = [];
  for (const id of entityIds) {
    const entity = entities.get(id);
    if (!entity) throw new Error(`unknown context entity: ${id}`);
    const source = sourceContent(options.rootDir, entity);
    const content = source?.text ?? `${entity.kind}: ${entity.title}${entity.description ? `\n${entity.description}` : ''}`;
    additions.push(makeEvidence(source ? 'implementation' : 'dependency_edge', entity.title, content, [{
      source: source ? 'source' : 'code_graph', uri: entity.sourcePath ?? `codegraph://${entity.id}`,
      ...(source ? { sha256: source.sha256, lineStart: source.start, lineEnd: source.end } : {}),
      entityId: entity.id as FactoryEntityId, detail: 'explicit expansion',
    }]));
  }
  for (const evidence of expanded.evidence) if (evidenceKinds.includes(evidence.kind)) additions.push(evidence);
  const old = new Set(packet.evidence.map((evidence) => evidence.id));
  const merged = uniqueEvidence([...packet.evidence, ...additions]);
  const next: ContextPacket = { ...packet, targetIds: [...new Set([...packet.targetIds, ...entityIds])].sort(), evidence: [], omitted: { itemCount: 0, charCount: 0 }, expansions: [...packet.expansions] };
  bound(next, merged, positiveInt(options.maxEvidence, 40, 'maxEvidence'), positiveInt(options.maxChars, 24000, 'maxChars'));
  next.expansions.push({ requestedAt: 'explicit', entityIds, evidenceKinds, addedEvidenceIds: next.evidence.map((item) => item.id).filter((id) => !old.has(id)) });
  next.sha256 = packetHash(next);
  return next;
}

function chooseTargets(entities: CodeEntity[], query: string[]): FactoryEntityId[] {
  const candidates = entities.filter((entity) => SYMBOL_KINDS.has(entity.kind));
  const ranked = candidates.map((entity) => ({ entity, score: relevance(entity.title, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.entity.id.localeCompare(b.entity.id));
  if (ranked.length === 0) return [];
  const best = ranked[0]!.score;
  return ranked.filter(({ score }) => score === best).slice(0, 3).map(({ entity }) => entity.id as FactoryEntityId).sort();
}

function compileSpecClauses(
  options: ContextCompilerOptions, query: string[], targetIds: string[],
  push: (kind: ContextEvidenceKind, title: string, content: string, provenance: ContextProvenance[]) => void,
): void {
  const relevantWords = [...new Set([...query, ...targetIds.flatMap((id) => words(options.index.graph.entities.find((entity) => entity.id === id)?.title ?? ''))])];
  for (const specPath of [...(options.specPaths ?? [])].map(normalizePath).sort()) {
    let bytes: Buffer;
    try { bytes = readFileSync(path.resolve(options.rootDir, specPath)); } catch { continue; }
    const lines = bytes.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^#{1,6}\s+/.test(lines[i]!)) continue;
      const level = lines[i]!.match(/^#+/)![0].length;
      let end = i + 1;
      while (end < lines.length && !new RegExp(`^#{1,${level}}\\s+`).test(lines[end]!)) end += 1;
      const body = lines.slice(i + 1, end).join('\n').trim();
      const title = lines[i]!.replace(/^#+\s+/, '').trim();
      if (relevance(`${title} ${body}`, relevantWords) === 0) continue;
      push('spec_clause', title, `${lines[i]}\n${body}`, [{ source: 'spec', uri: specPath, sha256: hash(bytes), lineStart: i + 1, lineEnd: end, detail: title }]);
    }
  }
}

function compileNotes(
  notes: ContextNote[], kind: 'diagnostic' | 'previous_finding' | 'invariant' | 'recent_change',
  source: ContextProvenance['source'], query: string[], selected: Set<FactoryEntityId>,
  byId: (id: string) => CodeEntity | undefined,
  push: (kind: ContextEvidenceKind, title: string, content: string, provenance: ContextProvenance[]) => void,
): void {
  const searchable = [...selected].map((id) => byId(id)?.title ?? '').join(' ');
  for (const note of notes.slice().sort((a, b) => (a.id ?? '').localeCompare(b.id ?? '') || (a.title ?? '').localeCompare(b.title ?? ''))) {
    const text = `${note.title ?? ''} ${note.content ?? note.message ?? ''} ${note.sourcePath ?? ''}`;
    if (note.symbolId && selected.has(note.symbolId) || relevance(text, query) > 0 || relevance(text, words(searchable)) > 0) {
      const content = note.content ?? note.message ?? note.title ?? '';
      push(kind, note.title ?? note.id ?? kind, content, [{ source, uri: note.sourcePath ?? `${source}://${note.id ?? hash(content)}`,
        sha256: hash(content), ...(note.symbolId ? { entityId: note.symbolId } : {}), ...(note.line ? { lineStart: note.line, lineEnd: note.line } : {}) }]);
    }
  }
}

function sourceContent(root: string, entity: CodeEntity): { text: string; start: number; end: number; sha256: string } | undefined {
  if (!entity.sourcePath || entity.kind === 'module' || entity.kind === 'api' || entity.kind === 'schema' || entity.kind === 'database_model' || entity.kind === 'data' || entity.kind === 'configuration' || entity.kind === 'external_service' || entity.kind === 'queue' || entity.kind === 'event') return undefined;
  try {
    const bytes = readFileSync(path.resolve(root, entity.sourcePath));
    if (entity.kind === 'file' || entity.kind === 'test') {
      const text = bytes.toString('utf8');
      return { text, start: 1, end: text.split(/\r?\n/).length, sha256: hash(bytes) };
    }
    const source = ts.createSourceFile(entity.sourcePath, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    const wanted = entity.title.split('::').at(-1);
    if (!wanted) return undefined;
    let match: ts.Node | undefined;
    const visit = (node: ts.Node, parents: string[] = []): void => {
      if (match) return;
      let nextParents = parents;
      if (isNamedDeclaration(node) && node.name) {
        const name = declarationName(node.name);
        if (name) {
          if ([...parents, name].join('.') === wanted) match = node;
          if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isModuleDeclaration(node)) nextParents = [...parents, name];
        }
      }
      ts.forEachChild(node, (child) => visit(child, nextParents));
    };
    visit(source);
    if (!match) return undefined;
    const start = source.getLineAndCharacterOfPosition(match.getStart(source)).line + 1;
    const end = source.getLineAndCharacterOfPosition(match.end).line + 1;
    return { text: match.getText(source), start, end, sha256: hash(bytes) };
  } catch { return undefined; }
}

function isNamedDeclaration(node: ts.Node): node is ts.NamedDeclaration {
  return (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) ||
    ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.name !== undefined;
}
function declarationName(name: ts.DeclarationName): string | undefined {
  return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}
function uniqueEvidence(items: ContextEvidence[]): ContextEvidence[] {
  return [...new Map(items.map((item) => [item.id, item])).values()].sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.id.localeCompare(b.id));
}
function bound(packet: ContextPacket, input: ContextEvidence[], maxItems: number, maxChars: number): void {
  const kept: ContextEvidence[] = []; let chars = 0;
  for (const item of input) {
    if (kept.length >= maxItems || chars + item.content.length > maxChars) continue;
    kept.push(item); chars += item.content.length;
  }
  packet.evidence = kept;
  packet.omitted = { itemCount: input.length - kept.length, charCount: input.reduce((sum, item) => sum + item.content.length, 0) - chars };
}
function packetHash(packet: ContextPacket): string {
  return hash(JSON.stringify({ schemaVersion: packet.schemaVersion, request: packet.request, query: packet.query, targetIds: packet.targetIds, evidence: packet.evidence, omitted: packet.omitted, expansions: packet.expansions }));
}
function relevance(value: string, query: string[]): number {
  const tokens = words(value);
  return query.reduce((score, word) => score + (tokens.includes(word) ? (tokens.at(-1) === word ? 4 : 1) : 0), 0);
}
function words(value: string): string[] {
  const ignored = new Set(['review', 'inspect', 'check', 'the', 'and', 'for', 'from', 'with', 'behavior', 'implementation']);
  return [...new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? []).filter((word) => word.length > 2 && !ignored.has(word)))].sort();
}
function edgeOrder(a: { from: string; type: string; to: string }, b: { from: string; type: string; to: string }): number {
  return a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to);
}
function provenanceOrder(a: ContextProvenance, b: ContextProvenance): number { return a.source.localeCompare(b.source) || a.uri.localeCompare(b.uri) || (a.entityId ?? '').localeCompare(b.entityId ?? ''); }
function kindOrder(kind: ContextEvidenceKind): number {
  return ['request', 'implementation', 'caller', 'callee', 'interface', 'schema', 'test', 'spec_clause', 'diagnostic', 'previous_finding', 'invariant', 'recent_change', 'dependency_edge'].indexOf(kind);
}
function normalizePath(value: string): string { return value.replaceAll('\\', '/'); }
function isTestPath(value: string): boolean { return /(?:^|\/)(?:__tests__\/|test\/|tests\/)|\.(?:test|spec)\.[cm]?tsx?$/.test(value); }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
function makeEvidence(kind: ContextEvidenceKind, title: string, content: string, provenance: ContextProvenance[]): ContextEvidence {
  const identity = `${kind}\0${title}\0${content}\0${JSON.stringify(provenance)}`;
  return { id: `context:v1:${hash(identity)}`, kind, title, content, provenance };
}
