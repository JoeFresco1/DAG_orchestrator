import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { emit, flag, flagRequired } from '../cli-args.js';
import { acquireLock, atomicWriteJson, loadRun, runPaths, saveRun } from '../store.js';
import { compilePlan, attachPlanning, checkCommand } from '../planning/compile.js';
import { compileFlowPlan } from '../flow3/graph.js';
import type { FlowPlan } from '../flow3/contracts.js';
import { validatePlanningManifest } from '../planning/contracts.js';
import { executionProfilePatch } from '../execution-policy.js';
import { validatePlan } from '../planning/validation.js';
import { validatePlanningReview, reviewPlan, correctionProposal } from '../planning/review.js';
import { amendPlan, migratePlan } from '../planning/amend.js';
import type { PlanningManifest, PlanningReview } from '../planning/contracts.js';
import { normalizeFragments, type PlanningFragments } from '../planning/importer.js';

export async function planningCmd(argv: string[]): Promise<void> {
  const action = argv[0] ?? 'validate', file = resolve(flag(argv, 'file') ?? 'dag.run.json');
  const planFile = flag(argv, 'plan');
  const root = resolve(flag(argv, 'cwd') ?? dirname(file));
  if (action === 'normalize' || action === 'merge') {
    const input = JSON.parse(readFileSync(resolve(flagRequired(argv, 'fragments')), 'utf8')) as PlanningFragments;
    const result = normalizeFragments(input, root);
    if (result.report.valid) atomicWriteJson(resolve(flagRequired(argv, 'out')), result.manifest);
    else process.exitCode = 1;
    emit(argv, result, () => JSON.stringify(result, null, 2)); return;
  }
  if (action === 'proposal') {
    const run = loadRun(file);
    if (!run.planning) throw Error('No planning contract on this legacy run');
    emit(argv, correctionProposal(run.planning.manifest, Object.values(run.planningState?.holds ?? {}).flat()), () => 'Inspect JSON correction proposal; apply only through a validated stopped amendment'); return;
  }
  if (!['validate', 'compile', 'review', 'amend', 'migrate'].includes(action)) throw Error('Expected plan validate|compile|review|amend|migrate|proposal|normalize|merge');
  const plan = planFile ? JSON.parse(readFileSync(resolve(planFile), 'utf8')) as PlanningManifest : loadRun(file).planning?.manifest;
  if (!plan) throw Error('--plan is required for a run without a planning contract');
  if ((plan as unknown as FlowPlan).version === 3 || (action === 'compile' && (flag(argv, 'profile') ?? 'flow3') === 'flow3')) {
    if (!['compile', 'validate'].includes(action)) throw Error('Version 3 plans support validate and compile; their one advisory review runs alongside execution');
    const releaseFlow = action === 'compile' ? acquireLock(file, 'Flow 3.0 compile') : undefined;
    try {
      if (action === 'compile' && existsSync(file)) throw Error('Compilation requires a fresh run file');
      let input = plan as unknown as FlowPlan;
      if (plan.version === 2) {
        validatePlanningManifest(plan);
        const command = (c: PlanningManifest['tasks'][number]['checks'][number]) => checkCommand(c, join(runPaths(file).dir, 'flow-checks'));
        input = { version: 3, title: plan.title, nodes: plan.tasks.map(task => {
          const first = task.checks[0];
          if (!first) throw Error(`${task.id}: supply one fast acceptance check before migrating to Flow 3.0`);
          return { id: task.id, goal: task.objective, depends_on: (task.dependencies ?? []).map(d => d.owner),
            touches: (task.files ?? []).filter(f => f.role !== 'frozen').map(f => f.path),
            creates: (task.provides ?? []).map(p => p.id), relies_on: (task.inputs ?? []).map(i => i.capability),
            verify: command(first), cmd: task.cmd };
        }), settings: { additionalFinalChecks: [...new Set(plan.tasks.flatMap(t => [...t.checks.slice(1), ...(t.provides ?? []).map(p => p.check)]).map(command))] } };
      }
      const { run, report } = compileFlowPlan(input);
      if (action === 'validate') { emit(argv, report, () => JSON.stringify(report, null, 2)); return; }
      if (plan.version === 2) attachPlanning(run, plan);
      saveRun(run, file);
      emit(argv, { runId: run.id, tasks: Object.keys(run.tasks).length, profile: 'flow3', report }, () => `Compiled ${Object.keys(run.tasks).length} Flow 3.0 nodes`);
    } finally { releaseFlow?.(); }
    return;
  }
  const report = validatePlan(plan, root);
  if (action === 'validate') { emit(argv, report, () => JSON.stringify(report, null, 2)); if (!report.valid) process.exitCode = 1; return; }
  if (!report.valid) { emit(argv, report, () => JSON.stringify(report, null, 2)); process.exitCode = 1; return; }
  if (action === 'review') {
    const review = await reviewPlan(plan, root);
    if (planFile) atomicWriteJson(`${resolve(planFile)}.review.json`, review);
    else {
      const release = acquireLock(file, 'planning review receipt');
      try {
        const run = loadRun(file);
        if (run.planning?.revision !== review.revision) throw Error('Plan changed while review ran');
        run.planning.review = review; saveRun(run, file);
      } finally { release(); }
    }
    emit(argv, review, () => JSON.stringify(review, null, 2)); if (review.verdict !== 'pass') process.exitCode = 1; return;
  }
  const receiptFile = flag(argv, 'review') ?? (planFile ? `${resolve(planFile)}.review.json` : undefined);
  const review: PlanningReview | undefined = receiptFile && existsSync(receiptFile) ? validatePlanningReview(JSON.parse(readFileSync(receiptFile, 'utf8')), plan) : undefined;
  if (action === 'migrate') {
    emit(argv, migratePlan(file, plan, flagRequired(argv, 'reason'), review), () => 'Canonical migration committed; historical acceptance and budgets preserved'); return;
  }
  if (action === 'amend') {
    emit(argv, amendPlan(file, plan, flagRequired(argv, 'reason'), review), () => 'Planning amendment committed; accepted work and budgets preserved'); return;
  }
  if (report.semanticRequired && (!review || review.verdict !== 'pass')) throw Error('Run dag plan review --plan first; semantic approval is required for this plan');
  const release = acquireLock(file, 'planning compile');
  try {
    if (existsSync(file)) throw Error('Compilation requires a fresh run file; use a stopped amendment for an existing contract-managed run');
    const run = compilePlan(plan); run.planning!.review = review;
    Object.assign(run.settings, executionProfilePatch(flag(argv, 'profile')));
    atomicWriteJson(join(runPaths(file).dir, 'planning-validation.json'), report);
    saveRun(run, file);
    emit(argv, { runId: run.id, revision: report.revision, tasks: Object.keys(run.tasks).length }, () => `Compiled ${Object.keys(run.tasks).length} tasks`);
  } finally { release(); }
}
