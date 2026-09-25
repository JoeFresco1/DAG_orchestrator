import { createHash } from 'node:crypto';
import type { FactoryEntityId } from './contracts.js';
import { validateVerificationResult, type VerificationResult } from './verification.js';

export type RootCauseSeverity = 'critical' | 'high' | 'medium' | 'low';

/** A separately verified defect. The defect and its verification remain intact. */
export interface VerifiedDefect {
  id: FactoryEntityId;
  title: string;
  severity: RootCauseSeverity;
  affected_components: string[];
  verification: VerificationResult;
}

/** Evidence that the listed defects share this causal mechanism. */
export interface RootCauseAssessment {
  title: string;
  explanation: string;
  defect_ids: FactoryEntityId[];
  affected_components?: string[];
  remediation_scope: string[];
  evidence: RootCauseEvidence[];
}

export interface RootCauseEvidence {
  defect_id: FactoryEntityId;
  evidence_id: string;
  rationale: string;
}

export interface RootCauseDefect extends VerifiedDefect {
  kind: 'defect';
}

export interface RootCause {
  id: FactoryEntityId;
  kind: 'root_cause';
  title: string;
  explanation: string;
  defects: FactoryEntityId[];
  evidence: RootCauseEvidence[];
  affected_components: string[];
  severity: RootCauseSeverity;
  remediation_scope: string[];
}

export interface ExplainedByLink {
  type: 'explained_by';
  from: FactoryEntityId;
  to: FactoryEntityId;
  evidence: RootCauseEvidence[];
}

/** Versioned, standalone defect graph artifact; compatible with the run v2 format. */
export interface RootCauseGraph {
  schema_version: 1;
  defects: RootCauseDefect[];
  root_causes: RootCause[];
  explained_by: ExplainedByLink[];
}

/**
 * Link separately verified defects to explicitly assessed shared causes.
 * This does not infer causation from textual similarity: every cause must
 * cover at least two verified defects and cite their verification evidence.
 */
export function createRootCauseGraph(
  defects: readonly VerifiedDefect[],
  assessments: readonly RootCauseAssessment[],
): RootCauseGraph {
  const defectById = new Map<string, VerifiedDefect>();
  for (const defect of defects) {
    validateDefect(defect);
    if (defectById.has(defect.id)) throw new Error(`duplicate defect id: ${defect.id}`);
    defectById.set(defect.id, defect);
  }

  const rootCauses: RootCause[] = [];
  const explainedBy: ExplainedByLink[] = [];
  const causeIds = new Set<string>();
  for (const assessment of assessments) {
    validateAssessment(assessment);
    const memberIds = [...new Set(assessment.defect_ids)].sort();
    if (memberIds.length < 2) throw new Error('a shared root cause must link at least two distinct defects');
    const members = memberIds.map((id) => {
      const defect = defectById.get(id);
      if (!defect) throw new Error(`root cause references unknown verified defect: ${id}`);
      return defect;
    });

    const evidenceByDefect = new Map<string, RootCauseEvidence[]>();
    for (const evidence of assessment.evidence) {
      if (!memberIds.includes(evidence.defect_id)) throw new Error(`root cause evidence references unlinked defect: ${evidence.defect_id}`);
      const defect = defectById.get(evidence.defect_id)!;
      if (!defect.verification.evidence_for.some((citation) => citation.evidenceId === evidence.evidence_id)) {
        throw new Error(`root cause evidence is not supporting verification evidence for defect ${evidence.defect_id}: ${evidence.evidence_id}`);
      }
      const items = evidenceByDefect.get(evidence.defect_id) ?? [];
      items.push({ ...evidence });
      evidenceByDefect.set(evidence.defect_id, items);
    }
    for (const id of memberIds) {
      if (!evidenceByDefect.has(id)) throw new Error(`root cause requires causal evidence for every defect: ${id}`);
    }

    const title = assessment.title.trim();
    const id = `defect:v1:root-cause.${hash(JSON.stringify({ title: title.toLocaleLowerCase('en-US'), defects: memberIds }))}` as FactoryEntityId;
    if (causeIds.has(id)) throw new Error(`duplicate root cause: ${id}`);
    causeIds.add(id);
    const causalEvidence = assessment.evidence
      .map((item) => ({ ...item }))
      .sort((a, b) => a.defect_id.localeCompare(b.defect_id) || a.evidence_id.localeCompare(b.evidence_id));
    const affectedComponents = union([
      ...members.flatMap((defect) => defect.affected_components),
      ...(assessment.affected_components ?? []),
    ]);
    const severity = members.reduce<RootCauseSeverity>(
      (highest, defect) => severityRank[defect.severity] < severityRank[highest] ? defect.severity : highest,
      'low',
    );
    rootCauses.push({
      id, kind: 'root_cause', title, explanation: assessment.explanation.trim(),
      defects: memberIds, evidence: causalEvidence, affected_components: affectedComponents,
      severity, remediation_scope: union(assessment.remediation_scope),
    });
    for (const defectId of memberIds) {
      explainedBy.push({
        type: 'explained_by', from: defectId, to: id,
        evidence: (evidenceByDefect.get(defectId) ?? []).map((item) => ({ ...item }))
          .sort((a, b) => a.evidence_id.localeCompare(b.evidence_id)),
      });
    }
  }
  rootCauses.sort((a, b) => a.id.localeCompare(b.id));
  explainedBy.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const graph: RootCauseGraph = {
    schema_version: 1,
    defects: [...defectById.values()].map((defect) => ({
      ...defect,
      kind: 'defect' as const,
      affected_components: union(defect.affected_components),
      verification: cloneVerification(defect.verification),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    root_causes: rootCauses,
    explained_by: explainedBy,
  };
  validateRootCauseGraph(graph);
  return graph;
}

/** Validate persisted/imported root-cause graph data and all graph links. */
export function validateRootCauseGraph(value: unknown): asserts value is RootCauseGraph {
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.defects) ||
    !Array.isArray(value.root_causes) || !Array.isArray(value.explained_by)) {
    throw new Error('invalid root-cause graph: expected schema_version 1 and graph arrays');
  }
  const defects = new Map<string, RootCauseDefect>();
  for (const raw of value.defects) {
    validateDefectEntity(raw);
    if (defects.has(raw.id)) throw new Error(`duplicate defect id: ${raw.id}`);
    defects.set(raw.id, raw);
  }
  const causes = new Map<string, RootCause>();
  for (const raw of value.root_causes) {
    if (!isRecord(raw) || !isRootCauseId(raw.id) || raw.kind !== 'root_cause' ||
      typeof raw.title !== 'string' || !raw.title.trim() || typeof raw.explanation !== 'string' || !raw.explanation.trim() ||
      !Array.isArray(raw.defects) || new Set(raw.defects).size !== raw.defects.length || raw.defects.length < 2 ||
      !raw.defects.every((id) => isDefectId(id) && defects.has(id)) ||
      !Array.isArray(raw.evidence) || !validStringArray(raw.affected_components) ||
      !isSeverity(raw.severity) || !validStringArray(raw.remediation_scope)) {
      throw new Error('invalid root cause entity');
    }
    for (const evidence of raw.evidence) validateRootCauseEvidence(evidence, defects);
    if (causes.has(raw.id)) throw new Error(`duplicate root cause id: ${raw.id}`);
    causes.set(raw.id, raw as unknown as RootCause);
  }
  const seenLinks = new Set<string>();
  for (const raw of value.explained_by) {
    if (!isRecord(raw) || raw.type !== 'explained_by' || !isDefectId(raw.from) || !defects.has(raw.from) ||
      !isRootCauseId(raw.to) || !causes.has(raw.to) || !Array.isArray(raw.evidence)) {
      throw new Error('invalid explained_by link');
    }
    const cause = causes.get(raw.to)!;
    if (!cause.defects.includes(raw.from)) throw new Error(`explained_by link is absent from root cause membership: ${raw.from}`);
    const key = `${raw.from}\0${raw.to}`;
    if (seenLinks.has(key)) throw new Error(`duplicate explained_by link: ${raw.from} -> ${raw.to}`);
    seenLinks.add(key);
    if (raw.evidence.length === 0) throw new Error(`explained_by link lacks evidence: ${raw.from} -> ${raw.to}`);
    for (const evidence of raw.evidence) {
      validateRootCauseEvidence(evidence, defects);
      if (evidence.defect_id !== raw.from) throw new Error('explained_by evidence must belong to its source defect');
    }
  }
  for (const cause of causes.values()) for (const defectId of cause.defects) {
    if (!seenLinks.has(`${defectId}\0${cause.id}`)) throw new Error(`root cause membership lacks explained_by link: ${defectId} -> ${cause.id}`);
  }
}

const severityRank: Record<RootCauseSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function validateDefect(defect: VerifiedDefect): void {
  validateDefectEntity({ ...defect, kind: 'defect' });
  if (defect.verification.verdict !== 'verified') throw new Error(`root causes require verified defects: ${defect.id}`);
}

function validateDefectEntity(value: unknown): asserts value is RootCauseDefect {
  if (!isRecord(value) || !isDefectId(value.id) || value.kind !== 'defect' ||
    typeof value.title !== 'string' || !value.title.trim() || !isSeverity(value.severity) ||
    !validStringArray(value.affected_components)) throw new Error('invalid verified defect');
  validateVerificationResult(value.verification);
  if (value.verification.verdict !== 'verified') throw new Error(`root causes require verified defects: ${value.id}`);
}

function validateAssessment(value: unknown): asserts value is RootCauseAssessment {
  if (!isRecord(value) || typeof value.title !== 'string' || !value.title.trim() ||
    typeof value.explanation !== 'string' || !value.explanation.trim() ||
    !Array.isArray(value.defect_ids) || !value.defect_ids.every(isDefectId) ||
    (value.affected_components !== undefined && !validStringArray(value.affected_components)) ||
    !validStringArray(value.remediation_scope) || !Array.isArray(value.evidence) || value.evidence.length === 0) {
    throw new Error('invalid root cause assessment');
  }
  for (const evidence of value.evidence) {
    if (!isRecord(evidence) || !isDefectId(evidence.defect_id) || typeof evidence.evidence_id !== 'string' ||
      !evidence.evidence_id.trim() || typeof evidence.rationale !== 'string' || !evidence.rationale.trim()) {
      throw new Error('invalid root cause evidence');
    }
  }
}

function validateRootCauseEvidence(value: unknown, defects: Map<string, RootCauseDefect>): asserts value is RootCauseEvidence {
  if (!isRecord(value) || !isDefectId(value.defect_id) || typeof value.evidence_id !== 'string' ||
    !value.evidence_id.trim() || typeof value.rationale !== 'string' || !value.rationale.trim()) {
    throw new Error('invalid root cause evidence');
  }
  const defect = defects.get(value.defect_id);
  if (!defect || !defect.verification.evidence_for.some((citation) => citation.evidenceId === value.evidence_id)) {
    throw new Error(`root cause evidence is not linked to supporting evidence for defect ${value.defect_id}`);
  }
}

function cloneVerification(value: VerificationResult): VerificationResult {
  return {
    ...value,
    evidence_for: value.evidence_for.map((citation) => ({ ...citation })),
    evidence_against: value.evidence_against.map((citation) => ({ ...citation })),
    inspected: [...value.inspected],
  };
}

function union(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function isDefectId(value: unknown): value is FactoryEntityId {
  return typeof value === 'string' && /^defect:v1:defect\.[A-Za-z0-9._/-]+$/.test(value);
}

function isRootCauseId(value: unknown): value is FactoryEntityId {
  return typeof value === 'string' && /^defect:v1:root-cause\.[a-f0-9]{64}$/.test(value);
}

function isSeverity(value: unknown): value is RootCauseSeverity {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low';
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
