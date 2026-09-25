/**
 * Read-only calibration over historical reviewer finding verdicts.
 *
 * Only adjudicated `verified` and `rejected` findings contribute to precision.
 * `unverified` findings remain in the report so missing adjudication is visible,
 * but they are never silently treated as true or false positives.
 */
export type CalibrationFindingVerdict = 'verified' | 'rejected' | 'unverified';
export type CalibrationSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface ReviewerCalibrationFinding {
  id: string;
  category: string;
  verdict: CalibrationFindingVerdict;
  /** Duplicate of a finding already proposed in this history population. */
  duplicate?: boolean;
  /** Severity proposed by the reviewer. */
  proposedSeverity?: CalibrationSeverity;
  /** Independently adjudicated severity; meaningful only for verified findings. */
  verifiedSeverity?: CalibrationSeverity;
}

export interface ReviewerCalibrationReview {
  /** Stable history event ID. When omitted, object identity is used in this call. */
  reviewId?: string;
  reviewer: string;
  model: string;
  reviewType: string;
  findings: ReviewerCalibrationFinding[];
  /** One invocation/request unless the caller records a larger request count. */
  requests?: number;
  tokens?: number;
  cost?: number;
  latencyMs?: number;
  /** Human changed or overruled at least one outcome from this review. */
  humanOverride?: boolean;
  /** Count of downstream defects explicitly recorded as prevented. */
  downstreamDefectsPrevented?: number;
}

export interface ReviewerCalibrationBucket {
  reviewer: string;
  model: string;
  reviewType: string;
  category: string;
  findingsProposed: number;
  findingsVerified: number;
  findingsRejected: number;
  findingsUnverified: number;
  duplicateFindings: number;
  /** verified / (verified + rejected); unverified findings are excluded. */
  precision: number | null;
  /** Number of adjudicated findings used as the precision denominator. */
  precisionSampleSize: number;
  /** Verified findings without a duplicate marker; unverified claims never count. */
  uniqueFindingsDiscovered: number;
  duplicateRate: number | null;
  humanOverrides: number;
  humanOverrideRate: number | null;
  severityComparisons: number;
  severityMatches: number;
  severityCalibration: number | null;
  reviews: number;
  averageRequests: number | null;
  averageTokens: number | null;
  averageCost: number | null;
  averageLatencyMs: number | null;
  downstreamDefectsPrevented: number;
}

export interface ReviewerCalibrationReport {
  schemaVersion: 1;
  buckets: ReviewerCalibrationBucket[];
}

/** Estimate reviewer performance by reviewer, model, review type, and finding category. */
export function calibrateReviewers(history: readonly ReviewerCalibrationReview[]): ReviewerCalibrationReport {
  const groups = new Map<string, Array<{ review: ReviewerCalibrationReview; finding: ReviewerCalibrationFinding }>>();
  for (const review of history) {
    validateReview(review);
    for (const finding of review.findings) {
      const category = normalizedCategory(finding.category);
      const key = JSON.stringify([review.reviewer.trim(), review.model.trim(), review.reviewType.trim(), category]);
      const group = groups.get(key) ?? [];
      group.push({ review, finding });
      groups.set(key, group);
    }
  }

  const buckets = [...groups.entries()].map(([key, records]) => {
    const [reviewer, model, reviewType, category] = JSON.parse(key) as [string, string, string, string];
    const findings = records.map((record) => record.finding);
    const verified = findings.filter((finding) => finding.verdict === 'verified').length;
    const rejected = findings.filter((finding) => finding.verdict === 'rejected').length;
    const unverified = findings.filter((finding) => finding.verdict === 'unverified').length;
    const duplicates = findings.filter((finding) => finding.duplicate === true).length;
    const adjudicated = verified + rejected;
    const severityComparable = findings.filter((finding) => finding.verdict === 'verified' &&
      finding.proposedSeverity !== undefined && finding.verifiedSeverity !== undefined);
    const reviewSamples = uniqueReviews(records.map((record) => record.review));
    const overrideCount = reviewSamples.filter((item) => item.humanOverride === true).length;
    const severityMatches = severityComparable.filter((finding) => finding.proposedSeverity === finding.verifiedSeverity).length;
    return {
      reviewer, model, reviewType, category,
      findingsProposed: findings.length,
      findingsVerified: verified,
      findingsRejected: rejected,
      findingsUnverified: unverified,
      duplicateFindings: duplicates,
      precision: adjudicated ? verified / adjudicated : null,
      precisionSampleSize: adjudicated,
      uniqueFindingsDiscovered: findings.filter((finding) => finding.verdict === 'verified' && finding.duplicate !== true).length,
      duplicateRate: findings.length ? duplicates / findings.length : null,
      humanOverrides: overrideCount,
      humanOverrideRate: reviewSamples.length ? overrideCount / reviewSamples.length : null,
      severityComparisons: severityComparable.length,
      severityMatches,
      severityCalibration: severityComparable.length ? severityMatches / severityComparable.length : null,
      reviews: reviewSamples.length,
      averageRequests: average(reviewSamples.map((item) => item.requests)),
      averageTokens: average(reviewSamples.map((item) => item.tokens)),
      averageCost: average(reviewSamples.map((item) => item.cost)),
      averageLatencyMs: average(reviewSamples.map((item) => item.latencyMs)),
      downstreamDefectsPrevented: reviewSamples.reduce((sum, item) => sum + (item.downstreamDefectsPrevented ?? 0), 0),
    } satisfies ReviewerCalibrationBucket;
  }).sort((a, b) => a.reviewer.localeCompare(b.reviewer) || a.model.localeCompare(b.model) ||
    a.reviewType.localeCompare(b.reviewType) || a.category.localeCompare(b.category));

  return { schemaVersion: 1, buckets };
}

function uniqueReviews(records: ReviewerCalibrationReview[]): ReviewerCalibrationReview[] {
  const byIdentity = new Map<string, ReviewerCalibrationReview>();
  const objectIds = new WeakMap<ReviewerCalibrationReview, number>();
  let nextObjectId = 1;
  for (const item of records) {
    // A review may propose multiple findings in one category; sample review-level
    // measurements once, without collapsing distinct reviews that cost the same.
    let objectId = objectIds.get(item);
    if (objectId === undefined) { objectId = nextObjectId++; objectIds.set(item, objectId); }
    const key = item.reviewId ? `id:${item.reviewId}` : `object:${objectId}`;
    byIdentity.set(key, item);
  }
  return [...byIdentity.values()];
}

function average(values: Array<number | undefined>): number | null {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

function normalizedCategory(category: string): string {
  const value = category.trim();
  return value || 'uncategorized';
}

function validateReview(review: ReviewerCalibrationReview): void {
  if (!review || typeof review.reviewer !== 'string' || !review.reviewer.trim() ||
    typeof review.model !== 'string' || !review.model.trim() ||
    typeof review.reviewType !== 'string' || !review.reviewType.trim() || !Array.isArray(review.findings)) {
    throw new Error('review calibration record requires reviewer, model, reviewType, and findings');
  }
  for (const [field, value] of Object.entries({ requests: review.requests, tokens: review.tokens, cost: review.cost,
    latencyMs: review.latencyMs, downstreamDefectsPrevented: review.downstreamDefectsPrevented })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`${field} must be a finite non-negative number`);
  }
  for (const finding of review.findings) {
    if (!finding || typeof finding.id !== 'string' || !finding.id.trim() || typeof finding.category !== 'string' ||
      !['verified', 'rejected', 'unverified'].includes(finding.verdict)) throw new Error('invalid reviewer calibration finding');
    if (finding.proposedSeverity !== undefined && !isSeverity(finding.proposedSeverity)) throw new Error('invalid proposed severity');
    if (finding.verifiedSeverity !== undefined && !isSeverity(finding.verifiedSeverity)) throw new Error('invalid verified severity');
  }
}

function isSeverity(value: string): value is CalibrationSeverity {
  return ['critical', 'high', 'medium', 'low', 'info'].includes(value);
}
