import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectedTestEvidence } from './check-evidence.js';
import { validatePlanningCheck, isKnownTestCommand, type PlanningCheck } from './contracts.js';
const check: PlanningCheck = { id: 'tests', program: process.execPath, args: [], timeoutMs: 1000, kind: 'test', selectedTests: { pattern: '^tests (\\d+)$' } };
test('known test runners cannot bypass selection counts by omitting the check kind', () => {
  const examples: [string, string[]][] = [
    ['pytest', ['-q']], ['C:\\tools\\pytest.exe', []], ['vitest', ['run']], ['jest', []], ['mocha', []],
    ['python', ['-m', 'pytest']], ['python3.12', ['-m', 'pytest']], ['node', ['--test', 'file.test.js']],
    ['npm', ['test']], ['pnpm.cmd', ['run', 'test:unit']], ['yarn', ['test']], ['npm', ['run', 'test']], ['npx', ['vitest', 'run']],
    ['npm', ['--prefix', 'folder', 'test']], ['pnpm', ['exec', 'vitest']], ['node', ['node_modules/vitest/vitest.mjs', 'run']],
  ];
  for (const [program, args] of examples) {
    assert.equal(isKnownTestCommand(program, args), true, program);
    const command = { ...check, program, args, kind: undefined, selectedTests: undefined };
    assert.throws(() => validatePlanningCheck(command), /count contract/, program);
    assert.doesNotThrow(() => validatePlanningCheck({ ...command, kind: 'command' }));
    assert.doesNotThrow(() => validatePlanningCheck({ ...command, kind: 'test', selectedTests: check.selectedTests }));
  }
  for (const [program, args] of [['node', ['-e', 'process.exit(0)']], ['tsc', ['--noEmit']], ['npm', ['run', 'build', '--', 'vitest']], ['eslint', ['src']], ['python', ['script.py']]] as [string, string[]][]) {
    assert.equal(isKnownTestCommand(program, args), false);
    assert.doesNotThrow(() => validatePlanningCheck({ ...check, program, args, kind: undefined, selectedTests: undefined }));
  }
});
test('test count contracts require one numeric summary and nonzero selection', () => {
  assert.deepEqual(selectedTestEvidence(check, 'tests 3\n'), { checkId: 'tests', selectedTests: 3, allowEmpty: false });
  for (const output of ['', 'tests 0', 'tests 1\ntests 2', 'tests x']) assert.throws(() => selectedTestEvidence(check, output));
  assert.equal(selectedTestEvidence({ ...check, selectedTests: { pattern: '^tests (\\d+)$', allowEmpty: true } }, 'tests 0')!.selectedTests, 0);
  assert.equal(selectedTestEvidence({ ...check, kind: 'command', selectedTests: undefined }, ''), undefined);
  assert.throws(() => validatePlanningCheck({ ...check, selectedTests: undefined }), /count contract/);
  assert.throws(() => validatePlanningCheck({ ...check, selectedTests: { pattern: '[' } }), /pattern/);
});
test('canonical checker fails an exit-zero empty selection and emits selected-count evidence on success', () => {
  const script = fileURLToPath(new URL('./check-command.js', import.meta.url));
  for (const count of [0, 2]) {
    const command = { ...check, args: ['-e', `console.log('tests ${count}')`] };
    const result = spawnSync(process.execPath, [script, Buffer.from(JSON.stringify(command)).toString('base64')], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, count ? 0 : 1, result.stderr);
    if (count) assert.match(result.stdout, /DAG_CHECK_EVIDENCE:.*"selectedTests":2/);
  }
});
