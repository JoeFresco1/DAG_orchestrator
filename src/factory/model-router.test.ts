import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calibrateReviewers } from './reviewer-calibration.js';
import { routeModel, type ModelRouteCandidate } from './model-router.js';

const candidates: ModelRouteCandidate[] = [
  { harness: 'opencode', model: 'fast', tier: 'cheap', estimatedCost: 0.01 },
  { harness: 'claude', model: 'balanced', tier: 'medium', estimatedCost: 0.1 },
  { harness: 'codex', model: 'strong', tier: 'strong', estimatedCost: 0.5 },
];

describe('factory model routing', () => {
  it('uses the cheapest capable stage for a low-risk task and records why', () => {
    const route = routeModel({ taskTitle: 'Format a helper', riskScore: 10 }, candidates);
    assert.equal(route.candidate?.model, 'fast');
    assert.match(route.reason, /lowest-cost sufficient cheap candidate/);
    assert.equal(route.reviewType, 'implementation');
  });

  it('escalates only when risk, uncertainty, or an unresolved prior stage requires it', () => {
    assert.equal(routeModel({ taskTitle: 'review', riskScore: 70 }, candidates).candidate?.model, 'balanced');
    assert.equal(routeModel({ taskTitle: 'review', riskScore: 20, uncertainty: 85 }, candidates).candidate?.model, 'strong');
    assert.equal(routeModel({ taskTitle: 'review', riskScore: 20, unresolved: true }, candidates).candidate?.model, 'strong');
  });

  it('uses review-type calibration and avoids a calibrated weak cheap model', () => {
    const calibration = calibrateReviewers([
      { reviewer: 'reviewer', model: 'fast', reviewType: 'security', findings: [
        { id: 'v', category: 'auth', verdict: 'verified' },
        { id: 'r1', category: 'auth', verdict: 'rejected' },
        { id: 'r2', category: 'auth', verdict: 'rejected' },
      ] },
      { reviewer: 'reviewer', model: 'balanced', reviewType: 'security', findings: [
        { id: 'v2', category: 'auth', verdict: 'verified' },
        { id: 'v3', category: 'auth', verdict: 'verified' },
        { id: 'v4', category: 'auth', verdict: 'verified' },
      ] },
    ]);
    const route = routeModel({ taskTitle: 'Check credentials', riskScore: 70 }, candidates, calibration);
    assert.equal(route.candidate?.model, 'balanced');
    assert.equal(route.calibration.precision, 1);
    assert.equal(route.calibration.sampleSize, 3);
  });

  it('preserves explicit model selection and does not repeat resolved work at a stronger stage', () => {
    const pinned = routeModel({ taskTitle: 'security review', override: { model: 'fast' } }, candidates);
    assert.equal(pinned.candidate?.model, 'fast');
    assert.match(pinned.reason, /explicit model override/);
    const resolved = routeModel({ taskTitle: 'routine review', riskScore: 20, deterministicResolved: true }, candidates);
    assert.equal(resolved.tier, 'deterministic');
    assert.equal(resolved.candidate, null);
  });

  it('escalates to a human when risk is unresolved and the budget cannot fund a capable model', () => {
    const route = routeModel({ taskTitle: 'auth review', remainingBudgetUsd: 0.05 }, candidates);
    assert.equal(route.tier, 'human');
    assert.match(route.reason, /human escalation/);
  });
});
