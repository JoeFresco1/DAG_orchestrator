import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DagRunner, type Executor, type RunnerOptions } from '../runner.js';
import { gitRepo } from '../test-helpers.js';
import { loadRun, saveRun } from '../store.js';
import { compileFlowPlan } from './graph.js';
import { flowProgress } from './progress.js';
import { quotaSignal } from './quota.js';

const ok = { exitCode: 0, output: 'ok' }, quota = { exitCode: 1, output: "ERROR: You've hit your usage limit" };
const fresh = async () => ({ remainingPercent: 80, observedAt: Date.now() });
function fixture(ids = ['a']) {
  const cwd = gitRepo(), file = join(cwd, 'dag.run.json');
  const { run } = compileFlowPlan({ version: 3, title: 'quota', settings: { waveChecks: ['wave'], finalChecks: ['final'] }, nodes: ids.map(id => ({ id, goal: 'write message', depends_on: [], touches: [id + '.txt'], creates: [], relies_on: [], cmd: 'work', verify: 'check' })) });
  return { cwd, file, run };
}
function runner(f: ReturnType<typeof fixture>, executor: Executor, opts: Partial<RunnerOptions> = {}) {
  return new DagRunner(f.run, { cwd: f.cwd, file: f.file, executor, persist: r => saveRun(r, f.file), ...opts });
}
test('healthy plan uses identical commands without quota telemetry; generic failures never probe', async () => {
  assert.equal(quotaSignal('HTTP 429 too many requests'), false);
  for (const mode of ['absent', 'unused', 'failed']) {
    const f = fixture(), cmds: string[] = []; let probes = 0;
    const r = runner(f, async (t, c, cmd) => {
      cmds.push(cmd!);
      if (cmd === 'work') { writeFileSync(join(c.cwd!, 'a.txt'), t.id); if (mode === 'failed') return { exitCode: 1, output: 'Authentication failed' }; }
      return ok;
    }, mode === 'absent' ? {} : { quotaProbe: () => { probes++; throw Error('unexpected quota request') } });
    await r.start();
    assert.equal(r.result?.flow3?.passed, mode !== 'failed');
    assert.equal(probes, 0);
    assert.deepEqual(cmds, mode === 'failed' ? ['work'] : ['work', 'check', 'wave', 'wave', 'final', 'check']);
    assert.equal(f.run.tasks.a.attempts, 1);
  }
});
test('saved implementation resumes once with prior edits and allowance; no second implementation attempt', async () => {
  const f = fixture(); let n = 0, reads = 0;
  const r = runner(f, async (t, c, cmd) => {
    const p = join(c.cwd!, 'a.txt');
    if (cmd === 'work' && n++ === 0) { writeFileSync(p, 'partial'); return quota; }
    if (cmd === 'work') { assert.equal(t.attempts, 1); assert.equal(readFileSync(p, 'utf8'), 'partial'); writeFileSync(p, 'finished'); }
    return ok;
  }, { quotaProbe: async () => { reads++; return fresh(); } });
  await r.start(); assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
  assert.equal(n, 2); assert.equal(reads, 1); assert.equal(f.run.tasks.a.attempts, 1);
  assert.equal(f.run.flowState?.quotaWait, undefined);
});
test('explicit stop during wait survives reload; later explicit start restores source', async () => {
  const f = fixture(); let entered!: () => void; const waiting = new Promise<void>(r => entered = r);
  const r = runner(f, async (_, c, cmd) => { if (cmd === 'work') { writeFileSync(join(c.cwd!, 'a.txt'), 'saved'); return quota; } return ok; }, {
    quotaProbe: async () => { entered(); return { remainingPercent: 0, observedAt: Date.now(), resetAt: Date.now() + 300000 }; }
  });
  const active = r.start(); await waiting; await r.stop(); await active;
  f.run = loadRun(f.file);
  assert.equal(f.run.flowState?.userStopped, true);
  assert.equal(flowProgress(f.run, false)?.activity, 'stopped');
  const resumed = runner(f, async (_, c, cmd) => { if (cmd === 'work') assert.equal(readFileSync(join(c.cwd!, 'a.txt'), 'utf8'), 'saved'); return ok; }, { quotaProbe: fresh });
  await resumed.start(); assert.equal(resumed.result?.flow3?.passed, true);
  assert.equal(f.run.tasks.a.attempts, 1);
});


test('one quota pause drains concurrent nodes, preserves repair edits and lands verified peers once', async () => {
  const f = fixture(['a', 'b', 'c']);
  f.run.settings.flow3!.repairCommand = 'repair';
  const calls: Record<string, number> = {};
  const r = runner(f, async (t, c, cmd) => {
    const p = join(c.cwd!, t.id + '.txt');
    if (cmd === 'work') {
      const n = calls[t.id] = (calls[t.id] ?? 0) + 1;
      if (n === 1) writeFileSync(p, t.id === 'b' ? 'broken' : 'saved');
      if (t.id === 'a' && n === 1) return quota;
      if (t.id === 'a') assert.equal(readFileSync(p, 'utf8'), 'saved');
    }
    if (t.id === 'b' && cmd === 'check' && readFileSync(p, 'utf8') === 'broken') return { exitCode: 1, output: 'error TS1234: b.txt type mismatch' };
    if (cmd === 'repair') { calls.repair = (calls.repair ?? 0) + 1; writeFileSync(p, 'fixed'); return quota; }
    return ok;
  }, { concurrency: 3, quotaProbe: fresh });
  await r.start();
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
  assert.deepEqual(calls, { a: 2, b: 1, c: 1, repair: 1 });
  assert.equal(f.run.flowState?.nodeRepairs?.b.used, 1);
  for (const t of Object.values(f.run.tasks)) assert.equal(t.attempts, 1);
});

test('resuming an unattended quota wait excludes it from an expired deadline exactly once', async () => {
  const f = fixture(), since = Date.now() - 120000, oldDeadline = since + 90000;
  f.run.flowState = {
    version: 3, repairRound: 0, checkpoints: [], issues: [], deadlineAt: oldDeadline,
    quotaWait: { provider: 'adapter', since, reason: 'confirmed quota pause' }
  };
  const r = runner(f, async (t, c, cmd) => { if (cmd === 'work') writeFileSync(join(c.cwd!, 'a.txt'), t.id); return ok; }, { quotaProbe: fresh });
  await r.start();
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
  const deadline = f.run.flowState.deadlineAt!;
  assert.ok(deadline >= oldDeadline + 120000);
  const resumed = runner(f, async () => ok); await resumed.start();
  assert.equal(f.run.flowState.deadlineAt, deadline);
});

test('process death between quota capture and pinning resumes from the recorded worktree', async () => {
  const f = fixture();
  saveRun(f.run, f.file);
  const store = new URL('../store.js', import.meta.url).href;
  const runnerModule = new URL('../runner.js', import.meta.url).href;
  const source = `
    import { DagRunner } from ${JSON.stringify(runnerModule)};
    import { loadRun, saveRun } from ${JSON.stringify(store)};
    import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
    const [file,cwd]=process.argv.slice(1),run=loadRun(file);
    await new DagRunner(run,{file,cwd,quotaProbe:async()=>({remainingPercent:80,observedAt:Date.now()}),
      persist:r=>{saveRun(r,file);if(r.tasks.a.nodeState?.quotaCapture)process.exit(71);},
      executor:async(t,c,cmd)=>{if(cmd==='work'){writeFileSync(join(c.cwd,'a.txt'),'before crash');return {exitCode:1,output:'Quota exhausted'};}
        return {exitCode:0,output:'ok'};}
    }).start();
  `;
  const died = spawnSync(process.execPath, ['--input-type=module', '-e', source, f.file, f.cwd], { encoding: 'utf8', timeout: 90000, windowsHide: true });
  assert.equal(died.status, 71, died.stderr);
  f.run = loadRun(f.file);
  assert.ok(f.run.tasks.a.nodeState?.quotaCapture);
  const resumed = runner(f, async (_, c, cmd) => { if (cmd === 'work') assert.equal(readFileSync(join(c.cwd!, 'a.txt'), 'utf8'), 'before crash'); return ok; }, { quotaProbe: fresh });
  await resumed.start();
  assert.equal(resumed.result?.flow3?.passed, true, JSON.stringify(resumed.result));
  assert.equal(f.run.tasks.a.attempts, 1);
});

test('quota without a supported probe holds with one explicit next action', async () => {
  const f = fixture(), r = runner(f, async (_, c, cmd) => {
    if (cmd === 'work') { writeFileSync(join(c.cwd!, 'a.txt'), 'partial'); return quota; }
    return ok;
  });
  await r.start();
  assert.equal(f.run.flowState?.quotaWait?.manual, true);
  assert.equal(flowProgress(f.run, false)?.operatorActionRequired, true);
  assert.ok(f.run.tasks.a.nodeState?.quotaWork);
  assert.equal(f.run.tasks.a.attempts, 1);
});

test('configured reserve waits before charging an attempt; fresh capacity releases dispatch', async () => {
  const f = fixture();
  f.run.settings.flow3!.quotaReservePercent = 5;
  let reads = 0;
  const r = runner(f, async (t, c, cmd) => {
    if (cmd === 'work') writeFileSync(join(c.cwd!, 'a.txt'), t.id);
    return ok;
  }, { quotaProbe: async () => {
    if (++reads <= 2) assert.equal(f.run.tasks.a.attempts, 0);
    return { remainingPercent: reads === 1 ? 5 : 6, observedAt: Date.now() };
  } });
  await r.start();
  assert.equal(r.result?.flow3?.passed, true);
  assert.equal(f.run.tasks.a.attempts, 1);
  assert.ok(reads >= 2);
});

test('status explains a deferred producer without mutating state or treating it as a failure', () => {
  const f = fixture();
  f.run.flowState = { version: 3, repairRound: 0, issues: [], checkpoints: [{
    id: 'wave-1', kind: 'wave', head: 'head', nodes: [], passed: false,
    results: [{ command: 'compose', passed: false, output: '', outcome: 'deferred',
      decision: { action: 'defer', category: 'dependency', reason: 'needs a', fingerprint: 'f', requires: ['a'] } }]
  }] };
  const before = JSON.stringify(f.run);
  const status = flowProgress(f.run, true);
  assert.equal(status?.activity, 'deferred');
  assert.match(status!.message, /compose awaits a/);
  assert.equal(status?.operatorActionRequired, false);
  assert.equal(JSON.stringify(f.run), before);
});
