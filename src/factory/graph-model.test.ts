import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFactoryGraphModel,
  deserializeFactoryGraphModel,
  serializeFactoryGraphModel,
  traceRequirement,
  validateFactoryGraphModel,
  type FactoryGraphModel,
} from './graph-model.js';

const ids = {
  requirement: 'requirement:v1:req.login' as const,
  symbol: 'code:v1:symbol.login' as const,
  task: 'execution:v1:task.implement-login' as const,
  observation: 'defect:v1:observation.missing-check' as const,
  defect: 'defect:v1:defect.missing-check' as const,
  cause: 'defect:v1:cause.input-validation' as const,
  fix: 'execution:v1:task.fix-validation' as const,
};

function exampleModel(): FactoryGraphModel {
  const model = createFactoryGraphModel();
  model.graphs.requirement.entities.push({ id: ids.requirement, kind: 'requirement', title: 'Login rejects invalid credentials' });
  model.graphs.code.entities.push({ id: ids.symbol, kind: 'symbol', title: 'LoginService.authenticate' });
  model.graphs.execution.entities.push(
    { id: ids.task, kind: 'implementation_task', title: 'Implement login' },
    { id: ids.fix, kind: 'remediation_task', title: 'Fix input validation' },
  );
  model.graphs.defect.entities.push(
    { id: ids.observation, kind: 'observation', title: 'Invalid credentials are accepted' },
    { id: ids.defect, kind: 'defect', title: 'Login accepts malformed credentials' },
    { id: ids.cause, kind: 'root_cause', title: 'Missing input validation' },
  );
  model.links.push(
    { from: ids.requirement, type: 'implemented_by', to: ids.symbol },
    { from: ids.symbol, type: 'modified_by', to: ids.task },
    { from: ids.task, type: 'produced', to: ids.observation },
    { from: ids.observation, type: 'supports', to: ids.defect },
    { from: ids.defect, type: 'explained_by', to: ids.cause },
    { from: ids.cause, type: 'repaired_by', to: ids.fix },
  );
  return model;
}

describe('factory graph model', () => {
  it('round-trips all four graph kinds and cross-graph links', () => {
    const model = exampleModel();
    const restored = deserializeFactoryGraphModel(serializeFactoryGraphModel(model));
    assert.deepEqual(restored, model);
    assert.deepEqual(Object.keys(restored.graphs), ['requirement', 'code', 'execution', 'defect']);
    assert.equal(restored.links.length, 6);
  });

  it('rejects dangling and ill-typed references', () => {
    const dangling = exampleModel();
    dangling.links[0] = { from: ids.requirement, type: 'implemented_by', to: 'code:v1:missing' as typeof ids.symbol };
    assert.throws(() => validateFactoryGraphModel(dangling), /dangling edge reference/);

    const illTyped = exampleModel();
    illTyped.links[0] = { from: ids.requirement, type: 'implemented_by', to: ids.task } as unknown as typeof illTyped.links[number];
    assert.throws(() => validateFactoryGraphModel(illTyped), /ill-typed implemented_by edge/);

    const wrongNamespace = exampleModel();
    wrongNamespace.graphs.code.entities[0] = { id: ids.requirement, kind: 'symbol', title: 'Wrong graph' };
    assert.throws(() => validateFactoryGraphModel(wrongNamespace), /invalid entity in code graph/);
  });

  it('traces a requirement through implementation, evidence, defect, cause, and fix deterministically', () => {
    const model = exampleModel();
    const expected = [ids.requirement, ids.symbol, ids.task, ids.observation, ids.defect, ids.cause, ids.fix];
    const findFixTraces = () => traceRequirement(model, ids.requirement).filter((path) => path.at(-1) === ids.fix);
    const first = findFixTraces();
    assert.deepEqual(first, [expected]);
    assert.deepEqual(findFixTraces(), first);
  });
});
