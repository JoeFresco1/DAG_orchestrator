import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DagRunner, type ExecContext, type Executor } from '../runner.js';
import { deriveStatus } from '../graph.js';
import { git } from '../git-worktree.js';
import { gitRepo } from '../test-helpers.js';
import { loadRun, recordHeartbeat, retryTask, saveRun } from '../store.js';
import { compileFlowPlan, checkGraph, chainWaves } from './graph.js';
import { validateFlowSettings, type FlowNode, type FlowSettings } from './contracts.js';
import { planningCmd } from '../commands/planning.js';
import { runCmd } from '../commands/run.js';
import { codexSessionArgs, codexStdin } from '../codex-transport.js';
import { agentSessionArgs, captureSessionEvent, type WorkerSession } from '../agent-session.js';

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const ok = { exitCode: 0, output: 'ok' };
function node(id: string, deps: string[] = [], changes: Partial<FlowNode> = {}): FlowNode {
  return { id, goal: `Implement ${id}`, depends_on: deps, touches: [`${id}.txt`], creates: [], relies_on: [], verify: `verify-${id}`, cmd: 'work', ...changes };
}
function fixture(nodes: FlowNode[], config: FlowSettings = {}) {
  const repo = gitRepo();
  const { run } = compileFlowPlan({ version: 3, title: 'flow', nodes,
    settings: { waveChecks: ['wave'], finalChecks: ['full'], repairRounds: 0, ...config } });
  return { repo, run, file: join(repo, 'dag.run.json') };
}
function runner(f: ReturnType<typeof fixture>, executor: Executor) {
  saveRun(f.run, f.file);
  return new DagRunner(f.run, { cwd: f.repo, file: f.file, executor, persist: run => saveRun(run, f.file) });
}

test('graph admission repairs only missing producer edges and rejects invalid graphs transactionally', () => {
  const { run, report } = compileFlowPlan({ version: 3, title: 'edges', nodes: [
    node('consumer', [], { touches: ['api.ts'], relies_on: ['parse(input): Result'] }),
    node('producer', [], { touches: ['api.ts'], creates: ['api.ts', 'parse(input): Result'] }),
  ] });
  assert.deepEqual(run.tasks.consumer.deps, ['producer']);
  assert.equal(report.addedEdges.length, 1);
  assert.throws(() => compileFlowPlan({ version: 3, title: 'duplicate', nodes: [node('a'), node('a')] }), /duplicate/);
  assert.throws(() => compileFlowPlan({ version: 3, title: 'missing', nodes: [node('a', ['missing'])] }), /missing dependency/);
  assert.throws(() => compileFlowPlan({ version: 3, title: 'cycle', nodes: [node('50', ['150']), node('150', ['50'])] }), /cycle/);
  run.tasks.producer.deps = ['consumer'];
  const original = JSON.stringify(run.tasks.consumer.deps);
  assert.equal(checkGraph(run).valid, false);
  assert.equal(JSON.stringify(run.tasks.consumer.deps), original);
  assert.ok(validateFlowSettings({ phaseTimeouts: { verify: 120_000 } }).length);
  assert.ok(validateFlowSettings({ repairRounds: 3 }).length);
});

test('straight chains share one warm worktree and session; branches checkpoint independently', async () => {
  const f = fixture([node('a'), node('b', ['a']), node('c', ['b']), node('independent')]);
  assert.deepEqual(chainWaves(f.run, new Set(Object.keys(f.run.tasks))), [[['a', 'b', 'c'], ['independent']]]);
  f.run.settings.worktreePrepareCmd = 'setup';
  const paths = new Map<string, string>(), sessions: ExecContext['session'][] = [], commands: string[] = [];
  const r = runner(f, async (task, ctx, cmd) => {
    commands.push(cmd!);
    if (cmd === 'work') {
      paths.set(task.id, ctx.cwd!); sessions.push(ctx.session);
      if (task.id === 'b') assert.equal(readFileSync(join(ctx.cwd!, 'a.txt'), 'utf8'), 'a');
      if (task.id === 'c') assert.equal(readFileSync(join(ctx.cwd!, 'b.txt'), 'utf8'), 'b');
      writeFileSync(join(ctx.cwd!, `${task.id}.txt`), task.id);
    }
    return ok;
  });
  await r.start();
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
  assert.equal(paths.get('a'), paths.get('b')); assert.equal(paths.get('b'), paths.get('c'));
  assert.equal(sessions[0], sessions[2]);
  assert.equal(new Set(paths.values()).size, 2);
  assert.equal(commands.filter(c => c === 'setup').length, 3); // 2 pool slots + integration
  assert.equal(commands.filter(c => c === 'work').length, 4);
  assert.equal(git(f.repo, ['show', `dag/${f.run.id}:c.txt`]).stdout, 'c');
  assert.equal(existsSync(join(f.repo, 'c.txt')), false);
  const restored = loadRun(f.file);
  assert.ok(restored.flowState?.checkpoints.some(c => c.kind === 'final' && c.passed));
  assert.ok(restored.tasks.a.phaseHistory?.some(p => p.phase === 'work' && p.durationMs >= 0));
});

test('one retry then block descendants, while an independent branch finishes', async () => {
  const f = fixture([node('a'), node('b', ['a']), node('c', ['b']), node('good')]);
  const calls: string[] = [];
  const r = runner(f, async (task, ctx, cmd) => {
    if (cmd === 'work') {
      calls.push(task.id);
      if (task.id === 'a') return { exitCode: 5, output: 'specific compiler error' };
      writeFileSync(join(ctx.cwd!, 'good.txt'), 'good');
    }
    return ok;
  });
  await r.start();
  assert.equal(f.run.tasks.a.attempts, 2);
  assert.equal(deriveStatus(f.run, f.run.tasks.b), 'blocked');
  assert.equal(deriveStatus(f.run, f.run.tasks.c), 'blocked');
  assert.equal(f.run.tasks.good.status, 'completed');
  assert.deepEqual(calls.filter(id => id !== 'a'), ['good']);
  assert.equal(r.result?.flow3?.passed, false);
  assert.equal(f.run.flowState?.checkpoints.some(c => c.kind === 'final'), false);
});

test('final acceptance waits for required producers and runs after explicit recovery', async () => {
  const f = fixture([node('producer'), node('consumer', ['producer'])]);
  f.run.tasks.producer.maxAttempts = 1;
  let fail = true, finalChecks = 0;
  const execute: Executor = async (task, ctx, cmd) => {
    if (cmd === 'work') {
      if (task.id === 'producer' && fail) return { exitCode: 1, output: 'producer interrupted' };
      if (task.id === 'consumer') assert.equal(readFileSync(join(ctx.cwd!, 'producer.txt'), 'utf8'), 'ready');
      writeFileSync(join(ctx.cwd!, `${task.id}.txt`), 'ready');
    }
    if (cmd === 'full') {
      finalChecks++;
      assert.equal(readFileSync(join(ctx.cwd!, 'consumer.txt'), 'utf8'), 'ready');
    }
    return ok;
  };
  await runner(f, execute).start();
  assert.equal(f.run.tasks.producer.attempts, 1);
  assert.equal(finalChecks, 0);
  assert.equal(deriveStatus(f.run, f.run.tasks.consumer), 'blocked');
  fail = false;
  retryTask(f.run, 'producer');
  const resumed = runner(f, execute); await resumed.start();
  assert.equal(finalChecks, 1);
  assert.equal(resumed.result?.flow3?.passed, true);
});

test('touches conflicts serialize workers even with concurrency available', async () => {
  const f = fixture([node('a', [], { touches: ['shared.txt'] }), node('b', [], { touches: ['shared.txt'] })]);
  let active = 0, peak = 0;
  const r = runner(f, async (task, ctx, cmd) => {
    if (cmd === 'work') {
      active++; peak = Math.max(peak, active); await delay(15);
      writeFileSync(join(ctx.cwd!, `${task.id}.txt`), task.id); active--;
    }
    return ok;
  });
  await r.start(); assert.equal(peak, 1); assert.equal(r.result?.flow3?.passed, true);
});

test('verify failure repairs saved implementation with the actual error and no new implementation attempt', async () => {
  const f = fixture([node('a')]); let works = 0, verifies = 0;
  const r = runner(f, async (task, ctx, cmd) => {
    if (cmd === 'work') {
      works++;
      if (works === 2) {
        assert.match(task.spec, /missing exported API/);
        assert.equal(readFileSync(join(ctx.cwd!, 'a.txt'), 'utf8'), 'saved implementation');
      }
      writeFileSync(join(ctx.cwd!, 'a.txt'), works === 1 ? 'saved implementation' : 'repaired implementation');
    }
    if (cmd === 'verify-a' && ++verifies === 1) return { exitCode: 1, output: 'missing exported API' };
    return ok;
  });
  await r.start(); assert.equal(works, 2); assert.equal(f.run.tasks.a.status, 'completed');
  assert.equal(f.run.tasks.a.attempts, 1);
  assert.equal(f.run.tasks.a.nodeState?.repairAttempts, 1);
  assert.equal(r.result?.flow3?.passed, true);
});

test('a one-attempt node repairs real CRLF diff-check failure in place before integration', async () => {
  const f = fixture([node('a', [], { verify: 'format' })], { repairCommand: 'repair', nodeRepairRounds: 1 });
  f.run.tasks.a.maxAttempts = 1;
  assert.equal(git(f.repo, ['config', 'core.autocrlf', 'false']).code, 0);
  writeFileSync(join(f.repo, 'a.txt'), 'baseline\n');
  assert.equal(git(f.repo, ['add', 'a.txt']).code, 0);
  assert.equal(git(f.repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'tracked report']).code, 0);
  let works = 0, repairs = 0, failures = 0;
  const r = runner(f, async (task, ctx, cmd) => {
    if (cmd === 'work') { works++; writeFileSync(join(ctx.cwd!, 'a.txt'), 'completed implementation\r\n'); }
    if (cmd === 'repair') {
      repairs++; assert.match(task.spec, /trailing whitespace/);
      const saved = readFileSync(join(ctx.cwd!, 'a.txt'), 'utf8');
      assert.equal(saved, 'completed implementation\r\n');
      writeFileSync(join(ctx.cwd!, 'a.txt'), saved.replaceAll('\r\n', '\n'));
    }
    if (cmd === 'format') {
      const check = git(ctx.cwd!, ['-c', 'core.whitespace=blank-at-eol,blank-at-eof', 'diff', '--check', 'HEAD']);
      if (check.code) failures++;
      return { exitCode: check.code, output: check.stdout + check.stderr };
    }
    return ok;
  });
  await r.start();
  assert.equal(works, 1); assert.equal(repairs, 1); assert.equal(failures, 1);
  assert.equal(f.run.tasks.a.attempts, 1); assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
  assert.deepEqual(f.run.executionPolicy?.flow3Repair, { nodeRounds: 1, checkpointRounds: 0, timeoutMs: 300_000 });
  assert.equal(git(f.repo, ['show', `dag/${f.run.id}:a.txt`]).stdout, 'completed implementation');
});

test('repair cannot change acceptance assertions, check entrypoints or files outside its ownership', async () => {
  for (const forbidden of ['a.test.ts', 'unowned.txt', 'unusual.mjs', 'nested-runner.mjs']) {
    const f = fixture([node('a', [], { touches: ['a.txt', 'a.test.ts', 'unusual.mjs', 'nested-runner.mjs'] })], { repairCommand: 'repair', finalChecks: ['node unusual.mjs', 'pnpm test'] });
    let repairs = 0;
    const r = runner(f, async (_task, ctx, cmd) => {
      if (cmd === 'work') {
        writeFileSync(join(ctx.cwd!, 'a.txt'), 'saved');
        writeFileSync(join(ctx.cwd!, 'a.test.ts'), 'assert.equal(actual, expected);');
        writeFileSync(join(ctx.cwd!, 'unusual.mjs'), 'throw new Error("acceptance");');
        writeFileSync(join(ctx.cwd!, 'nested-runner.mjs'), 'throw new Error("nested acceptance");');
        writeFileSync(join(ctx.cwd!, 'package.json'), JSON.stringify({ scripts: { test: 'pnpm run inner', inner: 'node nested-runner.mjs' } }));
      }
      if (cmd === 'verify-a') return { exitCode: 1, output: 'AssertionError: actual behavior differs' };
      if (cmd === 'repair') { repairs++; writeFileSync(join(ctx.cwd!, forbidden), 'assert.ok(true);'); }
      return ok;
    });
    await r.start();
    assert.equal(repairs, 1); assert.equal(f.run.tasks.a.status, 'failed');
    assert.match(f.run.tasks.a.result!, /Repair policy violation/);
    assert.notEqual(git(f.repo, ['cat-file', '-e', `dag/${f.run.id}:a.txt`]).code, 0);
  }
});

test('repair has a separate bounded deadline and a timed-out repair cannot restart implementation', async () => {
  const f = fixture([node('a')], { repairCommand: 'repair', nodeRepairRounds: 2, phaseTimeouts: { repair: 20 } });
  let works = 0, kills = 0;
  const r = runner(f, async (_task, ctx, cmd) => {
    if (cmd === 'work') { works++; writeFileSync(join(ctx.cwd!, 'a.txt'), 'saved'); }
    if (cmd === 'verify-a') return { exitCode: 1, output: 'AssertionError: repair needed' };
    if (cmd === 'repair') return new Promise((_, reject) => ctx.registerKill(() => { kills++; reject(Error('killed')); }));
    return ok;
  });
  await r.start(); assert.equal(works, 1); assert.equal(kills, 1);
  assert.equal(f.run.tasks.a.status, 'failed'); assert.equal(f.run.tasks.a.failureKind, 'timeout');
  assert.equal(f.run.tasks.a.nodeState?.repairAttempts, 1);
});

test('disabling node repairs never spends checkpoint rounds to bypass the local budget', async () => {
  const f = fixture([node('a')], { repairCommand: 'repair', nodeRepairRounds: 0, repairRounds: 2 });
  let works = 0, repairs = 0;
  const r = runner(f, async (_task, ctx, cmd) => {
    if (cmd === 'work') { works++; writeFileSync(join(ctx.cwd!, 'a.txt'), 'saved'); }
    if (cmd === 'verify-a') return { exitCode: 1, output: 'AssertionError: genuine local failure' };
    if (cmd === 'repair') repairs++;
    return ok;
  });
  await r.start();
  assert.equal(works, 1); assert.equal(repairs, 0); assert.equal(f.run.flowState?.repairRound, 0);
  assert.equal(f.run.tasks.a.status, 'failed');
  assert.equal(f.run.tasks.a.nodeState?.decision?.action, 'hold');
  assert.match(f.run.tasks.a.nodeState!.decision!.reason, /budget exhausted: 0\/0/);
});

test('repeated local failure and no-change repair stop without redoing implementation', async () => {
  for (const changes of [true, false]) {
    const f = fixture([node('a')], { repairCommand: 'repair', nodeRepairRounds: 2, repairRounds: 2 });
    let works = 0, repairs = 0;
    const r = runner(f, async (_task, ctx, cmd) => {
      if (cmd === 'work') { works++; writeFileSync(join(ctx.cwd!, 'a.txt'), 'saved'); }
      if (cmd === 'verify-a') return { exitCode: 1, output: 'AssertionError: unchanged failure' };
      if (cmd === 'repair') { repairs++; if (changes) writeFileSync(join(ctx.cwd!, 'a.txt'), 'still broken'); }
      return ok;
    });
    await r.start();
    assert.equal(works, 1); assert.equal(repairs, 1); assert.equal(f.run.tasks.a.status, 'failed');
    assert.equal(f.run.flowState?.repairRound, 0);
    assert.equal(f.run.tasks.a.nodeState?.decision?.action, 'hold');
  }
});

test('checkpoint prerequisites defer premature acceptance without executing it or spending repairs', async () => {
  const f = fixture([node('a'), node('producer', ['a'], { touches: ['artifact.ts'], creates: ['artifact.ts'] }), node('side', ['a'])], {
    waveChecks: ['composed'], checkPrerequisites: { composed: ['producer'] }, repairCommand: 'repair', repairRounds: 2,
  });
  let checks = 0, repairs = 0;
  const r = runner(f, async (task, ctx, cmd) => {
    if (cmd === 'work') writeFileSync(join(ctx.cwd!, task.id === 'producer' ? 'artifact.ts' : `${task.id}.txt`), 'ready');
    if (cmd === 'composed') {
      checks++; assert.equal(f.run.tasks.producer.status, 'completed');
      assert.equal(readFileSync(join(ctx.cwd!, 'artifact.ts'), 'utf8'), 'ready');
    }
    if (cmd === 'repair') repairs++;
    return ok;
  });
  await r.start();
  assert.ok(checks >= 2); assert.equal(repairs, 0); assert.equal(f.run.flowState?.repairRound, 0);
  assert.ok(f.run.flowState?.checkpoints.some(c => !c.passed && c.results.some(r => r.decision?.action === 'defer')));
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
});

test('missing artifact from a unique future producer defers a wave error and gets checked after production', async () => {
  const f = fixture([node('a'), node('producer', ['a'], { touches: ['artifact.ts'], creates: ['artifact.ts'] }), node('side', ['a'])], { repairCommand: 'repair', repairRounds: 2 });
  let premature = 0, repairs = 0;
  const r = runner(f, async (task, ctx, cmd) => {
    if (cmd === 'work') writeFileSync(join(ctx.cwd!, task.id === 'producer' ? 'artifact.ts' : `${task.id}.txt`), 'ready');
    if (cmd === 'wave' && !existsSync(join(ctx.cwd!, 'artifact.ts'))) { premature++; return { exitCode: 1, output: 'ENOENT: open artifact.ts' }; }
    if (cmd === 'repair') repairs++;
    return ok;
  });
  await r.start();
  assert.equal(premature, 1); assert.equal(repairs, 0);
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
});

test('quota or unknown checkpoint failure never launches a coding repair', async () => {
  for (const output of ['HTTP 429 usage limit reached', 'unexpected external service condition']) {
    const f = fixture([node('a')], { repairCommand: 'repair', repairRounds: 2 });
    let repairs = 0;
    const r = runner(f, async (_task, ctx, cmd) => {
      if (cmd === 'work') writeFileSync(join(ctx.cwd!, 'a.txt'), 'ready');
      if (cmd === 'full') return { exitCode: 1, output };
      if (cmd === 'repair') repairs++;
      return ok;
    });
    await r.start(); assert.equal(repairs, 0); assert.equal(f.run.flowState?.repairRound, 0);
    assert.equal(r.result?.flow3?.passed, false);
  }
});

test('setup and work have separate clocks, and idle watchdog accepts heartbeats', async () => {
  const f = fixture([node('a')], { phaseTimeouts: { setup: 200, work: 200 }, idleTimeoutMs: 45 });
  f.run.settings.worktreePrepareCmd = 'setup';
  const r = runner(f, async (task, ctx, cmd) => {
    if (cmd === 'setup' || cmd === 'work') for (let i = 0; i < 5; i++) {
      await delay(25);
      if (cmd === 'work') recordHeartbeat(f.file, task.id); else ctx.onOutput('warm\n');
    }
    if (cmd === 'work') writeFileSync(join(ctx.cwd!, 'a.txt'), 'a');
    return ok;
  });
  await r.start(); assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
  assert.equal(f.run.tasks.a.attempts, 1);
});

test('hung work is killed and held for infrastructure diagnosis without a coding retry', async () => {
  const f = fixture([node('a')], { phaseTimeouts: { work: 20 }, idleTimeoutMs: 1000 });
  let kills = 0;
  const r = runner(f, async (_task, ctx, cmd) => {
    if (cmd !== 'work') return ok;
    return new Promise((_, reject) => ctx.registerKill(() => { kills++; reject(Error('killed')); }));
  });
  await r.start(); assert.equal(kills, 1); assert.equal(f.run.tasks.a.attempts, 1);
  assert.equal(f.run.tasks.a.failureKind, 'timeout');
});

test('one advisory call can fail without gating worker dispatch or acceptance', async () => {
  const f = fixture([node('a')], { advisoryCommand: 'advisory', phaseTimeouts: { advisory: 1000 } });
  let workStarted = false, advisoryCalls = 0;
  const r = runner(f, async (_task, ctx, cmd) => {
    if (cmd === 'advisory') {
      advisoryCalls++;
      await delay(15);
      assert.equal(workStarted, true);
      return { exitCode: 1, output: 'oversized-node advice' };
    }
    if (cmd === 'work') { workStarted = true; writeFileSync(join(ctx.cwd!, 'a.txt'), 'a'); }
    return ok;
  });
  await r.start(); assert.equal(advisoryCalls, 1); assert.equal(r.result?.flow3?.passed, true);
  assert.equal(f.run.flowState?.advisory?.status, 'warning');
});

test('a checkpoint failure creates a targeted fix node and reruns the real check', async () => {
  const f = fixture([node('a')], { repairCommand: 'repair', repairRounds: 2 });
  let repaired = false, workCalls = 0;
  const r = runner(f, async (task, ctx, cmd) => {
    if (cmd === 'work') { workCalls++; writeFileSync(join(ctx.cwd!, 'a.txt'), 'a'); }
    if (cmd === 'wave' && !repaired) return { exitCode: 1, output: 'a.txt:3 type mismatch' };
    if (cmd === 'repair') {
      assert.match(task.spec, /a.txt:3 type mismatch/);
      repaired = true; writeFileSync(join(ctx.cwd!, 'a.txt'), 'fixed');
    }
    return ok;
  });
  await r.start();
  assert.equal(workCalls, 1); assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
  assert.equal(f.run.flowState?.repairRound, 1);
  assert.equal(Object.values(f.run.tasks).filter(t => t.cmd === 'repair').length, 1);
});

test('unchanged integration failure stops after one repair even when two rounds are available', async () => {
  const f = fixture([node('a')], { repairCommand: 'repair', repairRounds: 2 });
  const r = runner(f, async (_task, ctx, cmd) => {
    if (cmd === 'work') writeFileSync(join(ctx.cwd!, 'a.txt'), 'a');
    if (cmd === 'repair') writeFileSync(join(ctx.cwd!, 'a.txt'), 'attempted fix');
    if (cmd === 'full') return { exitCode: 1, output: 'integration assertion remains broken' };
    return ok;
  });
  await r.start();
  assert.equal(f.run.flowState?.repairRound, 1);
  assert.equal(r.result?.flow3?.passed, false);
  assert.ok(r.result?.flow3?.issues.some(issue => /assertion remains broken/.test(issue)));
});

test('distinct checkpoint failures still obey the shared two-round repair budget', async () => {
  const f = fixture([node('a')], { repairCommand: 'repair', repairRounds: 2 });
  let repairs = 0, works = 0;
  const r = runner(f, async (_task, ctx, cmd) => {
    if (cmd === 'work') { works++; writeFileSync(join(ctx.cwd!, 'a.txt'), 'a'); }
    if (cmd === 'repair') { repairs++; writeFileSync(join(ctx.cwd!, 'a.txt'), `repair-${repairs}`); }
    if (cmd === 'full') return { exitCode: 1, output: `AssertionError: remaining case ${repairs}` };
    return ok;
  });
  await r.start(); assert.equal(works, 1); assert.equal(repairs, 2);
  assert.equal(f.run.flowState?.repairRound, 2); assert.equal(r.result?.flow3?.passed, false);
});

test('checkpoint repair scope enforcement survives an explicit retry and storage round trip', async () => {
  const f = fixture([node('a')], { repairCommand: 'repair', repairRounds: 2 });
  let repairs = 0;
  const execute: Executor = async (_task, ctx, cmd) => {
    if (cmd === 'work') writeFileSync(join(ctx.cwd!, 'a.txt'), 'ready');
    if (cmd === 'full') return { exitCode: 1, output: 'AssertionError: real integration defect' };
    if (cmd === 'repair') { repairs++; writeFileSync(join(ctx.cwd!, 'unowned.txt'), 'outside repair scope'); }
    return ok;
  };
  await runner(f, execute).start();
  const fix = Object.values(f.run.tasks).find(t => t.node?.repair_of)!;
  assert.ok(fix); assert.equal(fix.status, 'failed');
  retryTask(f.run, fix.id); saveRun(f.run, f.file);
  const restored = loadRun(f.file);
  assert.equal(restored.tasks[fix.id].nodeState, undefined);
  assert.ok(restored.tasks[fix.id].node?.repair_of);
  const resumed = new DagRunner(restored, { cwd: f.repo, file: f.file, executor: execute, persist: r => saveRun(r, f.file) });
  await resumed.start();
  assert.equal(repairs, 2); assert.equal(restored.tasks[fix.id].status, 'failed');
  assert.match(restored.tasks[fix.id].result!, /outside allowed scope/);
  assert.notEqual(git(f.repo, ['cat-file', '-e', `dag/${f.run.id}:unowned.txt`]).code, 0);
});

test('merge conflicts resolve marker blocks without rerunning a verified task', async () => {
  const f = fixture([node('a'), node('b')], { conflictCommand: 'resolve' });
  const works = new Map<string, number>(); let resolves = 0;
  const r = runner(f, async (task, ctx, cmd) => {
    if (cmd === 'work') {
      works.set(task.id, (works.get(task.id) ?? 0) + 1);
      writeFileSync(join(ctx.cwd!, 'tracked.txt'), `${task.id}\n`);
      await delay(15);
    }
    if (cmd === 'resolve') { resolves++; writeFileSync(join(ctx.cwd!, 'tracked.txt'), 'resolved\n'); }
    return ok;
  });
  await r.start();
  assert.equal(resolves, 1); assert.equal(works.get('a'), 1); assert.equal(works.get('b'), 1);
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
  assert.equal(git(f.repo, ['show', `dag/${f.run.id}:tracked.txt`]).stdout, 'resolved');
});

test('resolver cannot edit unrelated files; a later retry lands saved source with no implementation redo', async () => {
  const f = fixture([node('a'), node('b')], { conflictCommand: 'resolve' });
  let legal = false, works = 0;
  const execute: Executor = async (task, ctx, cmd) => {
    if (cmd === 'work') { works++; writeFileSync(join(ctx.cwd!, 'tracked.txt'), `${task.id}\n`); await delay(15); }
    if (cmd === 'resolve') {
      writeFileSync(join(ctx.cwd!, 'tracked.txt'), 'resolved\n');
      if (!legal) writeFileSync(join(ctx.cwd!, 'unrelated.txt'), 'bad');
    }
    return ok;
  };
  const first = runner(f, execute); await first.start();
  const bad = Object.values(f.run.tasks).find(t => t.status === 'failed')!;
  assert.ok(bad); assert.equal(bad.failureKind, 'merge'); assert.ok(bad.nodeState?.candidate);
  legal = true;
  // Resolver-created untracked files must not leak into the next merge attempt.
  retryTask(f.run, bad.id);
  const second = runner(f, execute); await second.start();
  assert.equal(works, 2); assert.equal(second.result?.flow3?.passed, true, JSON.stringify(second.result));
  assert.notEqual(git(f.repo, ['cat-file', '-e', `dag/${f.run.id}:unrelated.txt`]).code, 0);
});

test('CLI compiles version 3 and executes a real command plus verification on integration', async () => {
  const repo = gitRepo(), file = join(repo, 'run.json'), plan = join(repo, 'flow.json');
  const q = (s: string) => `"${s.replaceAll('\\', '\\\\')}"`;
  const cmd = `${q(process.execPath)} -e "require('fs').writeFileSync('result.txt','ready')"`;
  const verify = `${q(process.execPath)} -e "if(require('fs').readFileSync('result.txt','utf8')!=='ready')process.exit(1)"`;
  const check = `${q(process.execPath)} -e "process.exit(0)"`;
  writeFileSync(plan, JSON.stringify({ version: 3, title: 'CLI', nodes: [node('output', [], { cmd, verify, touches: ['result.txt'] })], settings: { waveChecks: [check], finalChecks: [check] } }));
  const original = console.log; console.log = () => {};
  const exit = process.exitCode;
  try {
    process.exitCode = 0;
    await planningCmd(['compile', '--plan', plan, '--file', file]);
    await runCmd(['--file', file, '--json']);
    assert.equal(process.exitCode, 0);
  } finally { console.log = original; process.exitCode = exit; }
  const run = loadRun(file);
  assert.equal(run.tasks.output.status, 'completed');
  assert.equal(git(repo, ['show', `dag/${run.id}:result.txt`]).stdout, 'ready');
});

test('Codex chain continuation keeps explicit session and model options on stdin', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const first = codexSessionArgs('codex', ['exec', '--sandbox', 'workspace-write', '-m', 'model', 'do node a'], {});
  assert.ok(first.includes('--json'));
  const next = codexSessionArgs('codex', ['exec', '--sandbox', 'workspace-write', '-m', 'model', 'do node b'], { id });
  const stdin = codexStdin('codex', next)!;
  assert.deepEqual(stdin.args.slice(-3), ['resume', id, '-']); assert.equal(stdin.prompt, 'do node b');
  assert.ok(stdin.args.includes('workspace-write')); assert.ok(stdin.args.includes('model'));
});

test('worker caches stay warm across chain nodes, without committing the dependency link', async () => {
  const f = fixture([node('a'), node('b', ['a'])]);
  writeFileSync(join(f.repo, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(f.repo, 'node_modules'));
  writeFileSync(join(f.repo, 'node_modules', 'warm.txt'), 'shared dependency');
  const r = runner(f, async (task, ctx, cmd) => {
    if (cmd === 'work') {
      assert.equal(readFileSync(join(ctx.cwd!, 'node_modules', 'warm.txt'), 'utf8'), 'shared dependency');
      writeFileSync(join(ctx.cwd!, `${task.id}.txt`), task.id);
    }
    return ok;
  });
  await r.start();
  assert.equal(r.result?.flow3?.passed, true, `${JSON.stringify(r.result)}: ${f.run.tasks.a.result}`);
  assert.notEqual(git(f.repo, ['cat-file', '-e', `dag/${f.run.id}:node_modules`]).code, 0);
  assert.equal(readFileSync(join(f.repo, 'node_modules', 'warm.txt'), 'utf8'), 'shared dependency');
});

test('missing checkpoint configuration reports incomplete acceptance after implementation', async () => {
  const f = fixture([node('a')], { waveChecks: [], finalChecks: [], repairCommand: 'repair', repairRounds: 2 });
  let repairs = 0;
  const r = runner(f, async (task, ctx, cmd) => {
    if (cmd === 'work') writeFileSync(join(ctx.cwd!, `${task.id}.txt`), task.id);
    if (cmd === 'repair') repairs++;
    return ok;
  });
  await r.start();
  assert.equal(f.run.tasks.a.status, 'completed');
  assert.equal(r.result?.flow3?.passed, false);
  assert.equal(repairs, 0);
  assert.ok(r.result?.flow3?.issues.some(issue => /Configure.*commands|Configure full/.test(issue)));
});

test('supported harnesses resume only explicit worker sessions and do not cross harnesses', () => {
  const session: WorkerSession = {};
  const first = agentSessionArgs('opencode', ['run', '--auto', 'node a'], session);
  assert.ok(first.includes('--format')); assert.equal(first.includes('--session'), false);
  captureSessionEvent('opencode', session, { sessionID: 'ses_abc123' });
  const second = agentSessionArgs('opencode', ['run', '--auto', 'node b'], session);
  assert.equal(second[second.indexOf('--session') + 1], 'ses_abc123');
  const claude = agentSessionArgs('claude', ['-p', 'node c'], session);
  assert.equal(claude[0], '--session-id'); assert.notEqual(session.id, 'ses_abc123');
  const next = agentSessionArgs('claude', ['-p', 'node d'], session);
  assert.equal(next[0], '--resume'); assert.equal(next[1], session.id);
});

test('a second runner cannot mutate a live run, and the original runner can resume after settling', async () => {
  const f = fixture([node('a')]);
  let release: () => void = () => {}, begin: () => void = () => {}, works = 0;
  const workGate = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { begin = r; });
  const execute: Executor = async (task, ctx, cmd) => {
    if (cmd === 'work') { works++; begin(); await workGate; writeFileSync(join(ctx.cwd!, `${task.id}.txt`), task.id); }
    return ok;
  };
  const first = runner(f, execute), running = first.start();
  await started;
  try {
    const before = JSON.stringify(f.run.flowState);
    const second = new DagRunner(f.run, { file: f.file, cwd: f.repo, executor: execute });
    await second.start();
    assert.equal(second.result?.flow3?.passed, false);
    assert.ok(second.result?.flow3?.issues.some(issue => /locked/i.test(issue)));
    assert.equal(JSON.stringify(f.run.flowState), before);
  } finally { release(); await running; }
  assert.equal(first.result?.flow3?.passed, true);
  await first.start();
  assert.equal(first.result?.flow3?.passed, true); assert.equal(works, 1);
});
