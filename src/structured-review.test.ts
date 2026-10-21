import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeReviewProtocol, parseReviewBody, reviewEnvelope, validateReviewBody, type AdapterCircuits } from './review-protocol.js';
import { codexReviewArgs, codexStdin } from './codex-transport.js';

const blocking = { id: 'contract', severity: 'error', blocking: true, message: 'Wrong exported version', correction: 'Export version 2', evidence: [{ reference: 'src/api.ts:3', observation: 'The version export is 1; the pinned contract requires 2' }] };
test('structured review rejects contradictory verdicts, unsupported evidence and duplicate findings', () => {
  assert.throws(() => validateReviewBody({ verdict: 'pass', findings: [blocking] }), /contradicts/);
  assert.throws(() => validateReviewBody({ verdict: 'inconclusive', findings: [blocking] }), /contradicts/);
  assert.throws(() => validateReviewBody({ verdict: 'fail', findings: [] }), /contradicts/);
  assert.throws(() => validateReviewBody({ verdict: 'fail', findings: [{ ...blocking, evidence: [] }] }), /concrete/);
  assert.throws(() => validateReviewBody({ verdict: 'fail', findings: [blocking] }, new Set(['other.ts'])), /authority/);
  assert.throws(() => validateReviewBody({ verdict: 'fail', findings: [blocking, blocking] }), /Invalid/);
  assert.equal(validateReviewBody({ verdict: 'fail', findings: [blocking] }, new Set(['src/api.ts:3'])).verdict, 'fail');
  assert.equal(validateReviewBody({ verdict: 'fail', findings: [blocking] }, new Set(['src/api.ts'])).verdict, 'fail');
  assert.throws(() => validateReviewBody({ verdict: 'fail', findings: [{ ...blocking, evidence: [{ reference: 'src/api.ts:invented', observation: 'Different version' }] }] }, new Set(['src/api.ts'])), /authority/);
  assert.throws(() => parseReviewBody('DAG_REVIEW: {"verdict":"pass","findings":[]}\nDAG_REVIEW: {"verdict":"pass","findings":[]}'), /Multiple/);
});
test('protocol recovery persists before dispatch, keeps infrastructure distinct and opens durable circuit', async () => {
  const circuits: AdapterCircuits = {}; let dispatches = 0, saves = 0;
  const options = { adapter: 'codex', circuits, persist: () => { saves++; }, onDispatch: () => { dispatches++; },
    invoke: async () => { assert.ok(saves >= dispatches); return 'progress without conclusion'; }, parse: parseReviewBody };
  await assert.rejects(invokeReviewProtocol(options), /protocol exhausted/);
  assert.equal(dispatches, 2); assert.equal(circuits.codex!.open, false);
  await assert.rejects(invokeReviewProtocol(options), /protocol exhausted/);
  assert.equal(dispatches, 3); assert.equal(circuits.codex!.open, true);
  await assert.rejects(invokeReviewProtocol(options), /circuit open/); assert.equal(dispatches, 3);
  const before = saves;
  await assert.rejects(invokeReviewProtocol({ ...options, adapter: 'other', invoke: async () => { throw Error('network failure'); } }), /network failure/);
  assert.equal(saves, before + 1); assert.equal(circuits.other!.consecutiveFailures, 0);
});
test('valid recovery binds controller identity and resets provider failures', async () => {
  const circuits: AdapterCircuits = {}; let calls = 0;
  const body = await invokeReviewProtocol({ adapter: 'codex', circuits, parse: parseReviewBody, invoke: async (_dispatch, feedback) => {
    calls++; if (calls === 1) return '{}'; assert.match(feedback, /Invalid/); return '{"verdict":"pass","findings":[]}';
  } });
  assert.equal(calls, 2); assert.equal(circuits.codex!.consecutiveFailures, 0);
  const receipt = reviewEnvelope(body, { reviewId: 'r', taskId: 't', phase: 'final', attempt: 1, sourceIdentity: 'commit', contextDigest: 'context', adapter: 'codex' });
  assert.equal(receipt.sourceIdentity, 'commit'); assert.equal(receipt.bodyDigest.length, 64);
});
test('Codex final artifact options preserve stdin prompt and replace conflicting destinations', () => {
  const args = codexReviewArgs('codex.cmd', ['exec', '-o', 'old', '--output-schema=old.json', '-m', 'model', 'Review source'], 'final.txt', 'schema.json');
  assert.deepEqual(codexStdin('codex.cmd', args), { args: ['exec', '--sandbox', 'read-only', '--output-last-message', 'final.txt', '--output-schema', 'schema.json', '-m', 'model', '-'], prompt: 'Review source' });
  const restricted = codexReviewArgs('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--sandbox=workspace-write', '--full-auto', '-s', 'danger-full-access', 'Review'], 'final.txt');
  assert.equal(restricted.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(restricted.includes('--full-auto'), false); assert.equal(restricted.includes('danger-full-access'), false);
  assert.equal(restricted.includes('--sandbox=workspace-write'), false); assert.equal(restricted[2], 'read-only');
  assert.deepEqual(codexReviewArgs('other', ['exec', 'prompt'], 'final.txt'), ['exec', 'prompt']);
});
test('rolling circuit opens on three malformed responses within five despite intervening valid responses', async () => {
  const circuits: AdapterCircuits = {};
  for (const valid of [false, true, false, true, false]) {
    const promise = invokeReviewProtocol({ adapter: 'provider', circuits, retries: 0, parse: parseReviewBody,
      invoke: async () => valid ? '{"verdict":"pass","findings":[]}' : 'malformed' });
    if (valid) await promise; else await assert.rejects(promise, /exhausted/);
  }
  assert.equal(circuits.provider!.open, true);
  assert.deepEqual(circuits.provider!.recent, [false, true, false, true, false]);
});
test('durable dispatch count prevents extra invocation after process recovery', async () => {
  let calls = 0;
  await assert.rejects(invokeReviewProtocol({ adapter: 'provider', circuits: {}, dispatched: 2,
    invoke: async () => { calls++; return '{}'; }, parse: parseReviewBody }), /durable dispatch budget/);
  assert.equal(calls, 0);
});

test('late successful in-flight review cannot close an opened provider circuit', async () => {
  const circuits: AdapterCircuits = {};
  let finish: (value: string) => void = () => {};
  const pending = invokeReviewProtocol({ adapter: 'provider', circuits, retries: 0, parse: parseReviewBody,
    invoke: async () => new Promise<string>(resolve => { finish = resolve; }) });
  for (let failure = 0; failure < 3; failure++) {
    await assert.rejects(invokeReviewProtocol({ adapter: 'provider', circuits, retries: 0, parse: parseReviewBody,
      invoke: async () => 'malformed' }), /exhausted/);
  }
  finish('{"verdict":"pass","findings":[]}'); await pending;
  assert.equal(circuits.provider!.open, true);
  await assert.rejects(invokeReviewProtocol({ adapter: 'provider', circuits, parse: parseReviewBody,
    invoke: async () => { throw Error('must not dispatch'); } }), /circuit open/);
});
