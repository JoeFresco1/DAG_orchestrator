import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConfidenceFrontier,
  type ConfidenceFrontierAction,
  type ConfidenceFrontierClaim,
  type ConfidenceFrontierObservation,
} from './confidence-frontier.js';

const claim = (id: string, releaseImpact: number, confidence: number, status: ConfidenceFrontierClaim['status'] = 'unresolved'): ConfidenceFrontierClaim => ({
  id, claim: `Claim ${id}`, status, releaseImpact, confidence,
});

const action = (id: string, unit: string, reviewType: string, claimIds: string[], estimatedEffort: number, expectedInformationGain: number): ConfidenceFrontierAction => ({
  id, unit, reviewType, claimIds, estimatedEffort, expectedInformationGain,
});

const observation = (actionId: string, unit: string, reviewType: string, effort: number, observedRiskReduction: number): ConfidenceFrontierObservation => ({
  actionId, unit, reviewType, effort, observedRiskReduction,
});

describe('confidence frontier', () => {
  it('surfaces unresolved claims by remaining release impact and ignores settled claims', () => {
    const result = buildConfidenceFrontier([
      claim('low-impact', 0.2, 0.5),
      claim('high-impact', 0.9, 0.2),
      claim('settled', 1, 0, 'resolved'),
      claim('no-uncertainty', 1, 1),
    ]);

    assert.deepEqual(result.unresolvedClaims.map(({ claim: item, potentialReleaseImpact }) => [item.id, potentialReleaseImpact]), [
      ['high-impact', 0.72], ['low-impact', 0.1],
    ]);
    assert.equal(result.residualRisk, 1);
    assert.deepEqual(result.effortCurve, [{
      cumulativeEffort: 0, residualRisk: 1, riskReduction: 0, marginalRiskReduction: null, actionId: null,
    }]);
  });

  it('prioritizes material unresolved claims over repeated low-yield review', () => {
    const result = buildConfidenceFrontier(
      [claim('release-blocker', 0.9, 0.1), claim('minor', 0.1, 0.2)],
      [
        action('repeat-security', 'auth', 'security', ['minor'], 1, 0.9),
        action('verify-contract', 'release', 'contract', ['release-blocker'], 2, 0.8),
      ],
      [
        observation('auth-1', 'auth', 'security', 1, 0),
        observation('auth-2', 'auth', 'security', 1, 0),
      ],
    );

    assert.equal(result.actions[0]?.action.id, 'verify-contract');
    const repeat = result.actions.find(({ action: item }) => item.id === 'repeat-security')!;
    assert.equal(repeat.comparableObservations, 2);
    assert.equal(repeat.empiricalYield, 0);
    assert.equal(repeat.priority, 0);
    assert.deepEqual(result.actions[0]?.unresolvedClaimIds, ['release-blocker']);
  });

  it('shows diminishing observed returns as effort accumulates', () => {
    const result = buildConfidenceFrontier([], [], [
      observation('first', 'unit', 'local', 1, 0.6),
      observation('second', 'unit', 'local', 3, 0.25),
      observation('third', 'unit', 'local', 10, 0.1),
    ]);

    assert.deepEqual(result.effortCurve.map(({ cumulativeEffort, residualRisk, marginalRiskReduction }) => [
      cumulativeEffort, residualRisk, marginalRiskReduction,
    ]), [
      [0, 1, null], [1, 0.4, 0.6], [4, 0.15, 0.083], [14, 0.05, 0.01],
    ]);
    assert.equal(result.residualRisk, 0.05);
  });

  it('validates claim links, cost, and confidence values before ranking', () => {
    assert.throws(() => buildConfidenceFrontier([claim('c', 0.5, 0.5)], [
      action('bad-link', 'unit', 'local', ['missing'], 1, 0.5),
    ]), /must reference known claims/);
    assert.throws(() => buildConfidenceFrontier([claim('c', 0.5, 1.2)]), /confidence for c/);
    assert.throws(() => buildConfidenceFrontier([], [], [observation('bad-effort', 'unit', 'local', -1, 0)]), /effort for bad-effort/);
  });
});
