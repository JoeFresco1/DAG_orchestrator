import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CodeGraphIndex } from './code-graph.js';
import { analyzeSemanticImpact } from './impact.js';
import { createProjectMemory } from './project-memory.js';

const id = (value: string) => `code:v1:${value}` as `code:v1:${string}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40);

function graph(): CodeGraphIndex {
  const entities = [
    ['schema/case.ts#CaseDTO', 'schema', 'src/case.ts', 'CaseDTO'],
    ['symbol/src/serializer.ts#serializeCase', 'function', 'src/serializer.ts', 'serializeCase'],
    ['api/src/api.ts#caseApi', 'function', 'src/api.ts', 'caseApi'],
    ['symbol/src/client.ts#renderCase', 'function', 'src/client.ts', 'renderCase'],
    ['file/test/case.test.ts', 'file', 'test/case.test.ts', 'case.test.ts'],
    ['file/src/styles.css', 'file', 'src/styles.css', 'styles.css'],
  ] as const;
  return {
    schemaVersion: 1,
    files: entities.filter(([, kind]) => kind === 'file').map(([, , sourcePath]) => ({ path: sourcePath, sha256: digest(sourcePath) })),
    graph: {
      kind: 'code',
      entities: entities.map(([key, kind, sourcePath, title]) => ({
        id: id(key), kind, sourcePath, title,
      })) as CodeGraphIndex['graph']['entities'],
      edges: [
        { type: 'serializes', from: id('symbol/src/serializer.ts#serializeCase'), to: id('schema/case.ts#CaseDTO') },
        { type: 'uses', from: id('api/src/api.ts#caseApi'), to: id('symbol/src/serializer.ts#serializeCase') },
        { type: 'uses', from: id('symbol/src/client.ts#renderCase'), to: id('api/src/api.ts#caseApi') },
        { type: 'tests', from: id('file/test/case.test.ts'), to: id('symbol/src/client.ts#renderCase') },
      ],
    },
    requirements: [{ id: 'requirement:v1:spec/case-contract', kind: 'requirement', title: 'Case contract', sourcePath: 'src/case.ts' }],
    links: [{ type: 'implemented_by', from: 'requirement:v1:spec/case-contract', to: id('schema/case.ts#CaseDTO') }],
  };
}

test('follows typed DTO consumer paths, requirements, tests and certified assumptions reproducibly', () => {
  const memory = createProjectMemory({
    runId: 'run-one', repositoryRoot: '.', reviewedAtCommit: commit,
    subsystems: [{
      component: 'case', entry_points: [], critical_paths: [],
      contracts: [{ id: 'case-owner-required', value: 'CaseDTO.owner is required', evidence: [{ path: 'src/case.ts', sha256: digest('source'), sourceCommit: commit, symbol: 'CaseDTO' }] }],
      known_invariants: [], risk_profile: {}, historic_findings: [], historic_root_causes: [], false_positive_patterns: [],
    }],
  });
  const options = { graph: graph(), projectMemory: memory, change: { change: 'CaseDTO.owner optional → required', changed: [id('schema/case.ts#CaseDTO')] } };
  const first = analyzeSemanticImpact(options);
  const second = analyzeSemanticImpact({ ...options, graph: graph() });
  assert.deepEqual(first, second);
  assert.deepEqual(first.invalidated_units, [id('api/src/api.ts#caseApi'), id('file/test/case.test.ts'), id('schema/case.ts#CaseDTO'), id('symbol/src/client.ts#renderCase'), id('symbol/src/serializer.ts#serializeCase')]);
  assert.deepEqual(first.affected_requirements, ['requirement:v1:spec/case-contract']);
  assert.deepEqual(first.affected_tests, [id('file/test/case.test.ts')]);
  assert.deepEqual(first.invalidated_assumptions.map((fact) => fact.id), ['case-owner-required']);
  assert.deepEqual(first.affected_paths.find((path) => path.affected === id('symbol/src/client.ts#renderCase'))?.nodes,
    [id('schema/case.ts#CaseDTO'), id('symbol/src/serializer.ts#serializeCase'), id('api/src/api.ts#caseApi'), id('symbol/src/client.ts#renderCase')]);
  assert.match(first.reproducibility_hash, /^[a-f0-9]{64}$/);
});

test('keeps declaration-free CSS changes local and excludes ownership-only relationships', () => {
  const result = analyzeSemanticImpact({ graph: graph(), change: { change: 'button color changed', changed: ['src/styles.css'] } });
  assert.deepEqual(result.changed_units, [id('file/src/styles.css')]);
  assert.deepEqual(result.invalidated_units, [id('file/src/styles.css')]);
  assert.deepEqual(result.affected_paths, []);
  assert.deepEqual(result.required_reviews, []);
});

test('rejects unknown changed paths and produces stable output independent of change ordering', () => {
  const source = graph();
  assert.throws(() => analyzeSemanticImpact({ graph: source, change: { change: 'unknown', changed: ['missing.ts'] } }), /unknown changed/);
  const a = analyzeSemanticImpact({ graph: source, change: { change: 'two symbols changed', changed: [id('schema/case.ts#CaseDTO'), id('api/src/api.ts#caseApi')] } });
  const b = analyzeSemanticImpact({ graph: source, change: { change: 'two symbols changed', changed: [id('api/src/api.ts#caseApi'), id('schema/case.ts#CaseDTO')] } });
  assert.deepEqual(a, b);
});
