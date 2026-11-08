import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CRASH_BOUNDARIES, loadCrashCampaignReport, type CrashCampaignReport } from './crash-certification-report.js';

function campaign(reportPath: string, extra: string[] = []) {
  const cli = resolve(process.cwd(), 'src/cli.ts');
  return spawnSync(process.execPath, [
    '--import', 'tsx', cli, 'crash-certify', '--report', reportPath, ...extra, '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
  });
}

function parseReport(stdout: string): CrashCampaignReport & { reportPath: string } {
  const parsed = JSON.parse(stdout) as CrashCampaignReport & { reportPath: string };
  assert.equal(parsed.schemaVersion, 1);
  return parsed;
}

test('crash-certify kills and recovers real CLI processes at all six boundaries and retains interrupted coverage', { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dag-crash-campaign-'));
  const reportPath = join(root, 'campaign.json');

  const partialResult = campaign(reportPath, ['--max-boundaries', '1']);
  assert.equal(partialResult.status, 2, partialResult.stderr || partialResult.stdout);
  const partial = parseReport(partialResult.stdout);
  assert.equal(partial.status, 'interrupted');
  assert.equal(partial.interruptionHistory.length, 1);
  assert.equal(partial.boundaries['worker-launch'].iterations.length, 1);
  const retainedIterationId = partial.boundaries['worker-launch'].iterations[0].iterationId;
  for (const boundary of CRASH_BOUNDARIES.slice(1)) {
    assert.equal(partial.boundaries[boundary].outcome, 'not-run', `${boundary} must stay unrun in an interrupted campaign`);
    assert.deepEqual(partial.boundaries[boundary].iterations, []);
  }

  const resumedResult = campaign(reportPath);
  assert.ok(resumedResult.status === 0 || resumedResult.status === 1, resumedResult.stderr || resumedResult.stdout);
  const resumed = parseReport(resumedResult.stdout);
  const persisted = loadCrashCampaignReport(reportPath);
  assert.equal(resumed.status, 'complete');
  assert.equal(persisted.status, 'complete');
  assert.equal(resumed.interruptionHistory.length, 1);
  assert.equal(resumed.boundaries['worker-launch'].iterations[0].iterationId, retainedIterationId,
    'resuming must retain the completed observation rather than replacing it');
  assert.ok(CRASH_BOUNDARIES.every(boundary => resumed.boundaries[boundary].iterations.length > 0));

  const anyFailed = CRASH_BOUNDARIES.some(boundary => resumed.boundaries[boundary].outcome === 'failed');
  assert.equal(resumedResult.status, anyFailed ? 1 : 0, 'the command exit code must reflect the observed certification result');
  for (const boundary of CRASH_BOUNDARIES) {
    const coverage = resumed.boundaries[boundary];
    const iteration = coverage.iterations[0];
    assert.equal(iteration.boundary, boundary);
    assert.ok(iteration.evidence.some(item => item.kind === 'boundary-marker'), `${boundary} needs its real probe marker`);
    const termination = iteration.evidence.find(item => item.kind === 'process-termination');
    assert.ok(termination, `${boundary} needs evidence of process termination`);
    assert.match(termination.detail ?? '', /signal=SIGKILL/);
    assert.match(iteration.killPoint, /process terminated/);
    assert.ok(iteration.recoveryActions.some(action => action.command === 'dag resume'), `${boundary} needs supported resume recovery`);
    assert.ok(iteration.recoveryActions.some(action => action.command === 'dag run'), `${boundary} needs supported run recovery`);
    assert.ok(iteration.evidence.some(item => item.kind === 'salvage-branch'), `${boundary} needs salvage preservation evidence`);
    assert.ok(iteration.evidence.some(item => item.kind === 'attempt-budget-after-recovery'), `${boundary} needs attempt and budget evidence`);
    if (iteration.outcome === 'completed') {
      assert.equal(iteration.failureReason, undefined, 'a completed boundary cannot carry hidden failures');
      assert.ok(iteration.evidence.some(item => item.kind === 'git-store-reconciliation'));
    } else {
      assert.ok(iteration.failureReason, 'a failed boundary must explain what recovery did not preserve');
    }
  }

  const ambiguous = resumed.boundaries['result-capture'].iterations[0];
  assert.ok(ambiguous.evidence.some(item => item.kind === 'ambiguous-effect-held'));
  assert.ok(ambiguous.evidence.some(item => item.kind === 'ambiguous-resolution'));
  assert.ok(ambiguous.evidence.some(item => item.kind === 'stale-worker-late-write'));
  assert.ok(ambiguous.recoveryActions.some(action => action.command === 'dag resume' && action.args.includes('--resolve-ambiguous')));
  const staleWrite = ambiguous.evidence.find(item => item.kind === 'stale-worker-late-write')!;
  assert.ok(existsSync(staleWrite.ref), 'the detached worker must write after recovery to its old worktree');
  assert.ok(ambiguous.evidence.some(item => item.kind === 'durable-state-after-stale-write'));

  const markerEvidence = resumed.boundaries['verdict-persistence'].iterations[0].evidence.find(item => item.kind === 'verdict-evidence');
  assert.ok(markerEvidence?.sha256 && /^[a-f\d]{64}$/.test(markerEvidence.sha256));
  assert.ok(readFileSync(reportPath, 'utf8').includes('finalization'));
});

