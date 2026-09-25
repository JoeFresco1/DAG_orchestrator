import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCodeGraph } from './code-graph.js';
import { compileContext } from './context-compiler.js';
import { adaptExistingRunForVerification } from './existing-run-reviewer.js';
import type { DefectHypothesis } from './hypotheses.js';
import { adjudicateVerification, createVerificationPacket, renderVerificationPrompt, validateVerificationResult, VERIFICATION_CATEGORIES } from './verification.js';
import type { Run } from '../types.js';

const dirs: string[] = [];
function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dag-verification-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'test'), { recursive: true });
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true }, include: ['src/**/*.ts', 'test/**/*.ts'] }));
  writeFileSync(path.join(root, 'src/service.ts'), 'export function save(value: string | null): string { if (value === null) throw new Error("missing"); return value; }\nexport function run(): string { return save("ok"); }\n');
  writeFileSync(path.join(root, 'test/service.test.ts'), 'import { run } from "../src/service.js";\nif (run() !== "ok") throw new Error("bad result");\n');
  return root;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const hypothesis: Pick<DefectHypothesis, 'id' | 'claim'> = { id: 'defect:v1:hypothesis.null-save', claim: 'run can pass null into save and return null' };
const fullAssessment = (forId: string, againstId: string) => ({
  verdict: 'verified' as const, confidence: 0.94, reachability: 'confirmed' as const,
  inspectedCategories: [...VERIFICATION_CATEGORIES],
  evidenceFor: [{ evidenceId: forId, rationale: 'The entry path reaches the cited operation.' }],
  evidenceAgainst: [{ evidenceId: againstId, rationale: 'The null guard contradicts the claimed return.' }],
  reasoning: 'The claim is contradicted by the guard and test behavior.',
});

describe('adversarial verification', () => {
  it('creates reproducible source-linked evidence and requires challenge coverage and counterevidence', () => {
    const root = fixture();
    const index = buildCodeGraph({ rootDir: root });
    const context = compileContext({ rootDir: root, index, request: hypothesis.claim });
    const packet = createVerificationPacket(hypothesis, context);
    assert.match(packet.sha256, /^[a-f0-9]{64}$/);
    assert.ok(packet.evidence.some((item) => item.category === 'tests'));
    assert.ok(packet.evidence.some((item) => item.sha256));
    assert.match(renderVerificationPrompt(packet), /do not edit, create, delete, or repair/);
    const ids = packet.evidence.map((item) => item.id);
    const rejectedAsVerified = adjudicateVerification(packet, fullAssessment(ids[0]!, ids[1]!));
    assert.equal(rejectedAsVerified.verdict, 'verified');
    assert.equal(rejectedAsVerified.evidence_sha256, packet.sha256);
    validateVerificationResult(rejectedAsVerified);

    const incomplete = adjudicateVerification(packet, {
      ...fullAssessment(ids[0]!, ids[1]!), inspectedCategories: ['implementation'], evidenceAgainst: [],
    });
    assert.equal(incomplete.verdict, 'inconclusive');
    assert.ok(incomplete.confidence <= 0.59);
  });

  it('rejects citations that are not in the immutable evidence packet', () => {
    const root = fixture();
    const packet = createVerificationPacket(hypothesis, compileContext({ rootDir: root, index: buildCodeGraph({ rootDir: root }), request: hypothesis.claim }));
    const ids = packet.evidence.map((item) => item.id);
    const result = adjudicateVerification(packet, {
      ...fullAssessment(ids[0]!, ids[1]!), evidenceFor: [{ evidenceId: 'invented', rationale: 'fabricated' }],
    });
    assert.equal(result.verdict, 'inconclusive');
    assert.deepEqual(result.evidence_for, []);
  });

  it('adapts a stored run without changing run state or repository source', () => {
    const root = fixture();
    const source = path.join(root, 'src/service.ts');
    const before = readFileSync(source, 'utf8');
    const run = {
      id: 'run-existing', objective: 'existing work', tasks: {},
    } as Run;
    const adapted = adaptExistingRunForVerification({ run, hypothesis, rootDir: root, index: buildCodeGraph({ rootDir: root }) });
    assert.equal(adapted.runId, run.id);
    assert.match(adapted.prompt, /Existing run run-existing/);
    assert.equal(readFileSync(source, 'utf8'), before);
  });
});
