import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addTask, newRun, saveRun, logEvent, runPaths } from './store.js';

test('shared diagnostic lifecycle and routing regressions', () => {
  const script = fileURLToPath(new URL('../scripts/diagnostics/core.test.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', script], { encoding: 'utf8', timeout: 30000, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /(?:#|ℹ) tests 13/);
});

test('dag diagnose dry-run uses real rejection history without changing task state or launching a model', () => {
  const root = mkdtempSync(join(tmpdir(), 'dag-diagnose-cli-')), file = join(root, 'dag.run.json');
  const run = newRun('diagnostic proof');
  const task = addTask(run, { title: 'bounded task', spec: 'Only update parser.ts. Run parser tests.', cmd: 'node test.js' });
  saveRun(run, file);
  for (const attempt of [1, 2, 3]) {
    logEvent(run, 'task-start', task.id, `attempt ${attempt} (cycle ${attempt}/3)`);
    logEvent(run, 'task-review', task.id, 'reviewer rejected the work: parser returns wrong result');
  }
  saveRun(run, file);
  const definition = readFileSync(file, 'utf8'), state = readFileSync(runPaths(file).state, 'utf8');
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'diagnose', '--file', file, '--id', task.id, '--dry-run', '--json'],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout);
  assert.deepEqual(packet.rejectedAttempts, [1, 2, 3]);
  assert.equal(packet.eligible, true);
  assert.equal(packet.model, 'gpt-6-luna');
  assert.equal(packet.reasoning, 'xhigh');
  assert.equal(packet.scope.instructions, task.spec);
  assert.equal(packet.recordRoot, join(runPaths(file).dir, 'diagnostics'));
  assert.equal(readFileSync(file, 'utf8'), definition);
  assert.equal(readFileSync(runPaths(file).state, 'utf8'), state);
});


test('dag diagnose first timeout is eligible without semantic rejections', () => {
  const root=mkdtempSync(join(tmpdir(),'dag-diagnose-timeout-')),file=join(root,'dag.run.json');
  const run=newRun('first infrastructure failure');
  const task=addTask(run,{title:'hung verifier',spec:'Preserve acceptance.',cmd:'node test.js'});
  task.status='failed';task.attempts=1;task.failureKind='timeout';task.result='reviewer timeout';saveRun(run,file);
  const cli=fileURLToPath(new URL('./cli.js',import.meta.url));
  const result=spawnSync(process.execPath,[cli,'diagnose','--file',file,'--id',task.id,'--dry-run','--json'],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);const packet=JSON.parse(result.stdout);
  assert.equal(packet.eligible,true);assert.equal(packet.trigger,'infrastructure');assert.deepEqual(packet.rejectedAttempts,[]);
});
