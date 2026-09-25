import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeObservations, normalizeObservations, type RawObservation } from './observations.js';

describe('factory observation normalization and clustering', () => {
  it('normalizes content and ordering deterministically while retaining exact duplicates', () => {
    const repeated: RawObservation = {
      id: 'review-1',
      reviewer: 'Reviewer A',
      title: '  API returns   missing OWNER ',
      category: 'Contract',
      files: ['src\\api.ts', 'src/model.ts', 'src/api.ts'],
      symbols: ['Case.owner', 'Case'],
      executionPaths: [['API', 'DTO', 'Service']],
      semanticEvidence: ['owner can be absent'],
      evidenceIds: ['log:one'],
    };
    const second: RawObservation = { ...repeated, id: 'review-2', reviewer: 'Reviewer B' };
    const a = normalizeObservations([repeated, second]);
    const b = normalizeObservations([second, repeated]);

    assert.deepEqual(a, b);
    assert.equal(a.observations.length, 2);
    assert.equal(a.observations[0]!.title, 'api returns missing owner');
    assert.deepEqual(a.observations[0]!.files, ['src/api.ts', 'src/model.ts']);
    assert.deepEqual(a.observations[0]!.executionPaths, [['api', 'dto', 'service']]);
    assert.equal(a.corroborates.length, 1);
    assert.equal(a.corroborates[0]!.type, 'corroborates');
    assert.notEqual(a.corroborates[0]!.from, a.corroborates[0]!.to);
  });

  it('combines related contract findings into fewer hypotheses than raw observations', () => {
    const raw: RawObservation[] = [
      { id: '1', title: 'API sometimes returns missing owner', category: 'contract', files: ['src/api.ts'], symbols: ['Case.owner'], failureScenario: 'case owner missing', executionPaths: [['service', 'api']] },
      { id: '2', title: 'Frontend crashes when owner missing', category: 'runtime', files: ['src/view.ts'], symbols: ['Case.owner'], failureScenario: 'case owner missing', executionPaths: [['api', 'frontend']] },
      { id: '3', title: 'DTO allows owner=null', category: 'contract', files: ['src/dto.ts'], symbols: ['Case.owner'], failureScenario: 'case owner missing', executionPaths: [['service', 'dto']] },
      { id: '4', title: 'Service fails to populate owner', category: 'data', files: ['src/service.ts'], symbols: ['Case.owner'], failureScenario: 'case owner missing', executionPaths: [['service', 'repository']] },
      { id: '5', title: 'Unrelated date formatting is wrong', category: 'display', files: ['src/date.ts'], symbols: ['Date.format'], failureScenario: 'invalid date string' },
    ];
    const analysis = analyzeObservations(raw);

    assert.equal(analysis.observations.length, raw.length);
    assert.equal(analysis.clusters.length, 2);
    assert.ok(analysis.clusters.length < raw.length);
    const ownerCluster = analysis.clusters.find((cluster) => cluster.observationIds.length === 4)!;
    assert.ok(ownerCluster);
    assert.ok(ownerCluster.features.symbols.includes('case.owner'));
    assert.ok(ownerCluster.features.executionPaths.some((path) => path.includes('frontend')));
    assert.ok(ownerCluster.features.files.includes('src/api.ts'));
    assert.match(ownerCluster.claim, /owner/i);
  });

  it('uses code graph dependency paths as evidence when symbols differ', () => {
    const first: RawObservation = { title: 'serializes a request field', symbols: ['code:v1:symbol/api.serialize'] };
    const second: RawObservation = { title: 'parses a response body', symbols: ['code:v1:symbol/dto.parse'] };
    const graph = {
      graph: {
        kind: 'code' as const,
        entities: [],
        edges: [{ type: 'uses' as const, from: 'code:v1:symbol/api.serialize' as const, to: 'code:v1:symbol/dto.parse' as const }],
      },
    };
    const withoutGraph = analyzeObservations([first, second]);
    const withGraph = analyzeObservations([first, second], { codeGraph: graph });

    assert.equal(withoutGraph.clusters.length, 2);
    assert.equal(withGraph.clusters.length, 1);
    assert.ok(withGraph.clusters[0]!.score >= 0.3);
  });

  it('uses file and dependency overlap and incorporates category agreement', () => {
    const fileLinked = analyzeObservations([
      { title: 'alpha warning', files: ['src/shared.ts'], category: 'contract' },
      { title: 'beta warning', files: ['src/shared.ts'], category: 'contract' },
    ]);
    const dependencyLinked = analyzeObservations([
      { title: 'alpha warning', dependencies: ['Case.owner'] },
      { title: 'beta warning', dependencies: ['Case.owner'] },
    ]);
    const categoryMismatch = analyzeObservations([
      { title: 'alpha warning', files: ['src/shared.ts'], category: 'contract' },
      { title: 'beta warning', files: ['src/shared.ts'], category: 'runtime' },
    ]);

    assert.equal(fileLinked.clusters.length, 1);
    assert.equal(dependencyLinked.clusters.length, 1);
    assert.ok(fileLinked.clusters[0]!.score > categoryMismatch.clusters[0]!.score);
  });

  it('rejects invalid clustering thresholds', () => {
    const normalized = normalizeObservations([{ title: 'finding' }]).observations;
    assert.throws(() => analyzeObservations([{ title: 'finding' }], { threshold: 2 }), /threshold/);
    assert.equal(normalized.length, 1);
  });
});
