/**
 * Closed-loop factory controller. This module compiles each control-plane
 * phase into ordinary run tasks and delegates every launch, retry, review,
 * dependency decision, and recovery step to DagRunner.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, posix } from 'node:path';
import {
  addTask,
  atomicWriteJson,
  loadRun,
  readAttemptLog,
  readJsonFileWithBackup,
  runPaths,
  saveRun,
  newRun,
} from '../store.js';
import { DagRunner, type Executor } from '../runner.js';
import type { Run, Task, DagEvent } from '../types.js';
import type { Reviewer } from '../review-policy.js';
import { ensureIntegrationWorktree, snapshotExcludes } from '../git-worktree.js';
import { createFactoryGraphModel, validateFactoryGraphModel, type FactoryGraphModel } from './graph-model.js';
import type { FactoryEvidenceRef, FactorySidecarManifest } from './contracts.js';
import { buildCodeGraph, validateCodeGraphIndex, type CodeGraphIndex } from './code-graph.js';
import { compileContext, type ContextPacket } from './context-compiler.js';
import { analyzeObservations, type NormalizedObservation, type RawObservation } from './observations.js';
import { createHypotheses, validateHypothesisSet, type DefectHypothesis, type HypothesisSet } from './hypotheses.js';
import { preverifyHypothesis, type PreverificationResult } from './preverification.js';
import { createVerificationPacket, adjudicateVerification, renderVerificationPrompt, type VerificationPacket, type VerificationResult } from './verification.js';
import { createRootCauseGraph, validateRootCauseGraph, type RootCauseAssessment, type VerifiedDefect } from './root-causes.js';
import { compileRemediation, createRemediationTasks } from './remediation.js';
import { analyzeSemanticImpact } from './impact.js';
import { generateReviewUnits } from './review-units.js';
import { createRecertificationPlan, completeRecertification, type RecertificationPlan } from './recertification.js';
import { createCertification, saveCertification, type Certification, type CertificationEvidence, type CertificationInput } from './certification.js';
import { createBaseline, saveBaseline, type BaselinePolicy, type BaselinePromotion } from './baseline.js';
import { validateCertificationClaims, type CertificationClaim } from './certification-invalidation.js';

export interface FactoryRequirementInput {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface FactoryImplementationInput {
  id: string;
  title: string;
  spec: string;
  cmd: string;
  deps?: string[];
  requirementIds: string[];
  /** Repository-relative files this task owns or is expected to change. */
  codeUnits: string[];
  reviewCmd?: string;
  maxAttempts?: number;
}

export interface FactoryCheckInput {
  id: string;
  title: string;
  cmd: string;
  requirementIds?: string[];
}

export interface StructuredFactoryGoal {
  schemaVersion: 1;
  goal: { id: string; title: string; description: string };
  requirements: FactoryRequirementInput[];
  implementation: FactoryImplementationInput[];
  checks: FactoryCheckInput[];
  phases: {
    review: { command: string };
    verification: { command: string };
    rootCause: { command: string };
    remediation: { command: string; maxTasks?: number };
    regression: { command: string };
    recertification: { reviewCmd: string };
  };
  coverage: { criticalFlow: number; weightedRisk: number };
  certificationPolicy?: BaselinePolicy;
}

export type FactoryStage = 'implementation' | 'quality' | 'verification' | 'root_cause' | 'remediation' | 'recertification' | 'complete';
export type FactoryStatus = 'ready' | 'running' | 'waiting' | 'completed';

export interface FactoryTaskGroups {
  implementation: Record<string, string>;
  checks: Record<string, string>;
  review: string | null;
  verification: Record<string, string>;
  rootCause: string | null;
  remediation: Record<string, string>;
  regression: string | null;
  recertification: Record<string, string>;
}

export interface FactoryControllerState {
  schemaVersion: 1;
  runId: string;
  goalHash: string;
  stage: FactoryStage;
  status: FactoryStatus;
  tasks: FactoryTaskGroups;
  lastError: string | null;
  updatedAt: string;
}

export interface FactoryControllerOptions {
  executor?: Executor;
  cwd?: string;
  onEvent?: (event: DagEvent) => void;
}

export interface FactoryControllerResult {
  state: FactoryControllerState;
  runId: string;
  file: string;
  certification: Certification | null;
  summary: string;
}

const CONTROLLER_FILE = 'controller-v1.json';
const MANIFEST_FILE = 'manifest.json';
const GRAPH_FILE = 'graph-model-v1.json';
const CODE_GRAPH_FILE = 'code-v1.json';
const REGRESSION_TEST_ID = 'code:v1:test/factory-regression' as const;
const NOOP_CMD = 'node -e "process.exit(0)"';

/** Create and execute a factory run. Repeating start with the same goal resumes it. */
export async function startFactory(
  goal: StructuredFactoryGoal,
  runFile: string,
  options: FactoryControllerOptions = {},
): Promise<FactoryControllerResult> {
  validateFactoryGoal(goal);
  const file = resolve(runFile);
  const paths = runPaths(file);
  const statePath = join(paths.factory, CONTROLLER_FILE);
  const goalHash = sha256(canonicalJson(goal));
  let run: Run;
  let state: FactoryControllerState;

  if (existsSync(statePath)) {
    run = loadRun(file);
    state = loadControllerState(file, run.id);
    if (state.goalHash !== goalHash) throw new Error('factory run already belongs to a different structured goal; use a new run file');
    const persistedGoal = loadArtifact<StructuredFactoryGoal>(file, goalHash, 'goal-v1.json');
    validateFactoryGoal(persistedGoal);
  } else {
    run = existsSync(file) ? loadRun(file) : newRun(goal.goal.title);
    if (Object.keys(run.tasks).length > 0) {
      throw new Error(`run ${run.id} already has tasks and no factory controller state; use a fresh run file`);
    }
    run.objective = goal.goal.title;
    if (!existsSync(file)) saveRun(run, file);
    initializeManifest(file, run.id);
    saveArtifact(file, run.id, 'goal-v1.json', goal);
    const graph = createRequirementGraph(goal);
    validateFactoryGraphModel(graph);
    saveArtifact(file, run.id, GRAPH_FILE, graph);
    state = {
      schemaVersion: 1,
      runId: run.id,
      goalHash,
      stage: 'implementation',
      status: 'ready',
      tasks: emptyTaskGroups(),
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    compileImplementationTasks(run, goal, state, graph, goalHash);
    validateFactoryGraphModel(graph);
    saveArtifact(file, run.id, GRAPH_FILE, graph);
    saveControllerState(file, state);
    saveRun(run, file);
  }

  return driveFactory(run, state, file, goal, options);
}

/** Continue from the controller checkpoint and the normal persisted DAG task state. */
export async function resumeFactory(runFile: string, options: FactoryControllerOptions = {}): Promise<FactoryControllerResult> {
  const file = resolve(runFile);
  const run = loadRun(file);
  const state = loadControllerState(file, run.id);
  const goal = loadArtifact<StructuredFactoryGoal>(file, state.goalHash, 'goal-v1.json');
  validateFactoryGoal(goal);
  if (sha256(canonicalJson(goal)) !== state.goalHash) throw new Error('persisted factory goal hash mismatch');
  return driveFactory(run, state, file, goal, options);
}

/** Read the versioned controller checkpoint without modifying the run. */
export function factoryStatus(runFile: string): FactoryControllerResult {
  const file = resolve(runFile);
  const run = loadRun(file);
  const state = loadControllerState(file, run.id);
  const certification = loadArtifact<Certification>(file, state.goalHash, 'certification-v1.json', true);
  return { state, runId: run.id, file, certification, summary: summarizeController(run, state) };
}

async function driveFactory(
  run: Run,
  state: FactoryControllerState,
  file: string,
  goal: StructuredFactoryGoal,
  options: FactoryControllerOptions,
): Promise<FactoryControllerResult> {
  let turns = 0;
  state.lastError = null;
  while (state.stage !== 'complete' && turns++ < 12) {
    if (state.stage === 'implementation') {
      const graph = loadArtifact<FactoryGraphModel>(file, state.goalHash, GRAPH_FILE);
      compileImplementationTasks(run, goal, state, graph, state.goalHash);
      validateFactoryGraphModel(graph);
      saveArtifact(file, run.id, GRAPH_FILE, graph);
      saveRun(run, file);
      checkpoint(file, state);
    }
    state.status = 'running';
    checkpoint(file, state);
    const scope = stageTaskIds(state);
    if (scope.length > 0) {
      const runner = new DagRunner(run, {
        file,
        cwd: options.cwd ?? dirname(file),
        executor: options.executor,
        persist: (current) => saveRun(current, file),
        onEvent: options.onEvent,
      });
      await runner.start(new Set(scope));
      saveRun(run, file);
      if (scope.some((id) => run.tasks[id]?.status !== 'completed')) {
        state.status = 'waiting';
        checkpoint(file, state);
        return resultOf(run, state, file);
      }
    }

    try {
      switch (state.stage) {
        case 'implementation':
          prepareQualityStage(run, state, file, goal, state.goalHash, factoryWorkingRoot(run, file, options.cwd ?? dirname(file)));
          state.stage = 'quality';
          break;
        case 'quality':
          processQualityStage(run, state, file, goal, state.goalHash, factoryWorkingRoot(run, file, options.cwd ?? dirname(file)));
          state.stage = 'verification';
          break;
        case 'verification':
          processVerificationStage(run, state, file, goal, state.goalHash);
          state.stage = 'root_cause';
          break;
        case 'root_cause':
          processRootCauseStage(run, state, file, goal, state.goalHash);
          state.stage = 'remediation';
          break;
        case 'remediation':
          prepareRecertificationStage(run, state, file, goal, state.goalHash, factoryWorkingRoot(run, file, options.cwd ?? dirname(file)));
          state.stage = 'recertification';
          break;
        case 'recertification':
          processRecertificationStage(run, state, file, goal, state.goalHash, options.cwd ?? dirname(file));
          state.stage = 'complete';
          state.status = 'completed';
          break;
      }
      checkpoint(file, state);
      saveRun(run, file);
    } catch (error) {
      state.status = 'waiting';
      state.lastError = error instanceof Error ? error.message : String(error);
      checkpoint(file, state);
      saveRun(run, file);
      return resultOf(run, state, file);
    }
  }
  if (state.stage !== 'complete') {
    state.status = 'waiting';
    state.lastError = 'factory stage limit reached; resume to continue';
  } else {
    state.status = 'completed';
  }
  checkpoint(file, state);
  return resultOf(run, state, file);
}

function prepareQualityStage(run: Run, state: FactoryControllerState, file: string, goal: StructuredFactoryGoal, goalHash: string, rootDir: string): void {
  const model = loadArtifact<FactoryGraphModel>(file, goalHash, GRAPH_FILE);
  const index = buildGoalCodeGraph(goal, rootDir);
  attachCodeGraph(model, index, goal, goalHash);
  addCodeEntity(index, model, REGRESSION_TEST_ID, 'test', 'Factory regression suite');
  saveArtifact(file, run.id, CODE_GRAPH_FILE, index);
  saveArtifact(file, run.id, GRAPH_FILE, model);

  const implementationIds = Object.values(state.tasks.implementation);
  for (const check of goal.checks) {
    const task = ensureTask(run, taskId(goalHash, 'check', check.id), {
      title: check.title,
      spec: renderCheckSpec(goal, check),
      deps: implementationIds,
      cmd: check.cmd,
    });
    state.tasks.checks[check.id] = task.id;
    ensureExecutionEntity(model, task, 'verification_task');
    for (const implementationId of implementationIds) addExecutionEdge(model, 'verifies', task.id, implementationId);
  }
  const review = ensureTask(run, taskId(goalHash, 'review', 'implementation'), {
    title: `Factory review: ${goal.goal.title}`,
    spec: renderReviewSpec(goal),
    deps: implementationIds,
    cmd: goal.phases.review.command,
  });
  state.tasks.review = review.id;
  ensureExecutionEntity(model, review, 'review_task');
  for (const implementationId of implementationIds) addExecutionEdge(model, 'reviews', review.id, implementationId);
  validateFactoryGraphModel(model);
  saveArtifact(file, run.id, GRAPH_FILE, model);
  saveRun(run, file);
}

function processQualityStage(
  run: Run,
  state: FactoryControllerState,
  file: string,
  goal: StructuredFactoryGoal,
  goalHash: string,
  rootDir: string,
): void {
  const reviewTask = requiredTask(run, state.tasks.review, 'implementation review');
  const reviewOutput = parseJsonOutput(taskOutput(file, reviewTask), 'review observations');
  const raw = normalizeRawObservations(reviewOutput);
  const index = loadArtifact<CodeGraphIndex>(file, goalHash, CODE_GRAPH_FILE);
  const analyzed = analyzeObservations(raw, { codeGraph: index });
  const hypotheses = createHypotheses(analyzed.observations, analyzed.clusters);
  validateHypothesisSet(hypotheses);
  const packets: Record<string, { context: ContextPacket; preverification: PreverificationResult; packet: VerificationPacket }> = {};
  for (const hypothesis of hypotheses.hypotheses) {
    const observations = analyzed.observations.filter((item) => hypothesis.observations.includes(item.id as DefectHypothesis['observations'][number]));
    const context = compileContext({
      index,
      rootDir,
      request: `Adversarially verify: ${hypothesis.claim}`,
      previousFindings: observations.map((item) => ({ id: item.id, title: item.title, content: JSON.stringify(item), sourcePath: item.files[0] })),
    });
    const preverification = preverifyHypothesis(hypothesis, {
      rootDir,
      observations,
      codeGraph: index,
      graphIsComplete: true,
    });
    const packet = createVerificationPacket(hypothesis, context, preverification);
    packets[hypothesis.id] = { context, preverification, packet };
  }

  const model = loadArtifact<FactoryGraphModel>(file, goalHash, GRAPH_FILE);
  const observationIdBySource = new Map<string, string[]>();
  for (const observation of analyzed.observations) {
    addDefectEntity(model, observation.id, 'observation', observation.title, [observation.id]);
    for (const source of observation.files) {
      const ids = observationIdBySource.get(source) ?? [];
      ids.push(observation.id);
      observationIdBySource.set(source, ids);
      for (const codeEntity of index.graph.entities.filter((entity) => entity.sourcePath === source && entity.kind === 'symbol')) {
        addCrossLink(model, { type: 'involves', from: codeEntity.id as `code:v1:${string}`, to: observation.id as `defect:v1:${string}` });
      }
    }
  }
  for (const link of analyzed.corroborates) addDefectEdge(model, link.type, link.from, link.to);
  for (const hypothesis of hypotheses.hypotheses) {
    addDefectEntity(model, hypothesis.id, 'hypothesis', hypothesis.claim, hypothesis.observations);
    for (const observationId of hypothesis.observations) addDefectEdge(model, 'supports', observationId, hypothesis.id);
  }
  for (const observationId of analyzed.observations.map((item) => item.id)) {
    if (reviewTask.id) addCrossLink(model, { type: 'produced', from: executionEntityId(reviewTask.id), to: observationId as `defect:v1:${string}` });
  }
  // Keep the requirement -> code -> execution -> observation chain explicit.
  for (const [logicalId, implementationTaskId] of Object.entries(state.tasks.implementation)) {
    const input = goal.implementation.find((item) => item.id === logicalId)!;
    const files = new Set(input.codeUnits.map(normalizeRepoPath));
    const relevant = new Set([...files].flatMap((path) => observationIdBySource.get(path) ?? []));
    for (const observationId of relevant) addCrossLink(model, {
      type: 'produced', from: executionEntityId(implementationTaskId), to: observationId as `defect:v1:${string}`,
    });
  }

  const initialEvidence = qualityEvidence(file, state, run, goal);
  const currentCommit = repositoryCommit(rootDir, run);
  const specHash = sha256(canonicalJson(model.graphs.requirement));
  const codeHash = sha256(canonicalJson(index.graph));
  const testHash = sha256(canonicalJson(initialEvidence.deterministicChecks));
  const residualFindings = analyzed.observations.map((item) => ({
    id: `observation:${item.id}`,
    severity: 'medium' as const,
    description: `Unverified reviewer observation: ${item.title}`,
    evidence: [initialEvidence.reviewEvidence.evidence[0]!],
  }));
  const certInput: CertificationInput = {
    runId: run.id,
    commit: currentCommit,
    specificationGraphHash: specHash,
    architectureGraphHash: codeHash,
    testStateHash: testHash,
    deterministicChecks: initialEvidence.deterministicChecks,
    reviewEvidence: [initialEvidence.reviewEvidence],
    acceptedRisks: [],
    residualFindings,
    criticalFlowCoverage: goal.coverage.criticalFlow,
    weightedRiskCoverage: goal.coverage.weightedRisk,
  };
  const baseline = createBaseline(certInput, goal.certificationPolicy);
  saveBaseline(file, baseline);
  saveArtifact(file, run.id, 'baseline-initial-v1.json', baseline);
  if (baseline.status !== 'certified') {
    throw new Error(`initial quality evidence did not certify a baseline: ${baseline.reasons.join('; ')}`);
  }
  const claims = createInitialClaims(goal, index, baseline);
  validateCertificationClaims(claims);
  saveArtifact(file, run.id, 'certification-claims-v1.json', claims);
  saveArtifact(file, run.id, 'observations-v1.json', analyzed);
  saveArtifact(file, run.id, 'hypotheses-v1.json', hypotheses);
  saveArtifact(file, run.id, 'verification-packets-v1.json', packets);
  validateFactoryGraphModel(model);
  saveArtifact(file, run.id, GRAPH_FILE, model);

  for (const hypothesis of hypotheses.hypotheses) {
    const packet = packets[hypothesis.id]!.packet;
    const linkedTaskIds = implementationTasksForHypothesis(goal, state, hypothesis, analyzed.observations);
    const task = ensureTask(run, taskId(goalHash, 'verification', hypothesis.id), {
      title: `Verify defect hypothesis: ${hypothesis.claim}`,
      spec: renderVerificationPrompt(packet),
      deps: [reviewTask.id],
      cmd: goal.phases.verification.command,
    });
    state.tasks.verification[hypothesis.id] = task.id;
    ensureExecutionEntity(model, task, 'verification_task');
    for (const implementationId of linkedTaskIds) addExecutionEdge(model, 'verifies', task.id, implementationId);
  }
  validateFactoryGraphModel(model);
  saveArtifact(file, run.id, GRAPH_FILE, model);
  saveRun(run, file);
}

function processVerificationStage(run: Run, state: FactoryControllerState, file: string, goal: StructuredFactoryGoal, goalHash: string): void {
  const hypotheses = loadArtifact<HypothesisSet>(file, goalHash, 'hypotheses-v1.json');
  const packets = loadArtifact<Record<string, { context: ContextPacket; preverification: PreverificationResult; packet: VerificationPacket }>>(
    file, goalHash, 'verification-packets-v1.json',
  );
  const results: VerificationResult[] = [];
  const updated = hypotheses.hypotheses.map((hypothesis) => {
    const taskIdValue = state.tasks.verification[hypothesis.id];
    if (!taskIdValue) return { ...hypothesis, status: 'rejected' as const };
    const task = requiredTask(run, taskIdValue, `verification for ${hypothesis.id}`);
    const assessment = parseJsonOutput(taskOutput(file, task), `verification assessment for ${hypothesis.id}`);
    const result = adjudicateVerification(packets[hypothesis.id]!.packet, assessment);
    results.push(result);
    return { ...hypothesis, status: result.verdict === 'verified' ? 'verified' as const : result.verdict === 'rejected' ? 'rejected' as const : 'disputed' as const };
  });
  const updatedSet: HypothesisSet = { schemaVersion: 1, hypotheses: updated };
  const observations = loadArtifact<ReturnType<typeof analyzeObservations>>(file, goalHash, 'observations-v1.json');
  const defectByHypothesis = new Map<string, VerifiedDefect>();
  for (const result of results.filter((item) => item.verdict === 'verified')) {
    const hypothesis = updated.find((item) => item.id === result.hypothesis_id)!;
    const linkedObservations = observations.observations.filter((item) => hypothesis.observations.includes(item.id as DefectHypothesis['observations'][number]));
    const components = [...new Set(linkedObservations.flatMap((item) => [...item.files, ...item.symbols, ...item.dependencies]))].sort();
    const defect: VerifiedDefect = {
      id: `defect:v1:defect.${sha256(hypothesis.id)}`,
      title: hypothesis.claim,
      severity: severityFrom(linkedObservations),
      affected_components: components,
      verification: result,
    };
    defectByHypothesis.set(hypothesis.id, defect);
  }
  validateHypothesisSet(updatedSet);
  saveArtifact(file, run.id, 'hypotheses-v1.json', updatedSet);
  saveArtifact(file, run.id, 'verification-v1.json', {
    schemaVersion: 1,
    results,
    verifiedDefects: [...defectByHypothesis.values()],
  });
  const model = loadArtifact<FactoryGraphModel>(file, goalHash, GRAPH_FILE);
  for (const [hypothesisId, defect] of defectByHypothesis) {
    addDefectEntity(model, defect.id, 'defect', defect.title, defect.verification.evidence_for.map((item) => item.evidenceId));
    addDefectEdge(model, 'supports', hypothesisId, defect.id);
    for (const observationId of updated.find((item) => item.id === hypothesisId)!.observations) {
      addCrossLink(model, { type: 'supports', from: observationId as `defect:v1:${string}`, to: defect.id as `defect:v1:${string}` });
    }
  }
  validateFactoryGraphModel(model);
  saveArtifact(file, run.id, GRAPH_FILE, model);

  const verified = [...defectByHypothesis.values()];
  if (verified.length > 0) {
    const task = ensureTask(run, taskId(goalHash, 'root-cause', 'assessment'), {
      title: 'Assess shared root causes for verified defects',
      spec: renderRootCauseSpec(verified),
      deps: Object.values(state.tasks.verification),
      cmd: goal.phases.rootCause.command,
    });
    state.tasks.rootCause = task.id;
    ensureExecutionEntity(model, task, 'verification_task');
    validateFactoryGraphModel(model);
    saveArtifact(file, run.id, GRAPH_FILE, model);
  }
  saveRun(run, file);
}

function processRootCauseStage(run: Run, state: FactoryControllerState, file: string, goal: StructuredFactoryGoal, goalHash: string): void {
  const verification = loadArtifact<{ verifiedDefects: VerifiedDefect[] }>(file, goalHash, 'verification-v1.json');
  let assessments: RootCauseAssessment[] = [];
  if (verification.verifiedDefects.length > 0) {
    const task = requiredTask(run, state.tasks.rootCause, 'root-cause assessment');
    const raw = parseJsonOutput(taskOutput(file, task), 'root-cause assessments');
    if (!Array.isArray(raw)) throw new Error('root-cause command must emit a JSON array of RootCauseAssessment objects');
    assessments = raw as RootCauseAssessment[];
  }
  const graph = createRootCauseGraph(verification.verifiedDefects, assessments);
  validateRootCauseGraph(graph);
  saveArtifact(file, run.id, 'root-causes-v1.json', graph);
  const model = loadArtifact<FactoryGraphModel>(file, goalHash, GRAPH_FILE);
  for (const defect of graph.defects) {
    addDefectEntity(model, defect.id, 'defect', defect.title, defect.verification.evidence_for.map((item) => item.evidenceId));
  }
  for (const cause of graph.root_causes) {
    addDefectEntity(model, cause.id, 'root_cause', cause.title, cause.evidence.map((item) => item.evidence_id));
    for (const defectId of cause.defects) {
      addDefectEdge(model, 'explains', cause.id, defectId);
      addCrossLink(model, { type: 'explained_by', from: defectId as `defect:v1:${string}`, to: cause.id as `defect:v1:${string}` });
    }
  }
  const codeGraph = loadArtifact<CodeGraphIndex>(file, goalHash, CODE_GRAPH_FILE);
  const remediation = compileRemediation({
    defects: graph.defects,
    rootCauses: graph.root_causes,
    codeGraph,
    maxTasks: goal.phases.remediation.maxTasks,
  });
  saveArtifact(file, run.id, 'remediation-plan-v1.json', remediation);
  const prerequisiteIds = state.tasks.rootCause ? [state.tasks.rootCause] : Object.values(state.tasks.verification);
  const created = createRemediationTasks(
    run,
    remediation,
    model,
    (node) => taskId(state.goalHash, 'remediation', node.id),
    prerequisiteIds,
  );
  for (let index = 0; index < remediation.nodes.length; index++) {
    const node = remediation.nodes[index]!;
    const task = created.tasks[index]!;
    task.cmd = goal.phases.remediation.command;
    state.tasks.remediation[node.id] = task.id;
  }
  validateFactoryGraphModel(model);
  saveArtifact(file, run.id, GRAPH_FILE, model);
  saveRun(run, file);
}

function prepareRecertificationStage(
  run: Run,
  state: FactoryControllerState,
  file: string,
  goal: StructuredFactoryGoal,
  goalHash: string,
  rootDir: string,
): void {
  const baselinePromotion = loadArtifact<BaselinePromotion>(file, goalHash, 'baseline-initial-v1.json');
  if (baselinePromotion.status !== 'certified') throw new Error('recertification requires the initial certified baseline');
  const baseline = createCertification(baselinePromotion.certification);
  const claims = loadArtifact<CertificationClaim[]>(file, goalHash, 'certification-claims-v1.json');
  const previousGraph = loadArtifact<FactoryGraphModel>(file, goalHash, GRAPH_FILE);
  const currentCode = buildGoalCodeGraph(goal, rootDir);
  attachCodeGraph(previousGraph, currentCode, goal, goalHash);
  addCodeEntity(currentCode, previousGraph, REGRESSION_TEST_ID, 'test', 'Factory regression suite');
  saveArtifact(file, run.id, CODE_GRAPH_FILE, currentCode);
  saveArtifact(file, run.id, GRAPH_FILE, previousGraph);

  const regressionDependencies = Object.values(state.tasks.remediation);
  const qualityDependencies = [...Object.values(state.tasks.checks), ...(state.tasks.review ? [state.tasks.review] : [])];
  const regression = ensureTask(run, taskId(goalHash, 'regression', 'final'), {
    title: `Factory regression checks: ${goal.goal.title}`,
    spec: renderRegressionSpec(goal, state),
    deps: regressionDependencies.length ? regressionDependencies : qualityDependencies,
    cmd: goal.phases.regression.command,
  });
  state.tasks.regression = regression.id;
  ensureExecutionEntity(previousGraph, regression, 'verification_task');

  // The regression suite is always a changed certification input, even when a
  // remediation command produces no source diff. This forces fresh evidence
  // into every claim during recertification.
  const impact = analyzeSemanticImpact({
    graph: currentCode,
    change: { change: 'final factory regression suite', changed: [REGRESSION_TEST_ID] },
  });
  const reviewUnits = generateReviewUnits(currentCode).map((unit) => {
    const entity = currentCode.graph.entities.find((item) => item.id === unit.nucleus);
    return {
      ...unit,
      routing: {
        unit: unit.nucleus,
        title: entity?.title ?? unit.nucleus,
        spec: `Re-certify ${entity?.title ?? unit.nucleus} against the structured factory requirements.`,
        changedFiles: entity?.sourcePath ? [entity.sourcePath] : [],
        changedSymbols: [unit.nucleus],
        diffLines: null,
        workExitCode: 0,
        verifiedDefects: loadArtifact<{ verifiedDefects: VerifiedDefect[] }>(file, goalHash, 'verification-v1.json').verifiedDefects.map((item) => item.id),
      },
    };
  });
  const reviewers: Reviewer[] = [{
    name: 'factory-recertification',
    cmd: goal.phases.recertification.reviewCmd,
    verdict: 'marker',
    when: 'always',
    why: 'final scoped re-certification of requirements touched by the regression baseline',
  }];
  const plan = createRecertificationPlan({ baseline, claims, impact, reviewUnits, reviewers });
  saveArtifact(file, run.id, 'impact-v1.json', impact);
  saveArtifact(file, run.id, 'recertification-plan-v1.json', plan);

  for (const item of plan.reviewPlans) {
    const selected = item.plan.reviewers.filter((route) => route.selected && route.stage !== 'deterministic');
    const routedReviewers = reviewers.filter((reviewer) => selected.some((route) => route.name === reviewer.name));
    if (routedReviewers.length === 0) continue;
    const task = ensureTask(run, taskId(goalHash, 'recertification-review', item.unit), {
      title: `Re-certify ${item.unit}`,
      spec: [
        `Inputs: certification claims ${item.claims.join(', ')}.`,
        `Review unit: ${item.unit}.`,
        `Review plan: ${JSON.stringify(item.plan)}.`,
        `Verified findings: ${JSON.stringify(loadArtifact<{ verifiedDefects: VerifiedDefect[] }>(file, goalHash, 'verification-v1.json').verifiedDefects)}.`,
        'Acceptance: inspect the current implementation and regression evidence. End with VERDICT: PASS or VERDICT: FAIL: reason.',
      ].join('\n'),
      deps: [regression.id],
      cmd: NOOP_CMD,
      reviewers: routedReviewers,
    });
    state.tasks.recertification[item.unit] = task.id;
    ensureExecutionEntity(previousGraph, task, 'review_task');
    for (const remediationId of Object.values(state.tasks.remediation)) addExecutionEdge(previousGraph, 'reviews', task.id, remediationId);
    for (const implementationId of Object.values(state.tasks.implementation)) addExecutionEdge(previousGraph, 'reviews', task.id, implementationId);
  }
  validateFactoryGraphModel(previousGraph);
  saveArtifact(file, run.id, GRAPH_FILE, previousGraph);
  saveRun(run, file);
}

function processRecertificationStage(
  run: Run,
  state: FactoryControllerState,
  file: string,
  goal: StructuredFactoryGoal,
  goalHash: string,
  rootDir: string,
): void {
  const baselinePromotion = loadArtifact<BaselinePromotion>(file, goalHash, 'baseline-initial-v1.json');
  const baseline = createCertification(baselinePromotion.certification);
  const plan = loadArtifact<RecertificationPlan>(file, goalHash, 'recertification-plan-v1.json');
  const claims = loadArtifact<CertificationClaim[]>(file, goalHash, 'certification-claims-v1.json');
  const index = loadArtifact<CodeGraphIndex>(file, goalHash, CODE_GRAPH_FILE);
  const model = loadArtifact<FactoryGraphModel>(file, goalHash, GRAPH_FILE);
  const regression = requiredTask(run, state.tasks.regression, 'final regression check');
  const regressionEvidence = evidenceForTask(file, run, regression, 'command');
  const reviewTaskForClaim = new Map<string, Task>();
  for (const review of plan.reviewPlans) {
    const taskIdValue = state.tasks.recertification[review.unit];
    if (!taskIdValue) throw new Error(`recertification reviewer task was not compiled for ${review.unit}`);
    const task = requiredTask(run, taskIdValue, `recertification review for ${review.unit}`);
    const verdicts = Object.values(task.reviewerVerdicts);
    if (!verdicts.length || verdicts.some((item) => item.verdict !== 'pass')) {
      throw new Error(`recertification review did not pass for ${review.unit}`);
    }
    for (const claimId of review.claims) if (!reviewTaskForClaim.has(claimId)) reviewTaskForClaim.set(claimId, task);
  }
  const reviewEvidenceFor = (claimId: string) => {
    const task = reviewTaskForClaim.get(claimId);
    if (!task) throw new Error(`recertification lacks a passing review for claim ${claimId}`);
    const evidence = evidenceForTask(file, run, task, 'review');
    return { id: `recert-${safeKey(claimId)}`, reviewer: 'factory-recertification', verdict: 'pass' as const, evidence: [evidence] };
  };
  const results = plan.invalidation.invalidatedClaimIds.map((claimId) => ({
    claimId,
    deterministicChecks: [{ id: `regression-${safeKey(claimId)}`, status: 'pass' as const, evidence: [regressionEvidence] }],
    reviewEvidence: [reviewEvidenceFor(claimId)],
  }));
  const currentCommit = repositoryCommit(rootDir, run);
  const testStateHash = sha256(canonicalJson({ regressionTask: regression.id, evidence: regressionEvidence, output: taskOutput(file, regression) }));
  const recertified = completeRecertification({
    baseline,
    claims,
    plan,
    current: {
      commit: currentCommit,
      specificationGraphHash: sha256(canonicalJson(model.graphs.requirement)),
      architectureGraphHash: sha256(canonicalJson(index.graph)),
      testStateHash,
    },
    results,
    criticalFlowCoverage: goal.coverage.criticalFlow,
    weightedRiskCoverage: goal.coverage.weightedRisk,
    residualFindings: [],
  });
  saveCertification(file, recertified.certification);
  const finalPromotion = createBaseline(certificationInput(recertified.certification), goal.certificationPolicy);
  saveBaseline(file, finalPromotion);
  saveArtifact(file, run.id, 'certification-v1.json', recertified.certification);
  saveArtifact(file, run.id, 'baseline-final-v1.json', finalPromotion);
  saveArtifact(file, run.id, 'certification-claims-final-v1.json', recertified.claims);
  if (recertified.certification.status !== 'certified' || finalPromotion.status !== 'certified') {
    throw new Error(`final recertification did not certify the run: ${finalPromotion.reasons.join('; ')}`);
  }
}

function compileImplementationTasks(
  run: Run,
  goal: StructuredFactoryGoal,
  state: FactoryControllerState,
  graph: FactoryGraphModel,
  goalHash: string,
): void {
  for (const input of orderedImplementation(goal.implementation)) {
    const deps = (input.deps ?? []).map((id) => {
      const dependency = state.tasks.implementation[id];
      if (!dependency) throw new Error(`implementation task ${input.id} has an unknown or forward dependency ${id}`);
      return dependency;
    });
    const requirements = input.requirementIds.map((id) => goal.requirements.find((requirement) => requirement.id === id)!);
    const spec = [
      `Goal: ${goal.goal.title}`,
      `Description: ${goal.goal.description}`,
      'Requirements:',
      ...requirements.flatMap((requirement) => [
        `- ${requirement.id}: ${requirement.title}`,
        `  ${requirement.description}`,
        ...requirement.acceptanceCriteria.map((criterion) => `  Acceptance: ${criterion}`),
      ]),
      `Expected code units: ${input.codeUnits.join(', ')}`,
      `Inputs: ${input.spec.trim()}`,
      `Outputs: implement ${input.title} and update the listed tests when needed.`,
      `Acceptance: ${requirements.flatMap((requirement) => requirement.acceptanceCriteria).join('; ')}`,
    ].join('\n');
    const task = ensureTask(run, taskId(goalHash, 'implementation', input.id), {
      title: input.title,
      spec,
      deps,
      cmd: input.cmd,
      reviewCmd: input.reviewCmd ?? null,
      reviewRounds: input.reviewCmd ? 1 : 0,
      maxAttempts: input.maxAttempts,
    });
    state.tasks.implementation[input.id] = task.id;
    ensureExecutionEntity(graph, task, 'implementation_task');
    for (const dependency of deps) addExecutionEdge(graph, 'depends_on', task.id, dependency);
  }
}

function createRequirementGraph(goal: StructuredFactoryGoal): FactoryGraphModel {
  const model = createFactoryGraphModel();
  const goalId = requirementId(`goal/${goal.goal.id}`);
  const specId = requirementId(`spec/${goal.goal.id}`);
  model.graphs.requirement.entities.push(
    { id: goalId, kind: 'goal', title: goal.goal.title, description: goal.goal.description },
    { id: specId, kind: 'spec', title: `Structured goal: ${goal.goal.title}`, description: goal.goal.description },
  );
  model.graphs.requirement.edges.push({ type: 'parent_of', from: goalId, to: specId });
  for (const requirement of goal.requirements) {
    const id = requirementId(`requirement/${goal.goal.id}/${requirement.id}`);
    model.graphs.requirement.entities.push({ id, kind: 'requirement', title: requirement.title, description: requirement.description });
    model.graphs.requirement.edges.push({ type: 'specifies', from: specId, to: id });
    requirement.acceptanceCriteria.forEach((criterion, index) => {
      const criterionId = requirementId(`acceptance/${goal.goal.id}/${requirement.id}/${index + 1}`);
      model.graphs.requirement.entities.push({ id: criterionId, kind: 'acceptance_criterion', title: criterion });
      model.graphs.requirement.edges.push({ type: 'decomposes_to', from: id, to: criterionId });
    });
  }
  validateFactoryGraphModel(model);
  return model;
}

function buildGoalCodeGraph(goal: StructuredFactoryGoal, rootDir: string): CodeGraphIndex {
  const index = buildCodeGraph({ rootDir });
  for (const requirement of goal.requirements) {
    const id = factoryRequirementId(goal, requirement.id);
    if (!index.requirements.some((item) => item.id === id)) {
      index.requirements.push({ id, kind: 'requirement', title: requirement.title, sourcePath: 'factory://structured-goal' });
    }
  }
  const codeEntities = new Map(index.graph.entities.map((entity) => [entity.id, entity]));
  for (const task of goal.implementation) {
    for (const rawPath of task.codeUnits) {
      const path = normalizeRepoPath(rawPath);
      const fileId = `code:v1:file/${path}` as const;
      const sourceFile = codeEntities.get(fileId);
      if (!sourceFile) throw new Error(`implementation code unit is not in the code graph: ${path}`);
      const symbolId = syntheticSymbolId(goal, task.id, path);
      if (!codeEntities.has(symbolId)) {
        const symbol = { id: symbolId, kind: 'symbol' as const, title: `${path} — ${task.title}`, sourcePath: path, sourceHash: sourceFile.sourceHash };
        index.graph.entities.push(symbol);
        codeEntities.set(symbolId, symbol);
      }
      if (!index.graph.edges.some((edge) => edge.type === 'declares' && edge.from === fileId && edge.to === symbolId)) {
        index.graph.edges.push({ type: 'declares', from: fileId, to: symbolId });
      }
      for (const requirement of task.requirementIds) {
        const from = factoryRequirementId(goal, requirement);
        if (!index.links.some((link) => link.type === 'implemented_by' && link.from === from && link.to === symbolId)) {
          index.links.push({ type: 'implemented_by', from, to: symbolId });
        }
      }
    }
  }
  index.graph.entities.push({ id: REGRESSION_TEST_ID, kind: 'test', title: 'Factory regression suite' });
  validateCodeGraphIndex(index);
  return index;
}

function attachCodeGraph(model: FactoryGraphModel, index: CodeGraphIndex, goal: StructuredFactoryGoal, goalHash: string): void {
  validateCodeGraphIndex(index);
  model.graphs.code.entities = index.graph.entities.map((entity) => ({ ...entity }));
  model.graphs.code.edges = index.graph.edges.map((edge) => ({ ...edge }));
  model.links = model.links.filter((link) => {
    if (link.type === 'implemented_by') return false;
    if ('from' in link && link.from.startsWith('code:v1:') && !index.graph.entities.some((entity) => entity.id === link.from)) return false;
    if ('to' in link && link.to.startsWith('code:v1:') && !index.graph.entities.some((entity) => entity.id === link.to)) return false;
    return true;
  });
  for (const link of index.links) {
    if (link.type === 'implemented_by') addCrossLink(model, { type: 'implemented_by', from: link.from as `requirement:v1:${string}`, to: link.to as `code:v1:${string}` });
  }
  for (const task of goal.implementation) {
    const executionId = executionEntityId(taskId(goalHash, 'implementation', task.id));
    for (const path of task.codeUnits) {
      const symbolId = syntheticSymbolId(goal, task.id, normalizeRepoPath(path));
      addCrossLink(model, { type: 'modified_by', from: symbolId, to: executionId });
      for (const requirement of task.requirementIds) {
        // Requirement-to-code links are stored in the cross-graph implemented_by
        // relation above; task provenance continues through modified_by.
        if (!goal.requirements.some((item) => item.id === requirement)) throw new Error(`unknown requirement ${requirement}`);
      }
    }
  }
  if (!model.graphs.code.entities.some((entity) => entity.id === REGRESSION_TEST_ID)) {
    model.graphs.code.entities.push({ id: REGRESSION_TEST_ID, kind: 'test', title: 'Factory regression suite' });
  }
  validateFactoryGraphModel(model);
}

function addCodeEntity(index: CodeGraphIndex, model: FactoryGraphModel, id: `code:v1:${string}`, kind: 'test', title: string): void {
  if (!index.graph.entities.some((item) => item.id === id)) index.graph.entities.push({ id, kind, title });
  if (!model.graphs.code.entities.some((item) => item.id === id)) model.graphs.code.entities.push({ id, kind, title });
}

function createInitialClaims(goal: StructuredFactoryGoal, index: CodeGraphIndex, baseline: BaselinePromotion): CertificationClaim[] {
  const evidence: FactoryEvidenceRef[] = [
    ...baseline.certification.deterministicChecks.flatMap((check) => check.evidence.map((item) => toFactoryEvidence(item, 'command'))),
    ...baseline.certification.reviewEvidence.flatMap((review) => review.evidence.map((item) => toFactoryEvidence(item, 'review'))),
  ];
  const claims: CertificationClaim[] = goal.requirements.map((requirement) => {
    const implementation = goal.implementation.filter((task) => task.requirementIds.includes(requirement.id));
    const covers = implementation.flatMap((task) => task.codeUnits.map((path) => syntheticSymbolId(goal, task.id, normalizeRepoPath(path))));
    covers.push(REGRESSION_TEST_ID);
    return {
      id: `factory-claim:${safeKey(goal.goal.id)}:${safeKey(requirement.id)}`,
      covers: [...new Set(covers)],
      evidence: uniqueEvidence(evidence),
      provenance: { certificationId: baseline.id, runId: baseline.runId, commit: baseline.commit },
      status: 'valid' as const,
    };
  });
  if (claims.some((claim) => claim.covers.length === 0 || claim.evidence.length === 0)) {
    throw new Error('each requirement claim needs implementation code units and certification evidence');
  }
  // Confirm every covered identity is present in the deterministic code graph.
  const ids = new Set(index.graph.entities.map((entity) => entity.id));
  for (const claim of claims) for (const id of claim.covers) if (!ids.has(id)) throw new Error(`certification claim references unknown code entity: ${id}`);
  return claims;
}

function qualityEvidence(file: string, state: FactoryControllerState, run: Run, goal: StructuredFactoryGoal): {
  deterministicChecks: CertificationInput['deterministicChecks'];
  reviewEvidence: CertificationInput['reviewEvidence'][number];
} {
  const deterministicChecks = goal.checks.map((check) => {
    const task = requiredTask(run, state.tasks.checks[check.id], `quality check ${check.id}`);
    const evidence = evidenceForTask(file, run, task, 'command');
    return { id: check.id, status: 'pass' as const, evidence: [{ uri: evidence.uri, sha256: evidence.sha256 }] };
  });
  const reviewTask = requiredTask(run, state.tasks.review, 'implementation review');
  const review = evidenceForTask(file, run, reviewTask, 'review');
  return {
    deterministicChecks,
    reviewEvidence: { id: 'factory-implementation-review', reviewer: 'factory-review', verdict: 'pass', evidence: [{ uri: review.uri, sha256: review.sha256 }] },
  };
}

function renderCheckSpec(goal: StructuredFactoryGoal, check: FactoryCheckInput): string {
  const requirements = (check.requirementIds ?? []).map((id) => goal.requirements.find((item) => item.id === id)).filter(Boolean);
  return [
    `Inputs: structured goal ${goal.goal.id}; requirements ${requirements.map((item) => item!.id).join(', ') || 'all requirements'}.`,
    `Output: deterministic check ${check.id}.`,
    `Acceptance: ${check.title}; the configured command exits 0.`,
  ].join('\n');
}

function renderReviewSpec(goal: StructuredFactoryGoal): string {
  return [
    `Review the completed implementation for goal ${goal.goal.id}: ${goal.goal.title}.`,
    `Requirements: ${JSON.stringify(goal.requirements)}.`,
    'Inspect the code and tests. Return one JSON array of RawObservation objects; return [] when there are no findings.',
    'Each observation may include id, title, description, category, files, symbols, dependencies, failureScenario, executionPaths, semanticEvidence, evidenceIds, and reviewer.',
    'Do not repair the code during this review. Emit JSON only; no markdown fences or prose.',
  ].join('\n');
}

function renderRootCauseSpec(defects: VerifiedDefect[]): string {
  return [
    'Inputs: independently verified defect records below.',
    'Assess shared root causes only when evidence supports the causal link. Return a JSON array of RootCauseAssessment objects; return [] when no shared cause is supported.',
    'Each object uses title, explanation, defect_ids, affected_components, remediation_scope, and evidence. Every shared cause must include at least two distinct defect_ids and cite each defect’s supporting verification evidence_id with a rationale.',
    JSON.stringify(defects, null, 2),
  ].join('\n');
}

function renderRegressionSpec(goal: StructuredFactoryGoal, state: FactoryControllerState): string {
  return [
    `Inputs: goal ${goal.goal.title}; remediation tasks ${Object.values(state.tasks.remediation).join(', ') || 'none'}.`,
    `Requirements: ${JSON.stringify(goal.requirements)}.`,
    'Run the final regression suite after every remediation task has landed.',
    `Acceptance: ${goal.phases.regression.command} exits 0.`,
  ].join('\n');
}

function normalizeRawObservations(value: unknown): RawObservation[] {
  const observations = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.observations) ? value.observations : null;
  if (!observations) throw new Error('review command must emit a JSON array or {"observations": [...]}');
  return observations as RawObservation[];
}

function implementationTasksForHypothesis(
  goal: StructuredFactoryGoal,
  state: FactoryControllerState,
  hypothesis: DefectHypothesis,
  observations: NormalizedObservation[],
): string[] {
  const linked = observations.filter((item) => hypothesis.observations.includes(item.id as DefectHypothesis['observations'][number]));
  const paths = new Set(linked.flatMap((item) => item.files.map(normalizeRepoPath)));
  return goal.implementation.filter((task) => task.codeUnits.some((path) => paths.has(normalizeRepoPath(path))))
    .map((task) => state.tasks.implementation[task.id]).filter((id): id is string => Boolean(id));
}

function severityFrom(observations: NormalizedObservation[]): VerifiedDefect['severity'] {
  const labels = observations.map((item) => `${item.category} ${item.title} ${item.description}`.toLowerCase()).join(' ');
  if (/\bcritical\b/.test(labels)) return 'critical';
  if (/\bhigh\b/.test(labels)) return 'high';
  if (/\blow\b/.test(labels)) return 'low';
  return 'medium';
}

function ensureTask(run: Run, id: string, input: Parameters<typeof addTask>[1]): Task {
  const prior = run.tasks[id];
  if (prior) {
    const matches = prior.title === input.title && prior.spec === input.spec &&
      JSON.stringify(prior.deps) === JSON.stringify([...new Set(input.deps ?? [])]) &&
      prior.cmd === (input.cmd ?? null) && prior.reviewCmd === (input.reviewCmd ?? null) &&
      prior.reviewRounds === (input.reviewRounds ?? 0) && prior.maxAttempts === (input.maxAttempts ?? run.settings.maxAttempts) &&
      JSON.stringify(prior.reviewers) === JSON.stringify(input.reviewers ?? []);
    if (!matches) throw new Error(`persisted factory task does not match its compiler input: ${id}`);
    return prior;
  }
  return addTask(run, { ...input, id });
}

function stageTaskIds(state: FactoryControllerState): string[] {
  switch (state.stage) {
    case 'implementation': return Object.values(state.tasks.implementation);
    case 'quality': return [...Object.values(state.tasks.checks), ...(state.tasks.review ? [state.tasks.review] : [])];
    case 'verification': return Object.values(state.tasks.verification);
    case 'root_cause': return state.tasks.rootCause ? [state.tasks.rootCause] : [];
    case 'remediation': return Object.values(state.tasks.remediation);
    case 'recertification': return [...(state.tasks.regression ? [state.tasks.regression] : []), ...Object.values(state.tasks.recertification)];
    case 'complete': return [];
  }
}

function ensureExecutionEntity(model: FactoryGraphModel, task: Task, kind: 'implementation_task' | 'review_task' | 'verification_task' | 'remediation_task'): void {
  const id = executionEntityId(task.id);
  if (!model.graphs.execution.entities.some((entity) => entity.id === id)) {
    model.graphs.execution.entities.push({ id, kind, title: task.title });
  }
  for (const dep of task.deps) addExecutionEdge(model, 'depends_on', task.id, dep);
}

function addExecutionEdge(model: FactoryGraphModel, type: 'depends_on' | 'verifies' | 'reviews', fromTaskId: string, toTaskId: string): void {
  const from = executionEntityId(fromTaskId);
  const to = executionEntityId(toTaskId);
  if (!model.graphs.execution.entities.some((entity) => entity.id === from) || !model.graphs.execution.entities.some((entity) => entity.id === to)) return;
  const edge = { type, from, to } as FactoryGraphModel['graphs']['execution']['edges'][number];
  if (!model.graphs.execution.edges.some((item) => item.type === edge.type && item.from === edge.from && item.to === edge.to)) {
    model.graphs.execution.edges.push(edge);
  }
}

function addDefectEntity(model: FactoryGraphModel, id: string, kind: 'observation' | 'hypothesis' | 'defect' | 'root_cause', title: string, evidenceIds: string[]): void {
  if (!model.graphs.defect.entities.some((entity) => entity.id === id)) {
    model.graphs.defect.entities.push({ id: id as `defect:v1:${string}`, kind, title: title.trim() || id, evidenceIds: [...new Set(evidenceIds)] });
  }
}

function addDefectEdge(model: FactoryGraphModel, type: 'corroborates' | 'supports' | 'explains', from: string, to: string): void {
  const edge = { type, from: from as `defect:v1:${string}`, to: to as `defect:v1:${string}` } as FactoryGraphModel['graphs']['defect']['edges'][number];
  if (!model.graphs.defect.edges.some((item) => item.type === edge.type && item.from === edge.from && item.to === edge.to)) model.graphs.defect.edges.push(edge);
}

function addCrossLink(model: FactoryGraphModel, link: FactoryGraphModel['links'][number]): void {
  if (!model.links.some((item) => item.type === link.type && item.from === link.from && item.to === link.to)) model.links.push(link);
}

function executionEntityId(taskIdValue: string): `execution:v1:${string}` { return `execution:v1:${taskIdValue}`; }
function requirementId(key: string): `requirement:v1:${string}` { return `requirement:v1:factory/${safeKey(key)}`; }
function factoryRequirementId(goal: StructuredFactoryGoal, requirement: string): `requirement:v1:${string}` { return requirementId(`requirement/${goal.goal.id}/${requirement}`); }
function syntheticSymbolId(goal: StructuredFactoryGoal, taskIdValue: string, file: string): `code:v1:${string}` {
  return `code:v1:symbol/factory/${safeKey(goal.goal.id)}/${safeKey(taskIdValue)}/${file.split('/').map(safeKey).join('/')}`;
}
function taskId(goalHash: string, phase: string, key: string): string {
  return `task_${sha256(`${goalHash}\0${phase}\0${key}`).slice(0, 24)}`;
}

function orderedImplementation(tasks: FactoryImplementationInput[]): FactoryImplementationInput[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const result: FactoryImplementationInput[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`unknown implementation dependency: ${id}`);
    for (const dependency of task.deps ?? []) visit(dependency);
    visited.add(id);
    result.push(task);
  };
  for (const task of tasks) visit(task.id);
  return result;
}

function factoryWorkingRoot(run: Run, file: string, rootDir: string): string {
  const root = resolve(rootDir);
  if (run.settings.worktree !== 'task') return root;
  return ensureIntegrationWorktree(root, run.id, undefined, snapshotExcludes(file, root)).path;
}

function taskOutput(file: string, task: Task): string {
  return readAttemptLog(file, task.id, task.attempts, 1024 * 1024) ?? task.result ?? '';
}

function evidenceForTask(file: string, run: Run, task: Task, kind: FactoryEvidenceRef['kind']): CertificationEvidence & { kind: FactoryEvidenceRef['kind'] } {
  const output = taskOutput(file, task);
  const sha = sha256(output || `${task.id}:${task.exitCode ?? 0}`);
  const evidence: FactoryEvidenceRef = {
    id: `evidence:v1:${sha}`,
    kind,
    uri: `run://${run.id}/task/${task.id}/attempt/${task.attempts}`,
    sha256: sha,
  };
  const manifestPath = join(runPaths(file).factory, MANIFEST_FILE);
  const raw = readJsonFileWithBackup<unknown>(manifestPath);
  if (raw !== null) {
    validateManifest(raw, run.id);
    if (!raw.evidence.some((item) => item.id === evidence.id && item.uri === evidence.uri)) {
      atomicWriteJson(manifestPath, { ...raw, evidence: [...raw.evidence, evidence].sort((a, b) => a.uri.localeCompare(b.uri)) });
    }
  }
  return { uri: evidence.uri, sha256: evidence.sha256, kind };
}

function toFactoryEvidence(item: CertificationEvidence & { kind?: FactoryEvidenceRef['kind'] }, fallback: FactoryEvidenceRef['kind']): FactoryEvidenceRef {
  const kind = item.kind ?? fallback;
  return { id: `evidence:v1:${item.sha256}`, kind, uri: item.uri, sha256: item.sha256 };
}

function uniqueEvidence(items: FactoryEvidenceRef[]): FactoryEvidenceRef[] {
  return [...new Map(items.map((item) => [`${item.uri}\0${item.sha256}`, item])).values()];
}

function certificationInput(certification: Certification): CertificationInput {
  const { schemaVersion: _version, id: _id, status: _status, invalidationReason: _reason, ...input } = certification;
  return input;
}

function requiredTask(run: Run, id: string | null | undefined, label: string): Task {
  if (!id || !run.tasks[id]) throw new Error(`missing factory ${label} task`);
  const task = run.tasks[id]!;
  if (task.status !== 'completed') throw new Error(`factory ${label} task is ${task.status}`);
  return task;
}

function normalizeRepoPath(value: string): string {
  const normalized = posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes(':')) {
    throw new Error(`code unit must be a repository-relative path without traversal: ${value}`);
  }
  return normalized;
}

function safeKey(value: string): string {
  const sanitized = value.trim().replace(/\\/g, '/').split('/').map((part) => {
    const safe = part.replace(/[^A-Za-z0-9._-]/g, '-');
    return safe === '.' || safe === '..' ? safe.replace(/\./g, '-') : safe;
  }).filter(Boolean).join('/');
  return sanitized || sha256(value).slice(0, 16);
}

function validateFactoryGoal(value: unknown): asserts value is StructuredFactoryGoal {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.goal) ||
    !nonempty(value.goal.id) || !nonempty(value.goal.title) || !nonempty(value.goal.description) ||
    !Array.isArray(value.requirements) || !Array.isArray(value.implementation) || !Array.isArray(value.checks) ||
    !isRecord(value.phases) || !isRecord(value.coverage)) throw new Error('invalid structured factory goal: expected schemaVersion 1, goal, requirements, implementation, checks, phases, and coverage');
  const requirements = value.requirements as FactoryRequirementInput[];
  const requirementIds = new Set<string>();
  for (const requirement of requirements) {
    if (!isRecord(requirement) || !nonempty(requirement.id) || !nonempty(requirement.title) || !nonempty(requirement.description) ||
      !Array.isArray(requirement.acceptanceCriteria) || requirement.acceptanceCriteria.length === 0 || !requirement.acceptanceCriteria.every(nonempty)) {
      throw new Error('each requirement needs id, title, description, and at least one acceptance criterion');
    }
    if (requirementIds.has(requirement.id)) throw new Error(`duplicate requirement id: ${requirement.id}`);
    requirementIds.add(requirement.id);
  }
  const implementation = value.implementation as FactoryImplementationInput[];
  if (implementation.length === 0) throw new Error('structured goal needs at least one implementation task');
  const implementationIds = new Set<string>();
  for (const task of implementation) {
    if (!isRecord(task) || !nonempty(task.id) || !nonempty(task.title) || !nonempty(task.spec) || !nonempty(task.cmd) ||
      !Array.isArray(task.requirementIds) || task.requirementIds.length === 0 || !Array.isArray(task.codeUnits) || task.codeUnits.length === 0) {
      throw new Error('each implementation task needs id, title, spec, cmd, requirementIds, and codeUnits');
    }
    if (implementationIds.has(task.id)) throw new Error(`duplicate implementation task id: ${task.id}`);
    implementationIds.add(task.id);
    for (const requirementIdValue of task.requirementIds) if (!requirementIds.has(requirementIdValue)) throw new Error(`implementation task ${task.id} references unknown requirement ${requirementIdValue}`);
    for (const codeUnit of task.codeUnits) normalizeRepoPath(codeUnit);
    if (task.reviewCmd !== undefined && !nonempty(task.reviewCmd)) throw new Error(`implementation task ${task.id} has an empty reviewCmd`);
  }
  for (const task of implementation) for (const dep of task.deps ?? []) {
    if (!implementationIds.has(dep)) throw new Error(`implementation task ${task.id} references unknown dependency ${dep}`);
  }
  validateImplementationAcyclic(implementation);
  if (value.checks.length === 0) throw new Error('structured goal needs at least one deterministic quality check');
  const checkIds = new Set<string>();
  for (const check of value.checks as FactoryCheckInput[]) {
    if (!isRecord(check) || !nonempty(check.id) || !nonempty(check.title) || !nonempty(check.cmd)) throw new Error('each deterministic check needs id, title, and cmd');
    if (checkIds.has(check.id)) throw new Error(`duplicate deterministic check id: ${check.id}`);
    checkIds.add(check.id);
    for (const id of check.requirementIds ?? []) if (!requirementIds.has(id)) throw new Error(`check ${check.id} references unknown requirement ${id}`);
  }
  for (const [phase, key] of [['review', 'command'], ['verification', 'command'], ['rootCause', 'command'], ['remediation', 'command'], ['regression', 'command'], ['recertification', 'reviewCmd']] as const) {
    if (!isRecord(value.phases[phase]) || !nonempty(value.phases[phase][key])) throw new Error(`factory phase ${phase} requires a non-empty ${key}`);
  }
  for (const [name, coverage] of Object.entries(value.coverage)) {
    if (name !== 'criticalFlow' && name !== 'weightedRisk') continue;
    if (typeof coverage !== 'number' || !Number.isFinite(coverage) || coverage < 0 || coverage > 1) throw new Error(`coverage.${name} must be between 0 and 1`);
  }
  if (typeof value.coverage.criticalFlow !== 'number' || typeof value.coverage.weightedRisk !== 'number') throw new Error('coverage requires criticalFlow and weightedRisk values');
  if (value.certificationPolicy !== undefined) normalizePolicy(value.certificationPolicy);
}

function validateImplementationAcyclic(tasks: FactoryImplementationInput[]): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`implementation dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.deps ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function normalizePolicy(policy?: BaselinePolicy): Required<BaselinePolicy> {
  return {
    requiredCheckIds: [...(policy?.requiredCheckIds ?? [])],
    minimumCriticalFlowCoverage: policy?.minimumCriticalFlowCoverage ?? 1,
    minimumWeightedRiskCoverage: policy?.minimumWeightedRiskCoverage ?? 0.95,
  };
}

function initializeManifest(file: string, runId: string): void {
  const paths = runPaths(file);
  const existing = readJsonFileWithBackup<unknown>(join(paths.factory, MANIFEST_FILE));
  if (existing !== null) {
    validateManifest(existing, runId);
    return;
  }
  atomicWriteJson(join(paths.factory, MANIFEST_FILE), { schemaVersion: 1, runId, artifacts: [], evidence: [] } satisfies FactorySidecarManifest);
}

function loadControllerState(file: string, runId: string): FactoryControllerState {
  const raw = readJsonFileWithBackup<unknown>(join(runPaths(file).factory, CONTROLLER_FILE));
  if (!raw || !isRecord(raw) || raw.schemaVersion !== 1 || raw.runId !== runId || typeof raw.goalHash !== 'string' ||
    !['implementation', 'quality', 'verification', 'root_cause', 'remediation', 'recertification', 'complete'].includes(String(raw.stage)) ||
    !['ready', 'running', 'waiting', 'completed'].includes(String(raw.status)) || !isRecord(raw.tasks)) {
    throw new Error('missing or invalid factory controller checkpoint; start the factory from a structured goal');
  }
  return raw as unknown as FactoryControllerState;
}

function validateManifest(value: unknown, runId: string): asserts value is FactorySidecarManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.runId !== runId || !Array.isArray(value.artifacts) || !Array.isArray(value.evidence)) {
    throw new Error('factory manifest is invalid or belongs to a different run');
  }
  for (const item of value.artifacts) {
    if (!isRecord(item) || typeof item.path !== 'string' || item.path.includes('..') || !/^[a-f0-9]{64}$/.test(String(item.sha256))) {
      throw new Error('factory manifest contains an invalid artifact reference');
    }
  }
}

function saveArtifact(file: string, runId: string, name: string, value: unknown): void {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) throw new Error(`invalid factory artifact name: ${name}`);
  const path = join(runPaths(file).factory, name);
  atomicWriteJson(path, value);
  const bytes = readFileSync(path);
  const manifestPath = join(runPaths(file).factory, MANIFEST_FILE);
  const manifest = readJsonFileWithBackup<unknown>(manifestPath);
  if (manifest === null) initializeManifest(file, runId);
  const loaded = readJsonFileWithBackup<unknown>(manifestPath)!;
  validateManifest(loaded, runId);
  const ref = { path: name, sha256: sha256(bytes) };
  const next: FactorySidecarManifest = {
    ...loaded,
    artifacts: [...loaded.artifacts.filter((item) => item.path !== name), ref].sort((a, b) => a.path.localeCompare(b.path)),
  };
  atomicWriteJson(manifestPath, next);
}

function loadArtifact<T>(file: string, goalHash: string, name: string, optional: true): T | null;
function loadArtifact<T>(file: string, goalHash: string, name: string, optional?: false): T;
function loadArtifact<T>(file: string, _goalHash: string, name: string, optional = false): T | null {
  const path = join(runPaths(file).factory, name);
  const manifest = readJsonFileWithBackup<unknown>(join(runPaths(file).factory, MANIFEST_FILE));
  if (!manifest || !isRecord(manifest) || !Array.isArray(manifest.artifacts)) {
    if (optional) return null as T;
    throw new Error('factory manifest is missing');
  }
  const ref = manifest.artifacts.find((item): item is { path: string; sha256: string } => isRecord(item) && item.path === name);
  if (!ref || !existsSync(path)) {
    if (optional) return null as T;
    throw new Error(`factory artifact is missing: ${name}`);
  }
  const bytes = readFileSync(path);
  if (sha256(bytes) !== ref.sha256) throw new Error(`factory artifact hash mismatch: ${name}`);
  return JSON.parse(bytes.toString('utf8')) as T;
}

function saveControllerState(file: string, state: FactoryControllerState): void {
  checkpoint(file, state);
}
function checkpoint(file: string, state: FactoryControllerState): void {
  state.updatedAt = new Date().toISOString();
  atomicWriteJson(join(runPaths(file).factory, CONTROLLER_FILE), state);
}

function emptyTaskGroups(): FactoryTaskGroups {
  return { implementation: {}, checks: {}, review: null, verification: {}, rootCause: null, remediation: {}, regression: null, recertification: {} };
}

function resultOf(run: Run, state: FactoryControllerState, file: string): FactoryControllerResult {
  return {
    state,
    runId: run.id,
    file,
    certification: loadArtifact<Certification>(file, state.goalHash, 'certification-v1.json', true),
    summary: summarizeController(run, state),
  };
}

function summarizeController(run: Run, state: FactoryControllerState): string {
  const tasks = [
    ...Object.values(state.tasks.implementation), ...Object.values(state.tasks.checks),
    ...(state.tasks.review ? [state.tasks.review] : []), ...Object.values(state.tasks.verification),
    ...(state.tasks.rootCause ? [state.tasks.rootCause] : []), ...Object.values(state.tasks.remediation),
    ...(state.tasks.regression ? [state.tasks.regression] : []), ...Object.values(state.tasks.recertification),
  ];
  const completed = tasks.filter((id) => run.tasks[id]?.status === 'completed').length;
  const failed = tasks.filter((id) => run.tasks[id]?.status === 'failed').length;
  return `factory ${state.status} at ${state.stage}; ${completed}/${tasks.length} tasks completed; ${failed} failed` +
    (state.lastError ? `; ${state.lastError}` : '');
}

function parseJsonOutput(output: string, label: string): unknown {
  const trimmed = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [trimmed, ...(fence ? [fence[1]!.trim()] : []), ...balancedJsonCandidates(trimmed).sort((a, b) => b.length - a.length)];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next framed payload */ }
  }
  throw new Error(`${label}: command output did not contain valid JSON`);
}

function balancedJsonCandidates(source: string): string[] {
  const result: string[] = [];
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '{' && source[start] !== '[') continue;
    const stack: string[] = [];
    let string = false;
    let escaped = false;
    for (let end = start; end < source.length; end++) {
      const char = source[end]!;
      if (string) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') string = false;
        continue;
      }
      if (char === '"') { string = true; continue; }
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const open = stack.pop();
        if ((open === '{' && char !== '}') || (open === '[' && char !== ']')) break;
        if (stack.length === 0) {
          result.push(source.slice(start, end + 1));
          break;
        }
      }
    }
  }
  return result;
}

function repositoryCommit(rootDir: string, run: Run): string {
  const ref = run.settings.worktree === 'task' ? `dag/${run.id}` : 'HEAD';
  try { return execFileSync('git', ['rev-parse', ref], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`factory certification requires a Git commit in ${rootDir}`); }
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
