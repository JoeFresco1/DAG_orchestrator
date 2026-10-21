import assert from 'node:assert/strict';
import test from 'node:test';
import { compileFlowPlan } from './graph.js';
import { validateFlowSettings } from './contracts.js';
import { checkScriptCommands, commandMentionsPath, protectedRepairPath, repairDecision } from './repair.js';

function graph() {
  return compileFlowPlan({ version: 3, title: 'repair routing', nodes: [
    { id: 'producer', goal: 'Produce artifact', depends_on: [], touches: ['artifact.ts'], creates: ['artifact.ts'], relies_on: [], verify: 'check-producer' },
    { id: 'consumer', goal: 'Consume artifact', depends_on: [], touches: ['consumer.ts'], creates: [], relies_on: [], verify: 'check-consumer' },
  ] }).run;
}

test('only concrete implementation diagnostics are eligible; infrastructure, missing inputs and unknown failures hold', () => {
  const run = graph();
  for (const output of ['report.md:17: trailing whitespace.', 'SyntaxError: unexpected token', 'src/a.ts(4,2): error TS2322: bad type', 'AssertionError: expected 1 actual 2']) {
    assert.equal(repairDecision(run, { command: 'check', output, phase: 'verify' }).action, 'repair', output);
  }
  for (const output of ['HTTP 429 Too many requests', 'authentication failed', 'usage limit reached', 'spawn pnpm ENOENT', "No module named 'pytest'", 'Something went wrong']) {
    assert.equal(repairDecision(run, { command: 'check', output, phase: 'verify' }).action, 'hold', output);
  }
  assert.equal(repairDecision(run, { command: 'check', output: 'assertion failed', phase: 'setup' }).action, 'hold');
  assert.equal(repairDecision(run, { command: 'check', output: 'assertion failed', phase: 'verify', kind: 'timeout' }).action, 'hold');
});

test('checks wait only for registered producers; missing input defers only with unambiguous unfinished ownership', () => {
  const run = graph();
  const pending = repairDecision(run, { command: 'check', output: '', phase: 'checkpoint', requires: ['producer'] });
  assert.equal(pending.action, 'defer'); assert.deepEqual(pending.requires, ['producer']);
  assert.equal(repairDecision(run, { command: 'check', output: '', phase: 'checkpoint', requires: ['ghost'] }).action, 'hold');
  const output = 'ENOENT: no such file or directory, open artifact.ts';
  assert.equal(repairDecision(run, { command: 'check', output, phase: 'checkpoint' }).action, 'defer');
  assert.equal(repairDecision(run, { command: 'check', output: 'ENOENT: open not-artifact.ts', phase: 'checkpoint' }).action, 'hold');
  assert.equal(repairDecision(run, { command: 'check', output, phase: 'verify' }).action, 'hold');
  run.tasks.producer.status = 'completed';
  assert.equal(repairDecision(run, { command: 'check', output, phase: 'checkpoint' }).action, 'hold');
  run.tasks.producer.status = 'pending';
  run.tasks.consumer.node!.creates = ['artifact.ts'];
  assert.equal(repairDecision(run, { command: 'check', output, phase: 'checkpoint' }).action, 'hold');
});

test('graph admission safely adds verification prerequisites and rejects missing IDs and cycles', () => {
  const run = graph();
  const nodes = Object.values(run.tasks).map(t => ({ id: t.id, ...t.node!, depends_on: t.deps }));
  nodes[1].verify_requires = ['producer'];
  const compiled = compileFlowPlan({ version: 3, title: 'ordered checks', nodes });
  assert.deepEqual(compiled.run.tasks.consumer.deps, ['producer']);
  nodes[0].verify_requires = ['producer'];
  assert.throws(() => compileFlowPlan({ version: 3, title: 'self cycle', nodes }), /cycle/);
  nodes[0].verify_requires = ['consumer'];
  assert.throws(() => compileFlowPlan({ version: 3, title: 'cycle', nodes }), /cycle/);
  nodes[0].verify_requires = ['ghost'];
  assert.throws(() => compileFlowPlan({ version: 3, title: 'missing', nodes }), /missing verification producer/);
  assert.throws(() => compileFlowPlan({ version: 3, title: 'unknown check producer', nodes: [nodes[1]], settings: { checkPrerequisites: { suite: ['ghost'] } } }), /missing.*producer/);
});

test('repair settings validate bounded budgets, prerequisite maps and protected paths', () => {
  assert.deepEqual(validateFlowSettings({ nodeRepairRounds: 1, phaseTimeouts: { repair: 1000 }, checkPrerequisites: { suite: ['producer'] }, repairProtectedPaths: ['acceptance/contract.json'] }), []);
  for (const value of [{ nodeRepairRounds: 3 }, { nodeRepairRounds: -1 }, { checkPrerequisites: { suite: 'producer' } }, { checkPrerequisites: { suite: ['../bad'] } }, { repairProtectedPaths: ['../bad'] }]) {
    assert.ok(validateFlowSettings(value).length);
  }
});

test('test assertions, specifications and check configuration are protected, while implementation remains editable', () => {
  for (const path of ['src/parser.test.ts', 'scripts/tests/test_audit.py', 'docs/specs/a.md', 'package.json', 'tsconfig.json', 'scripts/check-scope.mjs', 'contracts/api.json']) assert.equal(protectedRepairPath(path), true, path);
  for (const path of ['src/parser.ts', 'docs/build/COMPLETION.md', 'src/client.ts']) assert.equal(protectedRepairPath(path), false, path);
  assert.equal(commandMentionsPath('node "scripts/unusual.mjs"', 'scripts/unusual.mjs'), true);
  assert.equal(commandMentionsPath('node scripts/not-unusual.mjs', 'unusual.mjs'), false);
  assert.deepEqual(checkScriptCommands(['pnpm test'], { test: 'npm run inner', inner: 'node nested-runner.mjs', unrelated: 'node app.mjs' }), ['pnpm test', 'npm run inner', 'node nested-runner.mjs']);
  assert.deepEqual(checkScriptCommands(['npm test'], { test: 'pnpm run test' }), ['npm test', 'pnpm run test']);
});
