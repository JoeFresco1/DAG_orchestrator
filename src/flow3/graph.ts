import { addTask, newRun } from '../store.js';
import type { Run, Task } from '../types.js';
import { executionProfilePatch } from '../execution-policy.js';
import { safeRelativePath, validateFlowSettings, type FlowPlan, type NodeBrief } from './contracts.js';

export interface GraphReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  addedEdges: Array<{ consumer: string; producer: string }>;
  waves: string[][];
}
const key = (s: string) => process.platform === 'win32' ? s.replaceAll('\\', '/').toLowerCase() : s.replaceAll('\\', '/');
export const overlaps = (a: string, b: string): boolean => key(a) === key(b) || key(a).startsWith(`${key(b)}/`) || key(b).startsWith(`${key(a)}/`);

export function validateBrief(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['node brief must be an object'];
  const node = value as NodeBrief;
  const errors: string[] = [];
  if (typeof node.goal !== 'string' || !node.goal.trim()) errors.push('goal is required');
  if (typeof node.verify !== 'string' || !node.verify.trim() || /[\0\r\n]/.test(node.verify)) errors.push('one verify command is required');
  if (!Array.isArray(node.touches) || !node.touches.every(safeRelativePath)) errors.push('touches must contain repository relative paths');
  for (const field of ['creates', 'relies_on'] as const) if (!Array.isArray(node[field]) || !node[field].every(s => typeof s === 'string' && !!s.trim() && !/[\0\r\n]/.test(s))) errors.push(`${field} must contain file or symbol names`);
  if (node.verify_requires !== undefined && (!Array.isArray(node.verify_requires) || !node.verify_requires.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)))) errors.push('verify_requires must contain producer IDs');
  if (node.repair_of !== undefined && (typeof node.repair_of !== 'string' || !node.repair_of.trim() || /[\0\r\n]/.test(node.repair_of))) errors.push('repair_of must identify a checkpoint');
  return errors;
}

/** The only automatic graph mutation is an unambiguous producer edge. No LLM or IO. */
export function checkGraph(run: Run, autoFix = true): GraphReport {
  const errors: string[] = [], warnings: string[] = [], addedEdges: GraphReport['addedEdges'] = [];
  const tasks = Object.values(run.tasks), deps = new Map(tasks.map(t => [t.id, [...t.deps]]));
  for (const [id, t] of Object.entries(run.tasks)) {
    if (id !== t.id) errors.push(`Task key ${id} differs from ID ${t.id}`);
    for (const dep of t.deps) if (!deps.has(dep)) errors.push(`${id}: missing dependency ${dep}`);
    for (const dep of t.node?.verify_requires ?? []) if (!deps.has(dep)) errors.push(`${id}: missing verification producer ${dep}`);
    if (t.node) {
      errors.push(...validateBrief(t.node).map(e => `${id}: ${e}`));
      if (t.node.goal.length > 800 || t.node.touches.length > 8) warnings.push(`${id}: consider splitting this node`);
    } else warnings.push(`${id}: legacy task has no Flow 3.0 brief or fast verify command`);
  }
  for (const [command, ids] of Object.entries(run.settings.flow3?.checkPrerequisites ?? {})) {
    for (const id of ids) if (!deps.has(id)) errors.push(`Check ${command}: missing producer ${id}`);
  }
  if (errors.length) return { valid: false, errors, warnings, addedEdges, waves: [] };
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (deps.get(from) ?? []).some(id => reaches(id, target, seen));
  };
  const producers = new Map<string, string[]>();
  for (const task of tasks) for (const owner of task.node?.verify_requires ?? []) {
    if (owner === task.id) { errors.push(`Verification dependency ${task.id} -> ${owner} would create a cycle`); continue; }
    if (reaches(task.id, owner)) continue;
    if (reaches(owner, task.id)) errors.push(`Verification dependency ${task.id} -> ${owner} would create a cycle`);
    else if (autoFix) { deps.get(task.id)!.push(owner); addedEdges.push({ consumer: task.id, producer: owner }); }
    else errors.push(`${task.id}: undeclared verification dependency on ${owner}`);
  }
  for (const task of tasks) for (const created of task.node?.creates ?? []) producers.set(key(created), [...(producers.get(key(created)) ?? []), task.id]);
  for (const [created, ids] of producers) if (new Set(ids).size > 1) errors.push(`Ambiguous creator for ${created}: ${ids.join(', ')}`);
  for (const task of tasks) {
    const needs = [...(task.node?.touches ?? []), ...(task.node?.relies_on ?? [])];
    for (const [created, owners] of producers) {
      if (owners.length !== 1 || owners[0] === task.id || !needs.some(n => overlaps(n.split('#')[0], created.split('#')[0]) || key(n) === created)) continue;
      const owner = owners[0];
      if (reaches(task.id, owner)) continue;
      if (reaches(owner, task.id)) { errors.push(`Undeclared dependency ${task.id} -> ${owner} would create a cycle`); continue; }
      if (autoFix) { deps.get(task.id)!.push(owner); addedEdges.push({ consumer: task.id, producer: owner }); }
      else errors.push(`${task.id}: undeclared dependency on ${owner} for ${created}`);
    }
  }
  const remaining = new Set(tasks.map(t => t.id)), done = new Set<string>(), waves: string[][] = [];
  while (remaining.size) {
    const wave = tasks.filter(t => remaining.has(t.id) && deps.get(t.id)!.every(d => done.has(d))).map(t => t.id);
    if (!wave.length) { errors.push(`Dependency cycle: ${[...remaining].join(', ')}`); break; }
    waves.push(wave);
    for (const id of wave) { done.add(id); remaining.delete(id); }
  }
  if (!errors.length && autoFix) for (const task of tasks) task.deps = deps.get(task.id)!;
  return { valid: !errors.length, errors, warnings, addedEdges: errors.length ? [] : addedEdges, waves };
}

/** Maximal straight chains are one worker session; branches form new units. */
export function chainWaves(run: Run, scope: Set<string>): string[][][] {
  const children = new Map<string, string[]>();
  for (const task of Object.values(run.tasks)) for (const dep of task.deps) children.set(dep, [...(children.get(dep) ?? []), task.id]);
  const units: string[][] = [], seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !scope.has(id)) return;
    const t = run.tasks[id];
    if (t.deps.length === 1 && scope.has(t.deps[0]) && !seen.has(t.deps[0]) && children.get(t.deps[0])?.length === 1) { visit(t.deps[0]); if (seen.has(id)) return; }
    const chain: string[] = []; let next: string | undefined = id;
    while (next && scope.has(next) && !seen.has(next)) {
      chain.push(next); seen.add(next);
      const list: string[] = children.get(next) ?? [];
      const child: string | undefined = list.length === 1 ? list[0] : undefined;
      next = child && run.tasks[child].deps.length === 1 ? child : undefined;
    }
    units.push(chain);
  };
  for (const id of scope) visit(id);
  const waves: string[][][] = [], completed = new Set(Object.keys(run.tasks).filter(id => !scope.has(id)));
  let remaining = [...units];
  while (remaining.length) {
    const wave = remaining.filter(chain => run.tasks[chain[0]].deps.every(id => completed.has(id)));
    if (!wave.length) throw Error('Cannot build execution waves: unresolved dependency cycle');
    waves.push(wave);
    for (const chain of wave) for (const id of chain) completed.add(id);
    remaining = remaining.filter(unit => !wave.includes(unit));
  }
  return waves;
}

/** Compile authored, small nodes; IDs and missing dependencies fail before any write. */
export function compileFlowPlan(value: unknown): { run: Run; report: GraphReport } {
  const plan = value as FlowPlan;
  if (!plan || plan.version !== 3 || typeof plan.title !== 'string' || !plan.title.trim() || !Array.isArray(plan.nodes)) throw Error('Expected version 3 plan with title and nodes');
  if (plan.cmd !== undefined && (typeof plan.cmd !== 'string' || !plan.cmd.trim())) throw Error('cmd must be a command');
  if (plan.settings) {
    const errors = validateFlowSettings(plan.settings);
    if (errors.length) throw Error(errors.map(e => `${e.field}: ${e.reason}`).join('; '));
  }
  const run = newRun(plan.title); Object.assign(run.settings, executionProfilePatch('flow3'));
  run.settings.flow3 = plan.settings;
  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (!node || typeof node.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(node.id) || ids.has(node.id)) throw Error(`Invalid or duplicate node ID: ${node?.id}`);
    ids.add(node.id);
    const errors = validateBrief(node);
    if (!Array.isArray(node.depends_on) || !node.depends_on.every(d => typeof d === 'string')) errors.push('depends_on must be an ID array');
    if (node.cmd !== undefined && (typeof node.cmd !== 'string' || !node.cmd.trim())) errors.push('cmd must be a command');
    if (errors.length) throw Error(`${node.id}: ${errors.join('; ')}`);
    const { id, depends_on, cmd, ...brief } = node;
    addTask(run, { id, title: brief.goal, spec: brief.goal, node: brief, cmd: cmd ?? plan.cmd ?? null });
  }
  for (const node of plan.nodes) run.tasks[node.id].deps = [...new Set(node.depends_on)];
  const report = checkGraph(run);
  if (!report.valid) throw Error(report.errors.join('; '));
  return { run, report };
}

export function promptFor(task: Task, retry: boolean): string {
  const node = task.node;
  return [
    `Node ${task.id}: ${node?.goal ?? task.spec}`,
    `Edit: ${node?.touches.join(', ') || '(use the task scope)'}.`,
    `Create: ${node?.creates.join(', ') || '(none)'}.`,
    `Available interfaces: ${node?.relies_on.join(', ') || '(none declared)'}.`,
    'Start editing from these file hints. Implement only this node; no planning or review phase.',
    `The runner executes the node verification after you return: ${node?.verify ?? '(configured by the runner)'}.`,
    'The runner owns wave and final acceptance suites and their separate time budgets. Implement the required behavior, tests and evidence files, then return. Do not launch or wait for repository-wide acceptance suites in this implementation phase. Record checks you have not run as pending runner verification; never claim they passed.',
    ...(retry ? [`Previous failure: ${(task.lastRejection ?? '').slice(-2500)}. Fix that specific failure.`] : []),
  ].join('\n');
}
