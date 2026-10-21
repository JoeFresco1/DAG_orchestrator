import { canonical, digest, validatePlanningManifest, safePlanningPath,
  type PlanningManifest, type PlanningSource, type PlanningTask, type PlanningFinding, type PlanningReport } from './contracts.js';
import { validatePlan } from './validation.js';

export interface PlanningFragments {
  version: 1; id: string; title: string;
  baseline: { commit: string; sources: PlanningSource[] };
  fragments: { namespace: string; baselineCommit: string; manifest: PlanningManifest; sharedTasks?: string[] }[];
}
const sorted = <T extends { id: string }>(values: T[]): T[] => values.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const unique = (values: string[]): string[] => [...new Set(values)].sort();
/** Explicit shared identities are deduplicated; similar-looking work is never silently discarded. */
export function normalizeFragments(input: PlanningFragments, root?: string): { manifest: PlanningManifest; report: PlanningReport } {
  if (!input || input.version !== 1 || !input.id || !input.title || !/^[a-f0-9]{40}$/.test(input.baseline?.commit ?? '') ||
    !Array.isArray(input.baseline.sources) || !Array.isArray(input.fragments) || !input.fragments.length) throw Error('Expected version 1 fragments with a pinned baseline commit');
  const findings: PlanningFinding[] = [];
  const add = (rule: string, refs: string[], message: string): void => {
    findings.push({ id: digest({ rule, refs, message }).slice(0, 24), rule, tasks: [], references: refs, evidence: refs,
      severity: 'error', blocking: true, message, correction: 'Resolve the conflicting fragment declarations explicitly; retain all requirements' });
  };
  const plan: PlanningManifest = { version: 2, id: input.id, title: input.title, sources: [], requirements: [], criteria: [], tasks: [],
    semanticReview: { mode: 'off' }, provenance: { baselineCommit: input.baseline.commit, baselineSources: [...input.baseline.sources].sort((a, b) => a.path.localeCompare(b.path)), fragments: [] } };
  const sources = new Map<string, PlanningSource>(), tasks = new Map<string, PlanningTask>(), namespaces = new Set<string>();
  const identities = new Map<string, string>();
  const checkSource = (source: PlanningSource): void => {
    safePlanningPath(source.path);
    if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw Error('Baseline source needs exact sha256');
    const key = process.platform === 'win32' ? source.path.toLowerCase() : source.path;
    const prior = sources.get(key);
    if (prior && prior.sha256 !== source.sha256) add('import.source-conflict', [source.path, prior.sha256, source.sha256], 'One source path has different pinned contents');
    else sources.set(key, source);
  };
  for (const source of input.baseline.sources) {
    safePlanningPath(source.path);
    if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw Error('Baseline source needs exact sha256');
  }
  if (new Set(input.baseline.sources.map(s => s.path)).size !== input.baseline.sources.length) throw Error('Duplicate baseline source identity');
  const globalShared = new Set(input.fragments.flatMap(f => f.sharedTasks ?? []));
  for (const fragment of [...input.fragments].sort((a, b) => a.namespace.localeCompare(b.namespace))) {
    const ns = fragment.namespace;
    if (!/^[A-Za-z0-9_-]+$/.test(ns) || namespaces.has(ns)) throw Error(`Invalid or duplicate fragment namespace ${ns}`);
    namespaces.add(ns); validatePlanningManifest(fragment.manifest);
    if (fragment.baselineCommit !== input.baseline.commit) add('import.baseline-conflict', [ns, fragment.baselineCommit, input.baseline.commit], 'Fragment does not use the shared pinned baseline');
    const manifest = fragment.manifest, shared = new Set(fragment.sharedTasks ?? []);
    for (const [kind, values] of [['task', manifest.tasks], ['requirement', manifest.requirements], ['criterion', manifest.criteria]] as const) {
      if (new Set(values.map(v => v.id)).size !== values.length) throw Error(`Duplicate ${kind} identity within fragment ${ns}`);
    }
    for (const id of shared) if (!manifest.tasks.some(t => t.id === id)) add('import.identity-conflict', [ns, id], 'Shared task identity is absent from fragment');
    const taskId = (id: string): string => shared.has(id) || globalShared.has(id) && !manifest.tasks.some(t => t.id === id)
      ? id : `task_${ns}.${id.replace(/^task_/, '')}`;
    const ref = (id: string): string => `${ns}:${id}`;
    const check = (value: PlanningTask['checks'][number]): PlanningTask['checks'][number] => ({ ...value, id: ref(value.id) });
    manifest.sources.forEach(checkSource);
    const requirementMap = Object.fromEntries(manifest.requirements.map(r => [r.id, ref(r.id)]));
    const criterionMap = Object.fromEntries(manifest.criteria.map(c => [c.id, ref(c.id)]));
    plan.provenance!.fragments.push({ namespace: ns, revision: digest(manifest), requirements: requirementMap, criteria: criterionMap });
    plan.requirements.push(...manifest.requirements.map(r => ({ ...r, id: ref(r.id), acceptance: r.acceptance.map(ref) })));
    plan.criteria.push(...manifest.criteria.map(c => ({ ...c, id: ref(c.id), requirement: c.requirement ? ref(c.requirement) : undefined,
      owner: taskId(c.owner), contributors: c.contributors.map(taskId), checks: c.checks.map(ref) })));
    for (const original of manifest.tasks) {
      const task: PlanningTask = { ...original, id: taskId(original.id), requirements: original.requirements.map(ref), acceptance: original.acceptance.map(ref),
        checks: original.checks.map(check), provides: original.provides?.map(p => ({ ...p, check: check(p.check) })),
        inputs: original.inputs?.map(p => ({ ...p, owner: p.owner ? taskId(p.owner) : undefined, check: p.check ? check(p.check) : undefined })),
        dependencies: original.dependencies?.map(d => ({ ...d, owner: taskId(d.owner) })) };
      const prior = tasks.get(task.id);
      const identity = digest({ ...original, requirements: [], acceptance: [], dependencies: task.dependencies,
        inputOwners: task.inputs?.map(p => p.owner) });
      if (!prior) { tasks.set(task.id, task); identities.set(task.id, identity); }
      else if (identities.get(task.id) !== identity) {
        add('import.identity-conflict', [ns, task.id], 'Shared task identity has different execution, interface or source declarations');
      } else {
        prior.requirements = unique([...prior.requirements, ...task.requirements]); prior.acceptance = unique([...prior.acceptance, ...task.acceptance]);
        prior.checks.push(...task.checks, ...(task.provides ?? []).map(p => p.check).filter(c => !task.checks.some(check => check.id === c.id)));
        // Every fragment keeps its check references, while the capability producer executes only once.
      }
    }
    for (const [name, value] of Object.entries(manifest.capacities ?? {})) {
      plan.capacities ??= {};
      if (plan.capacities[name] !== undefined && plan.capacities[name] !== value) add('import.resource-conflict', [name], 'Fragments declare different resource capacities');
      else plan.capacities[name] = value;
    }
    if (manifest.sizing) {
      if (plan.sizing && canonical(plan.sizing) !== canonical(manifest.sizing)) add('import.sizing-conflict', [ns], 'Fragments declare different sizing policies');
      else plan.sizing = manifest.sizing;
    }
    if (manifest.semanticReview?.mode === 'required') {
      if (plan.semanticReview?.mode === 'required' && canonical(plan.semanticReview) !== canonical(manifest.semanticReview)) add('import.review-conflict', [ns], 'Fragments declare different required reviewers');
      else plan.semanticReview = manifest.semanticReview;
    }
  }
  plan.sources = [...sources.values()].sort((a, b) => a.path.localeCompare(b.path));
  sorted(plan.tasks = [...tasks.values()]); sorted(plan.criteria); sorted(plan.requirements);
  const providers = new Map<string, string>();
  const interfaces = new Map<string, string>();
  for (const task of plan.tasks) for (const value of [...(task.interfaces ?? []), ...(task.provides ?? []).flatMap(p => p.interface ? [p.interface] : []),
    ...(task.inputs ?? []).flatMap(p => p.interface ? [p.interface] : [])]) {
    const identity = digest(value), prior = interfaces.get(value.id);
    if (prior && prior !== identity) add('import.interface-conflict', [value.id, task.id], 'One global interface identity has conflicting version or digest declarations');
    else interfaces.set(value.id, identity);
  }
  for (const task of plan.tasks) for (const capability of task.provides ?? []) {
    const prior = providers.get(capability.id);
    if (prior && prior !== task.id) add('import.producer-conflict', [capability.id, prior, task.id], 'Capability has multiple producers; select one explicit shared task identity');
    providers.set(capability.id, task.id);
  }
  const report = validatePlan(plan, root);
  report.findings.push(...findings); report.findings.sort((a, b) => a.id.localeCompare(b.id));
  report.valid = !report.findings.some(f => f.blocking);
  return { manifest: plan, report };
}
