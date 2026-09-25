import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewPlan, type ReviewRouterEvidence } from './review-router.js';
import type { Reviewer } from '../review-policy.js';

const base: ReviewRouterEvidence = {
  unit: 'task-1', title: 'format a label', changedFiles: ['src/label.ts'],
  diffLines: 12, workExitCode: 0,
};

describe('adaptive review router', () => {
  it('reproduces a machine-readable plan and skips redundant agents after deterministic validation', () => {
    const reviewers: Reviewer[] = [
      { name: 'typecheck', cmd: 'pnpm typecheck', verdict: 'exit-code' },
      { name: 'review', cmd: 'agent' },
      { name: 'architecture', cmd: 'agent-2' },
    ];
    const first = createReviewPlan(base, reviewers);
    const second = createReviewPlan(base, reviewers);
    assert.deepEqual(first, second);
    assert.equal(first.deterministicSufficient, true);
    assert.equal(first.reviewers[0]?.selected, true);
    assert.equal(first.reviewers[1]?.selected, false);
    assert.match(first.reviewers[1]?.reason ?? '', /deterministic validation is sufficient/);
    assert.ok(first.stages.every((stage) => stage.reason.length > 0));
  });

  it('escalates security-sensitive changes and applies an explicit agent review budget', () => {
    const reviewers: Reviewer[] = [
      { name: 'security', cmd: 'security-review' },
      { name: 'dependency', cmd: 'dependency-review' },
      { name: 'integration', cmd: 'integration-review' },
      { name: 'independent', cmd: 'verify' },
      { name: 'local', cmd: 'local-review' },
    ];
    const plan = createReviewPlan({
      ...base,
      title: 'authentication token contract',
      changedFiles: ['src/auth/token-service.ts', 'src/api/token.ts'],
      diffLines: 700,
      testCoverage: 0.2,
      maxAgentReviewers: 2,
    }, reviewers);
    assert.equal(plan.risk, 'critical');
    assert.equal(plan.depth, 'escalated');
    assert.equal(plan.modelClass, 'strong');
    assert.equal(plan.budget.usedAgentReviewers, 2);
    assert.ok(plan.riskReasons.some((reason) => /security-sensitive/.test(reason)));
    assert.ok(plan.reviewers.some((reviewer) => !reviewer.selected && /budget/.test(reviewer.reason)));
  });

  it('reserves on-reject triage without treating it as an always-on review', () => {
    const plan = createReviewPlan(base, [
      { name: 'review', cmd: 'agent' },
      { name: 'triage', cmd: 'triage-agent', when: 'on-reject' },
    ]);
    const triage = plan.reviewers.find((reviewer) => reviewer.name === 'triage');
    assert.equal(triage?.selected, true);
    assert.match(triage?.reason ?? '', /if an earlier reviewer rejects/);
  });
});
