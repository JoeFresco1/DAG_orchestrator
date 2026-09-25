import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  evaluateAndSaveConvergence,
  evaluateConvergence,
  loadConvergenceDecision,
  type ConvergenceAssessment,
  type ConvergencePolicy,
} from './convergence.js';
import { buildConfidenceFrontier } from './confidence-frontier.js';
import { createCertification, type CertificationInput } from './certification.js';
import { accountReviewUsage, createReviewBudget } from './review-budget.js';
import type { FactoryEvidenceRef } from './contracts.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const ref = (value: string, kind: FactoryEvidenceRef['kind'] = 'external'): FactoryEvidenceRef => {
  const sha256 = hash(value);
  return { id: `evidence:v1:${sha256}`, kind, uri: `evidence/${value}.json`, sha256 };
};
const certEvidence = (value: string) => ({ uri: `checks/${value}.log`, sha256: hash(value) });

function certificationInput(): CertificationInput {
  return {
    runId: 'run_convergence',
    commit: 'a'.repeat(40),
    specificationGraphHash: hash('spec-graph'),
    architectureGraphHash: hash('architecture-graph'),
    testStateHash: hash('test-state'),
    deterministicChecks: [{ id: 'typecheck', status: 'pass', evidence: [certEvidence('typecheck')] }],
    reviewEvidence: [{ id: 'review:security', reviewer: 'security', verdict: 'pass', evidence: [certEvidence('security-review')] }],
    acceptedRisks: [],
    residualFindings: [],
    criticalFlowCoverage: 1,
    weightedRiskCoverage: 0.96,
  };
}

function frontier(residualRisk = 0.04, confidence = 0.9) {
  const result = buildConfidenceFrontier([{
    id: 'claim:release',
    claim: 'Release behavior is understood',
    status: 'unresolved',
    releaseImpact: 0.4,
    confidence,
  }], [], [], residualRisk);
  return {
    schemaVersion: 1 as const,
    initialResidualRisk: result.initialResidualRisk,
    residualRisk: result.residualRisk,
    unresolvedClaims: result.unresolvedClaims,
    effortCurve: result.effortCurve,
    evidence: [ref('frontier', 'review')],
  };
}

function reviewUnit(id: string, completedAt: string, newFindings: ConvergenceAssessment['reviewUnits'][number]['newFindings'] = []) {
  return {
    id,
    completedAt,
    status: 'completed' as const,
    meaningful: true,
    requestCount: 400,
    evidence: [ref(`unit-${id}`, 'review')],
    newFindings,
  };
}

function assessment(overrides: Partial<ConvergenceAssessment> = {}): ConvergenceAssessment {
  const certification = createCertification(certificationInput());
  return {
    runId: 'run_convergence',
    certification,
    currentCertificationState: {
      commit: certification.commit,
      specificationGraphHash: certification.specificationGraphHash,
      architectureGraphHash: certification.architectureGraphHash,
      testStateHash: certification.testStateHash,
    },
    confidenceFrontier: frontier(),
    budget: {
      state: createReviewBudget({ limits: { requests: 10 } }),
      evidence: [ref('budget-ledger', 'external')],
    },
    criticalFlows: [{ flowId: 'auth-login', certified: true, evidence: [ref('critical-auth-flow', 'review')] }],
    findings: [],
    reviewUnits: [
      reviewUnit('unit-1', '2026-09-25T12:00:00.000Z'),
      reviewUnit('unit-2', '2026-09-25T12:01:00.000Z'),
      reviewUnit('unit-3', '2026-09-25T12:02:00.000Z'),
    ],
    ...overrides,
  };
}

const policy: ConvergencePolicy = {
  minimumMeaningfulReviewUnits: 3,
  maximumWeightedResidualRisk: 0.05,
  minimumReleaseConfidence: 0.85,
  maximumNovelVerifiedDefectsPer1000Requests: 1,
  minimumRequestsForYield: 1000,
  minimumWeightedRiskCoverage: 0.9,
  minimumCriticalFlowCoverage: 1,
  requiredCriticalFlowIds: ['auth-login'],
  requiredDeterministicCheckIds: ['typecheck'],
  minimumRemainingBudget: { requests: 1 },
};

describe('factory convergence policy', () => {
  it('stops only after risk, confidence, quiet-window, yield, budget, and certification gates pass', () => {
    const decision = evaluateConvergence(assessment(), policy, '2026-09-25T13:00:00.000Z');

    assert.equal(decision.status, 'stop');
    assert.equal(decision.summary.weightedResidualRisk, 0.04);
    assert.equal(decision.summary.releaseConfidence, 0.9);
    assert.equal(decision.summary.meaningfulReviewUnitIds.length, 3);
    assert.equal(decision.summary.windowRequestCount, 1200);
    assert.equal(decision.summary.verifiedNovelDefectsPer1000Requests, 0);
    assert.ok(decision.evidence.references.some((item) => item.uri === 'evidence/frontier.json'));
    assert.ok(decision.evidence.references.some((item) => item.uri === 'evidence/critical-auth-flow.json'));
    assert.ok(decision.criteria.every((item) => item.passed));
  });

  it('continues when residual risk, confidence, new high findings, or yield miss policy', () => {
    const highFinding = {
      id: 'finding:payment-race',
      severity: 'high' as const,
      status: 'resolved' as const,
      verified: true,
      evidence: [ref('payment-race-finding', 'review')],
    };
    const changed = assessment({
      confidenceFrontier: frontier(0.2, 0.6),
      findings: [highFinding],
      reviewUnits: [
        reviewUnit('unit-1', '2026-09-25T12:00:00.000Z'),
        reviewUnit('unit-2', '2026-09-25T12:01:00.000Z', [{
          id: highFinding.id,
          severity: 'high',
          verified: true,
          novel: true,
          evidence: highFinding.evidence,
        }]),
        reviewUnit('unit-3', '2026-09-25T12:02:00.000Z'),
      ],
    });
    const decision = evaluateConvergence(changed, { ...policy, maximumNovelVerifiedDefectsPer1000Requests: 0.5 });

    assert.equal(decision.status, 'continue');
    assert.equal(decision.summary.newVerifiedHighFindingIds[0], highFinding.id);
    assert.equal(decision.summary.verifiedNovelDefectsPer1000Requests, 0.833);
    assert.equal(decision.criteria.find((item) => item.id === 'weighted-residual-risk')?.passed, false);
    assert.equal(decision.criteria.find((item) => item.id === 'release-confidence')?.passed, false);
    assert.equal(decision.criteria.find((item) => item.id === 'quiet-high-severity-window')?.passed, false);
    assert.equal(decision.criteria.find((item) => item.id === 'novel-finding-yield')?.passed, false);
  });

  it('requires escalation when the review reserve is exhausted before enough evidence exists', () => {
    const budget = accountReviewUsage(
      createReviewBudget({ limits: { requests: 3 } }),
      { id: 'prior-review' },
      { requests: 3 },
    );
    const critical = {
      id: 'finding:critical-auth',
      severity: 'critical' as const,
      status: 'open' as const,
      verified: false,
      evidence: [ref('critical-auth-finding', 'review')],
    };
    const decision = evaluateConvergence(assessment({
      budget: { state: budget, evidence: [ref('exhausted-budget', 'external')] },
      findings: [critical],
      reviewUnits: [reviewUnit('unit-1', '2026-09-25T12:00:00.000Z')],
    }), policy);

    assert.equal(decision.status, 'escalate');
    assert.equal(decision.escalation?.kind, 'human-review');
    assert.equal(decision.summary.openCriticalFindingIds[0], critical.id);
    assert.ok(decision.criteria.some((item) => item.id === 'budget-for-next-review' && !item.passed));
    assert.ok(decision.reasons.some((reason) => /open critical findings/.test(reason)));
  });

  it('does not accept stale certification, missing critical flows, or dirty deterministic checks', () => {
    const original = createCertification({
      ...certificationInput(),
      deterministicChecks: [{ id: 'typecheck', status: 'fail', evidence: [certEvidence('typecheck-fail')] }],
    });
    const decision = evaluateConvergence(assessment({
      certification: original,
      currentCertificationState: { ...assessment().currentCertificationState, commit: 'b'.repeat(40) },
      criticalFlows: [{ flowId: 'auth-login', certified: false, evidence: [] }],
    }), policy);

    assert.equal(decision.status, 'continue');
    assert.equal(decision.criteria.find((item) => item.id === 'certification-current')?.passed, false);
    assert.equal(decision.criteria.find((item) => item.id === 'required-critical-flows')?.passed, false);
    assert.equal(decision.criteria.find((item) => item.id === 'deterministic-checks')?.passed, false);
  });

  it('persists the decision and evidence as a versioned artifact in the existing run sidecar', () => {
    const root = mkdtempSync(join(tmpdir(), 'dag-convergence-'));
    const runFile = join(root, 'dag.run.json');
    try {
      const decision = evaluateAndSaveConvergence(runFile, assessment(), policy, '2026-09-25T13:00:00.000Z');
      const loaded = loadConvergenceDecision(runFile, decision.id, decision.runId);
      const path = join(root, 'dag.run.d', 'factory', `convergence-v1-${decision.id.split(':').at(-1)}.json`);
      assert.deepEqual(loaded, decision);
      assert.ok(readFileSync(path, 'utf8').includes('"references"'));
      assert.ok(loaded!.evidence.references.some((item) => item.uri === 'evidence/frontier.json'));
      assert.throws(() => loadConvergenceDecision(runFile, decision.id, 'another-run'), /belongs to run/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects tampered persisted evidence and malformed policy thresholds', () => {
    const root = mkdtempSync(join(tmpdir(), 'dag-convergence-tamper-'));
    const runFile = join(root, 'dag.run.json');
    try {
      const decision = evaluateAndSaveConvergence(runFile, assessment(), policy, '2026-09-25T13:00:00.000Z');
      const path = join(root, 'dag.run.d', 'factory', `convergence-v1-${decision.id.split(':').at(-1)}.json`);
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
      saved.summary.weightedResidualRisk = 0;
      writeFileSync(path, JSON.stringify(saved));
      assert.throws(() => loadConvergenceDecision(runFile, decision.id), /does not match its policy and evidence/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    assert.throws(() => evaluateConvergence(assessment(), { ...policy, minimumReleaseConfidence: 1.1 }), /minimumReleaseConfidence/);
    assert.throws(() => evaluateConvergence(assessment(), { ...policy, minimumRemainingBudget: {} }), /reserve a positive amount/);
  });
});
