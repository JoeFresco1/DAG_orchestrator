import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCommand } from './compile.js';
import { addTask, loadRun, newRun, runPaths, saveRun } from '../store.js';
import { shellExecutor, shellSplit, type ExecContext } from '../runner.js';
import { digest, type PlanningCheck } from './contracts.js';

test('file check transport preserves large UTF8 payloads and literal argv after persistence and cwd changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-check-transport-'));
  try {
    const script = join(dir, 'check fixture.cjs');
    writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const literals = ['雪 café 🚀', '"quoted"', "'single'", '$() `literal`', '& | < > ^ %PATH% !TOKEN!', '{spec} {deps}', '', 'back\\slash'];
    const args = Array.from({ length: 80 }, () => literals).flat();
    const check: PlanningCheck = { id: 'large-' + '雪'.repeat(100_000), program: process.execPath, args: [script, ...args], timeoutMs: 10_000 };
    const file = join(dir, 'custom.run.json');
    const command = checkCommand(check, join(runPaths(file).dir, 'checks', 'task_fixture', '1'));
    assert.ok(command.length < 2000);
    assert.ok(!command.includes('quoted'));
    const payloadFile = shellSplit(command)[3]!;
    assert.deepEqual(JSON.parse(readFileSync(payloadFile, 'utf8')), check);
    const run = newRun('check transport');
    const task = addTask(run, { title: 'fixture', spec: '', cmd: command });
    saveRun(run, file);
    const reloaded = loadRun(file).tasks[task.id]!;
    const context: ExecContext = { deps: '', onOutput: () => {}, setPid: () => {}, registerKill: () => {}, aborted: () => false };
    const result = await shellExecutor(tmpdir())(reloaded, context, reloaded.cmd!);
    assert.equal(result.exitCode, 0, result.output);
    assert.deepEqual(JSON.parse(result.output), args);
    assert.ok(readFileSync(payloadFile, 'utf8').length > 100_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('check file reader fails closed and remains compatible with legacy saved commands', () => {
  const script = fileURLToPath(new URL('./check-command.js', import.meta.url));
  const legacy: PlanningCheck = { id: 'legacy', program: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 };
  assert.equal(spawnSync(process.execPath, [script, Buffer.from(JSON.stringify(legacy)).toString('base64')]).status, 0);
  const dir = mkdtempSync(join(tmpdir(), 'dag-check-invalid-'));
  try {
    const payload = join(dir, 'invalid.json');
    writeFileSync(payload, JSON.stringify({ ...legacy, args: ['bad\nargument'] }));
    assert.equal(spawnSync(process.execPath, [script, '--file', payload]).status, 1);
    assert.equal(spawnSync(process.execPath, [script, '--file', join(dir, 'missing.json')]).status, 1);
    const pinned = join(dir, `${digest(legacy)}.json`);
    writeFileSync(pinned, JSON.stringify({ ...legacy, args: ['-e', 'process.exit(0);'] }));
    const modified = spawnSync(process.execPath, [script, '--file', pinned], { encoding: 'utf8' });
    assert.equal(modified.status, 1);
    assert.match(modified.stderr, /payload identity changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canonical Codex check sends a large prompt through stdin after resolving a Windows shim', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-check-codex-'));
  try {
    writeFileSync(join(dir, 'codex.cmd'), '@node "%~dp0stub.cjs" %*');
    writeFileSync(join(dir, 'stub.cjs'), "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify({hash:require('crypto').createHash('sha256').update(s).digest('hex'),args:process.argv.slice(2)})))");
    const prompt = '雪 café $() `literal` & | "quotes" {spec} '.repeat(5000);
    const check: PlanningCheck = { id: 'codex-large', program: 'codex', args: ['exec', '-m', 'configured-model', prompt], timeoutMs: 10_000 };
    const command = checkCommand(check, join(dir, 'checks'));
    const payloadFile = /--file ["'](.+)["']$/.exec(command)![1];
    const script = fileURLToPath(new URL('./check-command.js', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--file', payloadFile], { encoding: 'utf8', env: { ...process.env, PATH: dir + delimiter + process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { hash: createHash('sha256').update(prompt).digest('hex'), args: ['exec', '-m', 'configured-model', '-'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
