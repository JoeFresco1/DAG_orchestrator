import { digest } from './planning/contracts.js';
import type { Task, RunSettings } from './types.js';

export interface ExecutionBudget {
  version: 1; firstDispatchAt: string; deadlineAt: string; limit: number; used: number;
  infrastructureRetries: Record<string, number>;
  lastFailure?: { fingerprint: string; source: string; reason: string };
}

export function budgetFor(task: Task, settings: RunSettings, now = Date.now()): ExecutionBudget {
  const firstDispatch = task.attempts > 0 ? task.phaseHistory?.[0]?.startedAt ?? task.startedAt ?? task.createdAt : new Date(now).toISOString();
  return task.executionBudget ??= {
    version: 1, firstDispatchAt: firstDispatch,
    deadlineAt: new Date(Date.parse(firstDispatch) + (settings.taskDeadlineMs ?? 2_700_000)).toISOString(),
    limit: settings.implementationAttempts ?? 3, used: task.attempts, infrastructureRetries: {},
  };
}
export function budgetRemaining(task: Task, now = Date.now()): boolean {
  const budget = task.executionBudget;
  return !budget || budget.used < budget.limit && now < Date.parse(budget.deadlineAt);
}
export function remainingTaskTime(task: Task, now = Date.now()): number {
  return task.executionBudget ? Math.max(0, Date.parse(task.executionBudget.deadlineAt) - now) : Infinity;
}
/** Extend a stopped task's time window without resetting its lifetime attempt ledger. */
export function renewExecutionDeadline(task: Task, settings: RunSettings, now = Date.now(), additionalAttempts = 0): { previous: string; next: string; previousLimit: number; nextLimit: number } {
  const budget = task.executionBudget;
  if (!budget) throw new Error(`task ${task.id} has no shared execution budget`);
  if (!Number.isSafeInteger(additionalAttempts) || additionalAttempts < 0 || !Number.isSafeInteger(budget.limit + additionalAttempts)) {
    throw new Error('additional attempts must be a non-negative safe integer');
  }
  if (budget.used >= budget.limit + additionalAttempts) throw new Error(`task ${task.id} has exhausted its implementation attempt budget`);
  const duration = settings.taskDeadlineMs ?? 2_700_000;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('task deadline must be a positive finite duration');
  const previous = budget.deadlineAt;
  const next = new Date(now + duration).toISOString();
  const previousLimit = budget.limit;
  budget.limit += additionalAttempts;
  budget.deadlineAt = next;
  return { previous, next, previousLimit, nextLimit: budget.limit };
}
export function repeatedFailure(task: Task, reason: string, source: string): boolean {
  if (!task.executionBudget) return false;
  const fingerprint = digest(reason.replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, '<time>'));
  const prior = task.executionBudget.lastFailure;
  task.executionBudget.lastFailure = { fingerprint, source, reason: reason.slice(0, 1000) };
  return prior?.fingerprint === fingerprint && prior.source === source;
}
