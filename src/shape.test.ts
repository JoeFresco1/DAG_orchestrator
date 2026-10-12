// Shape analysis tests: redundant deps, chain depth, width, blast radius.
// Guards the `dag lint` parallelism guardrail against regressions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addTask, newRun } from './store.js';
import {
  analyzeShape,
  findRedundantDeps,
  longestChain,
  transitiveDepSet,
} from './graph.js';

function linear(n: number) {
  const run = newRun('chain');
  let prev: string | null = null;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = addTask(run, { title: `t${i}`, spec: '', deps: prev ? [prev] : [] });
    ids.push(t.id);
    prev = t.id;
  }
  return { run, ids };
}

describe('shape analysis', () => {
  it('flags a direct dep already reachable through another direct dep', () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '', deps: [a.id] });
    const c = addTask(run, { title: 'c', spec: '', deps: [a.id, b.id] });
    const redundant = findRedundantDeps(run, c.id);
    assert.equal(redundant.length, 1);
    assert.equal(redundant[0].id, c.id);
    assert.equal(redundant[0].dep, a.id);
    assert.equal(redundant[0].via, b.id);
  });

  it('does not flag independent deps as redundant', () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '' });
    const c = addTask(run, { title: 'c', spec: '', deps: [a.id, b.id] });
    assert.deepEqual(findRedundantDeps(run, c.id), []);
  });

  it('reports the longest chain in order, root first', () => {
    const { run, ids } = linear(4);
    assert.deepEqual(longestChain(run), ids);
  });

  it('warns long-chain, narrow and blast-radius on a 6-deep serial graph', () => {
    const { run } = linear(6);
    const shape = analyzeShape(run);
    assert.equal(shape.tasks, 6);
    assert.equal(shape.depth, 5);
    assert.equal(shape.maxWidth, 1);
    const kinds = shape.warnings.map((w) => w.kind);
    assert.ok(kinds.includes('long-chain'), 'expected a long-chain warning');
    assert.ok(kinds.includes('narrow'), 'expected a narrow warning');
    assert.ok(kinds.includes('blast-radius'), 'expected a blast-radius warning');
  });

  it('stays quiet on a wide fan-out with minimal deps', () => {
    const run = newRun('t');
    const root = addTask(run, { title: 'root', spec: '' });
    addTask(run, { title: 'b', spec: '', deps: [root.id] });
    addTask(run, { title: 'c', spec: '', deps: [root.id] });
    addTask(run, { title: 'd', spec: '', deps: [root.id] });
    const shape = analyzeShape(run);
    assert.equal(shape.maxWidth, 3);
    assert.deepEqual(shape.redundant, []);
    assert.deepEqual(
      shape.warnings.map((w) => w.kind),
      [],
    );
  });

  it('computes transitive dep sets used for the redundant check', () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '', deps: [a.id] });
    const c = addTask(run, { title: 'c', spec: '', deps: [b.id] });
    assert.ok(transitiveDepSet(run, c.id).has(a.id));
    assert.ok(transitiveDepSet(run, b.id).has(a.id));
    assert.equal(transitiveDepSet(run, a.id).size, 0);
  });
});
