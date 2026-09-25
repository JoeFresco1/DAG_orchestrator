/** Granular, deterministic invalidation of certification claims after impact analysis. */
import { createHash } from 'node:crypto';
import { isFactoryEntityId, isFactoryEvidenceRef, type FactoryEntityId, type FactoryEvidenceRef } from './contracts.js';
import type { ImpactSet } from './impact.js';

export interface CertificationClaimProvenance {
  /** The certification snapshot that first established this claim. */
  certificationId: string;
  runId: string;
  commit: string;
}

export interface CertificationClaim {
  id: string;
  /** Code units, requirements, or test entities whose behavior this claim covers. */
  covers: FactoryEntityId[];
  evidence: FactoryEvidenceRef[];
  /** Original source certification, run, and commit are retained on invalidation. */
  provenance: CertificationClaimProvenance;
  status: 'valid' | 'invalidated';
  invalidation?: { impactHash: string; reason: string };
}

export interface CertificationInvalidationResult {
  schemaVersion: 1;
  claims: CertificationClaim[];
  invalidatedClaimIds: string[];
  unaffectedClaimIds: string[];
  impactHash: string;
}

/**
 * Invalidate only claims explicitly scoped to semantic impact. Claims and their
 * evidence are copied without rewriting provenance; already invalidated claims
 * remain unchanged so later analyses cannot obscure the original cause.
 */
export function invalidateCertificationClaims(
  claims: CertificationClaim[],
  impact: ImpactSet,
): CertificationInvalidationResult {
  validateCertificationClaims(claims);
  validateImpact(impact);
  const affected = new Set<FactoryEntityId>([
    ...impact.changed_units,
    ...impact.invalidated_units,
    ...impact.affected_requirements,
    ...impact.affected_tests,
  ]);
  const invalidatedClaimIds: string[] = [];
  const unaffectedClaimIds: string[] = [];
  const resultClaims = claims.map((claim) => {
    const touched = claim.status === 'valid' && claim.covers.some((unit) => affected.has(unit));
    if (!touched) {
      unaffectedClaimIds.push(claim.id);
      return claim;
    }
    invalidatedClaimIds.push(claim.id);
    const impacted = claim.covers.filter((unit) => affected.has(unit)).sort();
    return {
      ...claim,
      status: 'invalidated' as const,
      invalidation: {
        impactHash: impact.reproducibility_hash,
        reason: `semantic impact intersects certified scope: ${impacted.join(', ')}`,
      },
    };
  });
  return {
    schemaVersion: 1,
    claims: resultClaims,
    invalidatedClaimIds: invalidatedClaimIds.sort(),
    unaffectedClaimIds: unaffectedClaimIds.sort(),
    impactHash: impact.reproducibility_hash,
  };
}

/** Validate imported or persisted claim collections before evaluating them. */
export function validateCertificationClaims(value: unknown): asserts value is CertificationClaim[] {
  if (!Array.isArray(value)) throw new Error('certification claims must be an array');
  const ids = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim() || ids.has(raw.id)) {
      throw new Error('certification claim IDs must be non-empty and unique');
    }
    ids.add(raw.id);
    if (!Array.isArray(raw.covers) || raw.covers.length === 0 || raw.covers.some((id: unknown) => !isFactoryEntityId(id))) {
      throw new Error(`claim ${raw.id} must cover at least one valid factory entity`);
    }
    if (new Set(raw.covers).size !== raw.covers.length) throw new Error(`claim ${raw.id} has duplicate scope entities`);
    if (!Array.isArray(raw.evidence) || raw.evidence.some((evidence: unknown) => !isFactoryEvidenceRef(evidence))) {
      throw new Error(`claim ${raw.id} has invalid evidence`);
    }
    if (!isRecord(raw.provenance) || typeof raw.provenance.certificationId !== 'string' || !raw.provenance.certificationId.trim() ||
      typeof raw.provenance.runId !== 'string' || !raw.provenance.runId.trim() || typeof raw.provenance.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(raw.provenance.commit)) {
      throw new Error(`claim ${raw.id} has invalid provenance`);
    }
    if (raw.status !== 'valid' && raw.status !== 'invalidated') throw new Error(`claim ${raw.id} has invalid status`);
    if (raw.status === 'valid' && raw.invalidation !== undefined) throw new Error(`valid claim ${raw.id} cannot have invalidation data`);
    if (raw.status === 'invalidated' && (!isRecord(raw.invalidation) || !HASH.test(raw.invalidation.impactHash) ||
      typeof raw.invalidation.reason !== 'string' || !raw.invalidation.reason.trim())) {
      throw new Error(`invalidated claim ${raw.id} requires a reason and impact hash`);
    }
  }
}

function validateImpact(impact: ImpactSet): void {
  if (!isRecord(impact) || impact.schemaVersion !== 1 || !HASH.test(impact.reproducibility_hash)) {
    throw new Error('invalid semantic impact result');
  }
  for (const key of ['changed_units', 'invalidated_units', 'affected_requirements', 'affected_tests'] as const) {
    if (!Array.isArray(impact[key]) || impact[key].some((id) => !isFactoryEntityId(id))) {
      throw new Error(`semantic impact ${key} must contain valid factory entity IDs`);
    }
  }
}

/** Stable digest helper for callers assembling versioned invalidation records. */
export function certificationInvalidationHash(result: Omit<CertificationInvalidationResult, 'impactHash'>): string {
  return createHash('sha256').update(canonicalJson(result)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const HASH = /^[a-f0-9]{64}$/;
