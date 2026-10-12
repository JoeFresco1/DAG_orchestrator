import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { addTask, atomicWriteJson, newRun } from '../store.js';
import { DagRunner, shellExecutor, type Executor } from '../runner.js';
import { buildCodeGraph } from '../factory/code-graph.js';
import { createFactoryGraphModel } from '../factory/graph-model.js';
import { compileContext } from '../factory/context-compiler.js';
import { digest, assertPlanningRequirementsPreserved, type PlanningManifest, type PlanningFinding, type PlanningReview } from './contracts.js';
import { validatePlan } from './validation.js';
import { checkCommand } from './compile.js';
import { sizingBudget } from './sizing.js';

export function validatePlanningReview(value: unknown, plan: PlanningManifest): PlanningReview {
  if (!value || typeof value !== 'object') throw Error('Missing structured planning review');
  const r = value as PlanningReview;
  if (r.version !== 1 || r.revision !== digest(plan) || !['pass', 'fail', 'inconclusive'].includes(r.verdict) ||
    !r.reviewer?.trim() || !/^[a-f0-9]{64}$/.test(r.contextDigest ?? '') || !Array.isArray(r.findings)) throw Error('Invalid planning review identity/revision');
  const refs = new Set([...plan.requirements.map(v => v.id), ...plan.criteria.map(v => v.id), ...plan.sources.map(v => v.path), ...plan.tasks.flatMap(t => [t.id, ...(t.files ?? []).map(f => f.path)]), ...plan.tasks.flatMap(t => [...(t.provides ?? []).map(p => p.id), ...(t.inputs ?? []).map(i => i.capability)])]);
  const files = [...new Set([...plan.sources.map(s => s.path), ...plan.tasks.flatMap(t => (t.files ?? []).map(f => f.path))])];
  const registeredReference = (v: string) => typeof v === 'string' && (refs.has(v) || files.some(file => v.startsWith(`${file}:`) || v.startsWith(`${file}#`)));
  for (const f of r.findings) {
    if (!f || typeof f.id !== 'string' || !f.id || typeof f.rule !== 'string' || !f.rule ||
      typeof f.message !== 'string' || !f.message.trim() || typeof f.correction !== 'string' || !f.correction.trim() ||
      !['error', 'warning'].includes(f.severity) || typeof f.blocking !== 'boolean' ||
      !Array.isArray(f.tasks) || !f.tasks.length || f.tasks.some(t => !plan.tasks.some(v => v.id === t)) ||
      !Array.isArray(f.references) || !f.references.length || f.references.some(v => !registeredReference(v)) ||
      !Array.isArray(f.evidence) || !f.evidence.length || f.evidence.some(v => typeof v !== 'string' || !v.trim())) throw Error('Planning finding needs registered tasks/references, evidence and a concrete correction');
    if (f.blocking && f.severity !== 'error') throw Error('A warning cannot block execution');
  }
  if (r.verdict === 'pass' && r.findings.some(f => f.blocking) || r.verdict === 'fail' && !r.findings.some(f => f.blocking)) throw Error('Review verdict contradicts its specific findings');
  return r;
}

/** One independent reviewer, bounded by the existing runner's lifecycle. No graph edits. */
export async function reviewPlan(plan: PlanningManifest, root: string, executor?: Executor): Promise<PlanningReview> {
  const report = validatePlan(plan, root);
  if (!report.valid) throw Error('Correct deterministic findings before semantic review');
  const command = plan.semanticReview?.command;
  if (!command) throw Error('Configure semanticReview.command with {contextFile}; no reviewer model is selected implicitly');
  const directory = mkdtempSync(join(tmpdir(), 'dag-planning-review-'));
  try {
    const index = existsSync(join(root, 'tsconfig.json')) ? buildCodeGraph({ rootDir: root }) : {
      schemaVersion: 1 as const, files: [], graph: createFactoryGraphModel().graphs.code, requirements: [], links: [],
    };
    const packet = compileContext({ index, rootDir: root,
      request: `Review planning responsibility, prerequisite and acceptance boundaries for ${plan.title}`, specPaths: plan.sources.map(s => s.path) });
    // The full authoritative contract is never subject to the context compiler's relevance budget.
    const guidancePaths = new Set(['AGENTS.md', '.github/copilot-instructions.md']);
    for (const path of [...plan.sources.map(s => s.path), ...plan.tasks.flatMap(t => (t.files ?? []).map(f => f.path))]) {
      for (let directory = posix.dirname(path); directory !== '.'; directory = posix.dirname(directory)) guidancePaths.add(`${directory}/AGENTS.md`);
    }
    const guidance = [...guidancePaths].sort().filter(p => existsSync(join(root, p)))
      .map(path => ({ path, sha256: digest(readFileSync(join(root, path))), content: readFileSync(join(root, path), 'utf8') }));
    const protectedPaths = [...new Set([...index.files.map(f => f.path), ...plan.sources.map(s => s.path), ...guidance.map(g => g.path), ...plan.tasks.flatMap(t => (t.files ?? []).map(f => f.path))])];
    const before = digest(protectedPaths.map(p => [p, existsSync(join(root, p)) ? digest(readFileSync(join(root, p))) : null]));
    const budget = sizingBudget(plan);
    const context = { version: 1, revision: report.revision, plan, deterministic: report, packet, guidance,
      instructions: [
        'Independently review the proposed work against pinned specifications, AGENTS.md, applicable repository instructions, skills and interfaces.',
        'Check complete coverage, coherent bounded responsibilities, achievable intermediate acceptance, sufficient prerequisites and consistent interfaces.',
        `Check decomposition size against the plan budget: at most ${budget.maxSpecChars} characters of authored brief per task, at most ${budget.maxAcceptancePerTask} owned acceptance criteria, and at most ${budget.maxOutputConcerns} output concern per task. Report oversized tasks as scope.oversized, scope.acceptance or scope.concerns with the exact split you would make. Prefer many small independently verifiable tasks over few large ones.`,
        'A shared file concern must describe one observable behavior. Reject unrelated responsibilities grouped under a broad label even when numeric limits pass. Split scope without dropping original criteria, executable checks or producer/consumer prerequisites.',
        'Do not edit product code, plans, or run artifacts. Request missing authoritative evidence as an inconclusive finding, never infer approval.',
        'Return DAG_PLAN_REVIEW: followed by one JSON object. Use version 1, the exact revision/contextDigest below, reviewer identity, verdict pass/fail/inconclusive and findings.',
        'Every finding needs id, rule, tasks, registered references, evidence, severity error/warning, blocking, message and correction. Generic PASS/FAIL or confidence alone is insufficient.',
      ] };
    const contextDigest = digest(context), contextFile = join(directory, 'context.json');
    atomicWriteJson(contextFile, { ...context, contextDigest });
    const run = newRun('Independent planning review');
    run.settings.maxAttempts = 1;
    run.settings.maxWallClockMs = command.timeoutMs;
    run.settings.failOnNonZeroExit = true;
    const task = addTask(run, { title: 'Review planning contract', spec: JSON.stringify({ revision: report.revision, contextDigest, contextFile }),
      cmd: checkCommand({ ...command, id: 'planning-review', args: command.args.map(a => a.replaceAll('{contextFile}', contextFile)) }), timeoutMs: command.timeoutMs, maxAttempts: 1 });
    let output = '';
    const invoke = executor ?? shellExecutor(root);
    const runner = new DagRunner(run, { cwd: root, executor: async (t, ctx, cmd) => {
      const result = await invoke(t, ctx, cmd); output = result.output; return result;
    } });
    await runner.start();
    if (task.status !== 'completed' || task.exitCode !== 0) throw Error(`Planning review infrastructure/protocol failure: ${task.result}`);
    const line = output.split(/\r?\n/).find(v => v.startsWith('DAG_PLAN_REVIEW: '));
    if (!line) throw Error('Reviewer produced no structured planning findings');
    const result = validatePlanningReview(JSON.parse(line.slice('DAG_PLAN_REVIEW: '.length)), plan);
    if (result.contextDigest !== contextDigest) throw Error('Reviewer context identity changed');
    // Detect changes to pinned authority during review; a changed plan is never approved.
    const after = digest(protectedPaths.map(p => [p, existsSync(join(root, p)) ? digest(readFileSync(join(root, p))) : null]));
    if (before !== after || !validatePlan(plan, root).valid || digest(JSON.parse(readFileSync(contextFile, 'utf8')).plan) !== report.revision) throw Error('Reviewer changed authoritative planning inputs or product source');
    if (existsSync(join(root, 'tsconfig.json')) && digest(buildCodeGraph({ rootDir: root }).files) !== digest(index.files)) throw Error('Reviewer changed indexed product source inventory');
    return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function reviewCorrectionCycle(plan: PlanningManifest, root: string,
  correct: (plan: PlanningManifest, findings: PlanningFinding[]) => Promise<PlanningManifest>, executor?: Executor,
): Promise<{ plan: PlanningManifest; reviews: PlanningReview[] }> {
  const reviews: PlanningReview[] = [];
  for (let round = 0; round <= 2; round++) {
    const result = await reviewPlan(plan, root, executor); reviews.push(result);
    if (result.verdict === 'pass' || round === 2) return { plan, reviews };
    const updated = await correct(structuredClone(plan), result.findings);
    if (updated.id !== plan.id) throw Error('Correction cannot change planning identity');
    if (!validatePlan(updated, root).valid) throw Error('Correction violates deterministic planning validation');
    assertPlanningRequirementsPreserved(plan, updated);
    plan = updated;
  }
  throw Error('Unreachable review cycle');
}

export function correctionProposal(plan: PlanningManifest, findings: PlanningFinding[]): object {
  return { version: 1, revision: digest(plan), status: 'proposed', applyAutomatically: false,
    findings, affectedTasks: [...new Set(findings.flatMap(f => f.tasks))],
    requiredAction: 'Correct the canonical contract, validate and independently review it, then apply a stopped-run amendment. Preserve accepted work and remaining budgets.' };
}
