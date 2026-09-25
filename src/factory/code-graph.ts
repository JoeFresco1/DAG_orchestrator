import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { FactoryEntityId } from './contracts.js';
import type {
  CodeEntity, CodeEdgeType, FactoryCrossGraphEdge,
  FactoryGraph, RequirementEntity,
} from './graph-model.js';

/** Deterministic TypeScript code graph snapshot. Paths are always repo-relative. */
export interface CodeGraphIndex {
  schemaVersion: 1;
  files: Array<{ path: string; sha256: string }>;
  graph: FactoryGraph<'code'>;
  requirements: RequirementEntity[];
  links: FactoryCrossGraphEdge[];
}

export interface CodeGraphOptions {
  rootDir: string;
  /** Defaults to tsconfig.json; explicit paths are relative to rootDir. */
  tsconfigPath?: string;
  /** Optional deterministic source-file allowlist, relative to rootDir. */
  files?: string[];
  /** Exclude test files from this snapshot. Defaults to false. */
  excludeTests?: boolean;
}

type MutableIndex = CodeGraphIndex;
const HASH = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const makeId = (kind: 'code' | 'requirement', key: string): FactoryEntityId => `${kind}:v1:${key}`;
const posix = (value: string): string => value.split(path.sep).join('/');

/** Build using the TS compiler/checker; no model-generated relationships are used. */
export function buildCodeGraph(options: CodeGraphOptions): CodeGraphIndex {
  const root = path.resolve(options.rootDir);
  const configPath = path.resolve(root, options.tsconfigPath ?? 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath), undefined, configPath);
  if (parsed.errors.length) throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  const allowed = options.files ? new Set(options.files.map((file) => posix(path.normalize(file)))) : undefined;
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const index = emptyIndex();
  const sourceFiles = program.getSourceFiles()
    .filter((source) => !source.isDeclarationFile && within(root, source.fileName))
    .map((source) => ({ source, relative: posix(path.relative(root, source.fileName)) }))
    .filter(({ relative }) => (!allowed || allowed.has(relative)) && (!options.excludeTests || !isTestPath(relative)))
    .sort((a, b) => a.relative.localeCompare(b.relative));
  const declarations = new Map<ts.Declaration, string>();
  const dataEntities = new Map<ts.Declaration, string>();
  const symbolIdsByFile = new Map<string, string[]>();

  for (const { source, relative } of sourceFiles) {
    const bytes = readFileSync(source.fileName);
    const fileId = makeId('code', `file/${relative}`);
    const file = entity(fileId, 'file', relative, relative, HASH(bytes));
    index.graph.entities.push(file);
    index.files.push({ path: relative, sha256: HASH(bytes) });
    const dir = path.posix.dirname(relative);
    const moduleId = makeId('code', `module/${dir === '.' ? 'root' : dir}`);
    if (!index.graph.entities.some((item) => item.id === moduleId)) {
      index.graph.entities.push({ id: moduleId, kind: 'module', title: dir === '.' ? 'root' : dir });
    }
    addEdge(index, 'contains', moduleId, fileId);
    if (isConfigurationPath(relative)) {
      const configurationId = makeId('code', `configuration/${relative}`);
      index.graph.entities.push(entity(configurationId, 'configuration', relative, relative, HASH(bytes)));
      addEdge(index, 'declares', fileId, configurationId);
    }
    symbolIdsByFile.set(relative, []);

    const visit = (node: ts.Node, parentNames: string[]): void => {
      if (isNamedDeclaration(node)) {
        const name = declarationName(node.name);
        if (name) {
          const kind = entityKind(node);
          const qualified = [...parentNames, name].join('.');
          const key = `symbol/${relative}#${safeKey(qualified)}`;
          const id = makeId('code', key);
          const title = `${relative}::${qualified}`;
          if (!index.graph.entities.some((item) => item.id === id)) {
            index.graph.entities.push(entity(id, kind, title, relative, HASH(bytes)));
            addEdge(index, 'declares', fileId, id);
            symbolIdsByFile.get(relative)!.push(id);
            declarations.set(node as ts.Declaration, id);
            if (isExported(node)) {
              const apiId = makeId('code', `api/${relative}#${safeKey(qualified)}`);
              index.graph.entities.push(entity(apiId, 'api', title, relative, HASH(bytes)));
              addEdge(index, 'declares', fileId, apiId);
              addEdge(index, 'uses', id, apiId);
            }
            const schemaKind = inferredDataKind(name);
            if (schemaKind) {
              const dataId = makeId('code', `${schemaKind}/${relative}#${safeKey(name)}`);
              index.graph.entities.push(entity(dataId, schemaKind, name, relative, HASH(bytes)));
              addEdge(index, 'declares', id, dataId);
              dataEntities.set(node as ts.Declaration, dataId);
            }
            const requirement = documentedRequirement(node);
            if (requirement) {
              const reqId = makeId('requirement', `spec/${safeKey(requirement)}`);
              if (!index.requirements.some((item) => item.id === reqId)) {
                index.requirements.push({ id: reqId, kind: 'requirement', title: requirement, sourcePath: relative });
              }
              index.links.push({ type: 'implemented_by', from: reqId as `requirement:v1:${string}`, to: id as `code:v1:${string}` });
            }
          }
          const nested = node.kind === ts.SyntaxKind.ClassDeclaration || node.kind === ts.SyntaxKind.ClassExpression || node.kind === ts.SyntaxKind.ModuleDeclaration;
          const nextNames = nested ? [...parentNames, name] : parentNames;
          ts.forEachChild(node, (child) => visit(child, nextNames));
          return;
        }
      }
      ts.forEachChild(node, (child) => visit(child, parentNames));
    };
    visit(source, []);
  }

  const sourceByName = new Map(sourceFiles.map(({ source }) => [path.resolve(source.fileName), source]));
  for (const { source, relative } of sourceFiles) {
    const fileId = makeId('code', `file/${relative}`);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier)) {
          const symbol = checker.getSymbolAtLocation(specifier);
          const targetFile = symbol?.declarations?.map((decl) => decl.getSourceFile()).find((candidate) => sourceByName.has(path.resolve(candidate.fileName)));
          if (targetFile) {
            const targetRelative = posix(path.relative(root, targetFile.fileName));
            addEdge(index, 'imports', fileId, makeId('code', `file/${targetRelative}`));
            if (isTestPath(relative)) {
              for (const target of symbolIdsByFile.get(targetRelative) ?? []) addEdge(index, 'tests', fileId, target);
            }
          }
        }
      } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const targetSymbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression);
        const declaration = targetSymbol?.valueDeclaration ?? targetSymbol?.declarations?.[0];
        const targetId = declaration && declarations.get(declaration);
        const caller = enclosingCallable(node);
        const callerId = caller && declarations.get(caller);
        if (callerId && targetId && callerId !== targetId) addEdge(index, 'calls', callerId, targetId);
      } else if (ts.isTypeReferenceNode(node)) {
        let symbol = checker.getSymbolAtLocation(node.typeName);
        if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
        const declaration = symbol?.declarations?.[0];
        const targetId = declaration && dataEntities.get(declaration);
        const caller = enclosingCallable(node);
        const callerId = caller && declarations.get(caller);
        if (callerId && targetId) addEdge(index, 'uses', callerId, targetId);
      } else if (ts.isHeritageClause(node)) {
        const owner = enclosingClass(node);
        const ownerId = owner && declarations.get(owner);
        if (ownerId) for (const type of node.types) {
          let symbol = checker.getSymbolAtLocation(type.expression);
          if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
          const declaration = symbol?.declarations?.find(ts.isClassLike);
          const parentId = declaration && declarations.get(declaration);
          if (parentId) addEdge(index, node.token === ts.SyntaxKind.ExtendsKeyword ? 'inherits' : 'implements', ownerId, parentId);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return normalize(index);
}

/**
 * Reconcile records only for the supplied changed paths, preserving untouched
 * entity records. The compiler resolves the tracked project to refresh typed
 * relationships, so changed imports/calls retain accurate targets. Missing
 * changed paths remove their prior records.
 */
export function updateCodeGraph(previous: CodeGraphIndex, options: CodeGraphOptions, changedFiles: string[]): CodeGraphIndex {
  validateCodeGraphIndex(previous);
  const changed = new Set(changedFiles.map((file) => posix(path.normalize(file))));
  const trackedFiles = options.files ? [...new Set([...previous.files.map((file) => file.path), ...options.files, ...changedFiles])] : undefined;
  const fresh = buildCodeGraph({ ...options, files: trackedFiles, excludeTests: false });
  const delta = emptyIndex();
  delta.files = fresh.files.filter((file) => changed.has(file.path));
  delta.graph.entities = fresh.graph.entities.filter((item) => item.sourcePath && changed.has(item.sourcePath));
  delta.requirements = fresh.requirements.filter((item) => item.sourcePath && changed.has(item.sourcePath));
  delta.links = fresh.links.filter((link) => delta.requirements.some((req) => req.id === link.from) || delta.graph.entities.some((entity) => entity.id === link.to));
  const result = emptyIndex();
  const removedIds = new Set(previous.graph.entities.filter((item) => item.sourcePath && changed.has(item.sourcePath)).map((item) => item.id));
  result.graph.entities = previous.graph.entities.filter((item) => !item.sourcePath || !changed.has(item.sourcePath));
  result.graph.entities.push(...delta.graph.entities);
  // Relationships are cheap to regenerate and can change at untouched callers
  // when a changed file adds/removes an exported declaration.
  result.graph.edges = fresh.graph.edges;
  result.files = previous.files.filter((file) => !changed.has(file.path));
  result.files.push(...delta.files);
  const removedRequirements = new Set(previous.requirements.filter((item) => item.sourcePath && changed.has(item.sourcePath)).map((item) => item.id));
  result.requirements = previous.requirements.filter((item) => !item.sourcePath || !changed.has(item.sourcePath));
  result.requirements.push(...delta.requirements);
  result.links = previous.links.filter((link) => !removedIds.has(link.to) && !removedRequirements.has(link.from));
  result.links.push(...delta.links);
  return normalize(result);
}

/** Reverse dependency closure from a schema/data entity. */
export function dependentsOfSchema(index: CodeGraphIndex, schemaId: FactoryEntityId): FactoryEntityId[] {
  const schema = index.graph.entities.find((item) => item.id === schemaId);
  const sourceFileId = schema?.sourcePath ? makeId('code', `file/${schema.sourcePath}`) : schemaId;
  const types = new Set(['uses', 'reads', 'writes', 'serializes', 'deserializes', 'calls', 'imports', 'tests']);
  return uniqueSorted([
    ...reverseClosure(index, schemaId, types),
    ...reverseClosure(index, sourceFileId, types),
  ]);
}

/** Requirements tagged in source that have implementations inside a module subtree. */
export function requirementsImplementedByModule(index: CodeGraphIndex, moduleId: FactoryEntityId): FactoryEntityId[] {
  const descendants = new Set(forwardClosure(index, moduleId, new Set(['contains', 'declares'])));
  const found = index.links.filter((link) => link.type === 'implemented_by' && descendants.has(link.to))
    .map((link) => link.from as FactoryEntityId);
  return uniqueSorted(found);
}

/** Deterministic simple call paths which cross the changed symbol. */
export function executionPathsCrossingSymbol(index: CodeGraphIndex, symbolId: FactoryEntityId, maxPaths = 100): FactoryEntityId[][] {
  const calls = index.graph.edges.filter((edge) => edge.type === 'calls');
  const adjacent = adjacency(calls, false);
  const starts = [...new Set(calls.map((edge) => edge.from).filter((id) => id !== symbolId))].sort();
  const paths: FactoryEntityId[][] = [];
  for (const start of starts) {
    const queue: string[][] = [[start]];
    while (queue.length && paths.length < maxPaths) {
      const current = queue.shift()!;
      const tail = current[current.length - 1]!;
      if (tail === symbolId && current.length > 1) paths.push(current as FactoryEntityId[]);
      for (const next of adjacent.get(tail) ?? []) if (!current.includes(next) && current.length < 24) queue.push([...current, next]);
    }
    if (paths.length >= maxPaths) break;
  }
  return paths.sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
}

/** Findings explicitly linked to a module or any contained code descendant. */
export function findingsInModule(index: CodeGraphIndex, moduleId: FactoryEntityId): FactoryEntityId[] {
  const descendants = new Set([moduleId, ...forwardClosure(index, moduleId, new Set(['contains', 'declares']))]);
  return uniqueSorted(index.links.filter((link) => link.type === 'involves' && descendants.has(link.from as FactoryEntityId))
    .map((link) => link.to as FactoryEntityId));
}

/** Validate standalone artifacts before persistence or query. */
export function validateCodeGraphIndex(value: unknown): asserts value is CodeGraphIndex {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.files) || !Array.isArray(value.requirements) ||
    !Array.isArray(value.links) || !isRecord(value.graph) || value.graph.kind !== 'code' ||
    !Array.isArray(value.graph.entities) || !Array.isArray(value.graph.edges)) throw new Error('invalid code graph index');
  const entities = new Map<string, string>();
  for (const raw of value.graph.entities as unknown[]) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.startsWith('code:v1:') || typeof raw.kind !== 'string' || typeof raw.title !== 'string') throw new Error('invalid code graph entity');
    if (entities.has(raw.id)) throw new Error(`duplicate code graph entity: ${raw.id}`);
    entities.set(raw.id, raw.kind);
  }
  const edgeKinds: Record<string, [string[], string[]]> = {
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
  };
  for (const edge of value.graph.edges as unknown[]) {
    if (!isRecord(edge) || typeof edge.type !== 'string' || !edgeKinds[edge.type] || typeof edge.from !== 'string' || typeof edge.to !== 'string') throw new Error('invalid or dangling code graph edge');
    const fromKind = entities.get(edge.from); const toKind = entities.get(edge.to); const [fromKinds, toKinds] = edgeKinds[edge.type]!;
    if (!fromKind || !toKind || !fromKinds.includes(fromKind) || !toKinds.includes(toKind)) throw new Error(`ill-typed ${edge.type} code graph edge (${fromKind ?? 'missing'} -> ${toKind ?? 'missing'})`);
  }
  const requirementIds = new Set((value.requirements as Array<{ id?: unknown }>).map((item) => item.id));
  for (const link of value.links as unknown[]) {
    if (!isRecord(link) || !['implemented_by', 'involves'].includes(String(link.type)) || typeof link.from !== 'string' || typeof link.to !== 'string') throw new Error('invalid code graph link');
    if (link.type === 'implemented_by' && (!requirementIds.has(link.from) || !entities.has(link.to))) throw new Error('dangling implemented_by link');
    if (link.type === 'involves' && (!entities.has(link.from) || !String(link.to).startsWith('defect:v1:'))) throw new Error('invalid finding link');
  }
}

function emptyIndex(): MutableIndex {
  return { schemaVersion: 1, files: [], graph: { kind: 'code', entities: [], edges: [] }, requirements: [], links: [] };
}
function entity(id: FactoryEntityId, kind: CodeEntity['kind'], title: string, sourcePath: string, sourceHash: string): CodeEntity {
  return { id, kind, title, sourcePath, sourceHash };
}
function addEdge(index: MutableIndex, type: CodeEdgeType, from: string, to: string): void {
  index.graph.edges.push({ type, from: from as `code:v1:${string}`, to: to as `code:v1:${string}` });
}
function normalize(index: MutableIndex): CodeGraphIndex {
  const contained = new Set<string>(index.graph.edges.filter((edge) => edge.type === 'contains').map((edge) => edge.from));
  index.graph.entities = [...new Map(index.graph.entities.map((entity) => [entity.id, entity])).values()]
    .filter((entity) => entity.kind !== 'module' || contained.has(entity.id));
  index.files.sort((a, b) => a.path.localeCompare(b.path));
  index.graph.entities.sort((a, b) => a.id.localeCompare(b.id));
  index.graph.edges = uniqueEdges(index.graph.edges).sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to));
  index.requirements.sort((a, b) => a.id.localeCompare(b.id));
  index.links = [...new Map(index.links.map((edge) => [`${edge.type}\0${edge.from}\0${edge.to}`, edge])).values()]
    .sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to));
  validateCodeGraphIndex(index);
  return index;
}
function uniqueEdges<T extends { type: string; from: string; to: string }>(edges: T[]): T[] {
  return [...new Map(edges.map((edge) => [`${edge.type}\0${edge.from}\0${edge.to}`, edge])).values()];
}
function adjacency(edges: Array<{ from: string; to: string }>, reverse: boolean): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const from = reverse ? edge.to : edge.from;
    const to = reverse ? edge.from : edge.to;
    const values = result.get(from) ?? [];
    values.push(to); result.set(from, values);
  }
  for (const values of result.values()) values.sort();
  return result;
}
function reverseClosure(index: CodeGraphIndex, start: FactoryEntityId, types: Set<string>): FactoryEntityId[] {
  const edges = index.graph.edges.filter((edge) => types.has(edge.type));
  return closure(adjacency(edges, true), start).filter((id) => id !== start) as FactoryEntityId[];
}
function forwardClosure(index: CodeGraphIndex, start: FactoryEntityId, types: Set<string>): FactoryEntityId[] {
  const edges = index.graph.edges.filter((edge) => types.has(edge.type));
  return closure(adjacency(edges, false), start) as FactoryEntityId[];
}
function closure(adj: Map<string, string[]>, start: string): string[] {
  const seen = new Set<string>(); const queue = [start];
  while (queue.length) for (const next of adj.get(queue.shift()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return [...seen].sort();
}
function uniqueSorted(values: FactoryEntityId[]): FactoryEntityId[] { return [...new Set(values)].sort(); }
function within(root: string, file: string): boolean { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); }
function safeKey(value: string): string { return value.replace(/[^A-Za-z0-9._/-]/g, (ch) => `_u${ch.codePointAt(0)!.toString(16)}_`); }
function isTestPath(file: string): boolean { return /(?:^|\/)(?:__tests__\/|test\/|tests\/)|\.(?:test|spec)\.[cm]?tsx?$/.test(file); }
function isConfigurationPath(file: string): boolean { return /(?:^|\/)(?:config|configs)\/|(?:^|\/)[^/]*\.config\.[cm]?tsx?$|(?:^|\/)(?:config|settings)\.[cm]?tsx?$/.test(file); }
function isNamedDeclaration(node: ts.Node): node is ts.NamedDeclaration {
  return (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) ||
    ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.name !== undefined;
}
function declarationName(name: ts.DeclarationName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}
function entityKind(node: ts.NamedDeclaration): CodeEntity['kind'] {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return 'class';
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return 'function';
  if (ts.isInterfaceDeclaration(node)) return 'contract';
  return 'symbol';
}
function isExported(node: ts.Node): boolean { return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false); }
function inferredDataKind(name: string): CodeEntity['kind'] | undefined {
  if (/(?:Schema|Dto|DTO|Contract)$/.test(name)) return 'schema';
  if (/(?:Model|Entity|Record)$/.test(name)) return 'database_model';
  if (/Queue$/.test(name)) return 'queue';
  if (/Event$/.test(name)) return 'event';
  return undefined;
}
function documentedRequirement(node: ts.Node): string | undefined {
  const text = ts.getJSDocCommentsAndTags(node).map((item) => item.getText()).join('\n');
  return /@(?:implementsRequirement|requirement)\s+([A-Za-z0-9._/-]+)/.exec(text)?.[1] ??
    (isTestPath(node.getSourceFile().fileName) ? undefined : undefined);
}
function enclosingCallable(node: ts.Node): ts.Declaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) return current as ts.Declaration;
  }
  return undefined;
}
function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) if (ts.isClassLike(current)) return current;
  return undefined;
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
