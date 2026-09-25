/** A reviewer position on one bounded proposition. */
export interface ReviewerDisputePosition {
  reviewer: string;
  stance: 'for' | 'against';
  claim: string;
  evidence?: string[];
}

/** A concise reviewer assertion and its supporting evidence. */
export interface DisputeEvidence {
  reviewer: string;
  claim: string;
  evidence: string[];
}

/**
 * A focused record of reviewer disagreement. The snake_case fields are kept
 * aligned with the v0.1 specification's interchange shape.
 */
export interface Dispute {
  schema_version: 1;
  claim: string;
  evidence_for: DisputeEvidence[];
  evidence_against: DisputeEvidence[];
  open_question: string;
}

export interface CreateDisputeInput {
  /** The single proposition that the reviewers disagree about. */
  claim: string;
  positions: readonly ReviewerDisputePosition[];
  /** The smallest unresolved question that can settle the disagreement. */
  openQuestion: string;
}

/** Maximum sizes keep saved disputes and adjudication context bounded. */
export const DISPUTE_LIMITS = {
  claimCharacters: 1_000,
  questionCharacters: 500,
  reviewerCharacters: 100,
  reviewerClaimCharacters: 1_000,
  evidenceCharacters: 500,
  positionsPerSide: 8,
  evidenceItemsPerPosition: 8,
} as const;

/**
 * Build a bounded dispute from opposing reviewer positions. Both sides must
 * be present; evidence and claims are retained as compact, attributable
 * records instead of copying the reviewers' full review contexts.
 */
export function createDispute(input: CreateDisputeInput): Dispute {
  if (!isRecord(input)) throw new Error('invalid dispute input');
  const claim = boundedText(input.claim, DISPUTE_LIMITS.claimCharacters, 'dispute claim');
  const openQuestion = boundedText(input.openQuestion, DISPUTE_LIMITS.questionCharacters, 'open question');
  if (!Array.isArray(input.positions) || input.positions.length === 0) {
    throw new Error('dispute requires reviewer positions');
  }

  const sides: Record<'for' | 'against', DisputeEvidence[]> = { for: [], against: [] };
  for (const position of input.positions) {
    if (!isRecord(position) || (position.stance !== 'for' && position.stance !== 'against')) {
      throw new Error('dispute position stance must be for or against');
    }
    const reviewer = boundedText(position.reviewer, DISPUTE_LIMITS.reviewerCharacters, 'reviewer');
    const reviewerClaim = boundedText(position.claim, DISPUTE_LIMITS.reviewerClaimCharacters, 'reviewer claim');
    const evidence = boundedEvidence(position.evidence);
    sides[position.stance].push({ reviewer, claim: reviewerClaim, evidence });
  }

  for (const stance of ['for', 'against'] as const) {
    if (sides[stance].length === 0) throw new Error(`dispute requires evidence ${stance} the proposition`);
    if (sides[stance].length > DISPUTE_LIMITS.positionsPerSide) {
      throw new Error(`dispute exceeds ${DISPUTE_LIMITS.positionsPerSide} reviewer positions ${stance} the proposition`);
    }
    sides[stance].sort((a, b) => a.reviewer.localeCompare(b.reviewer) || a.claim.localeCompare(b.claim));
  }

  return {
    schema_version: 1,
    claim,
    evidence_for: sides.for,
    evidence_against: sides.against,
    open_question: openQuestion,
  };
}

/** Return exactly the unresolved proposition to send to an adjudicator. */
export function adjudicationInput(dispute: Dispute): string {
  validateDispute(dispute);
  return dispute.open_question;
}

/** Validate a dispute loaded from a factory artifact or external input. */
export function validateDispute(value: unknown): asserts value is Dispute {
  if (!isRecord(value) || value.schema_version !== 1 ||
    !isBoundedString(value.claim, DISPUTE_LIMITS.claimCharacters) ||
    !isBoundedString(value.open_question, DISPUTE_LIMITS.questionCharacters) ||
    !Array.isArray(value.evidence_for) || !Array.isArray(value.evidence_against) ||
    value.evidence_for.length === 0 || value.evidence_against.length === 0 ||
    value.evidence_for.length > DISPUTE_LIMITS.positionsPerSide ||
    value.evidence_against.length > DISPUTE_LIMITS.positionsPerSide ||
    !value.evidence_for.every(isDisputeEvidence) || !value.evidence_against.every(isDisputeEvidence)) {
    throw new Error('invalid dispute: expected bounded version 1 proposition with evidence for and against');
  }
}

function boundedEvidence(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DISPUTE_LIMITS.evidenceItemsPerPosition) {
    throw new Error(`reviewer evidence must contain at most ${DISPUTE_LIMITS.evidenceItemsPerPosition} items`);
  }
  return value.map((item) => boundedText(item, DISPUTE_LIMITS.evidenceCharacters, 'reviewer evidence'));
}

function isDisputeEvidence(value: unknown): value is DisputeEvidence {
  return isRecord(value) &&
    isBoundedString(value.reviewer, DISPUTE_LIMITS.reviewerCharacters) &&
    isBoundedString(value.claim, DISPUTE_LIMITS.reviewerClaimCharacters) &&
    Array.isArray(value.evidence) && value.evidence.length <= DISPUTE_LIMITS.evidenceItemsPerPosition &&
    value.evidence.every((item) => isBoundedString(item, DISPUTE_LIMITS.evidenceCharacters));
}

function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must not be empty`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return text;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
