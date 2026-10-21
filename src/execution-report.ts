import { readFileSync } from 'node:fs';
import { gateBlocks, getReady, isTerminal, topoSort, transitiveDepIds } from './graph.js';
import { missingPlanningAcceptance } from './planning/runtime.js';
import { admitPlanningTask } from './planning/validation.js';
import type { Run, Task } from './types.js';
import type { IntegrationReceipt } from './integration.js';
import { overlaps } from './flow3/graph.js';

export interface ExecutionReportOptions { root?: string; now?: number; concurrency?: number; scope?: Iterable<string> | null }
export interface ExecutionWaitReason { code: string; references: string[]; detail: string }
export interface PhaseTiming { invocations: number; totalMs: number; maxMs: number; averageMs: number; outcomes: Record<string, number> }
const timestamp = (value: string | null | undefined): number | undefined => {
  const number = value ? Date.parse(value) : NaN; return Number.isFinite(number) ? number : undefined;
};
/** A read-only snapshot of policy waits and measured work; never advances a scheduler. */
export function executionReport(run: Run, options: ExecutionReportOptions = {}) {
  const now = options.now ?? Date.now(), tasks = Object.values(run.tasks), scope = options.scope ? new Set(options.scope) : undefined;
  const concurrency = Math.max(1, options.concurrency ?? run.settings.concurrency);
  const active = tasks.filter(t => t.status === 'running').map(t => t.id), availableSlots = Math.max(0, concurrency - active.length);
  const waitReasons: Record<string, ExecutionWaitReason[]> = {}, phases: Record<string, PhaseTiming> = {};
  const counters = { implemented: 0, checked: 0, reviewed: 0, integrated: 0 };
  const starts: number[] = [], finishes: number[] = [], integrated: number[] = [];
  const noResourcePlan = run.planning ? { ...run.planning.manifest, tasks: run.planning.manifest.tasks.map(t => ({ ...t, resources: undefined })) } : undefined;
  const policyReasons = (task: Task, occupied: string[]): ExecutionWaitReason[] => {
    const reasons: ExecutionWaitReason[] = [];
    const add = (code: string, references: string[], detail: string): void => { reasons.push({ code, references, detail }); };
    if (scope && !scope.has(task.id)) add('outside-scope', [], 'Task is outside the selected execution scope');
    if (!task.cmd && !(task.harnessChain ?? run.settings.harnessChain).length) add('manual', [], 'Task requires manual completion');
    const pending = task.deps.filter(id => run.tasks[id]?.status !== 'completed');
    if (pending.length) add('dependencies', pending, 'Prerequisites have not completed');
    const failed = [task.id, ...transitiveDepIds(run, task.id)].filter(id => !run.tasks[id] || ['failed', 'skipped'].includes(run.tasks[id].status));
    if (failed.length) add('unusable-dependency', failed, 'Missing, failed or skipped prerequisite requires intervention');
    if (gateBlocks(task)) add('approval', [], task.gate?.question ?? 'Approval gate is closed');
    const held = [task.id, ...transitiveDepIds(run, task.id)].filter(id => !!run.planningState?.holds[id]);
    if (held.length && run.settings.executionProfile !== 'flow3') add('planning-hold', held, 'An evidence-backed planning hold blocks this task');
    if (run.settings.executionProfile === 'flow3') {
      const conflicts = occupied.filter(id => (run.tasks[id]?.node?.touches ?? []).some(a => task.node?.touches.some(b => overlaps(a, b))));
      if (conflicts.length) add('write-conflict', conflicts, 'Node touches overlap active work');
    }
    if (task.executionBudget && run.settings.executionProfile !== 'flow3') {
      if (task.executionBudget.used >= task.executionBudget.limit) add('implementation-budget', [], 'Durable implementation attempt budget is exhausted');
      if ((timestamp(task.executionBudget.deadlineAt) ?? 0) <= now) add('deadline', [], 'Total task deadline has elapsed');
    }
    const contract = run.planning?.manifest.tasks.find(t => t.id === task.id);
    if (contract && run.settings.executionProfile !== 'flow3') {
      const used: Record<string, number> = {};
      for (const id of occupied) for (const [name, count] of Object.entries(run.planning!.manifest.tasks.find(t => t.id === id)?.resources ?? {})) used[name] = (used[name] ?? 0) + count;
      const resources = Object.entries(contract.resources ?? {}).filter(([name, count]) => (used[name] ?? 0) + count > (run.planning!.manifest.capacities?.[name] ?? 0)).map(([name]) => name);
      if (resources.length) add('resources', resources, 'Declared resource capacity is occupied or insufficient');
      try {
        if (noResourcePlan && !admitPlanningTask(noResourcePlan, task.id, occupied, options.root)) {
          const conflicts = occupied.filter(id => !admitPlanningTask(noResourcePlan, task.id, [id], options.root));
          add('write-conflict', conflicts, 'Declared file or directory ownership overlaps active work');
        }
      } catch (error) { add('ownership-invalid', [], String(error)); }
    }
    return reasons;
  };
  for (const task of tasks) {
    if (task.status === 'running' && task.integrationQueuedAt) waitReasons[task.id] = [{ code: 'integration-queue', references: [], detail: `Waiting for serialized integration since ${task.integrationQueuedAt}` }];
    for (const value of [task.executionBudget?.firstDispatchAt, task.startedAt]) { const at = timestamp(value); if (at !== undefined) starts.push(at); }
    const finish = timestamp(task.finishedAt); if (finish !== undefined) finishes.push(finish);
    for (const [key, field] of [['implemented', 'implementedAt'], ['checked', 'checkedAt'], ['reviewed', 'reviewedAt'], ['integrated', 'integratedAt']] as const) {
      const at = timestamp(task.milestones?.[field]);
      if (at !== undefined) { counters[key]++; if (key === 'integrated') { integrated.push(at); finishes.push(at); } }
    }
    for (const phase of task.phaseHistory ?? []) {
      if (!Number.isFinite(phase.durationMs) || phase.durationMs < 0) continue;
      const timing = phases[phase.phase] ??= { invocations: 0, totalMs: 0, maxMs: 0, averageMs: 0, outcomes: {} };
      timing.invocations++; timing.totalMs += phase.durationMs; timing.maxMs = Math.max(timing.maxMs, phase.durationMs);
      timing.averageMs = timing.totalMs / timing.invocations; timing.outcomes[phase.outcome] = (timing.outcomes[phase.outcome] ?? 0) + 1;
      const start = timestamp(phase.startedAt), end = timestamp(phase.finishedAt);
      if (start !== undefined) starts.push(start); if (end !== undefined) finishes.push(end);
    }
    if (task.status === 'pending' || task.status === 'ready') {
      waitReasons[task.id] = policyReasons(task, active);
      if (!availableSlots) waitReasons[task.id].push({ code: 'concurrency', references: active, detail: 'All execution slots are occupied' });
    }
  }
  const admissible = topoSort(run).filter(t => (t.status === 'pending' || t.status === 'ready') && policyReasons(t, active).length === 0);
  const launchableTaskIds: string[] = [];
  for (const task of admissible) {
    if (launchableTaskIds.length >= availableSlots) break;
    if (policyReasons(task, [...active, ...launchableTaskIds]).length === 0) launchableTaskIds.push(task.id);
  }
  const firstDispatch = starts.length ? Math.min(...starts) : undefined;
  const finished = tasks.length > 0 && tasks.every(t => isTerminal(t.status));
  const end = finished && finishes.length ? Math.min(now, Math.max(...finishes)) : now;
  const elapsedMs = firstDispatch === undefined ? null : Math.max(0, end - firstDispatch);
  const missingCriteria = missingPlanningAcceptance(run), missing = new Set(missingCriteria);
  const acceptedCriteria = run.planning?.manifest.criteria.filter(c => !missing.has(c.id)).map(c => c.id) ?? [];
  const acceptedRequirements = run.planning?.manifest.requirements.filter(r => r.acceptance.length > 0 && r.acceptance.every(id => acceptedCriteria.includes(id))).map(r => r.id) ?? [];
  const missingRequirements = run.planning?.manifest.requirements.filter(r => !acceptedRequirements.includes(r.id)).map(r => r.id) ?? [];
  const receiptTasks: string[] = [], receiptErrors: { taskId: string; detail: string }[] = [];
  for (const task of tasks.filter(t => !!t.integrationReceipt)) {
    try {
      const receipt = JSON.parse(readFileSync(task.integrationReceipt!, 'utf8')) as IntegrationReceipt;
      if (receipt.version !== 1 || receipt.stage !== 'published' || !receipt.verification?.passed || receipt.taskId !== task.id ||
        receipt.attempt !== task.attempts || receipt.runId !== run.id || receipt.attemptId !== `${run.id}/${task.id}/${task.attempts}` ||
        !/^[a-f0-9]{40,64}$/.test(receipt.candidateCommit)) throw Error('Receipt is unpublished, unverified or belongs to another run/task attempt');
      receiptTasks.push(task.id);
    } catch (error) { receiptErrors.push({ taskId: task.id, detail: String(error) }); }
  }
  const rate = (count: number): number | null => elapsedMs && elapsedMs > 0 ? count * 3_600_000 / elapsedMs : null;
  return {
    version: 1 as const, at: new Date(now).toISOString(), concurrency, running: active.length, availableSlots,
    readySetWidth: getReady(run).filter(t => !scope || scope.has(t.id)).length,
    admissibleReadyWidth: admissible.length, launchableWidth: launchableTaskIds.length, launchableTaskIds, waitReasons,
    milestones: counters, phases,
    elapsedMs, firstDispatchAt: firstDispatch === undefined ? null : new Date(firstDispatch).toISOString(),
    timeToFirstIntegratedMs: firstDispatch === undefined || !integrated.length ? null : Math.max(0, Math.min(...integrated) - firstDispatch),
    acceptance: { criteria: acceptedCriteria.length, requirements: acceptedRequirements.length,
      acceptedCriteria, acceptedRequirements, missingCriteria, missingRequirements,
      criteriaPerHour: rate(acceptedCriteria.length), requirementsPerHour: rate(acceptedRequirements.length) },
    integration: { publishedReceiptTasks: receiptTasks, receiptErrors },
    flow3: run.flowState ?? null,
  };
}
