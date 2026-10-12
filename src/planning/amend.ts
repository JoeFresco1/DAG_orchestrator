import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { acquireLock, atomicWriteJson, loadRun, runPaths, saveRun } from '../store.js';
import { compilePlan, planningDefinition } from './compile.js';
import { digest, assertPlanningRequirementsPreserved, type PlanningManifest, type PlanningReview, type PlanningState } from './contracts.js';
import { validatePlan } from './validation.js';
import { validatePlanningReview } from './review.js';
import type { Run } from '../types.js';

/** Journal + existing atomic store: interruption refuses dispatch, never loses the old contract. */
export function amendPlan(file: string, manifest: PlanningManifest, reason: string, review?: PlanningReview): object {
  if (!reason.trim()) throw Error('Stopped planning amendment requires a reason');
  const release = acquireLock(file, 'planning amendment');
  try {
    const paths = runPaths(file), report = validatePlan(manifest, dirname(paths.file));
    const journalPath = join(paths.dir, 'planning-amendment.json');
    const existing = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : null;
    if (existing && existing.stage !== 'committed' && existing.revision !== report.revision) throw Error('Resume the interrupted amendment with the same contract first');
    // A validated journal is the recovery boundary if definition/state writes were interrupted.
    if (existing?.previousRun && existing.previousRunDigest !== digest(existing.previousRun)) throw Error('Invalid interrupted amendment snapshot');
    if (existing?.stage === 'validated' && existing.previousRun && existsSync(file)) {
      const definition = JSON.parse(readFileSync(file, 'utf8'));
      if (definition.id !== existing.previousRun.id) throw Error('Interrupted amendment belongs to a different run');
    }
    const run: Run = existing?.stage === 'validated' && existing.previousRun ? structuredClone(existing.previousRun) : loadRun(file);
    if (!run.planning) throw Error('Legacy run requires explicit migration into a fresh contract-managed run');
    if (Object.keys(run.planning.generated ?? {}).length) throw Error('Amend the factory goal through its controller before changing generated factory phases');
    if (Object.values(run.tasks).some(t => t.status === 'running' || t.pid !== null)) throw Error('Stop and recover the runner before amending');
    if (!report.valid) throw Error(`Invalid amendment: ${report.findings.map(f => `${f.rule}: ${f.message}`).join('; ')}`);
    if (review) validatePlanningReview(review, manifest);
    if (report.semanticRequired && (!review || review.verdict !== 'pass')) throw Error('Validated independent review required before amendment');
    assertPlanningRequirementsPreserved(run.planning.manifest, manifest);
    const next = compilePlan(manifest);
    next.planning!.review = review;
    for (const task of Object.values(run.tasks)) {
      if (!next.tasks[task.id] && task.attempts) throw Error(`Cannot remove attempted task ${task.id}`);
      if (task.status === 'completed' && (!next.tasks[task.id] || acceptedIdentity(run.planning.manifest, task.id, task.deps) !== acceptedIdentity(manifest, task.id, next.tasks[task.id]!.deps))) throw Error(`Amendment changes accepted work ${task.id}; explicit invalidation is required`);
      if (task.status === 'completed' && planningDefinition(task) !== run.planning.definitions[task.id]) throw Error(`Accepted task definition drift: ${task.id}`);
    }
    // A committed journal belongs to the last amendment, not the current baseline.
    // Interrupted recovery already restored this amendment's baseline above.
    const previous = structuredClone({ planning: run.planning, planningState: run.planningState, tasks: run.tasks, settings: run.settings });
    const journal = { version: 1, stage: 'validated', revision: report.revision, reason, previous, previousRun: structuredClone(run), previousRunDigest: digest(run) };
    atomicWriteJson(journalPath, journal);
    const priorState = run.planningState!;
    const retainedHolds = Object.fromEntries(Object.entries(priorState.holds).filter(([id]) =>
      next.tasks[id] && acceptedIdentity(run.planning!.manifest, id, run.tasks[id]!.deps) === acceptedIdentity(manifest, id, next.tasks[id]!.deps)));
    for (const task of Object.values(next.tasks)) {
      const prior = run.tasks[task.id];
      if (prior) {
        if (run.planning.legacyImports?.[task.id]) continue;
        const changed = planningDefinition(prior) !== planningDefinition(task);
        // Change only generated static fields. Attempts, budgets, results and salvage refs survive.
        Object.assign(prior, { title: task.title, spec: task.spec, deps: task.deps, cmd: task.cmd, reviewCmd: task.reviewCmd,
          reviewers: task.reviewers, planCmd: task.planCmd, prepareCmd: task.prepareCmd, harnessChain: task.harnessChain });
        if (prior.status === 'failed' && changed) prior.status = 'pending';
      } else run.tasks[task.id] = task;
    }
    for (const id of Object.keys(run.tasks)) if (!next.tasks[id]) delete run.tasks[id];
    const state: PlanningState = { revision: report.revision, evidence: {}, failures: priorState.failures, holds: retainedHolds };
    for (const [id, evidence] of Object.entries(priorState.evidence)) {
      const old = previous.planning.manifest.criteria.find((c: { id: string }) => c.id === id);
      const changed = manifest.criteria.find(c => c.id === id);
      if (old && changed && digest(old) === digest(changed) && run.tasks[evidence.taskId]?.status === 'completed') state.evidence[id] = { ...evidence, revision: report.revision };
    }
    run.planning = next.planning; run.planningState = state;
    if (previous.planning.legacyImports) {
      run.planning!.legacyImports = previous.planning.legacyImports;
      for (const id of Object.keys(previous.planning.legacyImports)) run.planning!.definitions[id] = planningDefinition(run.tasks[id]!);
    }
    saveRun(run, file);
    atomicWriteJson(journalPath, { ...journal, stage: 'committed' });
    return { revision: report.revision, budgetsPreserved: true, completedPreserved: true, reason };
  } finally { release(); }
}

/** Explicit legacy migration, journaled before writes; never resets task execution history. */
export function migratePlan(file: string, manifest: PlanningManifest, reason: string, review?: PlanningReview): object {
  if (!reason.trim()) throw Error('Legacy migration requires a recorded reason');
  const release = acquireLock(file, 'explicit canonical planning migration');
  try {
    const paths = runPaths(file), report = validatePlan(manifest, dirname(paths.file));
    const journalPath = join(paths.dir, 'planning-migration.json');
    const existing = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : null;
    if (existing?.stage === 'validated' && existing.revision !== report.revision) throw Error('Resume interrupted migration with the same manifest');
    if (existing?.stage === 'validated' && digest(existing.previousRun) !== existing.previousRunDigest) throw Error('Invalid migration snapshot');
    const run: Run = existing?.stage === 'validated' ? structuredClone(existing.previousRun) : loadRun(file);
    if (run.planning) throw Error('Already contract-managed; use stopped plan amend');
    if (Object.values(run.tasks).some(t => t.status === 'running' || t.pid !== null)) throw Error('Stop and recover the run before migration');
    if (!report.valid) throw Error(`Invalid migration: ${report.findings.map(f => f.message).join('; ')}`);
    if (review) validatePlanningReview(review, manifest);
    if (report.semanticRequired && (!review || review.verdict !== 'pass')) throw Error('Independent planning approval required before migration');
    const next = compilePlan(manifest), imports: NonNullable<NonNullable<Run['planning']>['legacyImports']> = {};
    for (const prior of Object.values(run.tasks)) {
      const task = next.tasks[prior.id], contract = manifest.tasks.find(t => t.id === prior.id);
      if (!task || !contract) throw Error(`Migration must retain existing task ${prior.id}`);
      if (prior.status === 'completed') {
        if (prior.deps.join('\0') !== task.deps.join('\0')) throw Error(`Cannot change completed dependencies ${prior.id}`);
        imports[prior.id] = { taskDigest: digest(prior), contractDigest: digest(contract) };
      }
    }
    const journal = { version: 1, stage: 'validated', revision: report.revision, reason,
      previousRun: structuredClone(run), previousRunDigest: digest(run), historicalAcceptance: imports };
    atomicWriteJson(journalPath, journal);
    for (const task of Object.values(next.tasks)) {
      const prior = run.tasks[task.id];
      if (!prior) run.tasks[task.id] = task;
      else if (prior.status !== 'completed') {
        // Execution fields, status, attempts, cycle budgets, outcomes and salvage stay intact.
        Object.assign(prior, { title: task.title, spec: task.spec, deps: task.deps, cmd: task.cmd, reviewCmd: task.reviewCmd,
          reviewers: task.reviewers, planCmd: task.planCmd, prepareCmd: task.prepareCmd, harnessChain: task.harnessChain });
      }
    }
    run.planning = next.planning; run.planning!.review = review; run.planning!.legacyImports = imports;
    run.planningState = next.planningState;
    for (const id of Object.keys(imports)) run.planning!.definitions[id] = planningDefinition(run.tasks[id]!);
    saveRun(run, file);
    atomicWriteJson(journalPath, { ...journal, stage: 'committed' });
    return { runId: run.id, revision: report.revision, completedPreserved: Object.keys(imports).length,
      historicalAcceptance: 'retained legacy records; no new planning evidence fabricated', budgetsPreserved: true };
  } finally { release(); }
}

// Updating deferred ownership is safe when this task's own obligation/input/check contract is unchanged.
function acceptedIdentity(plan: PlanningManifest, id: string, dependencies: string[]): string {
  const task = plan.tasks.find(t => t.id === id);
  if (!task) return '';
  const { maxAttempts: _budget, ...contract } = task;
  return digest({ contract, dependencies, sources: plan.sources, criteria: plan.criteria.filter(c => c.owner === id) });
}
