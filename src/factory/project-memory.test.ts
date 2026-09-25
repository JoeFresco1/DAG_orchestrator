import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitChangesSince, loadProjectMemory, createProjectMemory, resumeProjectMemory, saveProjectMemory } from './project-memory.js';

const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dag-project-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'src', 'case.ts');
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, 'export function createCase() { return {}; }\n');
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
  const contractSource = path.join(root, 'src', 'case-contract.ts');
  writeFileSync(contractSource, 'export interface Case { id: string }\n');
  const contractHash = createHash('sha256').update(readFileSync(contractSource)).digest('hex');
  const runFile = path.join(root, 'runs', 'dag.run.json');
  const evidence = { path: 'src/case.ts', sha256: hash, sourceCommit: commitA, lineStart: 1, lineEnd: 1, symbol: 'createCase' };
  const memory = createProjectMemory({
    runId: 'run-one', repositoryRoot: root, reviewedAtCommit: commitA,
    subsystems: [{
      component: 'case_management',
      entry_points: [{ id: 'entry:create', value: 'createCase', evidence: [evidence] }],
      critical_paths: [{ id: 'path:create', value: ['API', 'createCase', 'repository'], evidence: [evidence] }],
      contracts: [{ id: 'contract:case', value: 'Case exposes an id string', evidence: [{ path: 'src/case-contract.ts', sha256: contractHash, sourceCommit: commitA }] }],
      known_invariants: [],
      risk_profile: { persistence: { id: 'risk:persistence', value: true, evidence: [evidence] } },
      historic_findings: [], historic_root_causes: [], false_positive_patterns: [],
    }],
  });
  return { root, runFile, source, memory };
}

test('persists versioned project memory in the run sidecar and validates association and hashes', (t) => {
  const { runFile, memory } = fixture(t);
  const file = saveProjectMemory(runFile, memory);
  assert.match(file, /dag\.run\.d[\\/]factory[\\/]project-memory-v1\.json$/);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.subsystems.case_management.architecture_hash, memory.subsystems.case_management.architecture_hash);
  assert.deepEqual(loadProjectMemory(runFile, 'run-one'), memory);
  assert.throws(() => loadProjectMemory(runFile, 'another-run'), /belongs to run/);
});

test('resume retains known architecture and invalidates claims backed by changed files', (t) => {
  const { root, memory } = fixture(t);
  const result = resumeProjectMemory(memory, commitB, ['src\\case.ts'], { repositoryRoot: root });
  assert.deepEqual(result.changesSince, ['src/case.ts']);
  assert.equal(result.knownArchitecture[0]?.entry_points.length, 0);
  assert.deepEqual(result.knownArchitecture[0]?.contracts.map((fact) => fact.id), ['contract:case']);
  assert.deepEqual(result.invalidatedFacts.map((fact) => fact.factId).sort(), ['entry:create', 'path:create', 'risk:persistence']);
  assert.equal(result.knownArchitecture[0]?.reviewed_at_commit, commitA);
});

test('resume invalidates evidence whose bytes changed even when the diff list omitted it', (t) => {
  const { root, source, memory } = fixture(t);
  writeFileSync(source, 'export function createCase() { return null; }\n');
  const result = resumeProjectMemory(memory, commitB, [], { repositoryRoot: root });
  assert.equal(result.knownArchitecture[0]?.entry_points.length, 0);
  assert.match(result.invalidatedFacts[0]?.reason ?? '', /source hash changed/);
});

test('rejects unsupported versions and facts without evidence', (t) => {
  const { runFile, memory } = fixture(t);
  const unsupported = { ...memory, schemaVersion: 2 } as never;
  assert.throws(() => saveProjectMemory(runFile, unsupported), /unsupported project memory schema/);
  const emptyEvidence = structuredClone(memory);
  emptyEvidence.subsystems.case_management.entry_points[0]!.evidence = [];
  assert.throws(() => saveProjectMemory(runFile, emptyEvidence), /must include evidence/);
});

test('collects committed, staged, working-tree, and untracked changes since memory commit', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dag-memory-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(path.join(root, 'base.txt'), 'base\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Memory Test', '-c', 'user.email=memory@example.test', 'commit', '-qm', 'base'], { cwd: root });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  writeFileSync(path.join(root, 'base.txt'), 'updated\n');
  writeFileSync(path.join(root, 'new.txt'), 'untracked\n');
  assert.deepEqual(gitChangesSince(root, base), ['base.txt', 'new.txt']);
});
