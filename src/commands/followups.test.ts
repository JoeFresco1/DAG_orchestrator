import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { addTask, loadRun, newRun, saveRun } from '../store.js';
import { listFollowups } from '../followups.js';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dag-followups-cli-'));
  const file = join(dir, 'dag.run.json');
  const run = newRun('Follow-up CLI fixture');
  const task = addTask(run, { title: 'Existing producer', spec: 'Produce the API' });
  saveRun(run, file);
  const input = join(dir, 'finding.json');
  writeFileSync(input, JSON.stringify({
    id: 'missing-api', message: 'Combined check needs the producer API',
    evidence: ['Check output: producer API is missing'], references: [task.id],
    suggestedOwner: task.id, acceptance: 'Run the combined API check after its producer',
  }));
  const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, 'followups', ...args, '--file', file, '--json'], {
    cwd: dir, encoding: 'utf8', timeout: 15_000,
  });
  return { file, task, input, invoke };
}

test('followups CLI proposes, lists and assigns existing work without changing the run', () => {
  const { file, task, input, invoke } = fixture();
  const definition = readFileSync(file, 'utf8');
  const before = JSON.stringify(loadRun(file));
  const added = invoke('add', '--input', input, '--task', task.id, '--attempt', '1', '--stage', 'review');
  assert.equal(added.status, 0, added.stderr);
  const proposed = JSON.parse(added.stdout) as Array<{ id: string }>;
  assert.equal(proposed.length, 1);
  const id = proposed[0].id;
  const listed = invoke('list');
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), listFollowups(file));
  const assigned = invoke('triage', '--id', id, '--disposition', 'existing-task', '--owner', task.id,
    '--reason', 'Producer already owns this requirement');
  assert.equal(assigned.status, 0, assigned.stderr);
  assert.deepEqual(JSON.parse(assigned.stdout), listFollowups(file)[0]);
  assert.equal(readFileSync(file, 'utf8'), definition);
  assert.equal(JSON.stringify(loadRun(file)), before);
});

test('followups CLI rejects malformed commands and unknown owners without promoting work', () => {
  const { file, input, invoke } = fixture();
  assert.equal(invoke('add', '--input', input, '--attempt').status, 1);
  assert.deepEqual(listFollowups(file), []);
  const added = invoke('add', '--input', input);
  assert.equal(added.status, 0, added.stderr);
  const id = (JSON.parse(added.stdout) as Array<{ id: string }>)[0].id;
  const before = JSON.stringify(listFollowups(file));
  const invalid = invoke('triage', '--id', id, '--disposition', 'accepted', '--reason', 'Unsupported');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--disposition/);
  const missingOwner = invoke('triage', '--id', id, '--disposition', 'existing-task', '--owner', 'unknown-task', '--reason', 'Assign');
  assert.equal(missingOwner.status, 1);
  assert.equal(JSON.stringify(listFollowups(file)), before);
});
