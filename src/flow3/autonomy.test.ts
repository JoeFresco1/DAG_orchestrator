import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DagRunner, type Executor } from '../runner.js';
import { gitRepo } from '../test-helpers.js';
import { git } from '../git-worktree.js';
import { loadRun, saveRun } from '../store.js';
import { compileFlowPlan } from './graph.js';
import type { FlowNode, FlowSettings } from './contracts.js';

const ok = { exitCode: 0, output: 'ok' };
const node = (id: string, depends_on: string[] = [], extra: Partial<FlowNode> = {}): FlowNode => ({
  id, goal: `Implement ${id}`, depends_on, touches: [`${id}.txt`], creates: [], relies_on: [], cmd: 'work', verify: `check-${id}`, ...extra,
});
function fixture(nodes: FlowNode[], settings: FlowSettings = {}) {
  const cwd = gitRepo(), file = join(cwd, 'dag.run.json');
  const { run } = compileFlowPlan({ version: 3, title: 'autonomy', nodes, settings: { waveChecks: ['wave'], finalChecks: ['final'], repairRounds: 0, ...settings } });
  return { cwd, file, run };
}
function runner(f: ReturnType<typeof fixture>, executor: Executor) {
  return new DagRunner(f.run, { cwd: f.cwd, file: f.file, executor, persist: r => saveRun(r, f.file) });
}

test('transient worker transport failure uses only an authorized alternate and retains edits and charges', async () => {
  const f = fixture([node('a'), node('independent')]);
  f.run.tasks.a.harnessChain = [{ harness: 'opencode' }, { harness: 'codex' }];
  const harnesses: (string | null)[] = [];
  let peer = 0;
  const r = runner(f, async (t, c) => {
    if (c.env?.DAG_PHASE === 'work') {
      if (t.id === 'a') {
        harnesses.push(t.harness);
        if (harnesses.length === 1) { writeFileSync(join(c.cwd!, 'a.txt'), 'partial'); return { exitCode: 1, output: 'HTTP 429 too many requests' }; }
        assert.equal(readFileSync(join(c.cwd!, 'a.txt'), 'utf8'), 'partial');
        // The next dispatch and its spent attempt are already durable.
        assert.equal(loadRun(f.file).tasks.a.attempts, 2);
      } else peer++;
      writeFileSync(join(c.cwd!, `${t.id}.txt`), 'done');
    }
    return ok;
  });
  await r.start();
  assert.deepEqual(harnesses, ['opencode', 'codex']); assert.equal(peer, 1);
  assert.equal(f.run.flowState?.repairRound, 0); assert.equal(f.run.flowState?.nodeRepairs?.a, undefined);
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
});

test('unchanged provider failures exhaust existing attempts; auth and capacity failures never fall back', async () => {
  for (const output of ['HTTP 503 provider temporarily unavailable', 'HTTP 401 authentication failed', 'maximum context length exceeded']) {
    const f = fixture([node('a'), node('peer')]);
    f.run.tasks.a.harnessChain = [{ harness: 'opencode' }, { harness: 'codex' }];
    let calls = 0;
    const execute: Executor = async (t, c) => {
      if (c.env?.DAG_PHASE === 'work') {
        writeFileSync(join(c.cwd!, `${t.id}.txt`), 'saved');
        if (t.id === 'a') { calls++; return { exitCode: 1, output }; }
      }
      return ok;
    };
    await runner(f, execute).start();
    f.run = loadRun(f.file); await runner(f, execute).start();
    assert.equal(calls, output.startsWith('HTTP 503') ? 2 : 1);
    assert.equal(f.run.tasks.peer.status, 'completed');
    assert.equal(f.run.tasks.a.status, 'failed');
    assert.equal(git(f.cwd, ['show', `${f.run.tasks.a.branch}:a.txt`]).stdout, 'saved');
    assert.equal(f.run.flowState?.productComplete, false);
    if (output.includes('context')) assert.match(f.run.tasks.a.nodeState!.decision!.reason, /decomposition/);
  }
});

test('ordinary scheduling reopens declared acceptance producers before a final failure', async () => {
  const f = fixture([node('a'), node('producer', ['a']), node('peer', ['a'])], {
    waveChecks: ['composed'], checkPrerequisites: { composed: ['producer'] },
  });
  const works: string[] = [];
  const r = runner(f, async (t, c, cmd) => {
    if (cmd === 'work') { works.push(t.id); writeFileSync(join(c.cwd!, `${t.id}.txt`), 'done'); }
    if (cmd === 'composed') assert.equal(f.run.tasks.producer.status, 'completed');
    return ok;
  });
  await r.start(new Set(['a', 'peer']));
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
  assert.ok(works.includes('producer'));
  assert.ok(f.run.flowState?.completion?.required.includes('producer'));
  const deferred = f.run.flowState!.checkpoints.flatMap(c => c.results).filter(r => r.outcome === 'deferred');
  assert.ok(deferred.length); assert.ok(deferred.every(r => !r.passed));
  assert.ok(f.run.flowState!.checkpoints.filter(c => c.kind === 'final').every(c => c.passed));
  assert.equal(f.run.flowState?.productComplete, false); // explicit selection remains scoped
});

test('local missing producer adds an acyclic edge, retains edits, and revisits without a coding repair', async () => {
  const f = fixture([node('consumer'), node('producer', [], { creates: ['producer.txt'] }), node('peer')]);
  let consumer = 0;
  const r = runner(f, async (t, c, cmd) => {
    if (cmd === 'work') {
      if (t.id === 'consumer') {
        if (++consumer > 1) {
          assert.equal(readFileSync(join(c.cwd!, 'consumer.txt'), 'utf8'), 'partial');
          assert.equal(readFileSync(join(c.cwd!, 'producer.txt'), 'utf8'), 'done');
        }
        writeFileSync(join(c.cwd!, 'consumer.txt'), consumer === 1 ? 'partial' : 'done');
      } else writeFileSync(join(c.cwd!, `${t.id}.txt`), 'done');
    }
    if (cmd === 'check-consumer' && consumer === 1) return { exitCode: 1, output: "ENOENT: missing file 'producer.txt'" };
    return ok;
  });
  await r.start(new Set(['consumer', 'peer']));
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
  assert.equal(consumer, 2); assert.deepEqual(f.run.tasks.consumer.deps, ['producer']);
  assert.equal(f.run.tasks.consumer.nodeState?.repairAttempts, 0);
  assert.equal(f.run.tasks.consumer.nodeState?.dependencyWork, undefined);
  assert.ok(f.run.tasks.consumer.nodeState?.latestFailedChecks?.every(c => !c.passed));
});

test('missing prerequisite correction cannot introduce a cycle', async () => {
  const f = fixture([node('consumer'), node('producer', ['consumer'], { creates: ['producer.txt'] }), node('peer')]);
  const r = runner(f, async (t, c, cmd) => {
    if (cmd === 'work') writeFileSync(join(c.cwd!, `${t.id}.txt`), 'partial');
    if (cmd === 'check-consumer') return { exitCode: 1, output: "ENOENT: missing file 'producer.txt'" };
    return ok;
  });
  await r.start();
  assert.equal(f.run.tasks.consumer.status, 'failed');
  assert.deepEqual(f.run.tasks.consumer.deps, []);
  assert.match(f.run.tasks.consumer.nodeState!.decision!.reason, /cycle/);
  assert.equal(f.run.tasks.peer.status, 'completed'); assert.equal(f.run.tasks.producer.attempts, 0);
  assert.equal(r.result?.flow3?.passed, false);
});

test('promoting a failed producer never grants it another attempt or redispatches a blocked consumer', async () => {
  const f = fixture([node('consumer'), node('producer', [], { creates: ['producer.txt'] }), node('peer')]);
  Object.assign(f.run.tasks.producer, { status: 'failed', attempts: 1, attemptsInCycle: 1, maxAttempts: 1, result: 'previous failure' });
  let consumer = 0;
  const execute: Executor = async (t, c, cmd) => {
    if (cmd === 'work') { assert.notEqual(t.id, 'producer'); if (t.id === 'consumer') consumer++; writeFileSync(join(c.cwd!, `${t.id}.txt`), 'partial'); }
    if (cmd === 'check-consumer') return { exitCode: 1, output: "ENOENT: missing file 'producer.txt'" };
    return ok;
  };
  await runner(f, execute).start(new Set(['consumer', 'peer']));
  f.run = loadRun(f.file); await runner(f, execute).start();
  assert.equal(consumer, 1); assert.equal(f.run.tasks.producer.attempts, 1);
  assert.equal(f.run.tasks.producer.status, 'failed'); assert.equal(f.run.tasks.consumer.status, 'pending');
  assert.equal(f.run.tasks.peer.status, 'completed'); assert.equal(f.run.flowState?.productComplete, false);
});

test('unchanged readiness behind a failed chain does not spin the execution loop', async () => {
  const f = fixture([node('a'), node('b', ['a']), node('c', ['b'])]);
  f.run.tasks.a.status = 'failed'; f.run.tasks.b.status = 'completed';
  f.run.settings.maxWallClockMs = 10000;
  let calls = 0;
  const r = runner(f, async () => { calls++; return ok; });
  await r.start();
  assert.equal(calls, 0); assert.equal(r.result?.budgetReached, false);
  assert.equal(r.result?.flow3?.passed, false);
});

test('admission-added dependency closure joins a scoped run before dispatch', async () => {
  const f = fixture([node('consumer', [], { relies_on: ['producer.txt'] }), node('producer', ['root'], { creates: ['producer.txt'] }), node('root')]);
  // Simulate an older saved definition whose inferred edge has not been persisted.
  f.run.tasks.consumer.deps = [];
  const works: string[] = [];
  const r = runner(f, async (t, c, cmd) => {
    if (cmd === 'work') { works.push(t.id); writeFileSync(join(c.cwd!, `${t.id}.txt`), 'done'); }
    return ok;
  });
  await r.start(new Set(['consumer']));
  assert.deepEqual(works, ['root', 'producer', 'consumer']);
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
});

test('wave diagnosis reopens an excluded producer without waiting for final-checkpoint failure', async () => {
  const f = fixture([node('a'), node('producer', [], { creates: ['producer.txt'] })]);
  let missing = true, waveFailures = 0;
  const r = runner(f, async (t, c, cmd) => {
    if (cmd === 'work') { writeFileSync(join(c.cwd!, `${t.id}.txt`), 'done'); if (t.id === 'producer') missing = false; }
    if (cmd === 'wave' && missing) { waveFailures++; return { exitCode: 1, output: "ENOENT: missing file 'producer.txt'" }; }
    return ok;
  });
  await r.start(new Set(['a']));
  assert.equal(waveFailures, 1); assert.equal(f.run.tasks.producer.status, 'completed');
  assert.equal(f.run.flowState!.checkpoints.filter(c => c.kind === 'final').length, 1);
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
});

test('dependency suspension survives process death without treating saved edits as verified', async () => {
  const f = fixture([node('consumer'), node('producer', [], { creates: ['producer.txt'] })]);
  saveRun(f.run, f.file);
  const storeModule = new URL('../store.js', import.meta.url).href;
  const runnerModule = new URL('../runner.js', import.meta.url).href;
  const script = `
    import { DagRunner } from ${JSON.stringify(runnerModule)};
    import { loadRun, saveRun } from ${JSON.stringify(storeModule)};
    import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
    const [file,cwd] = process.argv.slice(1), run = loadRun(file);
    await new DagRunner(run, {file,cwd,
      persist:r=>{saveRun(r,file); if(r.tasks.consumer.nodeState?.dependencyWork) process.exit(73);},
      executor:async(t,c,cmd)=>{
        if(cmd==='work') writeFileSync(join(c.cwd,t.id+'.txt'),'partial');
        if(cmd==='check-consumer') return {exitCode:1,output:"ENOENT: missing file 'producer.txt'"};
        return {exitCode:0,output:'ok'};
      }
    }).start(new Set(['consumer']));
  `;
  const died = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.file, f.cwd], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  assert.equal(died.status, 73, died.stderr);
  f.run = loadRun(f.file);
  assert.equal(f.run.tasks.consumer.status, 'pending');
  assert.equal(f.run.tasks.consumer.nodeState?.candidate, undefined);
  assert.ok(f.run.tasks.consumer.nodeState?.dependencyWork);
  let consumerWorks = 0;
  const resumed = runner(f, async (t, c, cmd) => {
    if (cmd === 'work') {
      if (t.id === 'consumer') { consumerWorks++; assert.equal(readFileSync(join(c.cwd!, 'consumer.txt'), 'utf8'), 'partial'); }
      writeFileSync(join(c.cwd!, `${t.id}.txt`), 'done');
    }
    return ok;
  });
  await resumed.start();
  assert.equal(consumerWorks, 1); assert.equal(f.run.tasks.consumer.attempts, 2);
  assert.equal(resumed.result?.flow3?.passed, true, JSON.stringify(resumed.result));
});

test('verified candidate survives process death and resumes landing without another implementation', async () => {
  const f = fixture([node('a')]); saveRun(f.run, f.file);
  const storeModule = new URL('../store.js', import.meta.url).href;
  const runnerModule = new URL('../runner.js', import.meta.url).href;
  const script = `
    import { DagRunner } from ${JSON.stringify(runnerModule)};
    import { loadRun, saveRun } from ${JSON.stringify(storeModule)};
    import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
    const [file,cwd]=process.argv.slice(1),run=loadRun(file);
    await new DagRunner(run,{file,cwd,
      persist:r=>{saveRun(r,file);if(r.tasks.a.nodeState?.candidate)process.exit(75);},
      executor:async(t,c,cmd)=>{if(cmd==='work')writeFileSync(join(c.cwd,'a.txt'),'verified');return {exitCode:0,output:'ok'};}
    }).start();
  `;
  const died = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.file, f.cwd], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  assert.equal(died.status, 75, died.stderr);
  f.run = loadRun(f.file);
  const candidate = f.run.tasks.a.nodeState!.candidate!;
  assert.ok(candidate); assert.equal(f.run.tasks.a.status, 'running');
  const resumed = runner(f, async (_t, _c, cmd) => { assert.notEqual(cmd, 'work'); return ok; });
  await resumed.start();
  assert.equal(f.run.tasks.a.attempts, 1); assert.equal(f.run.tasks.a.nodeState!.candidate!.commit, candidate.commit);
  assert.equal(git(f.cwd, ['show', `dag/${f.run.id}:a.txt`]).stdout, 'verified');
  assert.equal(resumed.result?.flow3?.passed, true, JSON.stringify(resumed.result));
});

test('witnessed evidence changes establish freshness despite file clock skew; unchanged stale evidence fails', async () => {
  for (const fresh of [false, true]) {
    const f = fixture([node('a')], { finalChecks: ['evidence'], requiredEvidence: { evidence: ['node_modules/evidence.txt'] } });
    appendFileSync(join(f.cwd, '.gitignore'), '\nnode_modules/\n');
    git(f.cwd, ['add', '.gitignore']); git(f.cwd, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'ignore evidence']);
    const r = runner(f, async (t, c, cmd) => {
      if (cmd === 'work') writeFileSync(join(c.cwd!, `${t.id}.txt`), 'done');
      if (cmd === 'wave' || cmd === 'evidence' && fresh) {
        mkdirSync(join(c.cwd!, 'node_modules'), { recursive: true });
        const file = join(c.cwd!, 'node_modules/evidence.txt');
        writeFileSync(file, cmd === 'wave' ? 'old evidence' : 'current execution');
        utimesSync(file, 1, 1); // deterministic filesystem clock skew
      }
      return ok;
    });
    await r.start();
    assert.equal(r.result?.flow3?.passed, fresh, JSON.stringify(r.result));
    const evidence = f.run.flowState!.checkpoints.find(c => c.kind === 'final')!.results.find(r => r.command === 'evidence')!;
    assert.equal(evidence.passed, fresh);
    if (!fresh) assert.match(evidence.output, /predates this check/);
  }
});

test('quota interruption during prerequisite replay resumes the newer checkpoint without replaying stale metadata', async () => {
  const f = fixture([node('consumer'), node('producer', [], { creates: ['producer.txt'] })]);
  let works = 0;
  const r = new DagRunner(f.run, { cwd: f.cwd, file: f.file, persist: r => saveRun(r, f.file),
    quotaProbe: async () => ({ remainingPercent: 80, observedAt: Date.now() }),
    executor: async (t, c, cmd) => {
      if (cmd === 'work') {
        if (t.id === 'consumer') {
          works++;
          const file = join(c.cwd!, 'consumer.txt');
          if (works === 1) writeFileSync(file, 'partial');
          if (works === 2) { assert.equal(readFileSync(file, 'utf8'), 'partial'); writeFileSync(file, 'quota checkpoint'); return { exitCode: 1, output: 'Quota exhausted' }; }
          if (works === 3) { assert.equal(readFileSync(file, 'utf8'), 'quota checkpoint'); assert.equal(t.attempts, 2); }
        } else writeFileSync(join(c.cwd!, `${t.id}.txt`), 'done');
      }
      if (cmd === 'check-consumer' && works === 1) return { exitCode: 1, output: "ENOENT: missing file 'producer.txt'" };
      return ok;
    },
  });
  await r.start(new Set(['consumer']));
  assert.equal(works, 3); assert.equal(f.run.tasks.consumer.attempts, 2);
  assert.equal(f.run.flowState?.repairRound, 0);
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
});
