import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCodeGraph,
  dependentsOfSchema,
  executionPathsCrossingSymbol,
  findingsInModule,
  requirementsImplementedByModule,
  updateCodeGraph,
  type CodeGraphIndex,
} from './code-graph.js';

const tempDirs: string[] = [];
function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dag-code-graph-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'test'), { recursive: true });
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true }, include: ['src/**/*.ts', 'test/**/*.ts'] }));
  writeFileSync(path.join(root, 'src/case-schema.ts'), 'export interface CaseSchema { id: string }\n');
  writeFileSync(path.join(root, 'src/repository.ts'), "import type { CaseSchema } from './case-schema.js';\nexport class CaseRepository { save(value: CaseSchema): void {} }\n");
  writeFileSync(path.join(root, 'src/service.ts'), "import { CaseRepository } from './repository.js';\n/** @requirement SPEC-42 */\nexport function createCase() { const repository = new CaseRepository(); repository.save({ id: '1' }); }\n");
  writeFileSync(path.join(root, 'test/service.test.ts'), "import { createCase } from '../src/service.js';\ncreateCase();\n");
  return root;
}
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const id = (key: string): `code:v1:${string}` => `code:v1:${key}`;

describe('deterministic TypeScript code graph', () => {
  it('indexes file and symbol identities, imports, calls, tests, schemas, and requirement tags', () => {
    const root = fixture();
    const graph = buildCodeGraph({ rootDir: root });
    assert.ok(graph.files.some((file) => file.path === 'src/service.ts'));
    assert.ok(graph.graph.entities.some((item) => item.id === id('schema/src/case-schema.ts#CaseSchema')));
    assert.ok(graph.graph.edges.some((edge) => edge.type === 'imports' && edge.from === id('file/src/service.ts') && edge.to === id('file/src/repository.ts')));
    assert.ok(graph.graph.edges.some((edge) => edge.type === 'calls' && edge.from === id('symbol/src/service.ts#createCase') && edge.to === id('symbol/src/repository.ts#CaseRepository.save')));
    assert.ok(graph.graph.edges.some((edge) => edge.type === 'uses' && edge.from === id('symbol/src/repository.ts#CaseRepository.save') && edge.to === id('schema/src/case-schema.ts#CaseSchema')));
    assert.ok(graph.graph.edges.some((edge) => edge.type === 'tests' && edge.from === id('file/test/service.test.ts')));
    assert.deepEqual(graph.links.map((link) => [link.type, link.from, link.to]), [[
      'implemented_by', 'requirement:v1:spec/SPEC-42', id('symbol/src/service.ts#createCase'),
    ]]);
    const repeated = buildCodeGraph({ rootDir: root });
    assert.deepEqual(repeated, graph);
  });

  it('answers the four impact queries with stable sorted IDs', () => {
    const root = fixture();
    const graph = buildCodeGraph({ rootDir: root });
    assert.deepEqual(dependentsOfSchema(graph, id('schema/src/case-schema.ts#CaseSchema')), [
      id('file/src/repository.ts'), id('file/src/service.ts'), id('file/test/service.test.ts'), id('symbol/src/repository.ts#CaseRepository.save'),
      id('symbol/src/service.ts#createCase'),
    ]);
    assert.deepEqual(requirementsImplementedByModule(graph, id('module/src')), ['requirement:v1:spec/SPEC-42']);
    const paths = executionPathsCrossingSymbol(graph, id('symbol/src/repository.ts#CaseRepository.save'));
    assert.deepEqual(paths, [[id('symbol/src/service.ts#createCase'), id('symbol/src/repository.ts#CaseRepository.save')]]);
    graph.links.push({ type: 'involves', from: id('symbol/src/repository.ts#CaseRepository.save'), to: 'defect:v1:observation/save' });
    assert.deepEqual(findingsInModule(graph, id('module/src')), ['defect:v1:observation/save']);
  });

  it('updates changed and deleted files while preserving untouched entities and IDs', () => {
    const root = fixture();
    const initial = buildCodeGraph({ rootDir: root });
    const stable = initial.graph.entities.find((item) => item.id === id('symbol/src/service.ts#createCase'));
    writeFileSync(path.join(root, 'src/service.ts'), "import { CaseRepository } from './repository.js';\n/** @requirement SPEC-43 */\nexport function createCase() { const repository = new CaseRepository(); repository.save({ id: '2' }); }\n");
    rmSync(path.join(root, 'test/service.test.ts'));
    const updated: CodeGraphIndex = updateCodeGraph(initial, { rootDir: root }, ['src/service.ts', 'test/service.test.ts']);
    assert.equal(updated.graph.entities.find((item) => item.id === id('symbol/src/service.ts#createCase'))?.id, stable?.id);
    assert.equal(updated.files.some((file) => file.path === 'test/service.test.ts'), false);
    assert.equal(updated.graph.entities.some((item) => item.id === id('file/test/service.test.ts')), false);
    assert.deepEqual(updated.requirements.map((item) => item.title), ['SPEC-43']);
  });
});
