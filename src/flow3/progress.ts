import { gateBlocks } from '../graph.js';
import type { Run, Task } from '../types.js';
import type { RepairContext } from './contracts.js';

export function repairBrief(task: Task, protectedPaths: string[], history: RepairContext[] = []): string {
  const state = task.nodeState!, context = state.repairContext!, decision = state.decision ?? context.diagnosis;
  const checks = state.latestFailedChecks ?? context.failedChecks;
  const earlier = [...new Set([...history.map(c => c.diagnosis.reason), ...(state.diagnosisHistory ?? []).map(h => h.decision.reason)])].filter(s => s !== decision.reason);
  return [
    'Repair only the demonstrated defect. Preserve existing work and valid negative outcomes.',
    'Latest diagnosis: ' + decision.reason,
    ...checks.map(c => c.command + '\n' + c.output.slice(-4000) + (c.evidenceRef ? '\nEvidence: ' + c.evidenceRef : '')),
    'Authority: ' + context.authority + '; owners: ' + (context.owners.join(', ') || task.id),
    'Allowed files: ' + context.scope.join(', '),
    'Runner verification: ' + context.verification.join('; '),
    ...(earlier.length ? ['Previous diagnoses: ' + earlier.slice(-3).join('; ')] : []),
    ...[...new Set(history.flatMap(c => c.failedChecks.flatMap(k => k.evidenceRef ? [k.evidenceRef] : [])))].slice(-3).map(ref => 'Prior evidence: ' + ref),
    'Preserve tests, contracts, check configuration and Git history. Protected paths: ' + protectedPaths.join(', '),
    'Return the repair for the runner to verify. ' + context.escalation
  ].join('\n');
}

export function flowProgress(run: Run, live: boolean) {
  if (run.settings.executionProfile !== 'flow3') return undefined;
  const f = run.flowState;
  const progress = (activity: string, reason: string, nextAction: string, operatorActionRequired: boolean, taskIds: string[] = []) => ({
    activity, reason, nextAction, operatorActionRequired, taskIds,
    implementationComplete: f?.implementationComplete, acceptanceStatus: f?.acceptanceStatus,
    reviewStatus: f?.review?.status, mergeStatus: f?.mergeStatus, productComplete: f?.productComplete,
    message: reason + ' ' + nextAction + (operatorActionRequired ? '' : ' No operator action needed.')
  });
  if (f?.userStopped) return progress('stopped', 'Stopped by operator.', 'Start explicitly when ready.', true);
  if (f?.quotaWait) {
    const w = f.quotaWait, manual = w.manual || !live;
    return {
      ...progress('quota', w.reason, manual ? 'Resume the saved run when available.' : 'The run owner will recheck quota.', !!manual),
      reading: w.reading, nextProbeAt: w.nextProbeAt
    };
  }
  if (f?.productComplete || (f?.completion?.mode === 'scoped' && f.acceptanceStatus === 'passed' && ['pass', 'off'].includes(f.review?.status ?? 'pending')))
    return progress('accepted', f.productComplete ? 'Product acceptance passed.' : 'Scoped acceptance passed.', 'Changes are on the integration branch.', false);
  const tasks = Object.values(run.tasks), active = tasks.filter(t => t.status === 'running');
  if (f?.review?.status === 'fail' || f?.review?.status === 'error') return progress('review', 'Configured review: ' + f.review.status + '.', f.review.output?.slice(-400) || 'Inspect the review evidence.', true);
  const repairing = active.find(t => t.nodeState?.repairContext);
  if (live && repairing) return progress('repairing', 'Repairing ' + repairing.id + ': ' + repairing.nodeState!.repairContext!.diagnosis.reason, 'The runner verifies the repair before integration.', false, [repairing.id]);
  if (live && active.length) return progress('working', 'Running: ' + active.map(t => t.id).join(', ') + '.', 'The runner will verify and integrate eligible work.', false, active.map(t => t.id));
  const check = f?.checkpoints.at(-1), waiting = check?.results.filter(r => r.decision?.action === 'defer' && r.decision.requires?.some(id => run.tasks[id]?.status !== 'completed')) ?? [];
  if (waiting.length) {
    const ids = [...new Set(waiting.flatMap(r => r.decision!.requires ?? []))];
    const blocked = ids.some(id => !run.tasks[id] || ['skipped', 'failed'].includes(run.tasks[id].status));
    return progress('deferred', waiting.map(r => r.command).join('; ') + ' awaits ' + ids.map(id => id + ' (' + (run.tasks[id]?.status ?? 'missing') + ')').join(', ') + '.', blocked ? 'Inspect the named producer.' : live ? 'Eligible producers can proceed.' : 'Start the saved run.', blocked || !live, ids);
  }
  if (live) return progress('running', check?.outcome === 'running' ? 'Running ' + check.kind + ' checks.' : 'Run owner is active.', 'The runner will advance eligible work.', false);
  const required = (f?.completion?.required ?? tasks.map(t => t.id)).map(id => run.tasks[id]).filter(Boolean);
  const gated = required.find(t => gateBlocks(t) && t.status !== 'completed');
  if (gated) return progress('approval', 'Required task ' + gated.id + ' has a configured approval gate.', 'Resolve the existing gate.', true, [gated.id]);
  const failed = required.find(t => t.status === 'failed');
  if (failed) return progress('held', failed.id + ': ' + (failed.result ?? 'Task failed.'), 'Inspect its failed attempt.', true, [failed.id]);
  const issue = f?.issues.at(-1) ?? tasks.find(t => t.status === 'failed')?.result ?? check?.results.find(r => !r.passed)?.output;
  return progress(issue ? 'held' : 'idle', issue?.slice(-500) ?? 'No active run owner.', issue ? 'Inspect the recorded failure.' : 'Start the run when ready.', true);
}
