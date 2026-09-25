import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CodeGraphIndex } from './code-graph.js';
import { rankReviewableUnits, type CodeGraphEntityId } from './risk.js';

const id = (key: string) => `code:v1:${key}` as CodeGraphEntityId;
const source = id('function/source');
const service = id('function/service');
const schema = id('schema/record');
const api = id('api/service');
const test = id('file/service.test.ts');

function graph(): CodeGraphIndex {
  return {
    schemaVersion: 1,
    files: [],
    requirements: [],
    links: [],
    graph: {
      kind: 'code',
      entities: [
        { id: source, kind: 'function', title: 'source' },
        { id: service, kind: 'function', title: 'service' },
        { id: schema, kind: 'schema', title: 'Record' },
        { id: api, kind: 'api', title: 'service API' },
        { id: test, kind: 'test', title: 'service tests' },
      ],
      edges: [
        { type: 'calls', from: source, to: service },
        { type: 'writes', from: service, to: schema },
        { type: 'uses', from: service, to: api },
        { type: 'tests', from: test, to: service },
      ],
    },
  };
}

describe('factory risk ranking', () => {
  it('combines deterministic graph and supplied evidence, and explains the scores', () => {
    const scores = rankReviewableUnits(graph(), {
      units: [source, service],
      evidence: {
        [service]: { coverage: 0.2, cyclomaticComplexity: 16, authenticationSensitivity: 1, verifiedDefects: 1 },
        [source]: { coverage: 0.9, cyclomaticComplexity: 1, verifiedDefects: 0, regressionRate: 0 },
      },
    });
    const serviceRisk = scores.find((item) => item.unit === service)!;
    assert.ok(serviceRisk.impact > 0);
    assert.ok(serviceRisk.defect_probability > 0);
    assert.equal(serviceRisk.signals.fanIn, 1);
    assert.equal(serviceRisk.signals.publicApi, true);
    assert.equal(serviceRisk.signals.persistence, true);
    assert.equal(serviceRisk.signals.tested, true);
    assert.ok(serviceRisk.sub_scores.impact.public_api > 0);
    assert.ok(serviceRisk.sub_scores.defect_probability.low_coverage > 0);
    assert.ok(serviceRisk.missing_signals.includes('loc'));
    assert.ok(scores.findIndex((item) => item.unit === service) < scores.findIndex((item) => item.unit === source));
  });

  it('uses a stable entity ID tie-breaker and produces identical results for identical evidence', () => {
    const first = rankReviewableUnits(graph());
    const second = rankReviewableUnits(graph());
    assert.deepEqual(first, second);
    const sameRiskUnits = first.filter((item) => item.risk_score === first[0]!.risk_score).map((item) => item.unit);
    assert.deepEqual(sameRiskUnits, [...sameRiskUnits].sort((a, b) => a.localeCompare(b)));
  });

  it('excludes modules and tests by default and honors an explicit unit selection', () => {
    const index = graph();
    index.graph.entities.push({ id: id('module/root'), kind: 'module', title: 'root' });
    assert.ok(!rankReviewableUnits(index).some((item) => item.unit === test || item.unit === id('module/root')));
    assert.deepEqual(rankReviewableUnits(index, { units: [schema, test] }).map((item) => item.unit), [schema]);
  });
});
