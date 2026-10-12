import type { PlanningManifest, PlanningSizing, PlanningTask } from './contracts.js';

/**
 * Decomposition budget defaults. These are rule-of-thumb ceilings, not targets:
 * a task at the ceiling is already as large as a single bounded worker session
 * should be. The validator rejects oversized units for the planner to split;
 * it never truncates requirements or guesses new ownership boundaries.
 */
export const DEFAULT_SIZING: Required<PlanningSizing> = {
  maxSpecChars: 800, maxAcceptancePerTask: 2, maxOutputConcerns: 1,
};
export function sizingBudget(plan: PlanningManifest): Required<PlanningSizing> {
  return { ...DEFAULT_SIZING, ...(plan.sizing ?? {}) };
}
/** Authored worker-visible prose only: the brief a worker is asked to honour. */
export function taskBrief(task: PlanningTask, plan: PlanningManifest): string {
  const criteria = new Map(plan.criteria.map(c => [c.id, c.text]));
  return [
    task.title, task.objective, task.reviewBoundary,
    ...task.acceptance.map(id => criteria.get(id) ?? ''),
    ...(task.constraints ?? []),
    ...(task.inputs ?? []).map(input => input.contract),
    ...(task.provides ?? []).map(output => output.contract),
    ...outputConcerns(task).filter(concern => (task.files ?? []).some(file => file.concern === concern)),
  ].join(' ').trim();
}
/** Unlabelled outputs conservatively count separately; related files can share a concern. */
export function outputConcerns(task: PlanningTask): string[] {
  return [...new Set((task.files ?? []).filter(f => f.role === 'implementation' || f.role === 'generated').map(f => f.concern ?? f.path))];
}
export function taskSize(plan: PlanningManifest, task: PlanningTask): { chars: number; acceptance: number; concerns: number } {
  return { chars: taskBrief(task, plan).length, acceptance: task.acceptance.length, concerns: outputConcerns(task).length };
}

/**
 * Emits scope findings through the caller's finding sink so sizing reports carry
 * the same identity, evidence and correction shape as every other planning rule.
 */
export function lintSizing(plan: PlanningManifest,
  add: (rule: string, tasks: string[], references: string[], message: string, correction: string, evidence?: string[], warning?: boolean) => void,
): void {
  const budget = sizingBudget(plan);
  for (const task of plan.tasks) {
    const size = taskSize(plan, task);
    if (size.chars > budget.maxSpecChars) add('scope.oversized', [task.id], [task.id],
      `Task brief is ${size.chars} characters, over the ${budget.maxSpecChars} character budget`,
      `Split this task until each brief is at most ${budget.maxSpecChars} characters; move the surplus objective, review boundary or acceptance into its own task`,
      [`brief characters: ${size.chars}`, `budget: ${budget.maxSpecChars}`, taskBrief(task, plan)]);
    if (size.acceptance > budget.maxAcceptancePerTask) add('scope.acceptance', [task.id], task.acceptance,
      `Task owns ${size.acceptance} acceptance criteria, over the ${budget.maxAcceptancePerTask} criteria budget`,
      `Move the surplus criteria into their own tasks and keep the remaining criteria as this task's executable acceptance`,
      [`acceptance criteria: ${size.acceptance}`, `budget: ${budget.maxAcceptancePerTask}`, ...task.acceptance]);
    if (size.concerns > budget.maxOutputConcerns) add('scope.concerns', [task.id],
      (task.files ?? []).filter(f => f.role === 'implementation' || f.role === 'generated').map(f => f.path),
      `Task owns ${size.concerns} output concerns, over the ${budget.maxOutputConcerns} concern budget`,
      `Split into one task per independently verifiable output concern and declare each task's exact files; group related files only when they establish the same behavior`,
      [`output concerns: ${size.concerns}`, `budget: ${budget.maxOutputConcerns}`, ...outputConcerns(task)]);
  }
}
