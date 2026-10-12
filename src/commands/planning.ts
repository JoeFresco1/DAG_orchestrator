import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { emit, flag, flagRequired } from '../cli-args.js';
import { acquireLock, atomicWriteJson, loadRun, runPaths, saveRun } from '../store.js';
import { compilePlan } from '../planning/compile.js';
import { validatePlan } from '../planning/validation.js';
import { validatePlanningReview, reviewPlan, correctionProposal } from '../planning/review.js';
import { amendPlan, migratePlan } from '../planning/amend.js';
import type { PlanningManifest, PlanningReview } from '../planning/contracts.js';

export async function planningCmd(argv: string[]): Promise<void> {
  const action = argv[0] ?? 'validate', file = resolve(flag(argv, 'file') ?? 'dag.run.json');
  const planFile = flag(argv, 'plan');
  const root = resolve(flag(argv, 'cwd') ?? dirname(file));
  if (action === 'proposal') {
    const run = loadRun(file);
    if (!run.planning) throw Error('No planning contract on this legacy run');
    emit(argv, correctionProposal(run.planning.manifest, Object.values(run.planningState?.holds ?? {}).flat()), () => 'Inspect JSON correction proposal; apply only through a validated stopped amendment'); return;
  }
  if (!['validate', 'compile', 'review', 'amend', 'migrate'].includes(action)) throw Error('Expected plan validate|compile|review|amend|migrate|proposal');
  const plan = planFile ? JSON.parse(readFileSync(resolve(planFile), 'utf8')) as PlanningManifest : loadRun(file).planning?.manifest;
  if (!plan) throw Error('--plan is required for a run without a planning contract');
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
    atomicWriteJson(join(runPaths(file).dir, 'planning-validation.json'), report);
    saveRun(run, file);
    emit(argv, { runId: run.id, revision: report.revision, tasks: Object.keys(run.tasks).length }, () => `Compiled ${Object.keys(run.tasks).length} tasks`);
  } finally { release(); }
}
