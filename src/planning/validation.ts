import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { digest, validatePlanningManifest, type PlanningManifest, type PlanningFinding, type PlanningReport, type PlanningInterface } from './contracts.js';
import { lintAcceptance } from './acceptance-lint.js';

export function planningFile(root: string, file: string): string {
  const target = resolve(root, file), rel = relative(root, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw Error('Planning path escapes repository');
  if (existsSync(target)) {
    const actual = relative(realpathSync(root), realpathSync(target));
    if (isAbsolute(actual) || actual === '..' || actual.startsWith('../') || actual.startsWith('..\\')) throw Error('Planning symlink escapes repository');
  }
  return target;
}
export function compatible(wanted: PlanningInterface | undefined, actual: PlanningInterface | undefined): boolean {
  return !wanted || !!actual && wanted.id === actual.id && wanted.version === actual.version && (!wanted.digest || wanted.digest === actual.digest);
}
export function validatePlan(value: unknown, root?: string): PlanningReport {
  const findings: PlanningFinding[] = [];
  const add = (rule: string, tasks: string[], references: string[], message: string, correction: string, evidence = references, warning = false): void => {
    findings.push({ id: digest({ rule, tasks, references, message }).slice(0, 24), rule, tasks, references, evidence,
      severity: warning ? 'warning' : 'error', blocking: !warning, message, correction });
  };
  try { validatePlanningManifest(value); } catch (e) {
    add('contract.invalid', [], [], String(e), 'Supply a valid version 2 planning manifest', [String(e)]);
    return { version: 1, revision: digest(value), valid: false, findings, dependencies: {}, semanticRequired: false };
  }
  const plan: PlanningManifest = value, tasks = new Map(plan.tasks.map(t => [t.id, t]));
  const criteria = new Map(plan.criteria.map(c => [c.id, c]));
  const requirements = new Map(plan.requirements.map(r => [r.id, r]));
  const dependencies: PlanningReport['dependencies'] = {};
  const unique = (ids: string[], rule: string, owner: string[] = []): void => {
    for (const id of new Set(ids)) if (ids.filter(v => v === id).length > 1) add(rule, owner, [id], `Duplicate identity ${id}`, 'Assign a unique stable identity');
  };
  unique(plan.tasks.map(t => t.id), 'task.duplicate'); unique(plan.criteria.map(c => c.id), 'criterion.duplicate'); unique(plan.requirements.map(r => r.id), 'requirement.duplicate');
  unique(plan.sources.map(s => s.path), 'source.duplicate');
  const checkSource = (path: string, sha: string, owner: string[]): void => {
    if (!root) return;
    try { const file = planningFile(root, path); if (!existsSync(file) || digest(readFileSync(file)) !== sha) add('input.unavailable', owner, [path], 'Missing or changed authoritative input', 'Bind the plan to an available exact input revision'); }
    catch (e) { add('input.unavailable', owner, [path], String(e), 'Use an input within the repository'); }
  };
  plan.sources.forEach(s => checkSource(s.path, s.sha256, []));
  // Decomposition size is a structural rule: it is checked before relationships
  // so an oversized brief is split before anyone reasons about its ownership.
  for (const [name, capacity] of Object.entries(plan.capacities ?? {})) if (!Number.isSafeInteger(capacity) || capacity < 1) add('resource.capacity', [], [name], 'Invalid resource capacity', 'Set a positive integer capacity');
  for (const task of plan.tasks) {
    unique(task.acceptance, 'acceptance.duplicate', [task.id]);
    unique(task.requirements, 'requirement.duplicate', [task.id]);
    unique((task.dependencies ?? []).map(d => d.owner), 'dependency.duplicate', [task.id]);
    unique(task.checks.map(c => c.id), 'check.duplicate', [task.id]);
    const checks = new Map(task.checks.map(c => [c.id, c]));
    for (const promise of task.provides ?? []) {
      const prior = checks.get(promise.check.id);
      if (prior && digest(prior) !== digest(promise.check)) add('check.conflict', [task.id], [promise.check.id], 'One check ID identifies different commands', 'Assign distinct IDs or one shared check');
      checks.set(promise.check.id, promise.check);
    }
    unique((task.provides ?? []).map(c => c.id), 'capability.duplicate', [task.id]);
    unique((task.files ?? []).map(f => f.path), 'ownership.duplicate', [task.id]);
    dependencies[task.id] = [...(task.dependencies ?? [])];
    for (const d of task.dependencies ?? []) {
      if (!tasks.has(d.owner)) add('dependency.unknown', [task.id], [d.owner], 'Unknown dependency', 'Register the prerequisite task');
      if (!d.reason.trim() || !d.evidence.length) add('dependency.unexplained', [task.id, d.owner], [], 'Dependency lacks a reason or evidence', 'Document the execution prerequisite or remove the edge');
    }
    for (const r of task.requirements) if (!requirements.has(r)) add('requirement.unknown', [task.id], [r], 'Unknown requirement', 'Reference a registered requirement');
    for (const c of task.acceptance) if (!criteria.has(c) || criteria.get(c)?.owner !== task.id) add('acceptance.owner', [task.id], [c], 'Task acceptance is not owned by this task', 'Assign local acceptance to its actual verifier');
    for (const f of task.files ?? []) if (f.role === 'frozen') checkSource(f.path, f.digest!, [task.id]);
    if (task.entryPoint && !(task.files ?? []).some(f => f.path === task.entryPoint)) add('ownership.entrypoint', [task.id], [task.entryPoint], 'Entry point is outside declared ownership', 'Declare the entry point file');
    for (const [name, demand] of Object.entries(task.resources ?? {})) if (!Number.isSafeInteger(demand) || demand < 1 || demand > (plan.capacities?.[name] ?? 0)) add('resource.unachievable', [task.id], [name], 'Resource demand cannot be admitted', 'Declare a sufficient resource capacity');
    for (const input of task.inputs ?? []) {
      if (input.baseline) {
        if (input.owner || !input.check) add('capability.baseline', [task.id], [input.capability], 'Baseline input needs a readiness check and no planned owner', 'Declare a checked baseline or a task producer');
        checkSource(input.baseline.path, input.baseline.sha256, [task.id]); continue;
      }
      const producers = plan.tasks.filter(t => (t.provides ?? []).some(p => p.id === input.capability) && (!input.owner || t.id === input.owner));
      if (producers.length !== 1) { add(producers.length ? 'capability.ambiguous' : 'capability.missing', [task.id, ...producers.map(p => p.id)], [input.capability], producers.length ? 'Multiple declared producers' : 'No declared producer', 'Register or explicitly select a producer'); continue; }
      const producer = producers[0]!, promise = producer.provides!.find(p => p.id === input.capability)!;
      if (!compatible(input.interface, promise.interface)) add('interface.incompatible', [task.id, producer.id], [input.capability], 'Consumer and producer interface identities differ', 'Agree on a shared interface version/digest', [JSON.stringify(input.interface), JSON.stringify(promise.interface)]);
      if (!dependencies[task.id]!.some(d => d.owner === producer.id)) dependencies[task.id]!.push({ owner: producer.id, reason: `Requires capability ${input.capability}`, evidence: [input.contract, promise.contract] });
    }
  }
  const ancestors = new Map<string, Set<string>>(), visiting = new Set<string>();
  const walk = (id: string): Set<string> => {
    if (visiting.has(id)) { add('dependency.cycle', [id], [id], 'Execution dependency cycle', 'Correct the producer or ordering relationship'); return new Set(); }
    if (ancestors.has(id)) return ancestors.get(id)!;
    visiting.add(id); const set = new Set<string>();
    for (const d of dependencies[id] ?? []) { set.add(d.owner); if (tasks.has(d.owner)) walk(d.owner).forEach(a => set.add(a)); }
    visiting.delete(id); ancestors.set(id, set); return set;
  };
  plan.tasks.forEach(t => walk(t.id));
  findings.push(...lintAcceptance(plan, dependencies, root ? file => readFileSync(planningFile(root, file)) : undefined));
  for (const r of plan.requirements) for (const id of r.acceptance) {
    const c = criteria.get(id);
    if (!c || c.requirement !== r.id) add('coverage.missing', [], [r.id, id], 'Original criterion lacks a matching registry entry', 'Restore the unchanged criterion with a verification owner');
    if (!plan.tasks.some(t => t.requirements.includes(r.id))) add('coverage.implementation', [], [r.id], 'Requirement has no task contributor', 'Assign implementation ownership');
  }
  for (const c of plan.criteria) {
    const owner = tasks.get(c.owner);
    if (c.requirement && !c.contributors.length) add('coverage.contributor', [c.owner], [c.id], 'Original acceptance has no implementation contributor', 'Assign its implementation contributors without dropping acceptance');
    if (!owner || !owner.acceptance.includes(c.id)) add('coverage.owner', [c.owner], [c.id], 'Criterion has no recorded executable verification owner', 'Register its owning task and acceptance assignment');
    if (c.requirement && !requirements.get(c.requirement)?.acceptance.includes(c.id)) add('coverage.orphan', [c.owner], [c.id], 'Criterion is outside its original requirement registry', 'Retain the original requirement-to-criterion mapping');
    if (c.source && !plan.sources.some(s => s.path === c.source)) add('criterion.source', [c.owner], [c.id, c.source], 'Criterion source is not pinned', 'Register its authoritative source digest');
    for (const check of c.checks) if (!owner?.checks.some(v => v.id === check)) add('acceptance.check', [c.owner], [c.id, check], 'Criterion lacks its executable check', 'Register the owning check');
    for (const contributor of c.contributors) {
      if (!tasks.has(contributor)) add('coverage.contributor', [c.owner, contributor], [c.id], 'Unknown implementation contributor', 'Assign an existing task');
      else if (c.requirement && !tasks.get(contributor)!.requirements.includes(c.requirement)) add('coverage.contributor', [contributor], [c.id, c.requirement], 'Contributor does not declare this requirement', 'Trace the contributing task to its requirement');
      else if (contributor !== c.owner && !ancestors.get(c.owner)?.has(contributor)) {
        if (c.stage === 'local') add('acceptance.future', [c.owner, contributor], [c.id], 'Local acceptance requires work outside its prerequisites', 'Move composed acceptance to integration/final verification or correct prerequisites');
        else add('acceptance.prerequisite', [c.owner, contributor], [c.id], 'Integration verifier precedes a contributor', 'Declare all implementation contributors as prerequisites');
      }
    }
    for (const capability of c.requires ?? []) if (!owner?.inputs?.some(i => i.capability === capability) && !owner?.provides?.some(i => i.id === capability)) add('acceptance.input', [c.owner], [c.id, capability], 'Acceptance prerequisite has no declared input or owned output', 'Declare the capability and producer');
  }
  for (let a = 0; a < plan.tasks.length; a++) for (const b of plan.tasks.slice(a + 1)) {
    const first = plan.tasks[a]!;
    for (const f of first.files ?? []) for (const g of b.files ?? []) if (f.path === g.path && f.role !== g.role) add('ownership.role', [first.id, b.id], [f.path], 'Shared file has conflicting roles', 'Agree on the file role');
    for (const i of first.interfaces ?? []) for (const j of b.interfaces ?? []) if (i.id === j.id && (!compatible(i, j) || !compatible(j, i))) add('interface.conflict', [first.id, b.id], [i.id], 'Tasks assume incompatible shared interfaces', 'Pin one agreed interface', [JSON.stringify(i), JSON.stringify(j)]);
  }
  const risk = plan.requirements.some(r => plan.tasks.filter(t => t.requirements.includes(r.id)).length > 1) || plan.criteria.some(c => c.stage !== 'local' || c.contributors.length > 1) || plan.tasks.some(t => (t.inputs?.length ?? 0) > 0 || (t.interfaces?.length ?? 0) > 0 || (t.files ?? []).filter(f => f.role === 'implementation' || f.role === 'generated').length > 1);
  const mode = plan.semanticReview?.mode ?? 'auto';
  return { version: 1, revision: digest(plan), valid: !findings.some(f => f.blocking), findings, dependencies,
    semanticRequired: mode === 'required' || mode === 'auto' && risk };
}

/** Mutual exclusion is deliberately separate from execution dependencies. */
export function admitPlanningTask(plan: PlanningManifest, id: string, active: Iterable<string>): boolean {
  const task = plan.tasks.find(t => t.id === id); if (!task) return true;
  const writes = new Set((task.files ?? []).filter(f => f.role !== 'frozen').map(f => f.path));
  const used: Record<string, number> = {};
  for (const otherId of active) {
    const other = plan.tasks.find(t => t.id === otherId); if (!other) continue;
    if ((other.files ?? []).some(f => f.role !== 'frozen' && writes.has(f.path))) return false;
    for (const [name, count] of Object.entries(other.resources ?? {})) used[name] = (used[name] ?? 0) + count;
  }
  return Object.entries(task.resources ?? {}).every(([name, count]) => (used[name] ?? 0) + count <= (plan.capacities?.[name] ?? 0));
}
