import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createNegativeEvidenceStore,
  evaluateNegativeEvidence,
  loadNegativeEvidence,
  recordNegativeEvidence,
  saveNegativeEvidence,
  validateNegativeEvidenceStore,
} from './negative-evidence.js';

const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dag-negative-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'src', 'case', 'repository.ts');
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, 'export function requireEntity(value: unknown) { if (!value) throw Error(); return value; }\n');
  const evidence = {
    assumption: 'All repository results pass through requireEntity before use.',
    path: 'src/case/repository.ts',
    sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    sourceCommit: commitA,
    symbol: 'requireEntity',
  };
  const store = createNegativeEvidenceStore({ repositoryRoot: root, repositoryVersion: commitA });
  const known = recordNegativeEvidence(store, {
    id: 'case-repository-undefined',
    pattern: 'repository.find() may return undefined',
    status: 'known-non-issue',
    reason: 'All callers pass through requireEntity().',
    scope: 'src/case/**',
    evidence: [evidence],
  });
  const disproven = recordNegativeEvidence(store, {
    id: 'case-missing-owner',
    pattern: 'Case.owner is omitted by repository.find()',
    status: 'disproven',
    reason: 'The repository hydrates owner before returning a case.',
    scope: 'src/case/**',
    evidence: [{ ...evidence, assumption: 'Repository results include the hydrated owner.' }],
  });
  return { root, source, store, known, disproven, runFile: path.join(root, 'runs', 'dag.run.json') };
}

test('stores versioned disproven hypotheses and false-positive patterns in the run factory sidecar', (t) => {
  const { store, known, disproven, runFile } = fixture(t);
  const file = saveNegativeEvidence(runFile, store);
  assert.match(file, /dag\.run\.d[\\/]factory[\\/]negative-evidence-v1\.json$/);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.repositoryVersion, commitA);
  assert.deepEqual(saved.entries.map((entry: { status: string }) => entry.status), ['known-non-issue', 'disproven']);
  assert.deepEqual(loadNegativeEvidence(runFile), store);
  assert.equal(known.verifiedAtCommit, commitA);
  assert.equal(disproven.evidence[0]?.sourceCommit, commitA);
});

test('reuses evidence only when scoped files and assumption evidence remain unchanged', (t) => {
  const { store, known, disproven, source } = fixture(t);
  const unchanged = evaluateNegativeEvidence(store, commitB, [], { repositoryRoot: store.repositoryRoot });
  assert.deepEqual(unchanged.reusable.map((entry) => entry.id), [known.id, disproven.id]);
  assert.deepEqual(unchanged.invalidated, []);

  const scoped = evaluateNegativeEvidence(store, commitB, ['src/case/service.ts']);
  assert.deepEqual(scoped.reusable, []);
  assert.equal(scoped.invalidated.length, 2);
  assert.match(scoped.invalidated[0]?.reason ?? '', /scoped source changed/);

  writeFileSync(source, 'export function requireEntity(value: unknown) { return value; }\n');
  const assumptionsChanged = evaluateNegativeEvidence(store, commitB, []);
  assert.deepEqual(assumptionsChanged.reusable, []);
  assert.equal(assumptionsChanged.invalidated.length, 2);
  assert.match(assumptionsChanged.invalidated[0]?.reason ?? '', /assumption evidence changed/);
});

test('rejects records without evidence or repository-version provenance', (t) => {
  const { store, runFile } = fixture(t);
  assert.throws(() => recordNegativeEvidence(store, {
    pattern: 'missing evidence', status: 'disproven', reason: 'no source', scope: 'src/**', evidence: [],
  }), /evidence are required/);
  const unsupported = { ...store, schemaVersion: 2 } as never;
  assert.throws(() => saveNegativeEvidence(runFile, unsupported), /unsupported negative evidence schema/);
  const badCommit = { ...store, repositoryVersion: 'short' } as never;
  assert.throws(() => validateNegativeEvidenceStore(badCommit), /invalid negative evidence store header/);
});
