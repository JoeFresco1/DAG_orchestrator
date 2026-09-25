/**
 * Empirical confidence calibration for factory findings.
 *
 * Model-reported confidence is retained as a calibration stratum only. The
 * estimate is derived from adjudicated history and distinct current evidence;
 * this module never certifies a claim.
 */
export type ConfidenceOutcome = 'verified' | 'rejected' | 'unresolved';
export type ConfidenceEvidenceStance = 'corroborates' | 'contradicts';
export type ConfidenceBand = 'low' | 'medium' | 'high';

/** Dimensions that may define a separate calibration population. */
export interface ConfidenceContext {
  model?: string;
  reviewerRole?: string;
  language?: string;
  subsystem?: string;
  category?: string;
  severity?: string;
  repository?: string;
}

/** One historically adjudicated model finding. Unresolved outcomes do not train calibration. */
export interface ConfidenceObservation {
  id: string;
  context?: ConfidenceContext;
  /** The model's original score, used only to select a confidence band. */
  nominalConfidence: number;
  outcome: ConfidenceOutcome;
}

/** A current source that independently supports or challenges the claim. */
export interface ConfidenceEvidence {
  id: string;
  stance: ConfidenceEvidenceStance;
}

export interface CalibrateConfidenceInput {
  /** Untrusted score reported by the model; never used as the estimate itself. */
  nominalConfidence: number;
  /** Only specified context dimensions constrain the history population. */
  context?: ConfidenceContext;
  evidence?: readonly ConfidenceEvidence[];
}

export interface ConfidenceCalibrationResult {
  schemaVersion: 1;
  nominalConfidence: number;
  nominalBand: ConfidenceBand;
  /** Empirical posterior mean after historical outcomes and distinct evidence. */
  calibratedConfidence: number;
  /** Wilson 95% interval for the combined adjudicated/evidence sample. */
  interval95: { lower: number; upper: number };
  /** Width of the 95% interval; 1 means maximally uncertain. */
  uncertainty: number;
  historical: {
    verified: number;
    rejected: number;
    unresolved: number;
    sampleSize: number;
    contextDimensions: string[];
  };
  evidence: {
    corroborating: number;
    contradictory: number;
    duplicateIdsIgnored: number;
  };
  /** Calibration informs review; it does not make a finding true or certified. */
  certified: false;
  certificationReason: string;
}

const CONTEXT_FIELDS = [
  'model', 'reviewerRole', 'language', 'subsystem', 'category', 'severity', 'repository',
] as const satisfies readonly (keyof ConfidenceContext)[];

/**
 * Estimate claim confidence from matching historical precision plus current
 * corroborating/contradictory evidence. An uncalibrated score with no evidence
 * returns the neutral estimate and maximum uncertainty.
 */
export function calibrateConfidence(
  history: readonly ConfidenceObservation[],
  input: CalibrateConfidenceInput,
): ConfidenceCalibrationResult {
  validateScore(input?.nominalConfidence, 'nominalConfidence');
  const context = normalizeContext(input.context);
  const band = confidenceBand(input.nominalConfidence);
  const matches = history.filter((observation) => {
    validateObservation(observation);
    if (confidenceBand(observation.nominalConfidence) !== band) return false;
    const observedContext = normalizeContext(observation.context);
    return CONTEXT_FIELDS.every((field) => context[field] === undefined || observedContext[field] === context[field]);
  });

  let verified = 0;
  let rejected = 0;
  let unresolved = 0;
  const seenObservationIds = new Set<string>();
  for (const observation of matches) {
    // Duplicate records must not inflate apparent historical precision.
    if (seenObservationIds.has(observation.id)) continue;
    seenObservationIds.add(observation.id);
    if (observation.outcome === 'verified') verified += 1;
    else if (observation.outcome === 'rejected') rejected += 1;
    else unresolved += 1;
  }

  const seenEvidenceIds = new Set<string>();
  let corroborating = 0;
  let contradictory = 0;
  let duplicateIdsIgnored = 0;
  for (const item of input.evidence ?? []) {
    validateEvidence(item);
    if (seenEvidenceIds.has(item.id)) {
      duplicateIdsIgnored += 1;
      continue;
    }
    seenEvidenceIds.add(item.id);
    if (item.stance === 'corroborates') corroborating += 1;
    else contradictory += 1;
  }

  const positive = verified + corroborating;
  const negative = rejected + contradictory;
  const sampleSize = positive + negative;
  // Jeffreys' prior avoids impossible 0/1 estimates with sparse evidence.
  const calibratedConfidence = (positive + 0.5) / (sampleSize + 1);
  const interval95 = wilsonInterval(positive, sampleSize);
  const uncertainty = round(interval95.upper - interval95.lower);

  return {
    schemaVersion: 1,
    nominalConfidence: round(input.nominalConfidence),
    nominalBand: band,
    calibratedConfidence: round(calibratedConfidence),
    interval95: { lower: round(interval95.lower), upper: round(interval95.upper) },
    uncertainty,
    historical: {
      verified,
      rejected,
      unresolved,
      sampleSize: verified + rejected,
      contextDimensions: CONTEXT_FIELDS.filter((field) => context[field] !== undefined),
    },
    evidence: { corroborating, contradictory, duplicateIdsIgnored },
    certified: false,
    certificationReason: 'Confidence calibration is advisory; independent verification and certification are required.',
  };
}

/** Keep confidence categories stable and interpretable across callers. */
export function confidenceBand(confidence: number): ConfidenceBand {
  validateScore(confidence, 'confidence');
  if (confidence < 0.5) return 'low';
  if (confidence < 0.8) return 'medium';
  return 'high';
}

function wilsonInterval(successes: number, sampleSize: number): { lower: number; upper: number } {
  if (sampleSize === 0) return { lower: 0, upper: 1 };
  const z = 1.96;
  const p = successes / sampleSize;
  const z2 = z * z;
  const denominator = 1 + z2 / sampleSize;
  const center = (p + z2 / (2 * sampleSize)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * sampleSize)) / sampleSize) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function normalizeContext(context: ConfidenceContext | undefined): ConfidenceContext {
  if (context === undefined) return {};
  if (!isRecord(context)) throw new Error('confidence context must be an object');
  const normalized: ConfidenceContext = {};
  for (const field of CONTEXT_FIELDS) {
    const value = context[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`confidence context ${field} must be a non-empty string`);
    normalized[field] = value.trim().toLowerCase();
  }
  return normalized;
}

function validateObservation(value: ConfidenceObservation): void {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() ||
    !['verified', 'rejected', 'unresolved'].includes(String(value.outcome))) {
    throw new Error('invalid confidence observation');
  }
  validateScore(value.nominalConfidence, 'observation nominalConfidence');
  normalizeContext(value.context);
}

function validateEvidence(value: ConfidenceEvidence): void {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() ||
    !['corroborates', 'contradicts'].includes(String(value.stance))) {
    throw new Error('invalid confidence evidence');
  }
}

function validateScore(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number from 0 to 1`);
  }
}

function round(value: number): number { return Math.round(value * 1000) / 1000; }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
