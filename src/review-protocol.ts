import { createHash } from 'node:crypto';

export interface ReviewFinding {
  id: string; severity: 'error' | 'warning'; blocking: boolean;
  message: string; correction: string;
  evidence: { reference: string; observation: string }[];
}
export interface ReviewBody { verdict: 'pass' | 'fail' | 'inconclusive'; findings: ReviewFinding[] }
export interface ReviewEnvelope {
  version: 1; reviewId: string; taskId: string; phase: string; attempt: number;
  sourceIdentity: string; contextDigest: string; adapter: string; at: string;
  bodyDigest: string; body: ReviewBody;
  policyVersion?: string; toolVersion?: string; startedAt?: string; finishedAt?: string;
}
export const REVIEW_BODY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'findings'], properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'inconclusive'] },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'severity', 'blocking', 'message', 'correction', 'evidence'], properties: {
        id: { type: 'string', minLength: 1 }, severity: { type: 'string', enum: ['error', 'warning'] },
        blocking: { type: 'boolean' }, message: { type: 'string', minLength: 1 }, correction: { type: 'string', minLength: 1 },
        evidence: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['reference', 'observation'], properties: { reference: { type: 'string', minLength: 1 }, observation: { type: 'string', minLength: 1 } } } },
      } } },
  },
} as const;
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export class ReviewProtocolError extends Error { readonly kind = 'review-protocol'; readonly code = 'REVIEW_PROTOCOL_ERROR'; }
/** Identity belongs to the controller; reviewers supply only verdict and grounded findings. */
export function validateReviewBody(value: unknown, references?: ReadonlySet<string>): ReviewBody {
  if (!record(value) || Object.keys(value).some(k => !['verdict', 'findings'].includes(k)) ||
      !['pass', 'fail', 'inconclusive'].includes(String(value.verdict)) || !Array.isArray(value.findings)) throw new ReviewProtocolError('Invalid review body');
  const ids = new Set<string>();
  const registered = (reference: string): boolean => !references || references.has(reference) ||
    [...references].some(base => reference.startsWith(`${base}:`) && /^[1-9]\d*(?::[1-9]\d*)?(?:-[1-9]\d*)?$/.test(reference.slice(base.length + 1)));
  for (const f of value.findings) {
    if (!record(f) || !text(f.id) || ids.has(f.id) || !['error', 'warning'].includes(String(f.severity)) ||
        typeof f.blocking !== 'boolean' || !text(f.message) || !text(f.correction) || !Array.isArray(f.evidence) ||
        Object.keys(f).some(k => !['id', 'severity', 'blocking', 'message', 'correction', 'evidence'].includes(k))) throw new ReviewProtocolError('Invalid review finding');
    ids.add(f.id);
    if (f.blocking && (f.severity !== 'error' || !f.evidence.length)) throw new ReviewProtocolError('Blocking findings require error severity and concrete evidence');
    for (const e of f.evidence) {
      if (!record(e) || !text(e.reference) || !text(e.observation) || Object.keys(e).some(k => !['reference', 'observation'].includes(k)) ||
          !registered(e.reference)) throw new ReviewProtocolError('Finding evidence must reference supplied review authority');
    }
  }
  const blocking = value.findings.some(f => f.blocking);
  if (value.verdict === 'pass' && blocking || value.verdict === 'fail' && !blocking || value.verdict === 'inconclusive' && blocking) throw new ReviewProtocolError('Review verdict contradicts findings');
  return value as unknown as ReviewBody;
}
export function parseReviewBody(output: string, references?: ReadonlySet<string>): ReviewBody {
  const trimmed = output.trim();
  const marker = trimmed.split(/\r?\n/).filter(s => s.startsWith('DAG_REVIEW: '));
  if (marker.length > 1) throw new ReviewProtocolError('Multiple review bodies');
  try { return validateReviewBody(JSON.parse(marker.length ? marker[0]!.slice(12) : trimmed), references); }
  catch (error) { if (error instanceof ReviewProtocolError) throw error; throw new ReviewProtocolError('Missing or malformed structured review body'); }
}
export function reviewEnvelope(body: ReviewBody, identity: Omit<ReviewEnvelope, 'version' | 'at' | 'bodyDigest' | 'body'>): ReviewEnvelope {
  validateReviewBody(body);
  const at = new Date().toISOString();
  return { policyVersion: 'structured-review-v1', toolVersion: 'unreported', startedAt: at, finishedAt: at,
    ...identity, version: 1, at, bodyDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'), body };
}
export interface AdapterCircuit { consecutiveFailures: number; open: boolean; lastError?: string; recent?: boolean[] }
export type AdapterCircuits = Record<string, AdapterCircuit>;
/** State and dispatch callbacks must persist before invoking the provider. Infrastructure errors are never retried here. */
export async function invokeReviewProtocol<T>(options: {
  adapter: string; circuits: AdapterCircuits; invoke: (dispatch: number, feedback: string) => Promise<string>;
  parse: (output: string) => T; onDispatch?: (dispatch: number) => void;
  persist?: () => void; threshold?: number; retries?: number; dispatched?: number;
}): Promise<T> {
  const circuit = options.circuits[options.adapter] ??= { consecutiveFailures: 0, open: false };
  circuit.recent ??= Array(Math.min(5, circuit.consecutiveFailures)).fill(false);
  if (circuit.open) throw new ReviewProtocolError(`Review adapter circuit open: ${options.adapter}`);
  const maxDispatches = 1 + Math.max(0, options.retries ?? 1);
  if ((options.dispatched ?? 0) >= maxDispatches) throw new ReviewProtocolError(`Review protocol exhausted for ${options.adapter}: durable dispatch budget exhausted`);
  let feedback = '';
  for (let dispatch = 1 + (options.dispatched ?? 0); dispatch <= maxDispatches; dispatch++) {
    options.onDispatch?.(dispatch); options.persist?.();
    const output = await options.invoke(dispatch, feedback);
    try {
      const result = options.parse(output);
      circuit.recent = [...circuit.recent, true].slice(-5);
      circuit.consecutiveFailures = 0;
      // Calls already in flight may finish after another invocation opened the circuit.
      // Their successes must not reopen the provider for new dispatches.
      circuit.open = circuit.open || circuit.recent.filter(valid => !valid).length >= (options.threshold ?? 3);
      if (!circuit.open) delete circuit.lastError;
      options.persist?.();
      return result;
    } catch (error) {
      feedback = error instanceof Error ? error.message : String(error);
      circuit.consecutiveFailures++; circuit.lastError = feedback;
      circuit.recent = [...circuit.recent, false].slice(-5);
      circuit.open = circuit.recent.filter(valid => !valid).length >= (options.threshold ?? 3); options.persist?.();
      if (circuit.open || dispatch === maxDispatches) throw new ReviewProtocolError(`Review protocol exhausted for ${options.adapter}: ${feedback}`);
    }
  }
  throw new ReviewProtocolError('Review protocol exhausted');
}
