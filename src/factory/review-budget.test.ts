import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountReviewUsage,
  calculateBudgetCoverage,
  chooseNextReviewAction,
  createReviewBudget,
  remainingReviewBudget,
  type ReviewBudgetAction,
} from './review-budget.js';

const action = (id: string, risk: number, cost: ReviewBudgetAction['estimatedCost'], covers: string[] = []): ReviewBudgetAction => ({
  id,
  unit: id,
  riskScore: risk,
  expectedRiskReduction: risk,
  estimatedCost: cost,
  covers,
});

describe('factory review budget manager', () => {
  it('tracks remaining request, token, money, strong-model, and time allowances', () => {
    const budget = createReviewBudget({ limits: {
      requests: 5, tokens: 5000, usd: 2, strong_model_requests: 1, wall_clock_minutes: 30,
    } });
    const next = accountReviewUsage(budget, { id: 'r1' }, {
      requests: 1, tokens: 700, usd: 0.25, strong_model_requests: 1, wall_clock_minutes: 8,
    });
    assert.deepEqual(remainingReviewBudget(next), {
      requests: 4, tokens: 4300, usd: 1.75, strong_model_requests: 0, wall_clock_minutes: 22,
    });
  });

  it('chooses the affordable review with best risk reduction per remaining resource', () => {
    const budget = createReviewBudget({ limits: { requests: 2, usd: 2, wall_clock_minutes: 20 } });
    const actions = [
      action('expensive', 90, { requests: 1, usd: 2, wall_clock_minutes: 18 }),
      action('valuable', 45, { requests: 1, usd: 0.5, wall_clock_minutes: 5 }),
      action('too-many-requests', 100, { requests: 3 }),
    ];
    const decision = chooseNextReviewAction(budget, actions);
    assert.equal(decision.status, 'schedule');
    assert.equal(decision.nextAction?.id, 'valuable');
    assert.match(decision.reason, /risk reduction per remaining budget/);
  });

  it('accounts actual overruns without hiding the spend', () => {
    const budget = createReviewBudget({ limits: { requests: 1, usd: 0.5 } });
    const overrun = accountReviewUsage(budget, { id: 'r1' }, { requests: 2, usd: 0.75 });
    assert.deepEqual(overrun.spent, {
      requests: 2, tokens: 0, usd: 0.75, strong_model_requests: 0, wall_clock_minutes: 0,
    });
    assert.equal(remainingReviewBudget(overrun).requests, 0);
    assert.equal(remainingReviewBudget(overrun).usd, 0);
  });

  it('tracks risk-weighted coverage only for completed actions', () => {
    const inventory = [
      { id: 'auth', riskWeight: 80, riskScore: 95 },
      { id: 'docs', riskWeight: 20, riskScore: 10 },
    ];
    const budget = createReviewBudget({ minimumRiskCoverage: 0.8 });
    const failed = accountReviewUsage(budget, { id: 'failed', covers: ['auth'] }, { requests: 1 }, false);
    assert.equal(calculateBudgetCoverage(failed, inventory).percent, 0);
    const done = accountReviewUsage(failed, { id: 'done', covers: ['auth'] }, { requests: 1 });
    assert.deepEqual(calculateBudgetCoverage(done, inventory), {
      inspectedRisk: 80, totalRisk: 100, percent: 0.8, residualRisk: 20, targetMet: true,
    });
  });

  it('escalates instead of silently dropping high-risk work when a cap blocks it', () => {
    const budget = createReviewBudget({ limits: { strong_model_requests: 0, requests: 4 } });
    const inventory = [{ id: 'auth-boundary', riskWeight: 90, riskScore: 99 }];
    const decision = chooseNextReviewAction(budget, [
      action('security-review', 99, { requests: 1, strong_model_requests: 1 }, ['auth-boundary']),
    ], inventory);
    assert.equal(decision.status, 'escalate');
    assert.equal(decision.escalation?.kind, 'human-review');
    assert.deepEqual(decision.escalation?.blockedActionIds, ['security-review']);
    assert.match(decision.escalation?.reason ?? '', /high-risk/);
  });

  it('requests more budget when the risk-coverage objective cannot be met', () => {
    const budget = createReviewBudget({ limits: { requests: 0 }, minimumRiskCoverage: 0.9 });
    const inventory = [{ id: 'feature', riskWeight: 10, riskScore: 40 }];
    const decision = chooseNextReviewAction(budget, [action('review', 40, { requests: 1 }, ['feature'])], inventory);
    assert.equal(decision.status, 'escalate');
    assert.equal(decision.escalation?.kind, 'increase-budget');
    assert.equal(decision.coverage.residualRisk, 10);
  });

  it('rejects invalid limits, usage, and duplicate accounting', () => {
    assert.throws(() => createReviewBudget({ limits: { usd: -1 } }), /non-negative/);
    assert.throws(() => createReviewBudget({ minimumRiskCoverage: 1.2 }), /from 0 to 1/);
    const budget = createReviewBudget();
    const once = accountReviewUsage(budget, { id: 'review' }, { requests: 1 });
    assert.throws(() => accountReviewUsage(once, { id: 'review' }, { requests: 1 }), /already accounted/);
    assert.throws(() => accountReviewUsage(budget, { id: 'review' }, { tokens: Number.NaN }), /finite/);
  });
});
