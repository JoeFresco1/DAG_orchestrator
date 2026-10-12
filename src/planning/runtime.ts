import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, Task } from '../types.js';
import { digest, type PlanningFinding, type PlanningCheck } from './contracts.js';
import { compilePlan, planningDefinition } from './compile.js';
import { validatePlan, admitPlanningTask } from './validation.js';
import { validatePlanningReview } from './review.js';

export function planningRefusal(run: Run, root: string, sidecar?: string): string | null {
  if (sidecar && existsSync(join(sidecar, 'planning-migration.json'))) {
    try {
      const journal = JSON.parse(readFileSync(join(sidecar, 'planning-migration.json'), 'utf8'));
      if (journal.stage !== 'committed' || !run.planning || journal.previousRun?.id !== run.id)
        return 'Interrupted canonical migration; resume dag plan migrate before execution';
    } catch { return 'Invalid canonical migration journal'; }
  }
  if (!run.planning) return null;
  try {
    if (sidecar && existsSync(join(sidecar, 'planning-amendment.json'))) {
      const journal = JSON.parse(readFileSync(join(sidecar, 'planning-amendment.json'), 'utf8'));
      if (journal.stage !== 'committed' || journal.revision !== run.planning.revision) return 'Interrupted planning amendment; resume dag plan amend before execution';
    }
    const report = validatePlan(run.planning.manifest, root);
    if (!report.valid) return `Planning validation failed: ${report.findings.filter(f => f.blocking).map(f => `${f.rule}: ${f.message}`).join('; ')}`;
    if (report.revision !== run.planning.revision || run.planningState?.revision !== report.revision) return 'Invalid persisted planning revision/checkpoint';
    const state = run.planningState;
    if (!state || !state.evidence || !state.failures || !state.holds || [state.evidence, state.failures, state.holds].some(v => typeof v !== 'object' || Array.isArray(v))) return 'Invalid persisted planning checkpoint';
    for (const [id, findings] of Object.entries(state.holds)) if (!validFailureFindings(run, id, findings)) return `Invalid persisted planning hold: ${id}`;
    for (const failure of Object.values(state.failures)) if (!Number.isSafeInteger(failure.count) || failure.count < 1 || !Array.isArray(failure.findings) || !failure.findings.length || !Array.isArray(failure.occurrences) || failure.occurrences.some(o => typeof o !== 'string')) return 'Invalid persisted planning failure checkpoint';
    if (run.planning.review) validatePlanningReview(run.planning.review, run.planning.manifest);
    if (report.semanticRequired && (run.planning.review?.revision !== report.revision || run.planning.review.verdict !== 'pass' || run.planning.review.findings.some(f => f.blocking))) return 'Independent planning review required; run dag plan review';
    const expected = compilePlan(run.planning.manifest);
    for (const actual of Object.values(run.tasks)) {
      if (!run.planning.manifest.tasks.some(t => t.id === actual.id) && run.planning.generated?.[actual.id] !== planningDefinition(actual)) return `Unregistered task outside canonical planning authority: ${actual.id}`;
    }
    for (const task of run.planning.manifest.tasks) {
      const actual = run.tasks[task.id];
      const imported = run.planning.legacyImports?.[task.id];
      if (imported) {
        if (!actual || actual.status !== 'completed' || digest(actual) !== imported.taskDigest ||
          digest(task) !== imported.contractDigest || run.planning.definitions[task.id] !== planningDefinition(actual))
          return `Imported historical acceptance changed: ${task.id}`;
        if (actual.deps.join('\0') !== report.dependencies[task.id]!.map(d => d.owner).join('\0'))
          return `Imported historical dependencies changed: ${task.id}`;
        // Preserve the old acceptance record without manufacturing v2 receipts.
        continue;
      }
      if (!actual || run.planning.definitions[task.id] !== planningDefinition(actual) || planningDefinition(actual) !== planningDefinition(expected.tasks[task.id]!)) return `Compiled planning definition changed: ${task.id}; use stopped dag plan amend`;
      if (actual.deps.join('\0') !== report.dependencies[task.id]!.map(d => d.owner).join('\0')) return `Compiled dependencies do not match planning authority: ${task.id}`;
      if (actual.status === 'completed') for (const id of task.acceptance) {
        const criterion = run.planning.manifest.criteria.find(c => c.id === id)!;
        const evidence = state.evidence[id];
        if (!evidence || evidence.taskId !== task.id || evidence.revision !== report.revision || evidence.attempt !== actual.attempts ||
          !Array.isArray(evidence.checks) || !criterion.checks.every(c => evidence.checks.includes(c)) || !/^[a-f0-9]{64}$/.test(evidence.sourceDigest ?? '')) return `Completed task lacks valid planning acceptance evidence: ${task.id}/${id}`;
      }
    }
    return null;
  } catch (e) { return `Invalid persisted planning contract: ${String(e)}`; }
}
export function planningAdmitted(run: Run, id: string, active: Iterable<string>): boolean {
  if (!run.planning) return true;
  const holds = run.planningState?.holds ?? {};
  const seen = new Set<string>();
  const held = (key: string): boolean => {
    if (holds[key]) return true;
    if (seen.has(key)) return false; seen.add(key);
    return run.tasks[key]?.deps.some(held) ?? false;
  };
  return !held(id) && admitPlanningTask(run.planning.manifest, id, active);
}
export function planningProbes(run: Run, task: Task): PlanningCheck[] {
  const plan = run.planning?.manifest;
  const contract = plan?.tasks.find(t => t.id === task.id);
  return (contract?.inputs ?? []).map(input => input.check ?? plan!.tasks.find(t => (t.provides ?? []).some(p => p.id === input.capability) && (!input.owner || t.id === input.owner))!.provides!.find(p => p.id === input.capability)!.check);
}
export function recordPlanningAcceptance(run: Run, task: Task, sourceDigest: string): void {
  const plan = run.planning?.manifest, state = run.planningState;
  if (!plan || !state) return;
  for (const criterion of plan.criteria.filter(c => c.owner === task.id)) state.evidence[criterion.id] = {
    revision: run.planning!.revision, taskId: task.id, attempt: task.attempts, checks: criterion.checks, sourceDigest,
  };
}
export function missingPlanningAcceptance(run: Run): string[] {
  if (!run.planning) return [];
  return run.planning.manifest.criteria.filter(c => {
    const task = run.tasks[c.owner], evidence = run.planningState?.evidence[c.id];
    return !task || task.status !== 'completed' || !evidence || evidence.revision !== run.planning!.revision || evidence.attempt !== task.attempts || !c.checks.every(id => evidence.checks.includes(id));
  }).map(c => c.id);
}

/** Only evidence-backed contract findings trigger a planning hold. */
export function recordPlanningFailure(run: Run, taskId: string, findings: PlanningFinding[], occurrence = `attempt:${run.tasks[taskId]?.attempts}`, holdAfter = 2): boolean {
  if (![1, 2].includes(holdAfter)) throw Error('Planning hold threshold must be one or two grounded reports');
  if (!run.planning || !run.planningState || !validFailureFindings(run, taskId, findings)) return false;
  if (findings.some(f => f.rule === 'acceptance.future')) {
    const report = validatePlan(run.planning.manifest);
    const future = findings.filter(f => f.rule === 'acceptance.future');
    const ancestors = new Set<string>();
    const walk = (id: string) => { for (const d of report.dependencies[id] ?? []) if (!ancestors.has(d.owner)) { ancestors.add(d.owner); walk(d.owner); } };
    walk(taskId);
    // A claim alone does not earn immediate non-retryable treatment.
    if (future.every(f => f.references.some(path => run.planning!.manifest.tasks.some(t => t.id !== taskId && !ancestors.has(t.id) &&
      (t.files ?? []).some(file => file.path === path && file.role !== 'frozen'))))) holdAfter = 1;
  }
  const key = digest({ revision: run.planning.revision, taskId, findings: findings.map(f => ({ rule: f.rule, references: f.references, message: f.message })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  const prior = run.planningState.failures[key];
  if (prior?.occurrences?.includes(occurrence)) {
    if (prior.count >= holdAfter) run.planningState.holds[taskId] = findings;
    return !!run.planningState.holds[taskId];
  }
  const current = run.planningState.failures[key] = { count: (prior?.count ?? 0) + 1, findings, occurrences: [...(prior?.occurrences ?? []), occurrence] };
  if (current.count < holdAfter) return false;
  run.planningState.holds[taskId] = findings;
  return true;
}

export function validFailureFindings(run: Run, taskId: string, findings: PlanningFinding[]): boolean {
  if (!run.planning || !run.tasks[taskId] || !Array.isArray(findings) || !findings.length) return false;
  const allowed = ['acceptance.future', 'acceptance.owner', 'capability.missing', 'capability.ambiguous', 'interface.incompatible', 'scope.ambiguous'];
  try { validatePlanningReview({ version: 1, revision: run.planning.revision, contextDigest: run.planning.revision, reviewer: 'execution-diagnosis', verdict: 'fail', findings }, run.planning.manifest); } catch { return false; }
  if (findings.some(f => !f || !allowed.includes(f.rule) || !f.blocking || !Array.isArray(f.tasks) || !f.tasks.includes(taskId) ||
    !Array.isArray(f.evidence) || !f.evidence.length || f.evidence.some(v => typeof v !== 'string' || !v.trim()) ||
    !Array.isArray(f.references) || !f.references.length || !f.correction?.trim())) return false;
  return true;
}
