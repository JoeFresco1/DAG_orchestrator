import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calibrateConfidence, confidenceBand, type ConfidenceObservation } from './confidence.js';

describe('calibrated confidence', () => {
  it('uses historical precision in the matching confidence band and context', () => {
    const history: ConfidenceObservation[] = [
      ...Array.from({ length: 742 }, (_, index) => ({
        id: `verified-${index}`, nominalConfidence: 0.95, outcome: 'verified' as const,
        context: { model: 'model-a', reviewerRole: 'security', language: 'typescript' },
      })),
      ...Array.from({ length: 258 }, (_, index) => ({
        id: `rejected-${index}`, nominalConfidence: 0.91, outcome: 'rejected' as const,
        context: { model: 'model-a', reviewerRole: 'security', language: 'typescript' },
      })),
      { id: 'other-model', nominalConfidence: 0.95, outcome: 'rejected', context: { model: 'model-b' } },
      { id: 'unresolved', nominalConfidence: 0.95, outcome: 'unresolved', context: { model: 'model-a', reviewerRole: 'security', language: 'typescript' } },
    ];

    const result = calibrateConfidence(history, {
      nominalConfidence: 0.99,
      context: { model: 'model-a', reviewerRole: 'security', language: 'typescript' },
    });
    assert.equal(result.nominalConfidence, 0.99);
    assert.equal(result.nominalBand, 'high');
    assert.equal(result.calibratedConfidence, 0.742);
    assert.deepEqual(result.historical, {
      verified: 742, rejected: 258, unresolved: 1, sampleSize: 1000,
      contextDimensions: ['model', 'reviewerRole', 'language'],
    });
    assert.ok(result.interval95.lower < result.calibratedConfidence);
    assert.ok(result.interval95.upper > result.calibratedConfidence);
    assert.ok(result.uncertainty > 0 && result.uncertainty < 0.1);
    assert.equal(result.certified, false);
  });

  it('does not treat a bare model score as truth and reports maximum uncertainty', () => {
    const result = calibrateConfidence([], { nominalConfidence: 0.999 });
    assert.equal(result.calibratedConfidence, 0.5);
    assert.deepEqual(result.interval95, { lower: 0, upper: 1 });
    assert.equal(result.uncertainty, 1);
    assert.equal(result.certified, false);
  });

  it('raises or lowers the estimate with distinct corroborating and contradictory evidence', () => {
    const result = calibrateConfidence([], {
      nominalConfidence: 0.99,
      evidence: [
        { id: 'test-pass', stance: 'corroborates' },
        { id: 'source-check', stance: 'corroborates' },
        { id: 'guard', stance: 'contradicts' },
        { id: 'guard', stance: 'corroborates' }, // same source cannot vote twice
      ],
    });
    assert.equal(result.calibratedConfidence, 0.625);
    assert.deepEqual(result.evidence, { corroborating: 2, contradictory: 1, duplicateIdsIgnored: 1 });
    assert.equal(result.historical.sampleSize, 0);
    assert.equal(result.certified, false);
  });

  it('keeps unresolved outcomes out of precision and accepts narrower calibration dimensions', () => {
    const result = calibrateConfidence([
      { id: 'u', nominalConfidence: 0.65, outcome: 'unresolved', context: { category: 'bug' } },
      { id: 'v', nominalConfidence: 0.65, outcome: 'verified', context: { category: 'bug', repository: 'repo-a' } },
      { id: 'r', nominalConfidence: 0.65, outcome: 'rejected', context: { category: 'bug', repository: 'repo-b' } },
      { id: 'different-band', nominalConfidence: 0.9, outcome: 'rejected', context: { category: 'bug' } },
    ], { nominalConfidence: 0.6, context: { category: 'bug' } });
    assert.equal(result.nominalBand, 'medium');
    assert.equal(result.historical.verified, 1);
    assert.equal(result.historical.rejected, 1);
    assert.equal(result.historical.unresolved, 1);
    assert.equal(result.calibratedConfidence, 0.5);
  });

  it('validates scores, context, history, and evidence', () => {
    assert.equal(confidenceBand(0.8), 'high');
    assert.equal(confidenceBand(0.5), 'medium');
    assert.throws(() => calibrateConfidence([], { nominalConfidence: 1.1 }), /from 0 to 1/);
    assert.throws(() => calibrateConfidence([], { nominalConfidence: 0.5, context: { model: ' ' } }), /non-empty string/);
    assert.throws(() => calibrateConfidence([{ id: 'x', nominalConfidence: Number.NaN, outcome: 'verified' }], { nominalConfidence: 0.5 }), /finite number/);
    assert.throws(() => calibrateConfidence([], { nominalConfidence: 0.5, evidence: [{ id: '', stance: 'corroborates' }] }), /invalid confidence evidence/);
  });
});
