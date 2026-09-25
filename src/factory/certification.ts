/** Reproducible certification snapshots for a run's known-good repository state. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteJson, readJsonFileWithBackup, runPaths } from '../store.js';

export type CertificationSeverity = 'critical' | 'high' | 'medium' | 'low';
export type CertificationCheckStatus = 'pass' | 'fail' | 'skipped';

export interface CertificationEvidence {
  /** Stable URI or run-relative artifact path. */
  uri: string;
  /** SHA-256 of the referenced evidence bytes. */
  sha256: string;
}

export interface DeterministicCheck {
  id: string;
  status: CertificationCheckStatus;
  evidence: CertificationEvidence[];
}

export interface ReviewEvidence {
  id: string;
  reviewer: string;
  verdict: 'pass' | 'fail';
  evidence: CertificationEvidence[];
}

export interface AcceptedRisk {
  id: string;
  description: string;
  severity: CertificationSeverity;
  rationale: string;
  evidence: CertificationEvidence[];
}

export interface ResidualFinding {
  id: string;
  severity: CertificationSeverity;
  description: string;
  acceptedRiskId?: string;
  evidence: CertificationEvidence[];
}

export interface CertificationInput {
  runId: string;
  commit: string;
  /** SHA-256 of canonical requirement/specification graph bytes. */
  specificationGraphHash: string;
  /** SHA-256 of canonical architecture/code graph bytes. */
  architectureGraphHash: string;
  /** SHA-256 identifying the deterministic test state/results. */
  testStateHash: string;
  deterministicChecks: DeterministicCheck[];
  reviewEvidence: ReviewEvidence[];
  acceptedRisks: AcceptedRisk[];
  residualFindings: ResidualFinding[];
  criticalFlowCoverage: number;
  weightedRiskCoverage: number;
}

export interface Certification extends CertificationInput {
  schemaVersion: 1;
  id: `certification:v1:${string}`;
  status: 'certified' | 'uncertified' | 'invalidated';
  invalidationReason?: string;
}

export interface CertificationCurrentState {
  commit: string;
  specificationGraphHash: string;
  architectureGraphHash: string;
  testStateHash: string;
}

export interface CertificationValidity {
  valid: boolean;
  reasons: string[];
}

const FILE = 'certification-v1.json';
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const SEVERITIES: CertificationSeverity[] = ['critical', 'high', 'medium', 'low'];

/** Create the same ID and state whenever the certification evidence is identical. */
export function createCertification(input: CertificationInput): Certification {
  validateInput(input);
  const normalized = normalizeInput(input);
  const acceptedRiskIds = new Set(normalized.acceptedRisks.map((risk) => risk.id));
  const criticalOrHigh = normalized.residualFindings.some((finding) =>
    (finding.severity === 'critical' || finding.severity === 'high') &&
    (!finding.acceptedRiskId || !acceptedRiskIds.has(finding.acceptedRiskId)));
  const certified = normalized.deterministicChecks.length > 0 &&
    normalized.deterministicChecks.every((check) => check.status === 'pass') &&
    normalized.reviewEvidence.length > 0 && normalized.reviewEvidence.every((review) => review.verdict === 'pass') &&
    normalized.criticalFlowCoverage === 1 && !criticalOrHigh;
  const id = `certification:v1:${hash(canonicalJson(normalized))}` as const;
  return {
    schemaVersion: 1,
    ...normalized,
    id,
    status: certified ? 'certified' : 'uncertified',
  };
}

/** Persist certification beside its run without changing Run.storageVersion. */
export function saveCertification(runFile: string, certification: Certification): string {
  validateCertification(certification);
  const file = join(runPaths(runFile).factory, FILE);
  atomicWriteJson(file, certification);
  return file;
}

/** Load and validate the supported certification version and owning run. */
export function loadCertification(runFile: string, expectedRunId?: string): Certification | null {
  const file = join(runPaths(runFile).factory, FILE);
  const raw = readJsonFileWithBackup<unknown>(file);
  if (raw === null) return null;
  validateCertification(raw);
  if (expectedRunId !== undefined && raw.runId !== expectedRunId) {
    throw new Error(`certification belongs to run ${raw.runId}, expected ${expectedRunId}`);
  }
  return raw;
}

/** Compare all certification anchors; any changed anchor makes it stale. */
export function checkCertificationValidity(
  certification: Certification,
  current: CertificationCurrentState,
): CertificationValidity {
  validateCertification(certification);
  validateCurrentState(current);
  const reasons: string[] = [];
  if (certification.status === 'invalidated') reasons.push(certification.invalidationReason ?? 'certification was invalidated');
  if (certification.commit !== current.commit) reasons.push('commit changed');
  if (certification.specificationGraphHash !== current.specificationGraphHash) reasons.push('specification graph changed');
  if (certification.architectureGraphHash !== current.architectureGraphHash) reasons.push('architecture graph changed');
  if (certification.testStateHash !== current.testStateHash) reasons.push('deterministic test state changed');
  if (certification.status === 'uncertified') reasons.push('snapshot did not meet certification criteria');
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Preserve the evidence snapshot while recording an explicit invalidation. */
export function invalidateCertification(certification: Certification, reason: string): Certification {
  validateCertification(certification);
  if (!reason.trim()) throw new Error('invalidation reason cannot be empty');
  return { ...certification, status: 'invalidated', invalidationReason: reason.trim() };
}

export function validateCertification(value: unknown): asserts value is Certification {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('unsupported certification schema');
  const certification = value as unknown as Certification;
  validateInput(certification);
  if (!['certified', 'uncertified', 'invalidated'].includes(certification.status)) throw new Error('invalid certification status');
  if (certification.status === 'invalidated' && !certification.invalidationReason?.trim()) {
    throw new Error('invalidated certification requires a reason');
  }
  if (certification.status !== 'invalidated' && certification.invalidationReason !== undefined) {
    throw new Error('only invalidated certifications may have an invalidation reason');
  }
  const expected = `certification:v1:${hash(canonicalJson(normalizeInput(certification)))}`;
  if (certification.id !== expected) throw new Error('certification ID does not match its evidence');
  const rebuilt = createCertification(normalizeInput(certification));
  // Status is independently derived from the evidence; invalidation is the only mutable overlay.
  if (certification.status !== 'invalidated' && certification.status !== rebuilt.status) {
    throw new Error('certification status does not match its evidence');
  }
}

function validateInput(input: CertificationInput): void {
  if (!input.runId?.trim()) throw new Error('certification requires a runId');
  if (!COMMIT.test(input.commit)) throw new Error('certification commit must be a full Git commit hash');
  for (const [name, value] of Object.entries({
    specificationGraphHash: input.specificationGraphHash,
    architectureGraphHash: input.architectureGraphHash,
    testStateHash: input.testStateHash,
  })) if (!HASH.test(value)) throw new Error(`${name} must be a lowercase SHA-256 hash`);
  for (const [name, value] of Object.entries({
    criticalFlowCoverage: input.criticalFlowCoverage,
    weightedRiskCoverage: input.weightedRiskCoverage,
  })) if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
  for (const key of ['deterministicChecks', 'reviewEvidence', 'acceptedRisks', 'residualFindings'] as const) {
    if (!Array.isArray(input[key])) throw new Error(`${key} must be an array`);
  }
  uniqueIds(input.deterministicChecks, 'deterministic check');
  uniqueIds(input.reviewEvidence, 'review evidence');
  uniqueIds(input.acceptedRisks, 'accepted risk');
  uniqueIds(input.residualFindings, 'residual finding');
  for (const check of input.deterministicChecks) {
    if (!check.id.trim() || !['pass', 'fail', 'skipped'].includes(check.status)) throw new Error('invalid deterministic check');
    validateEvidence(check.evidence);
  }
  for (const review of input.reviewEvidence) {
    if (!review.id.trim() || !review.reviewer.trim() || !['pass', 'fail'].includes(review.verdict)) throw new Error('invalid review evidence');
    validateEvidence(review.evidence);
  }
  for (const risk of input.acceptedRisks) {
    if (!risk.id.trim() || !risk.description.trim() || !risk.rationale.trim() || !SEVERITIES.includes(risk.severity)) throw new Error('invalid accepted risk');
    validateEvidence(risk.evidence);
  }
  const riskIds = new Set(input.acceptedRisks.map((risk) => risk.id));
  for (const finding of input.residualFindings) {
    if (!finding.id.trim() || !finding.description.trim() || !SEVERITIES.includes(finding.severity)) throw new Error('invalid residual finding');
    if (finding.acceptedRiskId && !riskIds.has(finding.acceptedRiskId)) throw new Error(`finding ${finding.id} references unknown accepted risk`);
    validateEvidence(finding.evidence);
  }
}

function validateCurrentState(current: CertificationCurrentState): void {
  if (!COMMIT.test(current.commit)) throw new Error('current commit must be a full Git commit hash');
  for (const [name, value] of Object.entries({
    specificationGraphHash: current.specificationGraphHash,
    architectureGraphHash: current.architectureGraphHash,
    testStateHash: current.testStateHash,
  })) if (!HASH.test(value)) throw new Error(`${name} must be a lowercase SHA-256 hash`);
}

function validateEvidence(evidence: CertificationEvidence[]): void {
  if (!Array.isArray(evidence)) throw new Error('evidence must be an array');
  for (const ref of evidence) {
    if (!ref.uri?.trim() || !HASH.test(ref.sha256)) throw new Error('invalid certification evidence reference');
  }
}

function uniqueIds(items: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (typeof item?.id !== 'string' || !item.id.trim() || ids.has(item.id)) throw new Error(`${label} IDs must be non-empty and unique`);
    ids.add(item.id);
  }
}

function normalizeInput(input: CertificationInput): CertificationInput {
  return {
    runId: input.runId,
    commit: input.commit,
    specificationGraphHash: input.specificationGraphHash,
    architectureGraphHash: input.architectureGraphHash,
    testStateHash: input.testStateHash,
    criticalFlowCoverage: input.criticalFlowCoverage,
    weightedRiskCoverage: input.weightedRiskCoverage,
    deterministicChecks: [...input.deterministicChecks].map((item) => ({ ...item, evidence: sortedEvidence(item.evidence) })).sort(byId),
    reviewEvidence: [...input.reviewEvidence].map((item) => ({ ...item, evidence: sortedEvidence(item.evidence) })).sort(byId),
    acceptedRisks: [...input.acceptedRisks].map((item) => ({ ...item, evidence: sortedEvidence(item.evidence) })).sort(byId),
    residualFindings: [...input.residualFindings].map((item) => ({ ...item, evidence: sortedEvidence(item.evidence) })).sort(byId),
  };
}

function sortedEvidence(evidence: CertificationEvidence[]): CertificationEvidence[] {
  return [...evidence].map((item) => ({ ...item })).sort((a, b) => a.uri.localeCompare(b.uri) || a.sha256.localeCompare(b.sha256));
}
function byId(a: { id: string }, b: { id: string }): number { return a.id.localeCompare(b.id); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
