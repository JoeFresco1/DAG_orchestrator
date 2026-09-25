import type { FactoryEntityId } from './contracts.js';
import type { NormalizedObservation, ObservationCluster } from './observations.js';

export type HypothesisStatus = 'unverified' | 'verified' | 'rejected' | 'disputed';

/**
 * A testable claim synthesized from a cluster of observations. Observation
 * entity IDs remain the canonical links; sourceIds retain caller supplied IDs
 * such as reviewer finding IDs (F103).
 */
export interface DefectHypothesis {
  schemaVersion: 1;
  id: FactoryEntityId;
  kind: 'hypothesis';
  claim: string;
  observations: FactoryEntityId[];
  sourceIds: string[];
  affectedPath: string[];
  /** Coherence of the evidence cluster, not a verification verdict. */
  confidence: number;
  status: HypothesisStatus;
}

/** Versioned collection suitable for persistence as a factory artifact. */
export interface HypothesisSet {
  schemaVersion: 1;
  hypotheses: DefectHypothesis[];
}

/**
 * Turn observation clusters into independently verifiable claims. Raw
 * observations stay separate and are linked by ID; they are never promoted
 * or rewritten as hypotheses.
 */
export function createHypotheses(
  observations: readonly NormalizedObservation[],
  clusters: readonly ObservationCluster[],
): HypothesisSet {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const hypotheses = clusters.map((cluster): DefectHypothesis => {
    const linked = cluster.observationIds.map((id) => {
      const observation = byId.get(id);
      if (!observation) throw new Error(`hypothesis cluster references unknown observation: ${id}`);
      return observation;
    });
    const claim = cluster.claim.trim();
    if (!claim) throw new Error(`hypothesis cluster ${cluster.id} has an empty claim`);

    const paths = uniqueSorted(cluster.features.executionPaths.flat());
    const affectedPath = paths.length > 0 ? paths : uniqueSorted(cluster.features.files);
    return {
      schemaVersion: 1,
      id: cluster.id as FactoryEntityId,
      kind: 'hypothesis',
      claim,
      observations: [...cluster.observationIds].sort() as FactoryEntityId[],
      sourceIds: uniqueSorted(linked.flatMap((observation) => observation.sourceId ? [observation.sourceId] : [])),
      affectedPath,
      confidence: roundConfidence(cluster.score),
      status: 'unverified',
    };
  });
  hypotheses.sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: 1, hypotheses };
}

/** Guard factory artifacts before they are persisted or consumed. */
export function validateHypothesisSet(value: unknown): asserts value is HypothesisSet {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.hypotheses)) {
    throw new Error('invalid hypothesis set: expected schemaVersion 1 and hypotheses');
  }
  const ids = new Set<string>();
  for (const hypothesis of value.hypotheses) {
    if (!isRecord(hypothesis) || hypothesis.schemaVersion !== 1 || hypothesis.kind !== 'hypothesis' ||
      typeof hypothesis.id !== 'string' || !/^defect:v1:hypothesis\.[A-Za-z0-9._/-]+$/.test(hypothesis.id) ||
      typeof hypothesis.claim !== 'string' || !hypothesis.claim.trim() ||
      !Array.isArray(hypothesis.observations) || hypothesis.observations.length === 0 ||
      !hypothesis.observations.every((id) => typeof id === 'string' && /^defect:v1:observation\.[A-Za-z0-9._/-]+$/.test(id)) ||
      !Array.isArray(hypothesis.sourceIds) || !hypothesis.sourceIds.every((id) => typeof id === 'string' && id.trim()) ||
      !Array.isArray(hypothesis.affectedPath) || !hypothesis.affectedPath.every((part) => typeof part === 'string' && part.trim()) ||
      typeof hypothesis.confidence !== 'number' || !Number.isFinite(hypothesis.confidence) ||
      hypothesis.confidence < 0 || hypothesis.confidence > 1 ||
      !['unverified', 'verified', 'rejected', 'disputed'].includes(String(hypothesis.status))) {
      throw new Error('invalid hypothesis: expected a versioned, linked, testable claim');
    }
    if (ids.has(hypothesis.id)) throw new Error(`duplicate hypothesis id: ${hypothesis.id}`);
    ids.add(hypothesis.id);
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function roundConfidence(value: number): number {
  if (!Number.isFinite(value)) throw new Error('hypothesis confidence must be finite');
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
