import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { tempDir } from './test-helpers.js';
import { fileBackedAgentArgs } from './bulk-prompts.js';
import { digest } from './planning/contracts.js';
import { codexWorkArgs, codexStdin } from './codex-transport.js';

test('known coding adapters keep large Unicode prompts and dependency evidence out of argv', () => {
  const directory = tempDir(), prompt = '雪 café "quotes" $() & {spec}\n'.repeat(5000);
  for (const adapter of ['opencode.cmd', 'claude.exe', 'gemini', 'cursor-agent']) {
    const result = fileBackedAgentArgs(adapter, ['run', '--model', 'configured-model', prompt], directory);
    assert.deepEqual(result.args.slice(0, 3), ['run', '--model', 'configured-model']);
    assert.ok(result.args.join(' ').length < 8191);
    assert.equal(result.payloads[0]!.bytes, Buffer.byteLength(prompt, 'utf8'));
    assert.equal(result.payloads[0]!.sha256, digest(prompt));
    assert.equal(JSON.parse(readFileSync(result.payloads[0]!.path, 'utf8')).payload, prompt);
  }
});
test('Codex stdin and arbitrary executable argument contracts remain separate', () => {
  const args = ['literal '.repeat(10000)], directory = tempDir();
  assert.equal(fileBackedAgentArgs('codex', args, directory).args, args);
  assert.equal(fileBackedAgentArgs('node.exe', args, directory).args, args);
  const schema = JSON.stringify({ description: 'schema '.repeat(2000) });
  assert.deepEqual(fileBackedAgentArgs('claude', ['--json-schema', schema], directory).args, ['--json-schema', schema]);
});

test('lean Codex work keeps the process sandbox while preserving model and prompt transport', () => {
  const args = codexWorkArgs('codex.cmd', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--approve-for-me', '--sandbox=danger-full-access', '-m', 'model', 'Implement output']);
  assert.deepEqual(codexStdin('codex.cmd', args), { args: ['exec', '--sandbox', 'workspace-write', '-m', 'model', '-'], prompt: 'Implement output' });
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
});
