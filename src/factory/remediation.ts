/** Compile verified defects and root causes into ordinary DAG tasks. */
import { createHash } from 'node:crypto';
import type { Run, Task } from '../types.js';
import { addTask } from '../store.js';
import type { FactoryEntityId } from './contracts.js';
import { validateCodeGraphIndex, type CodeGraphIndex } from './code-graph.js';
import type { ImpactSet } from './impact.js';
import type { FactoryGraphModel, FactoryCrossGraphEdge } from './graph-model.js';
import { validateFactoryGraphModel } from './graph-model.js';
import type { RiskScore } from './risk.js';
import { validateRootCauseGraph, type RootCause, type RootCauseGraph, type RootCauseDefect } from './root-causes.js';

export type RemediationStage = 'root_cause_fix' | 'service_update' | 'api_contract_update' | 'frontend_adaptation' | 'integration_tests' | 'recertification' | 'defect_fix';

export interface RemediationAcceptanceCommands {
  /** Optional project-specific commands included in the generated task specs. */
  byStage?: Partial<Record<RemediationStage, string>>;
}

export interface RemediationCompilerInput {
  defects: RootCauseGraph['defects'];
  rootCauses: RootCauseGraph['root_causes'];
  codeGraph: CodeGraphIndex;
  /** Requirement entities and implemented_by links from the requirement graph. */
  requirementGraph?: Pick<CodeGraphIndex, 'requirements' | 'links'>;
  impactedPaths?: ImpactSet['affected_paths'];
  regressionRisks?: readonly Pick<RiskScore, 'unit' | 'risk_score'>[];
  acceptanceCommands?: RemediationAcceptanceCommands;
  /** Maximum nodes including test and recertification tasks. Defaults to 64. */
  maxTasks?: number;
  /** Maximum additional scope stages per cause/defect. Defaults to 4. */
  maxScopeSteps?: number;
}

export interface RemediationTrace {
  defectIds: FactoryEntityId[];
  rootCauseIds: FactoryEntityId[];
  evidenceIds: string[];
  verificationHashes: string[];
  codeEntityIds: FactoryEntityId[];
  testEntityIds: FactoryEntityId[];
  requirementIds: FactoryEntityId[];
  impactedPathIds: FactoryEntityId[][];
  regressionRisks: Array<{ unit: FactoryEntityId; risk_score: number }>;
}

export interface RemediationNode {
  /** Stable identity of this planned node, independent of the DAG task UUID. */
  id: string;
  title: string;
  stage: RemediationStage;
  deps: string[];
  spec: string;
  trace: RemediationTrace;
  sourceId: FactoryEntityId;
}

export interface RemediationPlan {
  schemaVersion: 1;
  nodes: RemediationNode[];
  /** defect/root-cause -> task links after materialization. */
  links: FactoryCrossGraphEdge[];
}

const DEFAULT_MAX_TASKS = 64;
const DEFAULT_MAX_SCOPE_STEPS = 4;
const MAX_TEXT = 500;

/**
 * Produce a deterministic, bounded remediation DAG. Verified defects explained
 * by a root cause are repaired through that shared-cause workstream; no
 * additional task is emitted for each covered symptom.
 */
export function compileRemediation(input: RemediationCompilerInput): RemediationPlan {
  validateCodeGraphIndex(input.codeGraph);
  const graph: RootCauseGraph = { schema_version: 1, defects: [...input.defects], root_causes: [...input.rootCauses], explained_by: linksFor(input.rootCauses) };
  validateRootCauseGraph(graph);
  const maxTasks = boundedInteger(input.maxTasks, DEFAULT_MAX_TASKS, 1, 256, 'maxTasks');
  const maxScopeSteps = boundedInteger(input.maxScopeSteps, DEFAULT_MAX_SCOPE_STEPS, 0, 8, 'maxScopeSteps');
  const requirements = input.requirementGraph ?? input.codeGraph;
  const defectById = new Map(input.defects.map((defect) => [defect.id, defect]));
  const codeEntities = new Map(input.codeGraph.graph.entities.map((entity) => [entity.id, entity]));
  const riskByUnit = new Map((input.regressionRisks ?? []).map((risk) => [risk.unit, risk.risk_score]));
  for (const [unit, score] of riskByUnit) if (!codeEntities.has(unit) || !Number.isFinite(score) || score < 0 || score > 1) throw new Error(`invalid regression risk for ${unit}`);
  const explained = new Set(input.rootCauses.flatMap((cause) => cause.defects));
  const scopeCount = (scopes: readonly string[]) => Math.min(maxScopeSteps, new Set(scopes.map(clean).filter(Boolean)).size);
  const estimatedTasks = input.rootCauses.reduce((sum, cause) => sum + 3 + scopeCount(cause.remediation_scope), 0) +
    input.defects.filter((defect) => !explained.has(defect.id)).reduce((sum, defect) => sum + 3 + scopeCount(defect.affected_components), 0);
  if (estimatedTasks > maxTasks) throw new Error(`remediation plan exceeds maxTasks (${estimatedTasks} > ${maxTasks}); increase the explicit bound or reduce verified inputs`);
  const planned: RemediationNode[] = [];
  for (const cause of [...input.rootCauses].sort((a, b) => a.id.localeCompare(b.id))) {
    const trace = traceFor(cause.defects, [cause], defectById, input, requirements, codeEntities, riskByUnit);
    appendWorkstream(planned, `root:${cause.id}`, cause.title, cause.id, cause.remediation_scope, trace, input.acceptanceCommands, maxScopeSteps);
  }
  // Defects without verified shared-cause evidence retain one bounded repair each.
  for (const defect of [...input.defects].filter((item) => !explained.has(item.id)).sort((a, b) => a.id.localeCompare(b.id))) {
    const trace = traceFor([defect.id], [], defectById, input, requirements, codeEntities, riskByUnit);
    appendWorkstream(planned, `defect:${defect.id}`, defect.title, defect.id, defect.affected_components, trace, input.acceptanceCommands, maxScopeSteps, true);
  }
  if (planned.length > maxTasks) throw new Error(`remediation plan exceeds maxTasks (${planned.length} > ${maxTasks}); increase the explicit bound or reduce verified inputs`);
  return { schemaVersion: 1, nodes: planned, links: [] };
}

/**
 * Materialize a compiled plan through the existing store.addTask API and add
 * its trace entities/links to the existing optional four-graph model.
 */
export function createRemediationTasks(run: Run, plan: RemediationPlan, model?: FactoryGraphModel): { tasks: Task[]; graph: FactoryGraphModel | undefined } {
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.nodes)) throw new Error('invalid remediation plan');
  if (model) validateFactoryGraphModel(model);
  const taskByPlanId = new Map<string, Task>();
  const tasks: Task[] = [];
  for (const node of plan.nodes) {
    const deps = node.deps.map((id) => {
      const task = taskByPlanId.get(id);
      if (!task) throw new Error(`remediation plan has missing or forward dependency: ${id}`);
      return task.id;
    });
    const task = addTask(run, { title: node.title, spec: node.spec, deps });
    tasks.push(task);
    taskByPlanId.set(node.id, task);
    if (model) addGraphTrace(model, node, task);
  }
  if (model) validateFactoryGraphModel(model);
  const links = tasks.flatMap((task, index) => {
    const node = plan.nodes[index]!;
    return node.trace.rootCauseIds.map((causeId) => ({ type: 'repaired_by' as const, from: causeId as `defect:v1:${string}`, to: `execution:v1:${task.id}` as `execution:v1:${string}` }));
  });
  plan.links = links;
  return { tasks, graph: model };
}

function appendWorkstream(
  out: RemediationNode[], key: string, title: string, sourceId: FactoryEntityId,
  scopes: readonly string[], trace: RemediationTrace, commands: RemediationAcceptanceCommands | undefined,
  maxScopeSteps: number, defectFix = false,
): void {
  const baseId = stableId(key);
  const stages: Array<{ stage: RemediationStage; label: string; source: string }> = [
    { stage: defectFix ? 'defect_fix' : 'root_cause_fix', label: defectFix ? `Fix verified defect: ${title}` : `Repair root cause: ${title}`, source: title },
  ];
  for (const scope of [...new Set(scopes.map(clean).filter(Boolean))].slice(0, maxScopeSteps)) {
    stages.push({ stage: classifyScope(scope), label: scope, source: scope });
  }
  stages.push({ stage: 'integration_tests', label: `Add or update integration tests for ${title}`, source: title });
  stages.push({ stage: 'recertification', label: `Re-certify impacted paths for ${title}`, source: title });
  let previous: string | undefined;
  for (let index = 0; index < stages.length; index++) {
    const step = stages[index]!;
    const id = `${baseId}.${index + 1}`;
    const deps = previous ? [previous] : [];
    const scope = step.source;
    const nodeTrace = { ...trace, defectIds: [...trace.defectIds], rootCauseIds: [...trace.rootCauseIds] };
    out.push({
      id, title: bounded(step.label, MAX_TEXT), stage: step.stage, deps, sourceId,
      trace: nodeTrace,
      spec: renderSpec(step.stage, title, scope, nodeTrace, commands?.byStage?.[step.stage]),
    });
    previous = id;
  }
}

function renderSpec(stage: RemediationStage, title: string, scope: string, trace: RemediationTrace, command?: string): string {
  const evidence = trace.evidenceIds.length ? trace.evidenceIds.join(', ') : 'verified defect record';
  const lines = [
    `Inputs: verified root cause/defect ${trace.rootCauseIds.join(', ') || trace.defectIds.join(', ')}; related verified defects ${trace.defectIds.join(', ')}.`,
    `Purpose: ${stageDescription(stage)} for ${bounded(title, MAX_TEXT)}.`,
    `Scope: ${bounded(scope, MAX_TEXT)}.`,
    `Evidence: ${evidence}. Verification packet hash(es): ${trace.verificationHashes.join(', ') || 'unavailable'}.`,
    `Code graph entities: ${trace.codeEntityIds.join(', ') || 'none linked'}.`,
    `Regression test entities: ${trace.testEntityIds.join(', ') || 'none linked; add targeted coverage from the impacted paths'}.`,
    `Requirement graph: ${trace.requirementIds.join(', ') || 'none linked'}.`,
    `Impacted execution paths: ${trace.impactedPathIds.map((path) => path.join(' -> ')).join(' | ') || 'none supplied'}.`,
    `Regression risks: ${trace.regressionRisks.map((risk) => `${risk.unit}=${risk.risk_score}`).join(', ') || 'none supplied'}.`,
    'Outputs: implement this bounded remediation step and preserve links to the listed verified evidence.',
    `Acceptance: ${acceptanceFor(stage)}${command?.trim() ? ` Command \`${command.trim()}\` exits 0.` : ''}`,
  ];
  return lines.join('\n');
}

function traceFor(
  defectIds: FactoryEntityId[], causes: RootCause[], defects: Map<FactoryEntityId, RootCauseDefect>,
  input: RemediationCompilerInput, requirements: Pick<CodeGraphIndex, 'requirements' | 'links'>,
  codeEntities: Map<string, CodeGraphIndex['graph']['entities'][number]>, riskByUnit: Map<string, number>,
): RemediationTrace {
  const causeIds = causes.map((cause) => cause.id).sort();
  const evidenceIds = [...new Set(defectIds.flatMap((id) => {
    const defect = defects.get(id)!;
    return defect.verification.evidence_for.map((evidence) => evidence.evidenceId);
  }).concat(causes.flatMap((cause) => cause.evidence.map((evidence) => evidence.evidence_id))))].sort();
  const verificationHashes = [...new Set(defectIds.map((id) => defects.get(id)!.verification.evidence_sha256))].sort();
  const components = new Set(defectIds.flatMap((id) => defects.get(id)?.affected_components ?? []));
  for (const cause of causes) for (const component of cause.affected_components) components.add(component);
  const impactedCode = new Set(input.impactedPaths?.flatMap((path) => path.nodes) ?? []);
  const codeIds = [...codeEntities.values()].filter((entity) => impactedCode.has(entity.id as FactoryEntityId) || components.has(entity.title) || components.has(entity.sourcePath ?? '') || [...components].some((component) => (entity.sourcePath ?? '').includes(component))).map((entity) => entity.id as FactoryEntityId);
  const codeSet = new Set(codeIds);
  const testIds = input.codeGraph.graph.edges.filter((edge) => edge.type === 'tests' && codeSet.has(edge.to as FactoryEntityId))
    .map((edge) => edge.from as FactoryEntityId).sort();
  const requirementIds = requirements.links.filter((link) => link.type === 'implemented_by' && codeSet.has(link.to)).map((link) => link.from as FactoryEntityId).filter((id) => requirements.requirements.some((req) => req.id === id)).sort();
  const impactedPathIds = (input.impactedPaths ?? []).map((path) => [...path.nodes]).slice(0, 20);
  const risks = [...riskByUnit].filter(([unit]) => codeSet.size === 0 || codeSet.has(unit as FactoryEntityId))
    .map(([unit, risk_score]) => ({ unit: unit as FactoryEntityId, risk_score })).sort((a, b) => b.risk_score - a.risk_score || a.unit.localeCompare(b.unit)).slice(0, 20);
  return { defectIds: [...defectIds].sort(), rootCauseIds: causeIds, evidenceIds, verificationHashes, codeEntityIds: codeIds.sort(), testEntityIds: testIds, requirementIds, impactedPathIds, regressionRisks: risks };
}

function addGraphTrace(model: FactoryGraphModel, node: RemediationNode, task: Task): void {
  const executionId = `execution:v1:${task.id}` as `execution:v1:${string}`;
  if (!model.graphs.execution.entities.some((entity) => entity.id === executionId)) {
    model.graphs.execution.entities.push({ id: executionId, kind: 'remediation_task', title: task.title, evidenceIds: node.trace.evidenceIds });
  }
  for (const causeId of node.trace.rootCauseIds) {
    // Root causes are preserved as defect-graph entities and point to the real
    // DAG execution task through the cross-graph repaired_by edge.
    if (!model.graphs.defect.entities.some((entity) => entity.id === causeId)) model.graphs.defect.entities.push({ id: causeId, kind: 'root_cause', title: causeId, evidenceIds: node.trace.evidenceIds });
    const link = { type: 'repaired_by' as const, from: causeId as `defect:v1:${string}`, to: executionId };
    if (!model.links.some((item) => item.type === link.type && item.from === link.from && item.to === link.to)) model.links.push(link);
  }
  for (const defectId of node.trace.defectIds) {
    if (!model.graphs.defect.entities.some((entity) => entity.id === defectId)) model.graphs.defect.entities.push({ id: defectId, kind: 'defect', title: defectId, evidenceIds: node.trace.evidenceIds });
    if (!node.trace.rootCauseIds.length) {
      // Factory graph's repaired_by is root-cause-only; represent direct defect
      // repair inside its defect graph and attach execution provenance in spec.
      model.graphs.defect.edges.push({ type: 'remediates', from: `defect:v1:remediation.${task.id}`, to: defectId } as FactoryGraphModel['graphs']['defect']['edges'][number]);
      const remediationId = `defect:v1:remediation.${task.id}` as `defect:v1:${string}`;
      if (!model.graphs.defect.entities.some((entity) => entity.id === remediationId)) model.graphs.defect.entities.push({ id: remediationId, kind: 'remediation', title: task.title, evidenceIds: node.trace.evidenceIds });
    }
  }
  for (const codeId of node.trace.codeEntityIds) {
    if (!model.graphs.code.entities.some((entity) => entity.id === codeId)) continue;
    const link = { type: 'modified_by' as const, from: codeId as `code:v1:${string}`, to: executionId };
    if (!model.links.some((item) => item.type === link.type && item.from === link.from && item.to === link.to)) model.links.push(link);
  }
}

function linksFor(causes: readonly RootCause[]): RootCauseGraph['explained_by'] {
  return causes.flatMap((cause) => cause.defects.map((id) => ({ type: 'explained_by' as const, from: id, to: cause.id, evidence: cause.evidence.filter((item) => item.defect_id === id) })));
}
function classifyScope(scope: string): RemediationStage {
  if (/front.?end|ui|client|view|component/i.test(scope)) return 'frontend_adaptation';
  if (/api|contract|dto|schema|interface/i.test(scope)) return 'api_contract_update';
  return 'service_update';
}
function stageDescription(stage: RemediationStage): string {
  return ({ root_cause_fix: 'fix the shared architectural cause', defect_fix: 'fix the verified defect', service_update: 'update the service layer', api_contract_update: 'update the API contract', frontend_adaptation: 'adapt frontend consumers', integration_tests: 'verify cross-component behavior with integration tests', recertification: 're-certify affected requirements and execution paths' })[stage];
}
function acceptanceFor(stage: RemediationStage): string {
  return ({
    root_cause_fix: 'the shared mechanism described by the evidence is corrected and all linked defects have a root-level fix.',
    defect_fix: 'the cited verified failure is no longer reproducible and its behavior is covered by a regression check.',
    service_update: 'the service behavior preserves the required invariant across all cited paths.',
    api_contract_update: 'the contract is explicit and producer/consumer types agree.',
    frontend_adaptation: 'the client handles the corrected contract on each impacted path.',
    integration_tests: 'targeted integration checks cover every supplied impacted path and fail on regression.',
    recertification: 'all targeted checks pass and every linked verified defect is addressed or explicitly reported unresolved.',
  })[stage];
}
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function clean(value: string): string { return value.trim().replace(/\s+/g, ' '); }
function bounded(value: string, max: number): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }
function stableId(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16); }
