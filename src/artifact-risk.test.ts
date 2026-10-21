import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewPlan } from './factory/review-router.js';
import { artifactRiskSignals } from './artifact-risk.js';

const evidence = (paths: string[], lines: number | null = 1) => ({ policy: 'lean' as const, unit: 'test', title: 'ordinary', spec: 'auth token concurrency API speculative words', changedFiles: paths, diffLines: lines, workExitCode: 0, checksPassed: true, artifactSignals: artifactRiskSignals(paths, true) });
test('lean scoring uses artifacts and does not promote prompt keywords', () => {
  const plan = createReviewPlan(evidence(['docs/example.md']), [{ name: 'agent', cmd: 'review' }]);
  assert.equal(plan.risk, 'low'); assert.equal(plan.reviewRequired, false); assert.equal(plan.budget.usedAgentReviewers, 0);
});
test('protected artifacts stay high despite supplied low score and false-positive history', () => {
  const plan = createReviewPlan({ ...evidence(['src/auth.ts']), riskScore: 0, priorFalsePositives: 100 }, [{ name: 'security', cmd: 'review' }]);
  assert.equal(plan.risk, 'high'); assert.equal(plan.reviewRequired, true); assert.equal(plan.budget.usedAgentReviewers, 1);
});
test('medium and high select at most one appropriately routed agent', () => {
  const configured = [{ name: 'local', cmd: 'review' }, { name: 'security', cmd: 'review' }, { name: 'independent', cmd: 'review' }];
  const medium = createReviewPlan(evidence(['src/contracts.ts']), configured);
  assert.equal(medium.risk, 'medium'); assert.equal(medium.budget.usedAgentReviewers, 1);
  const high = createReviewPlan(evidence(['src/auth.ts']), configured);
  assert.deepEqual(high.reviewers.filter(item => item.selected).map(item => item.name), ['security']);
});
test('missing diff and missing acceptance evidence never become a low-risk exemption', () => {
  assert.equal(createReviewPlan(evidence([], null), []).risk, 'high');
  const unknown = { ...evidence(['docs/example.md']), checksPassed: false, artifactSignals: artifactRiskSignals(['docs/example.md'], false) };
  assert.equal(createReviewPlan(unknown, []).reviewRequired, true);
});

test('trusted security symbols preserve the high override in a neutral file', () => {
  const plan = createReviewPlan({ ...evidence(['src/helper.ts']), graphSignals: { securitySensitive: true }, riskScore: 0 }, [{ name: 'security', cmd: 'review' }]);
  assert.equal(plan.risk, 'high'); assert.equal(plan.intensity.score, plan.riskScore);
});
