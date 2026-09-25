import assert from 'node:assert/strict';
import test from 'node:test';
import { newRun } from '../store.js';
import { compileRemediation, createRemediationTasks } from './remediation.js';
import { createFactoryGraphModel, validateFactoryGraphModel } from './graph-model.js';
import { createRootCauseGraph, type VerifiedDefect } from './root-causes.js';
import type { CodeGraphIndex } from './code-graph.js';

const codeId = 'code:v1:symbol/src/auth/AuthService.ts_u23_propagate' as const;
const requirementId = 'requirement:v1:auth-context' as const;

function defect(key: string, component: string): VerifiedDefect {
  return {
    id: `defect:v1:defect.${key}` as VerifiedDefect['id'],
    title: `${key} context is lost`, severity: 'high', affected_components: [component],
    verification: {
      hypothesis_id: `defect:v1:hypothesis.${key}`, verdict: 'verified', confidence: 0.95,
      evidence_for: [{ evidenceId: `evidence-${key}`, rationale: 'Observed on a reachable path.' }],
      evidence_against: [], reachability: 'confirmed',
      inspected: ['implementation', 'callers', 'dependencies', 'tests', 'guards', 'runtime_assumptions', 'reachability', 'counterevidence'],
      reasoning: 'The failure is reproducible on the execution path.', evidence_sha256: 'a'.repeat(64),
    },
  };
}

const first = defect('auth', 'authentication');
const second = defect('trace', 'tracing');
const standalone = defect('billing', 'billing');
const rootCauses = createRootCauseGraph([first, second, standalone], [{
  title: 'Missing shared request context propagation',
  explanation: 'Async boundaries do not preserve execution context.',
  defect_ids: [first.id, second.id],
  affected_components: ['request-context'],
  remediation_scope: ['update service propagation', 'API contract update', 'frontend client adaptation'],
  evidence: [
    { defect_id: first.id, evidence_id: 'evidence-auth', rationale: 'Authentication context is lost after the async boundary.' },
    { defect_id: second.id, evidence_id: 'evidence-trace', rationale: 'Trace context is lost at the same boundary.' },
  ],
}]);

function codeGraph(): CodeGraphIndex {
  return {
    schemaVersion: 1, files: [],
    graph: { kind: 'code', entities: [{ id: codeId, kind: 'symbol', title: 'src/auth/AuthService.ts::propagate', sourcePath: 'src/auth/AuthService.ts' }], edges: [] },
    requirements: [{ id: requirementId, kind: 'requirement', title: 'Preserve auth context' }],
    links: [{ type: 'implemented_by', from: requirementId, to: codeId }],
  };
}

test('compiles shared causes ahead of symptom fixes with bounded sequential stages and trace evidence', () => {
  const plan = compileRemediation({
    defects: rootCauses.defects, rootCauses: rootCauses.root_causes, codeGraph: codeGraph(),
    impactedPaths: [{ changed: codeId, affected: codeId, nodes: [codeId], edges: [] }],
    regressionRisks: [{ unit: codeId, risk_score: 0.87 }],
    acceptanceCommands: { byStage: { integration_tests: 'pnpm test -- auth-context' } },
  });

  const causeNodes = plan.nodes.filter((node) => node.trace.rootCauseIds.length > 0);
  const symptomNodes = plan.nodes.filter((node) => node.stage === 'defect_fix');
  assert.ok(causeNodes.length > 2);
  assert.equal(symptomNodes.length, 1);
  assert.deepEqual(symptomNodes[0]!.trace.defectIds, [standalone.id]);
  assert.ok(causeNodes.every((node) => node.trace.defectIds.includes(first.id) && node.trace.defectIds.includes(second.id)));
  assert.ok(causeNodes.every((node) => node.trace.evidenceIds.includes('evidence-auth') && node.trace.evidenceIds.includes('evidence-trace')));
  assert.ok(causeNodes.every((node) => node.spec.includes('Verification packet hash(es):')));
  assert.match(causeNodes.find((node) => node.stage === 'integration_tests')!.spec, /pnpm test -- auth-context/);
  for (const node of causeNodes.slice(1)) assert.deepEqual(node.deps, [causeNodes[causeNodes.indexOf(node) - 1]!.id]);
  assert.equal(causeNodes.at(-1)!.stage, 'recertification');
  assert.deepEqual(causeNodes[0]!.trace.requirementIds, [requirementId]);
  assert.deepEqual(causeNodes[0]!.trace.codeEntityIds, [codeId]);
  assert.deepEqual(causeNodes[0]!.trace.regressionRisks, [{ unit: codeId, risk_score: 0.87 }]);
});

test('materializes through existing DAG task creation and records typed remediation trace links', () => {
  const plan = compileRemediation({ defects: rootCauses.defects, rootCauses: rootCauses.root_causes, codeGraph: codeGraph(), maxScopeSteps: 0,
    impactedPaths: [{ changed: codeId, affected: codeId, nodes: [codeId], edges: [] }] });
  const model = createFactoryGraphModel();
  model.graphs.requirement.entities.push({ id: requirementId, kind: 'requirement', title: 'Preserve auth context' });
  model.graphs.code.entities.push({ id: codeId, kind: 'symbol', title: 'propagate', sourcePath: 'src/auth/AuthService.ts' });
  model.links.push({ type: 'implemented_by', from: requirementId, to: codeId });
  const run = newRun('remediation test');
  const { tasks } = createRemediationTasks(run, plan, model);

  assert.equal(Object.keys(run.tasks).length, tasks.length);
  assert.equal(tasks.length, 6); // shared workstream plus one standalone defect workstream
  assert.deepEqual(tasks[1]!.deps, [tasks[0]!.id]);
  assert.deepEqual(tasks[2]!.deps, [tasks[1]!.id]);
  assert.equal(plan.links.length, 3); // links only the shared root cause; the standalone defect is linked inside the defect graph
  assert.ok(plan.links.every((link) => link.type === 'repaired_by'));
  assert.equal(model.graphs.execution.entities.length, 6);
  assert.ok(model.links.some((link) => link.type === 'modified_by' && link.to === `execution:v1:${tasks[0]!.id}`));
  validateFactoryGraphModel(model);
});

test('enforces the task bound and validates scope limits', () => {
  assert.throws(() => compileRemediation({ defects: rootCauses.defects, rootCauses: rootCauses.root_causes, codeGraph: codeGraph(), maxTasks: 2 }), /exceeds maxTasks/);
  assert.throws(() => compileRemediation({ defects: rootCauses.defects, rootCauses: rootCauses.root_causes, codeGraph: codeGraph(), maxScopeSteps: 9 }), /maxScopeSteps/);
});
