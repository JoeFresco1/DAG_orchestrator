import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attemptsForChain, formatHarnessChain, parseHarnessChain, planAttempt } from './harness-chain.js';

test('parses harness chains with per-tool models and effort', () => {
  const chain = parseHarnessChain('opencode:opencode-go/muse-spark-1.3-contributor:xhigh, codex, claude:sonnet');
  assert.deepEqual(chain, [
    { harness: 'opencode', model: 'opencode-go/muse-spark-1.3-contributor', variant: 'xhigh' },
    { harness: 'codex', model: null, variant: null },
    { harness: 'claude', model: 'sonnet', variant: null },
  ]);
  assert.equal(formatHarnessChain(chain), 'opencode:opencode-go/muse-spark-1.3-contributor:xhigh, codex, claude:sonnet');
});

test('rejects unknown harnesses and ones without a command preset', () => {
  assert.throws(() => parseHarnessChain('opencode,nope'), /unknown harness/);
});

test('each attempt advances the chain and the last candidate sticks', () => {
  const chain = parseHarnessChain('opencode,codex,claude');
  assert.equal(planAttempt(chain, 1)?.candidate.harness, 'opencode');
  assert.equal(planAttempt(chain, 2)?.candidate.harness, 'codex');
  assert.equal(planAttempt(chain, 3)?.candidate.harness, 'claude');
  assert.equal(planAttempt(chain, 4)?.candidate.harness, 'claude');
  assert.equal(planAttempt(chain, 2)?.fellBack, true);
  assert.equal(planAttempt(chain, 1)?.fellBack, false);
  assert.equal(planAttempt(null, 1), null);
});

test('a chain raises the attempt budget so every candidate gets a turn', () => {
  assert.equal(attemptsForChain(1, null), 1);
  assert.equal(attemptsForChain(1, parseHarnessChain('opencode,codex')), 2);
  assert.equal(attemptsForChain(3, parseHarnessChain('opencode,codex')), 3);
});
