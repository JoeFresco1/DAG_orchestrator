import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRiskCoverage,
  prioritizeRiskCoverage,
  type RiskCoverageUnit,
} from './risk-coverage.js';

describe('factory risk-weighted coverage', () => {
  it('reports audit counts separately from weighted risk and includes residual risk', () => {
    const units: RiskCoverageUnit[] = [
      { id: 'auth', kind: 'code', riskWeight: 80, reviewed: true, securitySensitive: true },
      { id: 'docs-helper', kind: 'code', riskWeight: 10, reviewed: false },
      { id: 'auth->db', kind: 'dependency', riskWeight: 20, reviewed: false, securitySensitive: true },
      { id: 'login-flow', kind: 'execution-path', riskWeight: 30, reviewed: true, highImpact: true },
      { id: 'settings-flow', kind: 'execution-path', riskWeight: 5, reviewed: false, highImpact: true },
    ];
    const report = calculateRiskCoverage(units, {
      files: { total: ['auth.ts', 'helper.ts'], reviewed: ['auth.ts'] },
      symbols: { total: ['login', 'format'], reviewed: ['login'] },
      dependencyEdges: { total: ['auth->db', 'helper->text'], reviewed: [] },
      subsystems: { total: ['auth', 'settings'], reviewed: ['auth'] },
      integrationBoundaries: { total: ['db'], reviewed: ['db'] },
      e2ePaths: { total: ['login', 'settings'], reviewed: ['login'] },
      specialistPasses: { total: ['security', 'performance'], reviewed: ['security'] },
    });

    assert.deepEqual(report.auditCoverage.files, { reviewed: 1, total: 2, percent: 0.5 });
    assert.deepEqual(report.auditCoverage.dependencyEdges, { reviewed: 0, total: 2, percent: 0 });
    assert.deepEqual(report.auditCoverage.specialistPasses, { reviewed: 1, total: 2, percent: 0.5 });
    assert.equal(report.riskCoverage.weightedRisk.totalRisk, 145);
    assert.equal(report.riskCoverage.weightedRisk.inspectedRisk, 110);
    assert.equal(report.riskCoverage.weightedRisk.percent, 110 / 145);
    assert.deepEqual(report.riskCoverage.codeRisk, { inspectedRisk: 80, totalRisk: 90, percent: 80 / 90 });
    assert.deepEqual(report.riskCoverage.dependencyRisk, { inspectedRisk: 0, totalRisk: 20, percent: 0 });
    assert.deepEqual(report.riskCoverage.highImpactExecutionPaths, {
      inspectedRisk: 30, totalRisk: 35, percent: 30 / 35,
    });
    assert.deepEqual(report.riskCoverage.securitySensitiveRisk, {
      inspectedRisk: 80, totalRisk: 100, percent: 0.8,
    });
    assert.deepEqual(report.riskCoverage.residualRisk, {
      total: 35,
      byKind: { code: 10, dependency: 20, 'execution-path': 5 },
      securitySensitive: 20,
    });
  });

  it('gives an equal-sized high-risk reviewed unit more weight than a low-risk unit', () => {
    const units: RiskCoverageUnit[] = [
      // Both represent 100 LOC; riskWeight is risk score × exposure size.
      { id: 'critical', kind: 'code', riskWeight: 0.9 * 100, reviewed: true },
      { id: 'routine', kind: 'code', riskWeight: 0.1 * 100, reviewed: false },
    ];
    const report = calculateRiskCoverage(units);
    assert.ok(report.riskCoverage.codeRisk.inspectedRisk > 0.5 * report.riskCoverage.codeRisk.totalRisk);
    assert.equal(report.riskCoverage.codeRisk.percent, 0.9);
    assert.equal(report.riskCoverage.residualRisk.total, 10);
  });

  it('prioritizes uncovered high-risk work with deterministic ties', () => {
    const units: RiskCoverageUnit[] = [
      { id: 'already-reviewed', kind: 'code', riskWeight: 100, reviewed: true },
      { id: 'low', kind: 'code', riskWeight: 2, reviewed: false },
      { id: 'high-b', kind: 'dependency', riskWeight: 50, reviewed: false },
      { id: 'high-a', kind: 'code', riskWeight: 50, reviewed: false },
    ];
    assert.deepEqual(prioritizeRiskCoverage(units).map((unit) => unit.id), [
      'high-a', 'high-b', 'low', 'already-reviewed',
    ]);
  });

  it('returns null coverage for undeclared or zero-weight populations', () => {
    const report = calculateRiskCoverage([
      { id: 'zero', kind: 'code', riskWeight: 0, reviewed: false },
    ]);
    assert.equal(report.auditCoverage.files.percent, null);
    assert.equal(report.riskCoverage.weightedRisk.percent, null);
    assert.equal(report.riskCoverage.codeRisk.percent, null);
    assert.equal(report.riskCoverage.highImpactExecutionPaths.percent, null);
    assert.equal(report.riskCoverage.securitySensitiveRisk.percent, null);
  });

  it('rejects invalid or duplicate risk inventory entries', () => {
    assert.throws(() => calculateRiskCoverage([
      { id: 'duplicate', kind: 'code', riskWeight: 1, reviewed: false },
      { id: 'duplicate', kind: 'code', riskWeight: 2, reviewed: true },
    ]), /unique/);
    assert.throws(() => calculateRiskCoverage([
      { id: 'invalid', kind: 'code', riskWeight: -1, reviewed: false },
    ]), /non-negative/);
  });
});
