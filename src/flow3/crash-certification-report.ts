import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, runPaths } from '../store.js';

/** The durable seams exercised by the local crash certification campaign. */
export const CRASH_BOUNDARIES = [
  'worker-launch',
  'result-capture',
  'verdict-persistence',
  'commit',
  'merge',
  'finalization',
] as const;

export type CrashBoundary = typeof CRASH_BOUNDARIES[number];
export type CrashBoundaryOutcome = 'completed' | 'failed' | 'not-run';
export type CrashCampaignStatus = 'in-progress' | 'interrupted' | 'complete';
export type CrashIterationOutcome = Exclude<CrashBoundaryOutcome, 'not-run'>;

/** A local artifact or observation that supports an iteration's outcome. */
export interface CrashCampaignEvidence {
  kind: string;
  /** Local path, commit/ref, or another stable identifier for the evidence. */
  ref: string;
  sha256?: string;
  detail?: string;
}

/** The command/action used to recover after the injected termination. */
export interface CrashCampaignRecoveryAction {
  command: string;
  args: string[];
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  disposition?: string;
  detail?: string;
}

/** Identity connecting an observed result to Flow 3 state and Git history. */
export interface CrashCampaignAttribution {
  runId: string;
  taskId?: string;
  attemptId?: string;
  attempt?: number;
  definitionDigest?: string;
  sourceCommit?: string;
  integratedCommit?: string;
}

/** One completed observation at a boundary. Repeated injections are retained. */
export interface CrashCampaignIteration {
  iterationId: string;
  boundary: CrashBoundary;
  outcome: CrashIterationOutcome;
  killPoint: string;
  startedAt: string;
  finishedAt: string;
  recoveryActions: CrashCampaignRecoveryAction[];
  evidence: CrashCampaignEvidence[];
  attribution: CrashCampaignAttribution;
  failureReason?: string;
}

/** Coverage summary and complete iteration history for a single boundary. */
export interface CrashBoundaryCoverage {
  boundary: CrashBoundary;
  outcome: CrashBoundaryOutcome;
  iterations: CrashCampaignIteration[];
}

/** Persisted report for one local crash-recovery certification campaign. */
export interface CrashCampaignReport {
  schemaVersion: 1;
  campaignId: string;
  runId: string;
  status: CrashCampaignStatus;
  startedAt: string;
  updatedAt: string;
  /** Retained when an interrupted campaign is resumed. */
  interruptionHistory: string[];
  completedAt?: string;
  boundaries: Record<CrashBoundary, CrashBoundaryCoverage>;
}

export interface CreateCrashCampaignReportOptions {
  runId: string;
  campaignId?: string;
  startedAt?: string;
}

export type NewCrashCampaignIteration = Omit<CrashCampaignIteration, 'iterationId'> & {
  iterationId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requiredString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw Error(`${label} must be a non-empty string`);
}

function timestamp(value: unknown, label: string): asserts value is string {
  requiredString(value, label);
  if (!Number.isFinite(Date.parse(value))) throw Error(`${label} must be a valid timestamp`);
}

function isBoundary(value: unknown): value is CrashBoundary {
  return typeof value === 'string' && (CRASH_BOUNDARIES as readonly string[]).includes(value);
}

function deriveBoundaryOutcome(iterations: readonly CrashCampaignIteration[]): CrashBoundaryOutcome {
  if (iterations.length === 0) return 'not-run';
  return iterations.some(iteration => iteration.outcome === 'failed') ? 'failed' : 'completed';
}

function copyIteration(iteration: CrashCampaignIteration): CrashCampaignIteration {
  return {
    ...iteration,
    recoveryActions: iteration.recoveryActions.map(action => ({ ...action, args: [...action.args] })),
    evidence: iteration.evidence.map(item => ({ ...item })),
    attribution: { ...iteration.attribution },
  };
}

function validateIteration(value: unknown, reportRunId: string, boundary: CrashBoundary): asserts value is CrashCampaignIteration {
  if (!isRecord(value)) throw Error(`Iteration for ${boundary} must be an object`);
  requiredString(value.iterationId, `Iteration id for ${boundary}`);
  if (value.boundary !== boundary) throw Error(`Iteration ${value.iterationId} has the wrong boundary`);
  if (value.outcome !== 'completed' && value.outcome !== 'failed') throw Error(`Iteration ${value.iterationId} has an invalid outcome`);
  requiredString(value.killPoint, `Kill point for ${value.iterationId}`);
  timestamp(value.startedAt, `Start time for ${value.iterationId}`);
  timestamp(value.finishedAt, `Finish time for ${value.iterationId}`);
  if (!Array.isArray(value.recoveryActions) || value.recoveryActions.length === 0) {
    throw Error(`Iteration ${value.iterationId} must record at least one recovery action`);
  }
  for (const [index, action] of value.recoveryActions.entries()) {
    if (!isRecord(action)) throw Error(`Recovery action ${index} for ${value.iterationId} must be an object`);
    requiredString(action.command, `Recovery command ${index} for ${value.iterationId}`);
    if (!Array.isArray(action.args) || action.args.some(arg => typeof arg !== 'string')) {
      throw Error(`Recovery args ${index} for ${value.iterationId} must be an array of strings`);
    }
    timestamp(action.startedAt, `Recovery start time ${index} for ${value.iterationId}`);
    if (action.finishedAt !== undefined) timestamp(action.finishedAt, `Recovery finish time ${index} for ${value.iterationId}`);
    if (action.exitCode !== undefined && !Number.isInteger(action.exitCode)) throw Error(`Recovery exit code ${index} for ${value.iterationId} must be an integer`);
    for (const field of ['disposition', 'detail'] as const) {
      if (action[field] !== undefined) requiredString(action[field], `Recovery ${field} ${index} for ${value.iterationId}`);
    }
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    throw Error(`Iteration ${value.iterationId} must record at least one evidence item`);
  }
  for (const [index, item] of value.evidence.entries()) {
    if (!isRecord(item)) throw Error(`Evidence ${index} for ${value.iterationId} must be an object`);
    requiredString(item.kind, `Evidence kind ${index} for ${value.iterationId}`);
    requiredString(item.ref, `Evidence ref ${index} for ${value.iterationId}`);
    if (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(item.sha256))) {
      throw Error(`Evidence SHA-256 ${index} for ${value.iterationId} must be a 64-character hex digest`);
    }
    if (item.detail !== undefined) requiredString(item.detail, `Evidence detail ${index} for ${value.iterationId}`);
  }
  if (!isRecord(value.attribution)) throw Error(`Attribution for ${value.iterationId} must be an object`);
  if (value.attribution.runId !== reportRunId) throw Error(`Attribution run id for ${value.iterationId} does not match the campaign`);
  for (const field of ['taskId', 'attemptId', 'definitionDigest', 'sourceCommit', 'integratedCommit'] as const) {
    if (value.attribution[field] !== undefined) requiredString(value.attribution[field], `Attribution ${field} for ${value.iterationId}`);
  }
  if (value.attribution.attempt !== undefined && (!Number.isSafeInteger(value.attribution.attempt) || (value.attribution.attempt as number) < 1)) {
    throw Error(`Attribution attempt for ${value.iterationId} must be a positive integer`);
  }
  if (value.outcome === 'failed') requiredString(value.failureReason, `Failure reason for ${value.iterationId}`);
  else if (value.failureReason !== undefined) requiredString(value.failureReason, `Failure reason for ${value.iterationId}`);
}

function assertValidReport(value: unknown): asserts value is CrashCampaignReport {
  if (!isRecord(value)) throw Error('Crash campaign report must be an object');
  if (value.schemaVersion !== 1) throw Error('Unsupported crash campaign report schema version');
  requiredString(value.campaignId, 'Campaign id');
  requiredString(value.runId, 'Run id');
  timestamp(value.startedAt, 'Campaign start time');
  timestamp(value.updatedAt, 'Campaign update time');
  if (value.status !== 'in-progress' && value.status !== 'interrupted' && value.status !== 'complete') {
    throw Error('Invalid crash campaign status');
  }
  if (!Array.isArray(value.interruptionHistory)) throw Error('Campaign interruption history must be an array');
  for (const [index, at] of value.interruptionHistory.entries()) timestamp(at, `Campaign interruption time ${index}`);
  if (!isRecord(value.boundaries)) throw Error('Campaign boundaries must be an object');
  for (const boundary of CRASH_BOUNDARIES) {
    const coverage = value.boundaries[boundary];
    if (!isRecord(coverage)) throw Error(`Campaign report is missing boundary ${boundary}`);
    if (coverage.boundary !== boundary) throw Error(`Boundary record key does not match ${boundary}`);
    if (!Array.isArray(coverage.iterations)) throw Error(`Iterations for ${boundary} must be an array`);
    for (const iteration of coverage.iterations) validateIteration(iteration, value.runId as string, boundary);
    const outcome = deriveBoundaryOutcome(coverage.iterations as CrashCampaignIteration[]);
    if (coverage.outcome !== outcome) throw Error(`Stored outcome for ${boundary} does not match its iterations`);
  }
  if (value.status === 'interrupted' && value.interruptionHistory.length === 0) {
    throw Error('Interrupted campaign must record an interruption time');
  }
  if (value.status === 'complete') {
    timestamp(value.completedAt, 'Campaign completion time');
    if (CRASH_BOUNDARIES.some(boundary => (value.boundaries as Record<string, CrashBoundaryCoverage>)[boundary].outcome === 'not-run')) {
      throw Error('A campaign with unrun boundaries cannot be complete');
    }
  } else if (value.completedAt !== undefined) {
    throw Error('Only a complete campaign may have a completion time');
  }
}

/** Create a report with an explicit not-run entry for every required boundary. */
export function createCrashCampaignReport(options: CreateCrashCampaignReportOptions): CrashCampaignReport {
  requiredString(options.runId, 'Run id');
  const startedAt = options.startedAt ?? new Date().toISOString();
  timestamp(startedAt, 'Campaign start time');
  const boundaries = Object.fromEntries(CRASH_BOUNDARIES.map((boundary): [CrashBoundary, CrashBoundaryCoverage] => [boundary, {
    boundary,
    outcome: 'not-run' as const,
    iterations: [],
  }])) as Record<CrashBoundary, CrashBoundaryCoverage>;
  const report: CrashCampaignReport = {
    schemaVersion: 1,
    campaignId: options.campaignId ?? randomUUID(),
    runId: options.runId,
    status: 'in-progress',
    startedAt,
    updatedAt: startedAt,
    interruptionHistory: [],
    boundaries,
  };
  assertValidReport(report);
  return report;
}

/** Add a durable observation while preserving all prior iterations. */
export function recordCrashCampaignIteration(
  report: CrashCampaignReport,
  input: NewCrashCampaignIteration,
  recordedAt = new Date().toISOString(),
): CrashCampaignReport {
  assertValidReport(report);
  if (report.status !== 'in-progress') throw Error(`Cannot add an iteration to a ${report.status} campaign`);
  timestamp(recordedAt, 'Iteration record time');
  if (!isBoundary(input.boundary)) throw Error(`Unknown crash boundary: ${String(input.boundary)}`);
  const iteration: CrashCampaignIteration = { ...input, iterationId: input.iterationId ?? randomUUID() };
  validateIteration(iteration, report.runId, input.boundary);
  const coverage = report.boundaries[input.boundary];
  if (CRASH_BOUNDARIES.some(boundary => report.boundaries[boundary].iterations.some(item => item.iterationId === iteration.iterationId))) {
    throw Error(`Duplicate crash campaign iteration id: ${iteration.iterationId}`);
  }
  const iterations = [...coverage.iterations.map(copyIteration), copyIteration(iteration)];
  const boundaries = {
    ...report.boundaries,
    [input.boundary]: {
      boundary: input.boundary,
      iterations,
      outcome: deriveBoundaryOutcome(iterations),
    },
  } as Record<CrashBoundary, CrashBoundaryCoverage>;
  const updated: CrashCampaignReport = { ...report, updatedAt: recordedAt, boundaries };
  assertValidReport(updated);
  return updated;
}

/** Mark a campaign interrupted without discarding already persisted results. */
export function interruptCrashCampaignReport(report: CrashCampaignReport, interruptedAt = new Date().toISOString()): CrashCampaignReport {
  assertValidReport(report);
  if (report.status === 'complete') throw Error('A complete campaign cannot be interrupted');
  timestamp(interruptedAt, 'Campaign interruption time');
  const interrupted: CrashCampaignReport = {
    ...report,
    status: 'interrupted',
    updatedAt: interruptedAt,
    interruptionHistory: [...report.interruptionHistory, interruptedAt],
    completedAt: undefined,
  };
  assertValidReport(interrupted);
  return interrupted;
}

/** Resume without clearing any boundary result or interruption history. */
export function resumeCrashCampaignReport(report: CrashCampaignReport, resumedAt = new Date().toISOString()): CrashCampaignReport {
  assertValidReport(report);
  if (report.status === 'complete') throw Error('A complete campaign cannot be resumed');
  timestamp(resumedAt, 'Campaign resume time');
  const resumed: CrashCampaignReport = { ...report, status: 'in-progress', updatedAt: resumedAt, completedAt: undefined };
  assertValidReport(resumed);
  return resumed;
}

/** Finalize only when every required boundary has a conclusive iteration. */
export function completeCrashCampaignReport(report: CrashCampaignReport, completedAt = new Date().toISOString()): CrashCampaignReport {
  assertValidReport(report);
  if (report.status !== 'in-progress') throw Error(`Cannot complete a ${report.status} campaign; resume it first`);
  timestamp(completedAt, 'Campaign completion time');
  const missing = CRASH_BOUNDARIES.filter(boundary => report.boundaries[boundary].outcome === 'not-run');
  if (missing.length > 0) throw Error(`Cannot complete campaign; boundaries not run: ${missing.join(', ')}`);
  const completed: CrashCampaignReport = { ...report, status: 'complete', updatedAt: completedAt, completedAt };
  assertValidReport(completed);
  return completed;
}

/** True only when all six boundaries completed without a failed iteration. */
export function isCrashCampaignSuccessful(report: CrashCampaignReport): boolean {
  assertValidReport(report);
  return report.status === 'complete' && CRASH_BOUNDARIES.every(boundary => report.boundaries[boundary].outcome === 'completed');
}

/** Default report location inside the Flow 3 run's local sidecar directory. */
export function crashCampaignReportPath(runFile: string, campaignId: string): string {
  requiredString(campaignId, 'Campaign id');
  if (!/^[A-Za-z0-9._-]+$/.test(campaignId) || campaignId === '.' || campaignId === '..') {
    throw Error('Campaign id must be a safe file-name segment');
  }
  return join(runPaths(runFile).dir, 'crash-certification', `${campaignId}.json`);
}

/** Persist through Flow 3's fsync-and-rename JSON writer. */
export function saveCrashCampaignReport(path: string, report: CrashCampaignReport): void {
  assertValidReport(report);
  atomicWriteJson(path, report);
}

/** Load and validate a persisted report; malformed state fails closed. */
export function loadCrashCampaignReport(path: string): CrashCampaignReport {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assertValidReport(parsed);
  return parsed;
}
