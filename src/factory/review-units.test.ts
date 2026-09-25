import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CodeGraphIndex } from './code-graph.js';
import { generateReviewUnits } from './review-units.js';

type Id = `code:v1:${string}`;
function entity(key: string, kind: 'file' | 'symbol' | 'function' | 'contract' | 'test' = 'symbol') {
  return { id: `code:v1:${key}` as Id, kind, title: key };
}
function graph(entities: ReturnType<typeof entity>[], edges: CodeGraphIndex['graph']['edges']): CodeGraphIndex {
  return {
    schemaVersion: 1,
    files: [],
    graph: { kind: 'code', entities, edges },
    requirements: [],
    links: [],
  };
}
const edge = (type: 'calls' | 'uses' | 'tests', from: string, to: string) => ({
  type,
  from: `code:v1:${from}` as Id,
  to: `code:v1:${to}` as Id,
});

describe('coherent review unit generator', () => {
  it('forms a nucleus neighborhood with inbound, outbound, lateral, tests, and contracts', () => {
    const index = graph(
      [entity('A'), entity('B'), entity('C', 'function'), entity('D'), entity('E'), entity('T', 'test'), entity('I', 'contract')],
      [edge('calls', 'A', 'B'), edge('calls', 'A', 'C'), edge('calls', 'A', 'D'), edge('calls', 'C', 'E'),
        edge('tests', 'T', 'C'), edge('uses', 'C', 'I')],
    );

    const unit = generateReviewUnits(index).find((candidate) => candidate.nucleus === 'code:v1:C');
    assert.deepEqual(unit, {
      nucleus: 'code:v1:C',
      inbound: ['code:v1:A'],
      outbound: ['code:v1:E'],
      lateral: ['code:v1:B', 'code:v1:D'],
      tests: ['code:v1:T'],
      contracts: ['code:v1:I'],
    });
  });

  it('is deterministic and enforces entity and character budgets', () => {
    const entities = Array.from({ length: 30 }, (_, i) => entity(`n${i}`, 'function'));
    const edges = entities.slice(1).map((item) => edge('calls', 'n0', item.id.slice('code:v1:'.length)));
    const index = graph(entities, edges);
    const options = { maxContextEntities: 5, maxNeighbors: 3, maxContextChars: 200 };
    const first = generateReviewUnits(index, options);
    assert.deepEqual(generateReviewUnits(index, options), first);
    assert.equal(first.length, entities.length);
    assert.ok(first.every((unit) => new Set([
      unit.nucleus, ...unit.inbound, ...unit.outbound, ...unit.lateral, ...unit.tests, ...unit.contracts,
    ]).size <= 5));
    assert.ok(first.every((unit) => unit.inbound.length <= 3 && unit.outbound.length <= 3 && unit.lateral.length <= 3));
    assert.ok(first[0]!.outbound.length < 29);
  });

  it('rejects invalid limits', () => {
    const index = graph([entity('A')], []);
    assert.throws(() => generateReviewUnits(index, { maxContextEntities: 0 }), /positive integer/);
  });
});
