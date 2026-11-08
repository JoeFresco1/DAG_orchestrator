import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CRASH_BOUNDARIES,
  completeCrashCampaignReport,
  crashCampaignReportPath,
  createCrashCampaignReport,
  interruptCrashCampaignReport,
  isCrashCampaignSuccessful,
  loadCrashCampaignReport,
  recordCrashCampaignIteration,
  resumeCrashCampaignReport,
  saveCrashCampaignReport,
  type CrashBoundary,
  type CrashCampaignReport,
  type NewCrashCampaignIteration,
} from './crash-certification-report.js';

const at = '2026-11-08T12:00:00.000Z';

function makeIteration(
  runId: string,
  boundary: CrashBoundary,
  overrides: Partial<NewCrashCampaignIteration> = {},
): NewCrashCampaignIteration {
  return {
    boundary,
    outcome: 'completed',
    killPoint: `after-${boundary}`,
    startedAt: at,
    finishedAt: at,
    recoveryActions: [{ command: 'dag run', args: ['--file', 'fixture.json'], startedAt: at, finishedAt: at, exitCode: 0, disposition: 'safe-to-requeue' }],
    evidence: [{ kind: 'recovered-state', ref: 'fixture.d/state.json', sha256: 'a'.repeat(64) }],
    attribution: { runId, taskId: 'task-a', attemptId: 'attempt-a', attempt: 1, definitionDigest: 'definition-a', sourceCommit: 'source-a', integratedCommit: 'integrated-a' },
    ...overrides,
  };
}

function completeCoverage(report: CrashCampaignReport): CrashCampaignReport {
  let complete = report;
  for (const boundary of CRASH_BOUNDARIES) {
    if (complete.boundaries[boundary].outcome === 'not-run') {
      complete = recordCrashCampaignIteration(complete, makeIteration(report.runId, boundary), at);
    }
  }
  return complete;
}

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'dag-crash-report-'));
}

test('new campaigns explicitly mark all six boundaries not-run and reject partial completion', () => {
  const report = createCrashCampaignReport({ runId: 'run-1', campaignId: 'campaign-1', startedAt: at });
  assert.deepEqual(Object.keys(report.boundaries), [...CRASH_BOUNDARIES]);
  for (const boundary of CRASH_BOUNDARIES) {
    assert.equal(report.boundaries[boundary].boundary, boundary);
    assert.equal(report.boundaries[boundary].outcome, 'not-run');
    assert.deepEqual(report.boundaries[boundary].iterations, []);
  }
  assert.throws(() => completeCrashCampaignReport(report, at), /boundaries not run/);
  assert.equal(isCrashCampaignSuccessful(report), false);
});

test('iteration persistence retains recovery action, evidence, attribution, and repeated outcomes', () => {
  let report = createCrashCampaignReport({ runId: 'run-2', campaignId: 'campaign-2', startedAt: at });
  report = recordCrashCampaignIteration(report, makeIteration('run-2', 'merge', { iterationId: 'merge-pass' }), at);
  report = recordCrashCampaignIteration(report, makeIteration('run-2', 'merge', {
    iterationId: 'merge-fail',
    outcome: 'failed',
    failureReason: 'Integration head did not match the saved record',
    recoveryActions: [{ command: 'dag run', args: ['--file', 'fixture.json'], startedAt: at, exitCode: 1, disposition: 'intervention-required' }],
  }), at);

  assert.equal(report.boundaries.merge.outcome, 'failed');
  assert.equal(report.boundaries.merge.iterations.length, 2);
  assert.equal(report.boundaries.merge.iterations[0].recoveryActions[0].command, 'dag run');
  assert.equal(report.boundaries.merge.iterations[0].evidence[0].sha256, 'a'.repeat(64));
  assert.equal(report.boundaries.merge.iterations[0].attribution.attemptId, 'attempt-a');
  assert.equal(report.boundaries.merge.iterations[0].attribution.integratedCommit, 'integrated-a');
  assert.equal(report.boundaries.merge.iterations[1].failureReason, 'Integration head did not match the saved record');
  assert.throws(() => recordCrashCampaignIteration(report, makeIteration('other-run', 'commit'), at), /does not match/);
  assert.throws(() => recordCrashCampaignIteration(report, makeIteration('run-2', 'commit', { iterationId: 'merge-pass' }), at), /Duplicate/);
  assert.throws(() => recordCrashCampaignIteration(report, makeIteration('run-2', 'commit', { outcome: 'failed' }), at), /Failure reason/);
  assert.throws(() => recordCrashCampaignIteration(report, makeIteration('run-2', 'commit', { recoveryActions: [] }), at), /recovery action/);
  assert.throws(() => recordCrashCampaignIteration(report, makeIteration('run-2', 'commit', { evidence: [] }), at), /evidence item/);
});

test('full boundary coverage can be complete while a failed boundary keeps certification unsuccessful', () => {
  let report = createCrashCampaignReport({ runId: 'run-3', campaignId: 'campaign-3', startedAt: at });
  report = recordCrashCampaignIteration(report, makeIteration('run-3', 'worker-launch', {
    outcome: 'failed', failureReason: 'Recovery replayed a dispatched command without reconciliation',
  }), at);
  report = completeCoverage(report);

  const completed = completeCrashCampaignReport(report, at);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.boundaries['worker-launch'].outcome, 'failed');
  assert.equal(isCrashCampaignSuccessful(completed), false);
  assert.throws(() => recordCrashCampaignIteration(completed, makeIteration('run-3', 'merge'), at), /complete campaign/);
});

test('interrupted report resumes with prior iterations intact and cannot finalize while partial', () => {
  let report = createCrashCampaignReport({ runId: 'run-4', campaignId: 'campaign-4', startedAt: at });
  report = recordCrashCampaignIteration(report, makeIteration('run-4', 'worker-launch'), at);
  const interrupted = interruptCrashCampaignReport(report, at);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.boundaries['worker-launch'].outcome, 'completed');
  assert.equal(interrupted.boundaries['result-capture'].outcome, 'not-run');
  assert.throws(() => completeCrashCampaignReport(interrupted, at), /resume it first/);

  report = resumeCrashCampaignReport(interrupted, at);
  assert.equal(report.status, 'in-progress');
  assert.deepEqual(report.interruptionHistory, [at]);
  assert.equal(report.boundaries['worker-launch'].iterations.length, 1);
  assert.throws(() => completeCrashCampaignReport(report, at), /boundaries not run/);
});

test('sidecar persistence round-trips and refuses a forged complete partial report', () => {
  const directory = tempDirectory();
  try {
    const runFile = join(directory, 'fixture.json');
    const report = createCrashCampaignReport({ runId: 'run-5', campaignId: 'campaign-5', startedAt: at });
    const reportPath = crashCampaignReportPath(runFile, report.campaignId);
    saveCrashCampaignReport(reportPath, report);
    assert.deepEqual(loadCrashCampaignReport(reportPath), report);

    const forged = { ...report, status: 'complete' as const, completedAt: at };
    assert.throws(() => saveCrashCampaignReport(reportPath, forged), /unrun boundaries/);
    assert.deepEqual(loadCrashCampaignReport(reportPath), report);
    writeFileSync(reportPath, '{"schemaVersion":2}\n');
    assert.throws(() => loadCrashCampaignReport(reportPath), /Unsupported crash campaign report schema version/);
    assert.throws(() => crashCampaignReportPath(runFile, '../outside'), /safe file-name segment/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
