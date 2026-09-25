import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRootCauseGraph,
  validateRootCauseGraph,
  type RootCauseAssessment,
  type VerifiedDefect,
} from './root-causes.js';

function defect(id: string, severity: VerifiedDefect['severity'], component: string, evidenceId: string): VerifiedDefect {
  return {
    id: `defect:v1:defect.${id}` as VerifiedDefect['id'],
    title: `${id} context is lost`,
    severity,
    affected_components: [component],
    verification: {
      hypothesis_id: `defect:v1:hypothesis.${id}`,
      verdict: 'verified',
      confidence: 0.94,
      evidence_for: [{ evidenceId, rationale: `Direct evidence for ${id}.` }],
      evidence_against: [{ evidenceId: `counter-${id}`, rationale: `Countercheck for ${id}.` }],
      reachability: 'confirmed',
      inspected: ['implementation', 'callers', 'counterevidence'],
      reasoning: `Verified ${id}.`,
      evidence_sha256: 'a'.repeat(64),
    },
  };
}

const defects = [
  defect('auth', 'high', 'authentication', 'evidence-auth'),
  defect('trace', 'medium', 'tracing', 'evidence-trace'),
  defect('unrelated', 'low', 'billing', 'evidence-billing'),
];

function assessment(overrides: Partial<RootCauseAssessment> = {}): RootCauseAssessment {
  return {
    title: 'Missing execution-context propagation abstraction',
    explanation: 'Independent context values are dropped because callers propagate them manually.',
    defect_ids: [defects[0]!.id, defects[1]!.id],
    affected_components: ['request-context'],
    remediation_scope: ['introduce context carrier', 'update async boundaries'],
    evidence: [
      { defect_id: defects[0]!.id, evidence_id: 'evidence-auth', rationale: 'Auth context is absent after the async boundary.' },
      { defect_id: defects[1]!.id, evidence_id: 'evidence-trace', rationale: 'Trace context is independently absent at the same boundary.' },
    ],
    ...overrides,
  };
}

describe('root-cause graph', () => {
  it('links distinct verified defects without merging their evidence or severity', () => {
    const graph = createRootCauseGraph(defects, [assessment()]);
    assert.equal(graph.defects.length, 3);
    assert.equal(graph.root_causes.length, 1);
    const cause = graph.root_causes[0]!;
    assert.deepEqual(cause.defects, [defects[0]!.id, defects[1]!.id].sort());
    assert.equal(cause.severity, 'high');
    assert.deepEqual(cause.affected_components, ['authentication', 'request-context', 'tracing']);
    assert.deepEqual(cause.remediation_scope, ['introduce context carrier', 'update async boundaries']);
    assert.equal(graph.explained_by.length, 2);
    const auth = graph.defects.find((item) => item.id === defects[0]!.id)!;
    assert.equal(auth.title, defects[0]!.title);
    assert.equal(auth.severity, 'high');
    assert.deepEqual(auth.verification.evidence_for, defects[0]!.verification.evidence_for);
    assert.deepEqual(auth.verification.evidence_against, defects[0]!.verification.evidence_against);
    validateRootCauseGraph(graph);
  });

  it('produces stable root-cause IDs and ordering independent of input order', () => {
    const first = createRootCauseGraph(defects, [assessment()]);
    const second = createRootCauseGraph([...defects].reverse(), [assessment({ defect_ids: [...assessment().defect_ids].reverse() })]);
    assert.deepEqual(second, first);
  });

  it('rejects unverified defects, a single symptom, and unsupported causal evidence', () => {
    const unverified = { ...defects[0]!, verification: { ...defects[0]!.verification, verdict: 'inconclusive' as const } };
    assert.throws(() => createRootCauseGraph([unverified, defects[1]!], [assessment()]), /require verified defects/);
    assert.throws(() => createRootCauseGraph(defects, [assessment({ defect_ids: [defects[0]!.id] })]), /at least two distinct defects/);
    assert.throws(() => createRootCauseGraph(defects, [assessment({ evidence: [
      { defect_id: defects[0]!.id, evidence_id: 'not-cited', rationale: 'Unsupported.' },
      { defect_id: defects[1]!.id, evidence_id: 'evidence-trace', rationale: 'Supported.' },
    ] })]), /not supporting verification evidence/);
  });

  it('rejects broken graph links during validation', () => {
    const graph = createRootCauseGraph(defects, [assessment()]);
    graph.explained_by.pop();
    assert.throws(() => validateRootCauseGraph(graph), /membership lacks explained_by link/);
  });
});
