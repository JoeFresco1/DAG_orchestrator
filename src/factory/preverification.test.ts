import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCodeGraph } from './code-graph.js';
import { analyzeObservations } from './observations.js';
import { preverifyHypothesis, codeGraphReachable } from './preverification.js';

const tempDirs: string[] = [];
function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dag-preverify-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true }, include: ['src/**/*.ts'] }));
  writeFileSync(path.join(root, 'src/service.ts'), 'export function save(): void {}\nexport function run(): void { save(); }\n');
  writeFileSync(path.join(root, 'src/other.ts'), 'export function idle(): void {}\n');
  return root;
}
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const hypothesis = { id: 'defect:v1:hypothesis.h1' as const, claim: 'run does not call save' };
const id = (key: string): `code:v1:${string}` => `code:v1:${key}`;

describe('cheap hypothesis pre-verification', () => {
  it('checks source, line, symbol, caller and reachable graph path without rejecting plausible evidence', () => {
    const root = fixture();
    const graph = buildCodeGraph({ rootDir: root });
    const result = preverifyHypothesis(hypothesis, {
      rootDir: root,
      codeGraph: graph,
      graphIsComplete: true,
      references: [{ path: 'src/service.ts', line: 2, symbol: 'run' }],
      callers: [{ caller: 'run', callee: 'save' }],
    });
    assert.equal(result.status, 'plausible');
    assert.ok(result.checks.some((check) => check.question === 'does the referenced line exist?' && check.state === 'evidence'));
    assert.ok(result.checks.some((check) => check.question === 'is the claimed caller real?' && check.state === 'evidence'));
    const reachable = codeGraphReachable(graph, id('symbol/src/service.ts#run'), id('symbol/src/service.ts#save'));
    assert.equal(reachable, true);
  });

  it('rejects a cited missing path, out-of-range line, absent symbol in complete scope, and unreachable explicit path', () => {
    const root = fixture();
    const graph = buildCodeGraph({ rootDir: root });
    const result = preverifyHypothesis(hypothesis, {
      rootDir: root,
      codeGraph: graph,
      graphIsComplete: true,
      references: [
        { path: 'src/service.ts', line: 99, symbol: 'missingSymbol' },
        { path: 'src/deleted.ts' },
      ],
      callers: [{ caller: 'run', callee: 'idle' }],
    });
    assert.equal(result.status, 'rejected');
    assert.ok(result.checks.some((check) => check.state === 'invalid' && /line range/.test(check.detail)));
    assert.ok(result.checks.some((check) => check.state === 'invalid' && /symbol not found/.test(check.detail)));
    assert.ok(result.checks.some((check) => check.state === 'invalid' && /does not exist/.test(check.detail)));
    assert.ok(result.checks.some((check) => check.state === 'invalid' && /no call edge/.test(check.detail)));
  });

  it('rejects an explicit execution path only when a complete graph proves it unreachable', () => {
    const root = fixture();
    const graph = buildCodeGraph({ rootDir: root });
    const observation = analyzeObservations([{
      id: 'F1', title: 'Unreachable path', files: ['src/service.ts'],
      executionPaths: [[id('symbol/src/service.ts#run'), id('symbol/src/other.ts#idle')]],
    }]).observations;
    const complete = preverifyHypothesis(hypothesis, { rootDir: root, codeGraph: graph, graphIsComplete: true, observations: observation });
    assert.equal(complete.status, 'rejected');
    assert.ok(complete.checks.some((check) => check.question === 'is the execution path reachable?' && check.state === 'invalid'));

    const partial = preverifyHypothesis(hypothesis, { rootDir: root, codeGraph: graph, observations: observation });
    assert.equal(partial.status, 'plausible');
    assert.ok(partial.checks.some((check) => check.question === 'is the execution path reachable?' && check.state === 'unresolved'));
  });

  it('keeps incomplete graph, natural-language paths, and matching guards unresolved or as evidence', () => {
    const root = fixture();
    const graph = buildCodeGraph({ rootDir: root, files: ['src/service.ts'] });
    const result = preverifyHypothesis(hypothesis, {
      rootDir: root,
      codeGraph: graph,
      callers: [{ caller: 'run', callee: 'not-indexed' }],
      evidence: [{ id: 'guard-1', source: 'guard', conclusion: 'supports', summary: 'A null check is present.' }],
    });
    assert.equal(result.status, 'plausible');
    assert.ok(result.checks.some((check) => check.state === 'unresolved' && /call relationship unresolved/.test(check.detail)));
    assert.ok(result.evidenceIds.includes('guard-1'));
  });

  it('rejects only explicit contradictory deterministic test or type evidence', () => {
    const root = fixture();
    for (const source of ['test', 'typecheck', 'static-analysis'] as const) {
      const id = `${source}-contradiction`;
      const result = preverifyHypothesis(hypothesis, {
        rootDir: root,
        evidence: [{ id, source, conclusion: 'contradicts', hypothesisId: hypothesis.id, summary: 'Deterministic evidence disproves the claimed failure.' }],
      });
      assert.equal(result.status, 'rejected');
      assert.deepEqual(result.evidenceIds, [id]);
    }
  });
});
