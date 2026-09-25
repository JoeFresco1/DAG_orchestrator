/** Policy-gated promotion of reproducible certification evidence to a baseline. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteJson, readJsonFileWithBackup, runPaths } from '../store.js';
import {
  createCertification,
  type Certification,
  type CertificationInput,
} from './certification.js';

export interface BaselinePolicy {
  /** Every listed check must be present and pass. All supplied checks must pass too. */
  requiredCheckIds?: string[];
  minimumCriticalFlowCoverage?: number;
  minimumWeightedRiskCoverage?: number;
}

export interface BaselinePromotion {
  schemaVersion: 1;
  id: `baseline:v1:${string}`;
  runId: string;
  commit: string;
  policy: Required<BaselinePolicy>;
  /** Evidence snapshot without a separate status that could imply promotion. */
  certification: CertificationInput;
  /** Refused records retain the complete evidence and explain each failed gate. */
  status: 'certified' | 'refused';
  reasons: string[];
}

const FILE = 'baseline-v1.json';
const DEFAULT_POLICY: Required<BaselinePolicy> = {
  requiredCheckIds: [],
  minimumCriticalFlowCoverage: 1,
  minimumWeightedRiskCoverage: 0.95,
};

/** Evaluate the configured gates. A failing attempt is an explicit refusal, never a certificate. */
export function createBaseline(input: CertificationInput, policy: BaselinePolicy = {}): BaselinePromotion {
  const normalizedPolicy = normalizePolicy(policy);
  const assessment = createCertification(input);
  const certification = certificationInputOf(assessment);
  const reasons: string[] = [];

  if (assessment.status !== 'certified') reasons.push(...certificationFailureReasons(assessment));
  const checks = new Map(assessment.deterministicChecks.map((check) => [check.id, check.status]));
  for (const id of normalizedPolicy.requiredCheckIds) {
    const status = checks.get(id);
    if (status === undefined) reasons.push(`required deterministic check is missing: ${id}`);
    else if (status !== 'pass') reasons.push(`required deterministic check did not pass: ${id} (${status})`);
  }
  if (assessment.criticalFlowCoverage < normalizedPolicy.minimumCriticalFlowCoverage) {
    reasons.push(`critical-flow coverage ${assessment.criticalFlowCoverage} is below minimum ${normalizedPolicy.minimumCriticalFlowCoverage}`);
  }
  if (assessment.weightedRiskCoverage < normalizedPolicy.minimumWeightedRiskCoverage) {
    reasons.push(`weighted-risk coverage ${assessment.weightedRiskCoverage} is below minimum ${normalizedPolicy.minimumWeightedRiskCoverage}`);
  }

  const uniqueReasons = [...new Set(reasons)];
  const status: BaselinePromotion['status'] = uniqueReasons.length === 0 ? 'certified' : 'refused';
  const identity = { runId: certification.runId, commit: certification.commit, policy: normalizedPolicy, certification, status, reasons: uniqueReasons };
  return { schemaVersion: 1, id: `baseline:v1:${hash(canonicalJson(identity))}`, ...identity };
}

/** Save both passing and refused attempts; refused evidence remains reviewable and cannot be promoted. */
export function saveBaseline(runFile: string, baseline: BaselinePromotion): string {
  validateBaseline(baseline);
  const file = join(runPaths(runFile).factory, FILE);
  atomicWriteJson(file, baseline);
  return file;
}

/** Evaluate and persist a baseline attempt in one explicit promotion operation. */
export function promoteBaseline(
  runFile: string,
  input: CertificationInput,
  policy: BaselinePolicy = {},
): BaselinePromotion {
  const baseline = createBaseline(input, policy);
  saveBaseline(runFile, baseline);
  return baseline;
}

/** Read the latest baseline attempt and verify its evidence-derived identity. */
export function loadBaseline(runFile: string, expectedRunId?: string): BaselinePromotion | null {
  const raw = readJsonFileWithBackup<unknown>(join(runPaths(runFile).factory, FILE));
  if (raw === null) return null;
  validateBaseline(raw);
  if (expectedRunId !== undefined && raw.runId !== expectedRunId) {
    throw new Error(`baseline belongs to run ${raw.runId}, expected ${expectedRunId}`);
  }
  return raw;
}

export function validateBaseline(value: unknown): asserts value is BaselinePromotion {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('unsupported baseline schema');
  const baseline = value as unknown as BaselinePromotion;
  createCertification(baseline.certification);
  if (!baseline.runId?.trim() || baseline.runId !== baseline.certification.runId) throw new Error('baseline runId does not match certification');
  if (baseline.commit !== baseline.certification.commit) throw new Error('baseline commit does not match certification');
  const policy = normalizePolicy(baseline.policy);
  if (canonicalJson(policy) !== canonicalJson(baseline.policy)) throw new Error('baseline policy is not normalized');
  if (!Array.isArray(baseline.reasons) || baseline.reasons.some((reason) => typeof reason !== 'string' || !reason.trim())) {
    throw new Error('baseline reasons must be non-empty strings');
  }
  if (baseline.status !== 'certified' && baseline.status !== 'refused') throw new Error('invalid baseline status');
  const rebuilt = createBaseline(baseline.certification, policy);
  if (baseline.status !== rebuilt.status || canonicalJson(baseline.reasons) !== canonicalJson(rebuilt.reasons)) {
    throw new Error('baseline status does not match its configured gates');
  }
  if (baseline.id !== rebuilt.id) throw new Error('baseline ID does not match its evidence');
}

function certificationInputOf(certification: Certification): CertificationInput {
  const {
    runId, commit, specificationGraphHash, architectureGraphHash, testStateHash,
    deterministicChecks, reviewEvidence, acceptedRisks, residualFindings,
    criticalFlowCoverage, weightedRiskCoverage,
  } = certification;
  return {
    runId, commit, specificationGraphHash, architectureGraphHash, testStateHash,
    deterministicChecks, reviewEvidence, acceptedRisks, residualFindings,
    criticalFlowCoverage, weightedRiskCoverage,
  };
}

function normalizePolicy(policy: BaselinePolicy): Required<BaselinePolicy> {
  const requiredCheckIds = [...(policy.requiredCheckIds ?? [])];
  if (requiredCheckIds.some((id) => typeof id !== 'string' || !id.trim())) throw new Error('required check IDs must be non-empty strings');
  if (new Set(requiredCheckIds).size !== requiredCheckIds.length) throw new Error('required check IDs must be unique');
  requiredCheckIds.sort();
  const minimumCriticalFlowCoverage = policy.minimumCriticalFlowCoverage ?? DEFAULT_POLICY.minimumCriticalFlowCoverage;
  const minimumWeightedRiskCoverage = policy.minimumWeightedRiskCoverage ?? DEFAULT_POLICY.minimumWeightedRiskCoverage;
  for (const [name, value] of Object.entries({ minimumCriticalFlowCoverage, minimumWeightedRiskCoverage })) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
  }
  return { requiredCheckIds, minimumCriticalFlowCoverage, minimumWeightedRiskCoverage };
}

function certificationFailureReasons(certification: Certification): string[] {
  const reasons: string[] = [];
  if (certification.status === 'invalidated') reasons.push(`certification was invalidated: ${certification.invalidationReason ?? 'reason unavailable'}`);
  for (const check of certification.deterministicChecks) if (check.status !== 'pass') reasons.push(`deterministic check did not pass: ${check.id} (${check.status})`);
  for (const review of certification.reviewEvidence) if (review.verdict !== 'pass') reasons.push(`review did not pass: ${review.id}`);
  if (certification.deterministicChecks.length === 0) reasons.push('no deterministic checks were recorded');
  if (certification.reviewEvidence.length === 0) reasons.push('no review evidence was recorded');
  if (certification.criticalFlowCoverage !== 1) reasons.push('critical-flow coverage must be 1.0');
  const accepted = new Set(certification.acceptedRisks.map((risk) => risk.id));
  for (const finding of certification.residualFindings) {
    if ((finding.severity === 'critical' || finding.severity === 'high') && (!finding.acceptedRiskId || !accepted.has(finding.acceptedRiskId))) {
      reasons.push(`unaccepted ${finding.severity} residual finding: ${finding.id}`);
    }
  }
  return reasons;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
