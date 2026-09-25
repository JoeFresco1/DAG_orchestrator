import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FactoryEntityId } from './contracts.js';
import type { CodeGraphIndex } from './code-graph.js';
import { compileContext, expandContext } from './context-compiler.js';
import type { CodeEntity } from './graph-model.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'dag-context-compiler-'));
mkdirSync(path.join(root, 'src'), { recursive: true });
mkdirSync(path.join(root, 'tests'), { recursive: true });
mkdirSync(path.join(root, 'docs'), { recursive: true });
writeFileSync(path.join(root, 'src/payment.ts'), [
  'export class PaymentService {',
  '  retry() { return this.gateway.send(); }',
  '}',
].join('\n'));
writeFileSync(path.join(root, 'src/worker.ts'), 'export function processPayment(service: PaymentService) { return service.retry(); }');
writeFileSync(path.join(root, 'src/gateway.ts'), 'export class PaymentGateway { send() { return true; } }');
writeFileSync(path.join(root, 'src/contracts.ts'), 'export interface PaymentContract { amount: number }');
writeFileSync(path.join(root, 'tests/payment.test.ts'), "import { PaymentService } from '../src/payment'; describe('retry', () => PaymentService);");
writeFileSync(path.join(root, 'docs/retry.md'), '# Retry behavior\nThe service retries transient gateway failures once.\n\n# Unrelated storage\nStore values in a database.');
after(() => rmSync(root, { recursive: true, force: true }));

type CodeId = `code:v1:${string}`;
const id = (key: string): CodeId => `code:v1:${key}`;
const entity = (key: string, kind: CodeEntity['kind'], title: string, sourcePath?: string): CodeEntity => ({
  id: id(key), kind, title, ...(sourcePath ? { sourcePath } : {}),
});
const edge = (type: 'calls' | 'tests' | 'uses', from: string, to: string) => ({ type, from: id(from), to: id(to) });
const index: CodeGraphIndex = {
  schemaVersion: 1,
  files: [],
  graph: {
    kind: 'code',
    entities: [
      entity('symbol/payment-retry', 'function', 'src/payment.ts::PaymentService.retry', 'src/payment.ts'),
      entity('symbol/payment-service', 'class', 'src/payment.ts::PaymentService', 'src/payment.ts'),
      entity('symbol/worker', 'function', 'src/worker.ts::processPayment', 'src/worker.ts'),
      entity('symbol/gateway', 'function', 'src/gateway.ts::PaymentGateway.send', 'src/gateway.ts'),
      entity('contract/payment', 'contract', 'src/contracts.ts::PaymentContract', 'src/contracts.ts'),
      entity('schema/payment', 'schema', 'PaymentSchema'),
      entity('file/payment-test', 'file', 'tests/payment.test.ts', 'tests/payment.test.ts'),
      entity('symbol/cold-path', 'function', 'src/cold.ts::formatDate', 'src/payment.ts'),
    ],
    edges: [
      edge('calls', 'symbol/worker', 'symbol/payment-retry'),
      edge('calls', 'symbol/payment-retry', 'symbol/gateway'),
      edge('tests', 'file/payment-test', 'symbol/payment-retry'),
      edge('uses', 'symbol/payment-retry', 'contract/payment'),
      edge('uses', 'symbol/payment-retry', 'schema/payment'),
    ],
  },
  requirements: [],
  links: [],
};

const options = {
  index, rootDir: root, request: 'Review retry behavior in PaymentService',
  specPaths: ['docs/retry.md'],
  diagnostics: [{ id: 'diag-1', title: 'Retry warning', message: 'Retry has no backoff', sourcePath: 'src/payment.ts', line: 2 }],
  previousFindings: [{ id: 'finding-1', title: 'Retry duplicate attempt', content: 'Retry may issue a duplicate gateway request', symbolId: id('symbol/payment-retry') }],
  invariants: [{ id: 'inv-1', title: 'Payment retry invariant', content: 'Only transient failures may retry' }],
  recentChanges: [{ id: 'change-1', title: 'PaymentService retry change', content: 'Retry counter is now bounded' }],
};

describe('deterministic context compiler', () => {
  it('compiles graph neighborhood, source, tests, clauses, diagnostics, findings, and provenance', () => {
    const packet = compileContext(options);
    assert.deepEqual(compileContext(options), packet);
    assert.equal(packet.schemaVersion, 1);
    assert.equal(packet.targetIds.includes(id('symbol/payment-retry')), true);
    const kinds = new Set(packet.evidence.map((item) => item.kind));
    for (const kind of ['implementation', 'caller', 'callee', 'interface', 'schema', 'test', 'spec_clause', 'diagnostic', 'previous_finding', 'invariant', 'recent_change']) {
      assert.ok(kinds.has(kind as typeof packet.evidence[number]['kind']), `missing ${kind}`);
    }
    const implementation = packet.evidence.find((item) => item.kind === 'implementation' && item.title.includes('PaymentService.retry'))!;
    assert.match(implementation.content, /this\.gateway\.send/);
    assert.equal(implementation.provenance[0]?.lineStart, 2);
    assert.match(packet.evidence.find((item) => item.kind === 'spec_clause')!.content, /retries transient gateway failures/);
    assert.equal(packet.evidence.some((item) => item.content.includes('Unrelated storage')), false);
  });

  it('enforces packet budgets and reports omitted evidence deterministically', () => {
    const packet = compileContext({ ...options, maxEvidence: 3, maxChars: 100 });
    assert.ok(packet.evidence.length <= 3);
    assert.ok(packet.evidence.reduce((sum, item) => sum + item.content.length, 0) <= 100);
    assert.ok(packet.omitted.itemCount > 0);
    assert.match(packet.sha256, /^[a-f0-9]{64}$/);
  });

  it('adds explicitly requested graph context and records the expansion', () => {
    const original = compileContext(options);
    const expanded = expandContext(options, original, { entityIds: [id('symbol/cold-path')] });
    assert.ok(expanded.evidence.some((item) => item.title === 'src/cold.ts::formatDate'));
    assert.deepEqual(expanded.expansions[0]?.entityIds, [id('symbol/cold-path')]);
    assert.ok(expanded.expansions[0]?.addedEvidenceIds.length);
    assert.notEqual(expanded.sha256, original.sha256);
    assert.throws(() => expandContext(options, original, { entityIds: ['code:v1:missing' as FactoryEntityId] }), /unknown context entity/);
  });
});
