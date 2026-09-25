import { createHash } from 'node:crypto';
import type { DefectHypothesis } from './hypotheses.js';
import type { PreverificationResult } from './preverification.js';
import type { ContextPacket, ContextEvidence } from './context-compiler.js';

export const VERIFICATION_CATEGORIES = [
  'implementation', 'callers', 'dependencies', 'tests', 'guards',
  'runtime_assumptions', 'reachability', 'counterevidence',
] as const;
export type VerificationCategory = typeof VERIFICATION_CATEGORIES[number];
export type VerificationVerdict = 'verified' | 'rejected' | 'inconclusive';
export type VerificationReachability = 'confirmed' | 'refuted' | 'unresolved';

export interface VerificationEvidence {
  id: string;
  category: VerificationCategory;
  summary: string;
  source: string;
  sha256?: string;
  lineStart?: number;
  lineEnd?: number;
  content?: string;
}

export interface VerificationPacket {
  schemaVersion: 1;
  hypothesisId: string;
  claim: string;
  challenge: string[];
  evidence: VerificationEvidence[];
  preverification: PreverificationResult | null;
  sha256: string;
}

export interface VerificationCitation {
  evidenceId: string;
  rationale: string;
}

/** Untrusted structured response from an agent or human verifier. */
export interface VerificationAssessment {
  verdict: VerificationVerdict;
  confidence: number;
  reachability: VerificationReachability;
  inspectedCategories: VerificationCategory[];
  evidenceFor: VerificationCitation[];
  evidenceAgainst: VerificationCitation[];
  reasoning: string;
}

export interface VerificationResult {
  hypothesis_id: string;
  verdict: VerificationVerdict;
  confidence: number;
  evidence_for: VerificationCitation[];
  evidence_against: VerificationCitation[];
  reachability: VerificationReachability;
  inspected: VerificationCategory[];
  reasoning: string;
  evidence_sha256: string;
}

const REQUIRED_CHALLENGES = [
  'Trace the cited implementation and determine whether the claimed failure is possible on the real code path.',
  'Find every relevant caller and dependency edge; check whether the alleged path is reachable from an entry point.',
  'Inspect tests that cover the behavior, including what they assert and what they omit.',
  'Search for guards, validation, retries, type constraints, and error handling that could prevent the defect.',
  'List runtime assumptions required by the claim and identify evidence that confirms or contradicts each one.',
  'Actively try to disprove the hypothesis. Include the strongest contradictory evidence, even when it does not settle the claim.',
];

/**
 * Assemble a stable, source-linked challenge packet. This function reads only
 * its inputs; it never changes repository files or run state.
 */
export function createVerificationPacket(
  hypothesis: Pick<DefectHypothesis, 'id' | 'claim'>,
  context: ContextPacket,
  preverification: PreverificationResult | null = null,
): VerificationPacket {
  if (!hypothesis.claim.trim()) throw new Error('verification claim must not be empty');
  const evidence = context.evidence.map(toVerificationEvidence).sort((a, b) => a.id.localeCompare(b.id));
  const packet: VerificationPacket = {
    schemaVersion: 1,
    hypothesisId: hypothesis.id,
    claim: hypothesis.claim.trim(),
    challenge: [...REQUIRED_CHALLENGES],
    evidence,
    preverification,
    sha256: '',
  };
  packet.sha256 = verificationPacketHash(packet);
  return packet;
}

/** Render a verifier request with explicit read-only and evidence requirements. */
export function renderVerificationPrompt(packet: VerificationPacket): string {
  return [
    'Adversarially verify this defect hypothesis. Attempt to disprove it before accepting it.',
    'Read-only task: do not edit, create, delete, or repair repository files or run state.',
    `Hypothesis ${packet.hypothesisId}: ${packet.claim}`,
    `Evidence packet SHA-256: ${packet.sha256}`,
    'Use only supplied evidence IDs in citations. Cite both supporting and contradicting evidence with a concise rationale.',
    'Inspect and report each category: implementation, callers, dependencies, tests, guards, runtime_assumptions, reachability, counterevidence.',
    'Do not mark a category inspected if the packet does not establish it; request more context and use inconclusive.',
    'A verified verdict requires all categories inspected, confirmed reachability, and at least one direct supporting citation.',
    'Return one JSON object matching VerificationAssessment. No markdown fences or extra text.',
    'Challenge questions:',
    ...packet.challenge.map((question) => `- ${question}`),
    `Evidence and provenance:\n${JSON.stringify(packet.evidence, null, 2)}`,
    `Cheap preverification:\n${JSON.stringify(packet.preverification, null, 2)}`,
    'Assessment schema: {"verdict":"verified|rejected|inconclusive","confidence":0.0,"reachability":"confirmed|refuted|unresolved","inspectedCategories":[],"evidenceFor":[{"evidenceId":"...","rationale":"..."}],"evidenceAgainst":[{"evidenceId":"...","rationale":"..."}],"reasoning":"..."}',
  ].join('\n');
}

/**
 * Validate an agent/human assessment against the packet. Unsupported claims,
 * missing challenge coverage, or citations outside the packet fail closed to
 * an inconclusive verdict.
 */
export function adjudicateVerification(packet: VerificationPacket, input: unknown): VerificationResult {
  if (packet.sha256 !== verificationPacketHash(packet)) throw new Error('verification evidence packet hash mismatch');
  const assessment = parseAssessment(input);
  const evidenceIds = new Set(packet.evidence.map((item) => item.id));
  const evidenceFor = validCitations(assessment.evidenceFor, evidenceIds);
  const evidenceAgainst = validCitations(assessment.evidenceAgainst, evidenceIds);
  const inspected = [...new Set(assessment.inspectedCategories)].sort() as VerificationCategory[];
  const allInspected = VERIFICATION_CATEGORIES.every((category) => inspected.includes(category));
  const citationsValid = evidenceFor.length === assessment.evidenceFor.length && evidenceAgainst.length === assessment.evidenceAgainst.length;
  const supported = evidenceFor.length > 0;
  const challenged = evidenceAgainst.length > 0;
  let verdict = assessment.verdict;
  let reachability = assessment.reachability;
  let confidence = round(assessment.confidence);

  if (!allInspected || !citationsValid || (verdict === 'verified' && (!supported || reachability !== 'confirmed' || confidence < 0.8))) {
    verdict = 'inconclusive';
    confidence = Math.min(confidence, 0.59);
  } else if (verdict === 'rejected' && !challenged) {
    verdict = 'inconclusive';
    confidence = Math.min(confidence, 0.59);
  }
  if (packet.preverification?.status === 'rejected' && verdict === 'verified') {
    verdict = 'inconclusive';
    confidence = Math.min(confidence, 0.59);
  }
  if (verdict === 'inconclusive') confidence = Math.min(confidence, 0.59);
  return {
    hypothesis_id: packet.hypothesisId,
    verdict,
    confidence,
    evidence_for: evidenceFor,
    evidence_against: evidenceAgainst,
    reachability,
    inspected,
    reasoning: assessment.reasoning.trim(),
    evidence_sha256: packet.sha256,
  };
}

/** Validate the public JSON result shape when loading saved verification evidence. */
export function validateVerificationResult(value: unknown): asserts value is VerificationResult {
  if (!isRecord(value) || typeof value.hypothesis_id !== 'string' ||
    !['verified', 'rejected', 'inconclusive'].includes(String(value.verdict)) ||
    typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 ||
    !Array.isArray(value.evidence_for) || !Array.isArray(value.evidence_against) ||
    !['confirmed', 'refuted', 'unresolved'].includes(String(value.reachability)) ||
    !Array.isArray(value.inspected) || !value.inspected.every((item) => isCategory(item)) ||
    typeof value.reasoning !== 'string' || !/^[a-f0-9]{64}$/.test(String(value.evidence_sha256))) {
    throw new Error('invalid verification result');
  }
  validCitations(value.evidence_for, new Set(), true);
  validCitations(value.evidence_against, new Set(), true);
}

function toVerificationEvidence(item: ContextEvidence): VerificationEvidence {
  const first = item.provenance[0];
  const category = categoryOf(item.kind, item.title);
  return {
    id: item.id,
    category,
    summary: item.title,
    source: first?.uri ?? `context://${item.id}`,
    ...(first?.sha256 ? { sha256: first.sha256 } : {}),
    ...(first?.lineStart ? { lineStart: first.lineStart } : {}),
    ...(first?.lineEnd ? { lineEnd: first.lineEnd } : {}),
    content: item.content,
  };
}

function categoryOf(kind: ContextEvidence['kind'], title: string): VerificationCategory {
  if (kind === 'caller') return 'callers';
  if (kind === 'callee' || kind === 'interface' || kind === 'schema' || kind === 'dependency_edge') return 'dependencies';
  if (kind === 'test') return 'tests';
  if (kind === 'invariant' || /guard|validation|check|assert/i.test(title)) return 'guards';
  if (kind === 'recent_change' || kind === 'diagnostic' || kind === 'previous_finding') return 'counterevidence';
  return 'implementation';
}

function parseAssessment(value: unknown): VerificationAssessment {
  if (!isRecord(value) || !['verified', 'rejected', 'inconclusive'].includes(String(value.verdict)) ||
    typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 ||
    !['confirmed', 'refuted', 'unresolved'].includes(String(value.reachability)) ||
    !Array.isArray(value.inspectedCategories) || !value.inspectedCategories.every(isCategory) ||
    !Array.isArray(value.evidenceFor) || !Array.isArray(value.evidenceAgainst) ||
    typeof value.reasoning !== 'string') throw new Error('invalid verification assessment');
  const evidenceFor = parseCitations(value.evidenceFor);
  const evidenceAgainst = parseCitations(value.evidenceAgainst);
  return {
    verdict: value.verdict as VerificationVerdict,
    confidence: value.confidence,
    reachability: value.reachability as VerificationReachability,
    inspectedCategories: value.inspectedCategories as VerificationCategory[],
    evidenceFor,
    evidenceAgainst,
    reasoning: value.reasoning,
  };
}

function parseCitations(items: unknown[]): VerificationCitation[] {
  return items.map((item) => {
    if (!isRecord(item) || typeof item.evidenceId !== 'string' || typeof item.rationale !== 'string' || !item.rationale.trim()) {
      throw new Error('invalid verification evidence citation');
    }
    return { evidenceId: item.evidenceId, rationale: item.rationale.trim() };
  });
}

function validCitations(items: VerificationCitation[], allowed: Set<string>, shapeOnly = false): VerificationCitation[] {
  const citations = parseCitations(items);
  if (!shapeOnly && citations.some((item) => !allowed.has(item.evidenceId))) return citations.filter((item) => allowed.has(item.evidenceId));
  return citations;
}

function isCategory(value: unknown): value is VerificationCategory {
  return typeof value === 'string' && (VERIFICATION_CATEGORIES as readonly string[]).includes(value);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function verificationPacketHash(packet: VerificationPacket): string { return hash(JSON.stringify({ ...packet, sha256: undefined })); }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
