import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addTask, atomicWriteJson, newRun, runPaths, type AddTaskInput } from '../store.js';
import type { Run, Task } from '../types.js';
import { digest, validatePlanningCheck, type PlanningManifest, type PlanningTask, type PlanningCheck, type CompiledPlanning } from './contracts.js';
import { validatePlan } from './validation.js';

/** Keep check payloads out of command lines; retain files for persisted/resumed commands. */
export function checkCommand(check: PlanningCheck, payloadDir = join(runPaths(process.env.DAG_FILE || join(process.cwd(), 'dag.run.json')).dir, 'checks')): string {
  validatePlanningCheck(check);
  const script = join(dirname(fileURLToPath(import.meta.url)), 'check-command.js');
  const payloadFile = resolve(payloadDir, `${digest(check)}.json`);
  atomicWriteJson(payloadFile, check);
  const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return `${quote(process.execPath)} ${quote(script)} --file ${quote(payloadFile)}`;
}
export function renderPlanningTask(plan: PlanningManifest, task: PlanningTask): string {
  const local = plan.criteria.filter(c => c.owner === task.id);
  const deferred = plan.criteria.filter(c => c.owner !== task.id && (c.contributors.includes(task.id) || !!c.requirement && task.requirements.includes(c.requirement)));
  return [
    `Goal: ${plan.title}. Task: ${task.id}.`, `Objective: ${task.objective}`,
    `Responsibility and review boundary: ${task.reviewBoundary}`,
    `Authoritative sources: ${JSON.stringify(plan.sources)}`,
    `Requirement references: ${task.requirements.join(', ') || '(standalone task)'}`,
    `Owned files: ${JSON.stringify(task.files ?? [])}`,
    `Inputs: ${JSON.stringify(task.inputs ?? [])}`,
    `Provides: ${JSON.stringify(task.provides ?? [])}`,
    `Interfaces and constraints: ${JSON.stringify({ interfaces: task.interfaces ?? [], constraints: task.constraints ?? [] })}`,
    'Acceptance owned by this task:', ...local.map(c => `- ${c.id} [${c.stage}]: ${c.text}; checks: ${c.checks.join(', ')}`),
    `Executable checks: ${JSON.stringify(task.checks)}`,
    'Deferred integration/final obligations (context, not this task\'s rejection criteria):',
    ...deferred.map(c => `- ${c.id}: ${c.text}; verification owner: ${c.owner}; stage: ${c.stage}`),
    'Judge this task against its assigned acceptance only. Preserve all deferred requirements for their named verification owners.',
    'If a planning defect is reproduced, emit DAG_PLANNING_FINDINGS: followed by a JSON array. Each finding needs a stable id, rule (acceptance.future, acceptance.owner, capability.missing, capability.ambiguous, interface.incompatible, scope.ambiguous, scope.oversized, scope.acceptance, scope.concerns), tasks, registered references, specific evidence, severity error, blocking true, message and correction. Keep the same reason/ID for repeated evidence; ordinary implementation mistakes are not planning defects.',
  ].join('\n');
}
export function planningDefinition(task: Task): string {
  return digest({ id: task.id, title: task.title, spec: task.spec, deps: task.deps, cmd: task.cmd, reviewCmd: task.reviewCmd,
    reviewers: task.reviewers, planCmd: task.planCmd, prepareCmd: task.prepareCmd, harnessChain: task.harnessChain });
}
export function plannedTaskInput(plan: PlanningManifest, task: PlanningTask, deps: string[]): AddTaskInput {
  return { id: task.id, title: task.title, spec: renderPlanningTask(plan, task), deps,
    cmd: task.cmd ?? `"${process.execPath}" -e "process.exit(0)"`, reviewCmd: task.reviewCmd ?? null,
    reviewRounds: 0, ...(task.maxAttempts !== undefined ? { maxAttempts: task.maxAttempts } : {}) };
}
/** Pure compilation: never edits a persisted run or launches a worker. */
export function compilePlan(plan: PlanningManifest): Run {
  const report = validatePlan(plan);
  if (!report.valid) throw Error(`Invalid plan: ${report.findings.map(f => `${f.rule}: ${f.message}`).join('; ')}`);
  const run = newRun(plan.title), remaining = new Set(plan.tasks.map(t => t.id));
  while (remaining.size) {
    const task = plan.tasks.find(t => remaining.has(t.id) && report.dependencies[t.id]!.every(d => !!run.tasks[d.owner]));
    if (!task) throw Error('Plan cannot be topologically compiled');
    addTask(run, plannedTaskInput(plan, task, report.dependencies[task.id]!.map(d => d.owner)));
    remaining.delete(task.id);
  }
  attachPlanning(run, plan);
  return run;
}
export function attachPlanning(run: Run, plan: PlanningManifest): CompiledPlanning {
  const compiled: CompiledPlanning = { manifest: plan, revision: digest(plan), definitions: {} };
  for (const task of plan.tasks) {
    if (!run.tasks[task.id]) throw Error(`Missing compiled planning task ${task.id}`);
    compiled.definitions[task.id] = planningDefinition(run.tasks[task.id]!);
  }
  run.planning = compiled;
  run.planningState = { revision: compiled.revision, evidence: {}, failures: {}, holds: {} };
  return compiled;
}
