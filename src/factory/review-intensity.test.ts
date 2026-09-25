import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assignReviewIntensity } from './review-intensity.js';

describe('dynamic review intensity', () => {
  it('keeps low-risk work shallow and explains the decision', () => {
    const decision = assignReviewIntensity({ riskScore: 12 });
    assert.equal(decision.tier, 'deterministic');
    assert.deepEqual(decision.requiredStages, ['deterministic']);
    assert.match(decision.reasons.join(' '), /at most 20.*deterministic checks are sufficient/);
    assert.ok(decision.policy.some((band) => band.tier === 'independent' && band.minimumScore === 90));
  });

  it('escalates after newly observed findings, contradictions, contract changes, and defects', () => {
    const finding = assignReviewIntensity({ riskScore: 18, triggers: { 'deterministic-finding': 1 } });
    assert.equal(finding.tier, 'local');
    assert.ok(finding.requiredStages.includes('local'));
    assert.match(finding.reasons.join(' '), /new deterministic finding/);

    const contradiction = assignReviewIntensity({ riskScore: 45, triggers: { contradiction: 1 } });
    assert.equal(contradiction.tier, 'subsystem');
    assert.ok(contradiction.requiredStages.includes('subsystem'));

    const contract = assignReviewIntensity({ riskScore: 59, triggers: { 'changed-contract': 1 } });
    assert.equal(contract.tier, 'specialist');
    assert.ok(contract.requiredStages.includes('security'));

    const defect = assignReviewIntensity({ riskScore: 70, triggers: { 'verified-defect': 1 } });
    assert.equal(defect.tier, 'independent');
    assert.ok(defect.requiredStages.includes('e2e'));
    assert.ok(defect.requiredStages.includes('independent'));
  });
});
