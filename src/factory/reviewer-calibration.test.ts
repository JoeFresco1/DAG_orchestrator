import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calibrateReviewers, type ReviewerCalibrationReview } from './reviewer-calibration.js';

describe('reviewer calibration', () => {
  it('estimates precision and verified unique discovery by category from adjudicated history', () => {
    const history: ReviewerCalibrationReview[] = [
      {
        reviewId: 'review-1', reviewer: 'Muse', model: 'local-v2', reviewType: 'security',
        requests: 2, tokens: 1000, cost: 0.2, latencyMs: 500, humanOverride: true, downstreamDefectsPrevented: 1,
        findings: [
          { id: 'f1', category: 'auth', verdict: 'verified', proposedSeverity: 'high', verifiedSeverity: 'high' },
          { id: 'f2', category: 'auth', verdict: 'rejected' },
          { id: 'f3', category: 'auth', verdict: 'unverified' },
          { id: 'f4', category: 'auth', verdict: 'verified', duplicate: true, proposedSeverity: 'low', verifiedSeverity: 'high' },
          { id: 'f5', category: 'payments', verdict: 'unverified' },
        ],
      },
      {
        reviewId: 'review-2', reviewer: 'Muse', model: 'local-v2', reviewType: 'security',
        requests: 1, tokens: 500, cost: 0.1, latencyMs: 300, downstreamDefectsPrevented: 0,
        findings: [{ id: 'f6', category: 'auth', verdict: 'verified', proposedSeverity: 'medium', verifiedSeverity: 'high' }],
      },
    ];

    const report = calibrateReviewers(history);
    const auth = report.buckets.find((bucket) => bucket.category === 'auth')!;
    const payments = report.buckets.find((bucket) => bucket.category === 'payments')!;
    assert.equal(auth.findingsProposed, 5);
    assert.equal(auth.findingsVerified, 3);
    assert.equal(auth.findingsRejected, 1);
    assert.equal(auth.findingsUnverified, 1);
    assert.equal(auth.precisionSampleSize, 4);
    assert.equal(auth.precision, 0.75); // inconclusive f3 is not a negative outcome
    assert.equal(auth.uniqueFindingsDiscovered, 2);
    assert.equal(auth.duplicateRate, 0.2);
    assert.equal(auth.humanOverrides, 1);
    assert.equal(auth.humanOverrideRate, 0.5);
    assert.equal(auth.severityComparisons, 3);
    assert.equal(auth.severityCalibration, 1 / 3);
    assert.equal(auth.reviews, 2);
    assert.equal(auth.averageRequests, 1.5);
    assert.equal(auth.averageTokens, 750);
    assert.ok(Math.abs(auth.averageCost! - 0.15) < 1e-12);
    assert.equal(auth.averageLatencyMs, 400);
    assert.equal(auth.downstreamDefectsPrevented, 1);
    assert.equal(payments.precision, null);
    assert.equal(payments.precisionSampleSize, 0);
    assert.equal(payments.uniqueFindingsDiscovered, 0);
    assert.equal(payments.severityCalibration, null);
  });

  it('keeps reviewer, model, review type, and category as separate calibration populations', () => {
    const report = calibrateReviewers([
      { reviewer: 'R1', model: 'M1', reviewType: 'local', findings: [{ id: '1', category: 'logic', verdict: 'verified' }] },
      { reviewer: 'R1', model: 'M2', reviewType: 'local', findings: [{ id: '2', category: 'logic', verdict: 'rejected' }] },
      { reviewer: 'R1', model: 'M1', reviewType: 'dependency', findings: [{ id: '3', category: 'logic', verdict: 'rejected' }] },
    ]);
    assert.equal(report.buckets.length, 3);
    assert.deepEqual(report.buckets.map((bucket) => [bucket.model, bucket.reviewType, bucket.precision]), [
      ['M1', 'dependency', 0], ['M1', 'local', 1], ['M2', 'local', 0],
    ]);
  });

  it('rejects invalid measurements instead of corrupting historical estimates', () => {
    assert.throws(() => calibrateReviewers([{
      reviewer: 'R', model: 'M', reviewType: 'local', requests: -1,
      findings: [{ id: 'f', category: 'logic', verdict: 'verified' }],
    }]), /finite non-negative/);
  });
});
