import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rankReviewActionsByInformationGain, type InformationGainAction, type InformationGainObservation } from './information-gain.js';

const action = (id: string, unit: string, reviewType: string, risk: number, gain: number, cost: number): InformationGainAction => ({
  id, unit, reviewType, riskScore: 50, expectedRiskReduction: risk, expectedInformationGain: gain,
  estimatedCost: { requests: cost },
});

const evidence = (value: string) => {
  const sha256 = createHash('sha256').update(value).digest('hex');
  return { id: `evidence:v1:${sha256}` as `evidence:v1:${string}`, kind: 'review' as const, uri: `reviews/${value}.json`, sha256 };
};

const observation = (actionId: string, unit: string, reviewType: string, observedRiskReduction: number, observedInformationGain: number): InformationGainObservation => ({
  actionId, unit, reviewType, expectedRiskReduction: 10, expectedInformationGain: 0.8,
  observedRiskReduction, observedInformationGain, actualCost: { requests: 1 }, evidence: [evidence(actionId)],
});

describe('information-gain scheduler', () => {
  it('ranks by expected risk reduction and information gain per estimated cost', () => {
    const result = rankReviewActionsByInformationGain([
      action('large-but-costly', 'auth', 'security', 30, 0.8, 6),
      action('best-value', 'api', 'contract', 12, 0.9, 2),
      action('low-yield', 'docs', 'local', 10, 0.2, 1),
    ]);
    assert.deepEqual(result.actions.map((item) => item.action.id), ['best-value', 'large-but-costly', 'low-yield']);
    assert.equal(result.actions[0]?.priority, 5.4);
    assert.equal(result.schemaVersion, 1);
  });

  it('reduces priority of repeated inspections with little recorded yield', () => {
    const actions = [
      action('auth-repeat-2', 'auth', 'security', 10, 0.8, 1),
      action('payments-review', 'payments', 'security', 6, 0.8, 1),
    ];
    const history = [
      observation('auth-repeat-1', 'auth', 'security', 1, 0.1),
      observation('auth-repeat-0', 'auth', 'security', 0, 0),
    ];
    const ranking = rankReviewActionsByInformationGain(actions, history);
    assert.equal(ranking.actions[0]?.action.id, 'payments-review');
    const auth = ranking.actions.find((item) => item.action.id === 'auth-repeat-2')!;
    assert.equal(auth.comparableObservations, 2);
    assert.equal(auth.empiricalYield, 0.00625);
    assert.equal(auth.priority, 0.05);
  });

  it('uses stable action IDs to break equal-value ties independent of input order', () => {
    const a = action('review-a', 'one', 'local', 5, 0.5, 1);
    const b = action('review-b', 'two', 'local', 5, 0.5, 1);
    const first = rankReviewActionsByInformationGain([b, a]);
    const second = rankReviewActionsByInformationGain([a, b]);
    assert.deepEqual(first.actions.map((item) => item.action.id), ['review-a', 'review-b']);
    assert.deepEqual(first.actions.map((item) => item.action.id), second.actions.map((item) => item.action.id));
  });

  it('requires valid evidence for historical outcomes and validates estimates', () => {
    assert.throws(() => rankReviewActionsByInformationGain([], [
      { ...observation('seen', 'unit', 'local', 0, 0), evidence: [] },
    ]), /requires valid recorded evidence/);
    assert.throws(() => rankReviewActionsByInformationGain([
      { ...action('bad-gain', 'unit', 'local', 1, 1.5, 1) },
    ]), /expectedInformationGain.*from 0 to 1/);
  });
});
