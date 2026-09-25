import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeObservations } from './observations.js';
import { createHypotheses, validateHypothesisSet } from './hypotheses.js';

describe('factory defect hypotheses', () => {
  it('creates versioned testable claims linked to observations and source finding IDs', () => {
    const analysis = analyzeObservations([
      {
        id: 'F103', title: 'API sometimes returns missing owner', category: 'contract',
        files: ['src/api.ts'], symbols: ['Case.owner'], failureScenario: 'case owner missing',
        executionPaths: [['API', 'DTO', 'service']],
      },
      {
        id: 'F211', title: 'Frontend crashes when owner missing', category: 'runtime',
        files: ['src/view.ts'], symbols: ['Case.owner'], failureScenario: 'case owner missing',
        executionPaths: [['DTO', 'frontend']],
      },
    ]);

    const result = createHypotheses(analysis.observations, analysis.clusters);
    validateHypothesisSet(result);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.hypotheses.length, 1);
    const hypothesis = result.hypotheses[0]!;
    assert.match(hypothesis.id, /^defect:v1:hypothesis\./);
    assert.equal(hypothesis.kind, 'hypothesis');
    assert.match(hypothesis.claim, /owner/i);
    assert.equal(hypothesis.observations.length, 2);
    assert.deepEqual(hypothesis.sourceIds, ['F103', 'F211']);
    assert.deepEqual(hypothesis.affectedPath, ['api', 'dto', 'frontend', 'service']);
    assert.equal(hypothesis.confidence, analysis.clusters[0]!.score);
    assert.equal(hypothesis.status, 'unverified');
    assert.ok(analysis.observations.every((observation) => !('status' in observation)));
  });

  it('rejects dangling cluster references, invalid confidence, and unsupported artifact versions', () => {
    const analysis = analyzeObservations([{ id: 'F1', title: 'A finding', files: ['src/a.ts'] }]);
    const cluster = analysis.clusters[0]!;
    assert.throws(() => createHypotheses(analysis.observations, [{
      ...cluster,
      observationIds: ['defect:v1:observation.missing'],
    }]), /unknown observation/);

    const result = createHypotheses(analysis.observations, analysis.clusters);
    assert.throws(() => validateHypothesisSet({ ...result, schemaVersion: 2 }), /schemaVersion 1/);
    assert.throws(() => validateHypothesisSet({
      ...result,
      hypotheses: [{ ...result.hypotheses[0], confidence: 1.1 }],
    }), /invalid hypothesis/);
  });
});
