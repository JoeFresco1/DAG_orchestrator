import { createHash } from 'node:crypto';

/** Extends the reliability contract vocabulary. This is the only new plan format. */
export interface PlanningCheck { id: string; program: string; args: string[]; timeoutMs: number; files?: string[] }
export interface PlanningSource { path: string; sha256: string }
export interface PlanningInterface { id: string; version: string; digest?: string }
export interface PlanningCapability {
  id: string; contract: string; interface?: PlanningInterface; check: PlanningCheck;
}
export interface PlanningInput {
  capability: string; contract: string; owner?: string; interface?: PlanningInterface;
  baseline?: PlanningSource; check?: PlanningCheck;
}
export interface PlanningFile {
  path: string; role: 'implementation' | 'test' | 'frozen' | 'generated'; digest?: string;
  /** Related output files may share one independently verifiable behavior. */
  concern?: string;
}
export interface PlanningDependency { owner: string; reason: string; evidence: string[] }
export interface PlanningTask {
  id: string; title: string; objective: string; reviewBoundary: string;
  requirements: string[]; acceptance: string[]; checks: PlanningCheck[];
  files?: PlanningFile[]; entryPoint?: string; inputs?: PlanningInput[];
  provides?: PlanningCapability[]; dependencies?: PlanningDependency[];
  resources?: Record<string, number>; interfaces?: PlanningInterface[]; constraints?: string[];
  cmd?: string; reviewCmd?: string; maxAttempts?: number;
}
export interface PlanningCriterion {
  id: string; text: string; requirement?: string; source?: string;
  stage: 'local' | 'integration' | 'final'; owner: string; contributors: string[];
  checks: string[]; requires?: string[];
}
export interface PlanningRequirement { id: string; title: string; description: string; acceptance: string[] }
export interface PlanningManifest {
  version: 2; id: string; title: string; sources: PlanningSource[];
  requirements: PlanningRequirement[]; criteria: PlanningCriterion[]; tasks: PlanningTask[];
  capacities?: Record<string, number>;
  semanticReview?: { mode: 'off' | 'auto' | 'required'; command?: Omit<PlanningCheck, 'id'> };
}
export interface PlanningFinding {
  id: string; rule: string; tasks: string[]; references: string[]; evidence: string[];
  severity: 'error' | 'warning'; blocking: boolean; message: string; correction: string;
}
export interface PlanningReport {
  version: 1; revision: string; valid: boolean; findings: PlanningFinding[];
  dependencies: Record<string, PlanningDependency[]>; semanticRequired: boolean;
}
export interface PlanningReview {
  version: 1; revision: string; verdict: 'pass' | 'fail' | 'inconclusive';
  findings: PlanningFinding[]; reviewer: string; contextDigest: string;
}
export interface CompiledPlanning {
  manifest: PlanningManifest; revision: string; definitions: Record<string, string>;
  /** Factory phase tasks generated from its existing authoritative controller. */
  generated?: Record<string, string>;
  review?: PlanningReview;
  /** Explicit migration receipts. Historical acceptance is not new v2 check evidence. */
  legacyImports?: Record<string, { taskDigest: string; contractDigest: string }>;
}
export interface PlanningState {
  revision: string;
  evidence: Record<string, { revision: string; taskId: string; attempt: number; checks: string[]; sourceDigest: string }>;
  failures: Record<string, { count: number; findings: PlanningFinding[]; occurrences?: string[] }>;
  holds: Record<string, PlanningFinding[]>;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
}

export function assertPlanningRequirementsPreserved(before: PlanningManifest, after: PlanningManifest): void {
  for (const original of before.sources) if (!after.sources.some(s => s.path === original.path && s.sha256 === original.sha256)) throw Error(`Correction changes authoritative source ${original.path}`);
  for (const original of before.criteria) {
    const replacement = after.criteria.find(c => c.id === original.id);
    if (!replacement || replacement.text !== original.text || replacement.requirement !== original.requirement || replacement.source !== original.source) throw Error(`Correction loses original acceptance criterion ${original.id}`);
  }
  for (const original of before.requirements) {
    const replacement = after.requirements.find(r => r.id === original.id);
    if (!replacement || replacement.description !== original.description || original.acceptance.some(id => !replacement.acceptance.includes(id))) throw Error(`Correction loses original requirement ${original.id}`);
  }
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !/[\0\r\n]/.test(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
export function safePlanningPath(v: unknown): asserts v is string {
  if (!text(v) || /^[A-Za-z]:|^[/\\]|\\/.test(v) || v.split('/').some(p => !p || ['.', '..', '.git'].includes(p))) throw Error(`Unsafe planning path: ${String(v)}`);
}
function source(v: unknown): void {
  if (!record(v) || typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256)) throw Error('Source needs an exact sha256');
  safePlanningPath(v.path);
}
function interfaceValue(v: unknown): void {
  if (!record(v) || !text(v.id) || !text(v.version) || v.digest !== undefined && !text(v.digest)) throw Error('Invalid interface identity');
}
export function validatePlanningCheck(v: unknown): asserts v is PlanningCheck {
  if (!record(v) || !text(v.id) || !text(v.program) || !Array.isArray(v.args) ||
    v.args.some(a => typeof a !== 'string' || /[\0\r\n]/.test(a)) ||
    !Number.isSafeInteger(v.timeoutMs) || Number(v.timeoutMs) < 1 || Number(v.timeoutMs) > 7_200_000) throw Error('Check needs id, program, argument vector and bounded timeoutMs');
  if (v.files !== undefined) {
    if (!Array.isArray(v.files)) throw Error('Acceptance files must be a path array');
    v.files.forEach(safePlanningPath);
  }
}
/** Shape checks only. Relationship errors are returned as actionable findings. */
export function validatePlanningManifest(v: unknown): asserts v is PlanningManifest {
  if (!record(v) || v.version !== 2 || !text(v.id) || !text(v.title) ||
    !Array.isArray(v.sources) || !Array.isArray(v.requirements) || !Array.isArray(v.criteria) ||
    !Array.isArray(v.tasks) || !v.tasks.length) throw Error('Expected version 2 planning manifest with sources, requirements, criteria and tasks');
  v.sources.forEach(source);
  for (const r of v.requirements) if (!record(r) || !text(r.id) || !text(r.title) || typeof r.description !== 'string' || !strings(r.acceptance) || !r.acceptance.length) throw Error('Requirement needs acceptance IDs');
  for (const c of v.criteria) if (!record(c) || !text(c.id) || typeof c.text !== 'string' || !c.text.trim() ||
    !['local', 'integration', 'final'].includes(String(c.stage)) || !text(c.owner) || !strings(c.contributors) || !strings(c.checks) || !c.checks.length ||
    c.requirement !== undefined && !text(c.requirement) || c.source !== undefined && !text(c.source) || c.requires !== undefined && !strings(c.requires)) throw Error('Criterion needs text, stage, owner, contributors and check IDs');
  for (const t of v.tasks) {
    if (!record(t) || !text(t.id) || !/^task_[A-Za-z0-9._-]+$/.test(t.id) || !text(t.title) ||
      typeof t.objective !== 'string' || !t.objective.trim() || typeof t.reviewBoundary !== 'string' || !t.reviewBoundary.trim() ||
      !strings(t.requirements) || !strings(t.acceptance) || !t.acceptance.length || !Array.isArray(t.checks) || !t.checks.length) throw Error('Task needs stable task_ ID, objective, reviewBoundary, requirements, acceptance and checks');
    t.checks.forEach(validatePlanningCheck);
    if (t.cmd !== undefined && (typeof t.cmd !== 'string' || !t.cmd.trim())) throw Error('Empty task command');
    if (t.reviewCmd !== undefined && (typeof t.reviewCmd !== 'string' || !t.reviewCmd.trim())) throw Error('Empty review command');
    if (t.maxAttempts !== undefined && (!Number.isSafeInteger(t.maxAttempts) || Number(t.maxAttempts) < 1)) throw Error('Invalid task attempt budget');
    for (const key of ['files', 'inputs', 'provides', 'dependencies', 'interfaces']) if (t[key] !== undefined && !Array.isArray(t[key])) throw Error(`Invalid task ${key}`);
    for (const f of t.files as unknown[] ?? []) {
      if (!record(f) || !['implementation', 'test', 'frozen', 'generated'].includes(String(f.role))) throw Error('Invalid file role');
      safePlanningPath(f.path);
      if (f.concern !== undefined && (!text(f.concern) || !['implementation', 'generated'].includes(String(f.role)))) throw Error('Output concern needs a nonempty name on an output file');
      if (f.role === 'frozen') source({ path: f.path, sha256: f.digest });
    }
    if (t.entryPoint !== undefined) safePlanningPath(t.entryPoint);
    for (const p of t.provides as unknown[] ?? []) { if (!record(p) || !text(p.id) || !text(p.contract)) throw Error('Invalid capability promise'); validatePlanningCheck(p.check); if (p.interface) interfaceValue(p.interface); }
    for (const p of t.inputs as unknown[] ?? []) { if (!record(p) || !text(p.capability) || !text(p.contract) || p.owner !== undefined && !text(p.owner)) throw Error('Invalid capability input'); if (p.baseline) source(p.baseline); if (p.check) validatePlanningCheck(p.check); if (p.interface) interfaceValue(p.interface); }
    for (const d of t.dependencies as unknown[] ?? []) if (!record(d) || !text(d.owner) || typeof d.reason !== 'string' || !strings(d.evidence)) throw Error('Invalid dependency reason/evidence');
    for (const i of t.interfaces as unknown[] ?? []) interfaceValue(i);
    if (t.constraints !== undefined && !strings(t.constraints)) throw Error('Invalid constraints');
    if (t.resources !== undefined && !record(t.resources)) throw Error('Invalid resource demands');
  }
  if (v.capacities !== undefined && !record(v.capacities)) throw Error('Invalid resource capacities');
  if (v.semanticReview !== undefined) {
    if (!record(v.semanticReview) || !['off', 'auto', 'required'].includes(String(v.semanticReview.mode))) throw Error('Invalid semantic review policy');
    if (v.semanticReview.command) validatePlanningCheck({ ...v.semanticReview.command as object, id: 'planning-review' });
  }
}
