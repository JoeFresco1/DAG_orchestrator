import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { codexStdin } from './codex-transport.js';
import { shellExecutor, type ExecContext } from './runner.js';
import { addTask, newRun } from './store.js';

test('native executor sends a large Codex review through stdin with exact context and model options', async () => {
  const spec = 'x'.repeat(100_000) + '\n雪 $() `literal` {deps}', deps = 'upstream'.repeat(10_000);
  const task = addTask(newRun('transport'), { title: 'review', spec, cmd: 'work' });
  let livePid: number | null = null, streamed = '', launchedArgs: string[] = [];
  const context: ExecContext = { deps, onOutput: s => streamed += s, setPid: pid => livePid = pid, registerKill: () => {}, aborted: () => false };
  const script = `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify({hash:require('crypto').createHash('sha256').update(s).digest('hex'),args:process.argv.slice(1)})));`;
  const launch: typeof spawn = ((_file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    launchedArgs = [...args];
    return spawn(process.execPath, ['-e', script, '--', ...args], options);
  }) as typeof spawn;
  const executor = shellExecutor(process.cwd(), launch);
  const result = await executor(task, context, 'codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-6-luna -c model_reasoning_effort=xhigh Inspect {spec} upstream {deps}');
  assert.equal(result.exitCode, 0); assert.equal(livePid, null); assert.equal(streamed, result.output);
  assert.ok(launchedArgs.join(' ').length < 2000); assert.equal(launchedArgs.at(-1), '-');
  assert.ok(launchedArgs.includes('gpt-6-luna')); assert.ok(launchedArgs.includes('model_reasoning_effort=xhigh'));
  assert.equal(JSON.parse(result.output).hash, createHash('sha256').update(`Inspect ${spec} upstream ${deps}`).digest('hex'));
});

test('stdin conversion preserves configured flags and leaves other input protocols unchanged', () => {
  assert.deepEqual(codexStdin('codex.exe', ['exec', '--model=gpt-6-luna', '--output-schema', 'schema with spaces.json', '--', 'prompt']), {
    args: ['exec', '--model=gpt-6-luna', '--output-schema', 'schema with spaces.json', '-'], prompt: 'prompt',
  });
  for (const [file, args] of [['node', ['script.mjs']], ['codex', ['exec', 'resume', 'id']], ['codex', ['exec', '-']], ['codex', ['exec', '--unknown', 'payload']], ['codex', ['exec', '--image', 'one.png', 'two.png', 'prompt']]] as const)
    assert.equal(codexStdin(file, [...args]), null);
  assert.throws(() => codexStdin('codex', ['exec', '--model']), /Missing/);
});
