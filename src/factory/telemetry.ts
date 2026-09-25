import type { Run, Task } from '../types.js';

/** Structured view of one existing DAG attempt. It is input to reporting only. */
export interface FactoryAttemptHistory {
  taskId: string;
  attempt: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  success?: boolean;
  fallback?: boolean;
  strongModelEscalation?: boolean;
  /** Relative cost units (tokens, dollars, or another caller-defined proxy). */
  reviewCostProxy?: number;
  rawFindings?: number;
  verifiedFindings?: number;
  rejectedFindings?: number;
  hypothesisCount?: number;
  rootCauseCount?: number;
  reviewerOutcomes?: Array<{ reviewer: string; verdict: 'pass' | 'fail' | 'error' | 'skipped' }>;
}

export interface FactoryFindingHistory {
  id: string;
  verified: boolean;
  novel?: boolean;
  duplicate?: boolean;
  rootCauseId?: string | null;
  remediated?: boolean;
  regressed?: boolean;
}

export interface FactoryHumanHistory {
  kind: 'review-requested' | 'verdict-reversed' | 'manual-repair';
}

export interface FactoryCertificationHistory {
  requestedAt: string;
  certifiedAt: string;
}

export interface FactoryRiskCoverage {
  /** Risk weight in the measured population. */
  totalRisk: number;
  /** Portion inspected, in the same units as totalRisk. */
  inspectedRisk: number;
}

export interface FactoryTelemetryEvidence {
  requests?: number;
  attempts?: FactoryAttemptHistory[];
  findings?: FactoryFindingHistory[];
  human?: FactoryHumanHistory[];
  certifications?: FactoryCertificationHistory[];
  riskCoverage?: FactoryRiskCoverage[];
}

export interface FactoryTelemetry {
  requests: number;
  tasks: number;
  counts: {
    taskSuccesses: number;
    retries: number;
    mergeConflicts: number;
    repairs: number;
    agentFallbacks: number;
    rawFindings: number;
    verifiedFindings: number;
    rejectedFindings: number;
    falsePositives: number;
    reviewerPasses: number;
    reviewerRejections: number;
    reviewerErrors: number;
    reviewerSkips: number;
    rootCauses: number;
    humanReviewsRequested: number;
    humanVerdictReversals: number;
    manualRepairInterventions: number;
    regressionEscapes: number;
  };
  rates: {
    verifiedNovelFindingsPer1000Requests: number | null;
    rootCausesPer1000Requests: number | null;
    humanInterventionsPer1000Tasks: number | null;
    falsePositiveRate: number | null;
    duplicateFindingRate: number | null;
    strongModelEscalationRate: number | null;
    taskSuccessRate: number | null;
    mergeConflictRate: number | null;
    repairRate: number | null;
    agentFallbackRate: number | null;
    hypothesisCompressionRatio: number | null;
    rootCauseCompressionRatio: number | null;
    riskCoverage: number | null;
    regressionEscapeRate: number | null;
    remediationSuccessRate: number | null;
  };
  cost: {
    reviewCostProxy: number | null;
    perVerifiedDefect: number | null;
    perRootCause: number | null;
  };
  latencyMs: {
    averageAttempt: number | null;
    averageTimeToCertification: number | null;
  };
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

function elapsed(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/**
 * Summarize settled DAG and factory evidence. This is deliberately read-only:
 * it neither edits the run nor participates in task/reviewer routing.
 * Missing evidence produces null rates/costs instead of invented zeros.
 */
export function summarizeFactoryTelemetry(
  run: Pick<Run, 'tasks'>,
  evidence: FactoryTelemetryEvidence = {},
): FactoryTelemetry {
  const tasks = Object.values(run.tasks) as Task[];
  const attempts = evidence.attempts ?? [];
  const findings = evidence.findings ?? [];
  const human = evidence.human ?? [];
  const certifications = evidence.certifications ?? [];
  const riskCoverage = evidence.riskCoverage ?? [];

  const completed = tasks.filter((task) => task.status === 'completed').length;
  const taskCount = tasks.length;
  const rawFindings = attempts.reduce((sum, attempt) => sum + (attempt.rawFindings ?? 0), 0);
  const verifiedFromAttempts = attempts.reduce((sum, attempt) => sum + (attempt.verifiedFindings ?? 0), 0);
  const rejectedFindings = attempts.reduce((sum, attempt) => sum + (attempt.rejectedFindings ?? 0), 0);
  const verifiedFindings = findings.length
    ? findings.filter((finding) => finding.verified).length
    : verifiedFromAttempts;
  const uniqueRoots = new Set(findings.flatMap((finding) => finding.rootCauseId ? [finding.rootCauseId] : []));
  const rootCauses = uniqueRoots.size || attempts.reduce((sum, attempt) => sum + (attempt.rootCauseCount ?? 0), 0);
  const novelVerified = findings.filter((finding) => finding.verified && finding.novel !== false).length;
  const verifiedNovelCount = findings.length ? novelVerified : verifiedFromAttempts;
  const duplicateCount = findings.filter((finding) => finding.duplicate).length;
  const falsePositives = rejectedFindings;
  const verifiedDefects = findings.length ? verifiedFindings : verifiedFromAttempts;
  const reviewCost = attempts.some((attempt) => attempt.reviewCostProxy !== undefined)
    ? attempts.reduce((sum, attempt) => sum + (attempt.reviewCostProxy ?? 0), 0)
    : null;
  const attemptLatencies = attempts
    .map((attempt) => elapsed(attempt.startedAt, attempt.finishedAt))
    .filter((value): value is number => value !== null);
  const taskLatencies = tasks
    .map((task) => elapsed(task.startedAt, task.finishedAt))
    .filter((value): value is number => value !== null);
  const certificationLatencies = certifications
    .map((item) => elapsed(item.requestedAt, item.certifiedAt))
    .filter((value): value is number => value !== null);
  const riskTotal = riskCoverage.reduce((sum, item) => sum + Math.max(0, item.totalRisk), 0);
  const riskInspected = riskCoverage.reduce(
    (sum, item) => sum + Math.max(0, Math.min(item.totalRisk, item.inspectedRisk)),
    0,
  );
  const humanInterventions = human.length;
  const taskAttempts = attempts.length || tasks.reduce((sum, task) => sum + task.attempts, 0);
  const fallbackCount = attempts.filter((attempt) => attempt.fallback).length;
  const repairSuccesses = findings.filter((finding) => finding.verified && finding.remediated && !finding.regressed).length;
  const remediationCandidates = findings.filter((finding) => finding.verified && finding.remediated !== undefined).length;
  const regressionCandidates = findings.filter((finding) => finding.remediated).length;
  const rootCauseCount = Math.max(0, rootCauses);
  const hypotheses = attempts.reduce((sum, attempt) => sum + (attempt.hypothesisCount ?? 0), 0);
  const reviewerOutcomes = attempts.flatMap((attempt) => attempt.reviewerOutcomes ?? []);

  return {
    requests: evidence.requests ?? taskCount,
    tasks: taskCount,
    counts: {
      taskSuccesses: completed,
      retries: tasks.reduce((sum, task) => sum + Math.max(0, task.attempts - 1), 0),
      mergeConflicts: tasks.reduce((sum, task) => sum + task.mergeRetries, 0),
      repairs: tasks.reduce((sum, task) => sum + task.repairs, 0),
      agentFallbacks: fallbackCount,
      rawFindings: rawFindings || findings.length,
      verifiedFindings,
      rejectedFindings,
      falsePositives,
      reviewerPasses: reviewerOutcomes.filter((outcome) => outcome.verdict === 'pass').length,
      reviewerRejections: reviewerOutcomes.filter((outcome) => outcome.verdict === 'fail').length,
      reviewerErrors: reviewerOutcomes.filter((outcome) => outcome.verdict === 'error').length,
      reviewerSkips: reviewerOutcomes.filter((outcome) => outcome.verdict === 'skipped').length,
      rootCauses: rootCauseCount,
      humanReviewsRequested: human.filter((item) => item.kind === 'review-requested').length,
      humanVerdictReversals: human.filter((item) => item.kind === 'verdict-reversed').length,
      manualRepairInterventions: human.filter((item) => item.kind === 'manual-repair').length,
      regressionEscapes: findings.filter((finding) => finding.regressed).length,
    },
    rates: {
      verifiedNovelFindingsPer1000Requests: ratio(verifiedNovelCount * 1000, evidence.requests ?? taskCount),
      rootCausesPer1000Requests: ratio(rootCauseCount * 1000, evidence.requests ?? taskCount),
      humanInterventionsPer1000Tasks: ratio(humanInterventions * 1000, taskCount),
      falsePositiveRate: ratio(falsePositives, falsePositives + verifiedDefects),
      duplicateFindingRate: ratio(duplicateCount, findings.length || rawFindings),
      strongModelEscalationRate: ratio(
        attempts.filter((attempt) => attempt.strongModelEscalation).length,
        taskAttempts,
      ),
      taskSuccessRate: ratio(completed, taskCount),
      mergeConflictRate: ratio(tasks.filter((task) => task.mergeRetries > 0).length, taskCount),
      repairRate: ratio(tasks.filter((task) => task.repairs > 0).length, taskCount),
      agentFallbackRate: ratio(fallbackCount, taskAttempts),
      hypothesisCompressionRatio: ratio(rawFindings, hypotheses),
      rootCauseCompressionRatio: ratio(hypotheses, rootCauseCount),
      riskCoverage: ratio(riskInspected, riskTotal),
      regressionEscapeRate: ratio(findings.filter((finding) => finding.regressed).length, regressionCandidates),
      remediationSuccessRate: ratio(repairSuccesses, remediationCandidates),
    },
    cost: {
      reviewCostProxy: reviewCost,
      perVerifiedDefect: reviewCost === null ? null : ratio(reviewCost, verifiedDefects),
      perRootCause: reviewCost === null ? null : ratio(reviewCost, rootCauseCount),
    },
    latencyMs: {
      averageAttempt: average(attemptLatencies.length ? attemptLatencies : taskLatencies),
      averageTimeToCertification: average(certificationLatencies),
    },
  };
}
