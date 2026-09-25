import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { make } from '../test-helpers.js';
import type { Task } from '../types.js';
import { summarizeFactoryTelemetry, type FactoryAttemptHistory } from './telemetry.js';

describe('factory telemetry', () => {
  it('aggregates DAG outcomes and structured attempt evidence without changing the run', () => {
    const fixture = make(['first', 'second']);
    const run = fixture.run;
    const first = fixture.first as Task;
    const second = fixture.second as Task;
    first.status = 'completed';
    first.attempts = 2;
    first.mergeRetries = 1;
    first.repairs = 1;
    first.startedAt = '2025-01-01T00:00:00.000Z';
    first.finishedAt = '2025-01-01T00:00:03.000Z';
    second.status = 'failed';
    second.attempts = 1;

    const attempts: FactoryAttemptHistory[] = [
      {
        taskId: first.id,
        attempt: 1,
        startedAt: '2025-01-01T00:00:00.000Z',
        finishedAt: '2025-01-01T00:00:01.000Z',
        fallback: true,
        strongModelEscalation: true,
        reviewCostProxy: 12,
        rawFindings: 4,
        verifiedFindings: 1,
        rejectedFindings: 1,
        hypothesisCount: 2,
        rootCauseCount: 1,
        reviewerOutcomes: [
          { reviewer: 'contract', verdict: 'pass' },
          { reviewer: 'security', verdict: 'fail' },
        ],
      },
      {
        taskId: first.id,
        attempt: 2,
        startedAt: '2025-01-01T00:00:01.000Z',
        finishedAt: '2025-01-01T00:00:03.000Z',
        success: true,
        reviewCostProxy: 8,
        rawFindings: 0,
        verifiedFindings: 0,
        rejectedFindings: 0,
        hypothesisCount: 0,
        rootCauseCount: 0,
      },
    ];
    const before = JSON.stringify(run);
    const report = summarizeFactoryTelemetry(run, {
      requests: 10,
      attempts,
      findings: [
        { id: 'f1', verified: true, novel: true, rootCauseId: 'rc1', remediated: true },
        { id: 'f2', verified: false, duplicate: true },
      ],
      human: [
        { kind: 'review-requested' },
        { kind: 'verdict-reversed' },
        { kind: 'manual-repair' },
      ],
      certifications: [
        { requestedAt: '2025-01-01T00:00:00.000Z', certifiedAt: '2025-01-01T00:00:05.000Z' },
      ],
      riskCoverage: [{ totalRisk: 10, inspectedRisk: 7 }],
    });

    assert.equal(report.counts.taskSuccesses, 1);
    assert.equal(report.counts.retries, 1);
    assert.equal(report.counts.mergeConflicts, 1);
    assert.equal(report.counts.repairs, 1);
    assert.equal(report.counts.agentFallbacks, 1);
    assert.equal(report.counts.verifiedFindings, 1);
    assert.equal(report.counts.falsePositives, 1);
    assert.equal(report.counts.reviewerPasses, 1);
    assert.equal(report.counts.reviewerRejections, 1);
    assert.equal(report.counts.rootCauses, 1);
    assert.equal(report.counts.humanReviewsRequested, 1);
    assert.equal(report.counts.humanVerdictReversals, 1);
    assert.equal(report.counts.manualRepairInterventions, 1);
    assert.equal(report.rates.verifiedNovelFindingsPer1000Requests, 100);
    assert.equal(report.rates.falsePositiveRate, 0.5);
    assert.equal(report.rates.duplicateFindingRate, 0.5);
    assert.equal(report.rates.strongModelEscalationRate, 0.5);
    assert.equal(report.rates.hypothesisCompressionRatio, 2);
    assert.equal(report.rates.rootCauseCompressionRatio, 2);
    assert.equal(report.rates.riskCoverage, 0.7);
    assert.equal(report.cost.reviewCostProxy, 20);
    assert.equal(report.cost.perVerifiedDefect, 20);
    assert.equal(report.latencyMs.averageAttempt, 1500);
    assert.equal(report.latencyMs.averageTimeToCertification, 5000);
    assert.equal(JSON.stringify(run), before);
  });

  it('returns null for rates whose evidence denominator is unavailable', () => {
    const { run } = make([]);
    const report = summarizeFactoryTelemetry(run);
    assert.equal(report.rates.taskSuccessRate, null);
    assert.equal(report.rates.falsePositiveRate, null);
    assert.equal(report.rates.strongModelEscalationRate, null);
    assert.equal(report.cost.reviewCostProxy, null);
    assert.equal(report.latencyMs.averageTimeToCertification, null);
  });
});
