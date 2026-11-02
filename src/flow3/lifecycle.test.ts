import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DagRunner, type Executor } from '../runner.js';
import { gitRepo } from '../test-helpers.js';
import { git } from '../git-worktree.js';
import { editTask, loadRun, retryTask, saveRun } from '../store.js';
import { compileFlowPlan } from './graph.js';
import { acceptanceIdentity, completionScope, evidenceFailure } from './lifecycle.js';
import { repairDecision } from './repair.js';
import type { FlowNode, FlowSettings } from './contracts.js';

const ok = { exitCode: 0, output: 'ok' };
const node = (id: string, deps: string[] = []): FlowNode => ({ id, goal: id, depends_on: deps, touches: [`${id}.txt`], creates: [], relies_on: [], cmd: 'work', verify: `verify-${id}` });
function fixture(nodes = [node('a')], settings: FlowSettings = {}) {
  const repo = gitRepo(), file = join(repo, 'dag.run.json');
  const { run } = compileFlowPlan({ version: 3, title: 'acceptance', nodes, settings: { waveChecks: ['wave'], finalChecks: ['full'], repairRounds: 0, ...settings } });
  return { repo, file, run };
}
function make(f: ReturnType<typeof fixture>, extra: Executor = async () => ok) {
  return new DagRunner(f.run, { cwd: f.repo, file: f.file, persist: run => saveRun(run, f.file), executor: async (task, ctx, cmd) => {
    if (cmd === 'work') writeFileSync(join(ctx.cwd!, task.node!.touches[0]), task.id);
    return extra(task, ctx, cmd);
  } });
}

test('scoped acceptance persists scope and cannot claim product completion; required producer closes selection', async () => {
  const f = fixture([node('a'), node('b', ['a']), node('excluded')]);
  const r = make(f); await r.start(new Set(['b']));
  assert.equal(r.result?.flow3?.passed, true);
  assert.equal(r.result?.flow3?.productComplete, false);
  const saved = loadRun(f.file);
  assert.equal(saved.flowState?.completion?.mode, 'scoped');
  assert.deepEqual(new Set(saved.flowState?.completion?.required), new Set(['a', 'b']));
  assert.equal(saved.tasks.excluded.status, 'pending');
  const resumed = make({ ...f, run: saved }); await resumed.start();
  assert.equal(resumed.result?.flow3?.productComplete, false);
});

test('whole-product required unfinished and gated work blocks acceptance, optional work is explicit', async () => {
  const f = fixture([node('a'), node('b')], { completion: { mode: 'whole-product', required: ['a'], optional: ['b'] } });
  f.run.tasks.b.status = 'skipped';
  const r = make(f); await r.start();
  assert.equal(r.result?.flow3?.productComplete, true);
  f.run.tasks.a.status = 'pending'; f.run.tasks.a.cmd = null;
  const blocked = make(f); await blocked.start();
  assert.equal(blocked.result?.flow3?.implementationComplete, false);
  assert.equal(blocked.result?.flow3?.productComplete, false);
  assert.equal(blocked.result?.flow3?.acceptanceStatus, 'pending');
});

test('identity binds requirements checks environment fixture data and later required producers', () => {
  const f = fixture(); f.run.flowState = { version: 3, repairRound: 0, checkpoints: [], issues: [] };
  f.run.flowState.completion = completionScope(f.run, new Set(['a']), false);
  writeFileSync(join(f.repo, 'fixture.json'), 'one');
  const settings = { acceptanceInputs: ['fixture.json'], environmentIdentity: 'env1' };
  const id = () => acceptanceIdentity(f.run, settings, f.repo, 'source', ['check']);
  const initial = id(); writeFileSync(join(f.repo, 'fixture.json'), 'two'); assert.notEqual(id().inputs, initial.inputs);
  settings.environmentIdentity = 'env2'; assert.notEqual(id().environment, initial.environment);
  f.run.tasks.a.node!.goal = 'changed requirement'; assert.notEqual(id().requirements, initial.requirements);
  const { run } = compileFlowPlan({ version: 3, title: 'new producer', nodes: [node('a'), node('producer')] });
  run.flowState = f.run.flowState;
  assert.ok(completionScope(run, new Set(['a', 'producer']), false).required.includes('producer'));
});

test('zero, missing, interrupted and inconclusive evidence never passes; negative analysis stays evidence', () => {
  const f = fixture();
  for (const output of ['# tests 0', 'No tests found', 'inconclusive', 'cancelled', 'interrupted', 'missing required evidence', '0 passing', '# tests 3\n# pass 2\n# fail 1', 'not ok 1 - swallowed failure\n# tests 1', 'No test files found', 'Tests: 0 skipped, 0 total']) assert.ok(evidenceFailure('check', { exitCode: 0, output }, {}, f.repo), output);
  assert.ok(evidenceFailure('npm test', ok, {}, f.repo));
  assert.ok(evidenceFailure('node --test', { exitCode: 0, output: '# tests 3\n# pass 0\n# fail 0\n# skipped 3\n# cancelled 0' }, {}, f.repo));
  assert.equal(evidenceFailure('node --test', { exitCode: 0, output: '# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0' }, {}, f.repo), undefined);
  assert.ok(evidenceFailure('check', ok, { requiredEvidence: { check: ['report.json'] } }, f.repo));
  assert.equal(evidenceFailure('analysis', { exitCode: 0, output: 'valid negative analytical outcome' }, {}, f.repo), undefined);
  assert.equal(repairDecision(f.run, { command: 'analysis', output: 'valid negative analytical outcome: AssertionError', phase: 'integration' }).category, 'analytical');
  assert.equal(repairDecision(f.run, { command: 'review', output: 'reviewer finding rejected: assertion incorrect', phase: 'integration' }).category, 'review');
});

test('committed source mutation during acceptance invalidates all affected results', async () => {
  const f = fixture();
  const r = make(f, async (_task, ctx, cmd) => {
    if (cmd === 'full') {
      writeFileSync(join(ctx.cwd!, 'a.txt'), 'mutated');
      git(ctx.cwd!, ['add', 'a.txt']);
      git(ctx.cwd!, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'illegal check mutation']);
    }
    return ok;
  });
  await r.start();
  const final = f.run.flowState!.checkpoints.filter(c => c.kind === 'final').at(-1)!;
  assert.equal(final.passed, false);
  assert.ok(final.identity?.digest);
  assert.ok(final.results.some(result => result.outcome === 'invalidated'));
  assert.equal(r.result?.flow3?.passed, false);
});

test('configured final review covers accepted identity, reruns after change, and remains optional', async () => {
  const f = fixture(); f.run.settings.finalReview = 'run'; f.run.settings.finalReviewCmd = 'review';
  let reviews = 0;
  const execute: Executor = async (task, ctx, cmd) => {
    if (cmd === 'review') { reviews++; assert.equal(ctx.readOnly, true); assert.match(task.spec, /accepted identity/); return { exitCode: 0, output: reviews === 1 ? 'VERDICT: PASS' : 'VERDICT: FAIL: disputed finding' }; }
    return ok;
  };
  const r = make(f, execute); await r.start();
  assert.equal(r.result?.flow3?.reviewStatus, 'pass');
  assert.equal(r.result?.finalReview?.verdict, 'pass');
  f.run.tasks.a.node!.goal = 'new requirement';
  const resumed = make(f, execute); await resumed.start();
  assert.equal(reviews, 2);
  assert.equal(resumed.result?.flow3?.acceptanceStatus, 'passed');
  assert.equal(resumed.result?.flow3?.reviewStatus, 'fail');
  assert.equal(resumed.result?.flow3?.passed, false);
  assert.equal(f.run.flowState!.reviewHistory!.length, 2);
  f.run.settings.finalReview = 'off'; await make(f, execute).start(); assert.equal(reviews, 2);
});

test('lifetime repair accounting survives retry and definition changes; deadline never renews', async () => {
  const f = fixture();
  f.run.tasks.a.nodeState = { repairAttempts: 1, repairFailures: ['prior'] };
  f.run.tasks.a.status = 'failed';
  retryTask(f.run, 'a'); editTask(f.run, 'a', { spec: 'new specification' });
  assert.equal(f.run.tasks.a.nodeState?.repairAttempts, 1);
  f.run.flowState = { version: 3, repairRound: 2, checkpoints: [], issues: [], deadlineAt: Date.now() - 1 };
  const r = make(f); await r.start();
  assert.equal(r.result?.budgetReached, true);
  assert.equal(f.run.flowState.repairRound, 2);
  assert.ok(f.run.flowState.deadlineAt! < Date.now());
});

test('crash after durable finding and charge resumes exactly one repair with diagnosis and sibling checks', async () => {
  const a = node('a'), b = node('b'), future = node('future', ['a', 'b']); a.touches = b.touches = ['shared.txt'];
  const f = fixture([a, b, future], { repairRounds: 2, repairCommand: 'repair' });
  let crash = true, fixed = false; const checks: string[] = [];
  const execute: Executor = async (task, ctx, cmd) => {
    if (cmd === 'work') writeFileSync(join(ctx.cwd!, task.node!.touches[0]), task.id);
    if (cmd === 'wave' && !fixed) return { exitCode: 1, output: 'error TS1234: shared.txt type mismatch' };
    if (cmd === 'repair') {
      assert.match(task.spec, /flow3-automatic/); assert.match(task.spec, /TS1234/); assert.match(task.spec, /Latest diagnosis/); assert.match(task.spec, /updated investigation/);
      writeFileSync(join(ctx.cwd!, 'shared.txt'), 'fixed'); fixed = true;
    }
    if (ctx.env?.DAG_PHASE === 'verify' && task.node?.repair_of) checks.push(cmd!);
    return ok;
  };
  const interrupted = new DagRunner(f.run, { cwd: f.repo, file: f.file, executor: execute, persist: run => {
    saveRun(run, f.file);
    if (crash && run.flowState?.repairIntents?.some(i => i.status === 'pending')) { crash = false; throw Error('simulated crash after intent'); }
  } });
  await interrupted.start();
  const saved = loadRun(f.file); assert.equal(saved.flowState!.repairRound, 1);
  assert.equal(saved.flowState!.repairIntents!.length, 1);
  // A later diagnosis augments the immutable original evidence, and must survive materialization.
  const intent = saved.flowState!.repairIntents![0];
  // Materialization after crash is exercised by the scheduler; the original diagnosis is retained in context.
  intent.context.diagnosis.reason += '; updated investigation';
  const recovered = new DagRunner(saved, { cwd: f.repo, file: f.file, executor: execute, persist: run => saveRun(run, f.file) });
  await recovered.start();
  assert.equal(recovered.result?.flow3?.passed, true, JSON.stringify(recovered.result));
  assert.equal(saved.flowState!.repairRound, 1);
  assert.equal(Object.values(saved.tasks).filter(t => t.node?.repair_of).length, 1);
  assert.ok(checks.includes('verify-a')); assert.ok(checks.includes('verify-b')); assert.ok(!checks.includes('verify-future'));
});

// Exercise a real process death: finally blocks must not erase the only saved repair source.
test('a crashed repair resumes saved edits through verification without another coding dispatch', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const checkpoint of [true, false]) {
  const f = fixture([node('a')], { repairRounds: 1, repairCommand: 'repair' });
  saveRun(f.run, f.file);
  const moduleUrl = (name: string) => new URL(name, import.meta.url).href;
  const script = `
    import { DagRunner } from ${JSON.stringify(moduleUrl('../runner.js'))};
    import { loadRun, saveRun } from ${JSON.stringify(moduleUrl('../store.js'))};
    import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const file = ${JSON.stringify(f.file)}, repo = ${JSON.stringify(f.repo)}, run = loadRun(file);
    await new DagRunner(run, { cwd: repo, file, persist: r => saveRun(r, file), executor: async (task, ctx, cmd) => {
      if (cmd === 'work') writeFileSync(join(ctx.cwd, 'a.txt'), 'before');
      if (cmd === (${JSON.stringify(checkpoint)} ? 'full' : 'verify-a')) return { exitCode: 1, output: 'AssertionError: a.txt contract defect' };
      if (cmd === 'repair') { writeFileSync(join(ctx.cwd, 'a.txt'), 'recovered'); process.exit(17); }
      return { exitCode: 0, output: 'ok' };
    } }).start();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(child.status, 17, child.stderr);
  let saved = loadRun(f.file);
  let repair = checkpoint ? Object.values(saved.tasks).find(t => t.node?.repair_of)! : saved.tasks.a;
  assert.equal(repair.attempts, 1); assert.ok(repair.nodeState?.repairBaseline);
  const originalWorker = repair.nodeState!.worker!, originalHead = repair.nodeState!.repairBaseline!.head;
  const secondScript = `
    import { DagRunner } from ${JSON.stringify(moduleUrl('../runner.js'))};
    import { loadRun, saveRun } from ${JSON.stringify(moduleUrl('../store.js'))};
    const file = ${JSON.stringify(f.file)}, run = loadRun(file);
    await new DagRunner(run, { cwd: ${JSON.stringify(f.repo)}, file, persist: r => saveRun(r, file), executor: async (_task, ctx, cmd) => {
      if (cmd === 'work' || cmd === 'repair') process.exit(99);
      if (ctx.env.DAG_PHASE === 'verify') process.exit(18);
      return { exitCode: 0, output: 'ok' };
    } }).start();
  `;
  const second = spawnSync(process.execPath, ['--input-type=module', '-e', secondScript], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(second.status, 18, second.stderr);
  assert.equal(git(originalWorker, ['rev-parse', 'HEAD']).stdout, originalHead, 'recovery must not advance the only preserved source baseline');
  saved = loadRun(f.file); repair = saved.tasks[repair.id];
  const r = new DagRunner(saved, { cwd: f.repo, file: f.file, persist: run => saveRun(run, f.file), executor: async (_task, ctx, cmd) => {
    assert.notEqual(cmd, 'repair', 'must not grant another coding dispatch');
    assert.notEqual(cmd, 'work', 'must not redo implementation');
    if (cmd === 'full') assert.equal((await import('node:fs')).readFileSync(join(ctx.cwd!, 'a.txt'), 'utf8'), 'recovered');
    return ok;
  } });
  await r.start();
  assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
  assert.equal(saved.flowState!.repairRound, checkpoint ? 1 : 0); assert.equal(repair.attempts, 1);
  }
});

test('discovering a missing producer reopens scoped implementation before dependent acceptance', async () => {
  const producer = node('producer'); producer.creates = ['producer.txt'];
  const f = fixture([node('a'), producer], { completion: { mode: 'scoped', required: ['a'], optional: ['producer'] } }); let checks = 0;
  const r = make(f, async (_task, ctx, cmd) => {
    if (cmd === 'full') {
      checks++;
      if (!(await import('node:fs')).existsSync(join(ctx.cwd!, 'producer.txt'))) return { exitCode: 1, output: 'ENOENT: missing file producer.txt' };
    }
    return ok;
  });
  await r.start(new Set(['a']));
  assert.equal(checks, 2); assert.equal(f.run.tasks.producer.status, 'completed');
  assert.ok(f.run.flowState!.completion!.required.includes('producer'));
  assert.ok(!f.run.flowState!.completion!.optional.includes('producer'));
  assert.equal(f.run.flowState!.repairRound, 0);
  assert.equal(r.result?.flow3?.passed, true); assert.equal(r.result?.flow3?.productComplete, false);
});

test('node source mutation cannot pass; review mutation cannot inherit acceptance', async () => {
  const f = fixture();
  const local = make(f, async (_task, ctx, cmd) => { if (cmd === 'verify-a') writeFileSync(join(ctx.cwd!, 'a.txt'), 'illegal verifier edit'); return ok; });
  await local.start(); assert.equal(local.result?.flow3?.passed, false); assert.equal(f.run.tasks.a.status, 'failed');
  const reviewed = fixture(); reviewed.run.settings.finalReview = 'run'; reviewed.run.settings.finalReviewCmd = 'review';
  const r = make(reviewed, async (_task, ctx, cmd) => {
    if (cmd === 'review') {
      writeFileSync(join(ctx.cwd!, 'a.txt'), 'review mutation');
      writeFileSync(join(ctx.cwd!, 'package.json'), 'malformed reviewer modification'); git(ctx.cwd!, ['add', 'a.txt', 'package.json']);
      git(ctx.cwd!, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'unauthorized review mutation']);
      return { exitCode: 0, output: 'VERDICT: PASS' };
    }
    return ok;
  });
  await r.start(); assert.equal(r.result?.flow3?.passed, false);
  assert.equal(r.result?.flow3?.acceptanceStatus, 'failed'); assert.equal(r.result?.flow3?.reviewStatus, 'error');
  assert.equal(git(reviewed.repo, ['show', `dag/${reviewed.run.id}:a.txt`]).stdout, 'a');
});

test('CLI full-run entrypoint reports whole-product completion and tolerates explicit optional failure', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const f = fixture([node('a'), node('optional')], { completion: { mode: 'whole-product', required: ['a'], optional: ['optional'] } });
  const check = `node -e "if (!require('fs').existsSync('a.txt')) process.exit(1)"`;
  f.run.tasks.a.cmd = `node -e "require('fs').writeFileSync('a.txt','a')"`;
  f.run.tasks.a.node!.verify = check;
  f.run.settings.flow3!.waveChecks = [check]; f.run.settings.flow3!.finalChecks = [check];
  f.run.tasks.optional.status = 'failed'; f.run.tasks.optional.result = 'optional failure';
  saveRun(f.run, f.file);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), 'run', '--file', f.file, '--json'], { cwd: f.repo, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /"productComplete":\s*true/);
  assert.equal(loadRun(f.file).flowState!.completion!.mode, 'whole-product');
});

test('retry cannot switch a rejected local repair back to a fresh implementation allowance', async () => {
  const f = fixture([node('a')], { repairCommand: 'repair', nodeRepairRounds: 1 }); let works = 0, repairs = 0;
  const execute: Executor = async (_task, ctx, cmd) => {
    if (cmd === 'work') { works++; writeFileSync(join(ctx.cwd!, 'a.txt'), 'before'); }
    if (cmd === 'verify-a') return { exitCode: 1, output: 'AssertionError: contract defect' };
    if (cmd === 'repair') repairs++; // Demonstrably no progress: an additional mechanism is not authorized.
    return ok;
  };
  const run = () => new DagRunner(f.run, { cwd: f.repo, file: f.file, executor: execute, persist: state => saveRun(state, f.file) });
  await run().start(); assert.equal(works, 1); assert.equal(repairs, 1);
  retryTask(f.run, 'a'); await run().start();
  assert.equal(works, 1); assert.equal(repairs, 1);
  assert.match(f.run.tasks.a.result!, /cannot switch to implementation/);
});


test('passing test names and analytical prose are not mistaken for execution outcomes', async () => {
  const f = fixture([node('a')], { finalChecks: ['npm test'] });
  const report = 'TAP version 13\n# Subtest: interrupted checks remain inconclusive\nok 1 - interrupted checks remain inconclusive\n# Subtest: cancelled jobs do not pass\nok 2 - cancelled jobs do not pass\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0';
  assert.equal(evidenceFailure('npm test', { exitCode: 0, output: report }, {}, f.repo), undefined);
  assert.equal(evidenceFailure('analysis', { exitCode: 0, output: 'Estimate is inconclusive; valid negative analytical outcome retained' }, {}, f.repo), undefined);
  const r = make(f, async (_task, _ctx, cmd) => cmd === 'npm test' ? { exitCode: 0, output: report } : ok);
  await r.start(); assert.equal(r.result?.flow3?.passed, true, JSON.stringify(r.result));
});

test('explicit scoped selection replaces a previous whole-product target without excluding its producers', () => {
  const f = fixture([node('a'), node('b'), node('consumer', ['a'])]);
  f.run.flowState = { version: 3, repairRound: 0, checkpoints: [], issues: [], completion: { mode: 'whole-product', required: ['a', 'b', 'consumer'], optional: [], excluded: [] } };
  const scoped = completionScope(f.run, new Set(['consumer']), true);
  assert.equal(scoped.mode, 'scoped');
  assert.deepEqual(new Set(scoped.required), new Set(['consumer', 'a']));
  assert.deepEqual(scoped.excluded, ['b']);
});

test('a missing failed optional producer is promoted to required and blocks implementation completion', async () => {
  const producer = node('producer'); producer.creates = ['producer.txt'];
  const f = fixture([node('a'), producer], { completion: { mode: 'scoped', required: ['a'], optional: ['producer'] } });
  f.run.tasks.producer.status = 'failed';
  const r = make(f, async (_task, _ctx, cmd) => cmd === 'full' ? { exitCode: 1, output: 'ENOENT: missing file producer.txt' } : ok);
  await r.start(new Set(['a']));
  assert.ok(f.run.flowState!.completion!.required.includes('producer'));
  assert.equal(r.result?.flow3?.implementationComplete, false);
  assert.equal(f.run.tasks.producer.attempts, 0, 'promotion does not authorize a retry of failed work');
});

test('a later check cannot erase required evidence and inherit the earlier pass', async () => {
  const f = fixture([node('a')], { finalChecks: ['first', 'erase'], requiredEvidence: { first: ['node_modules/evidence.txt'] } });
  appendFileSync(join(f.repo, '.gitignore'), '\nnode_modules/\n');
  git(f.repo, ['add', '.gitignore']); git(f.repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'ignore evidence output']);
  const r = make(f, async (_task, ctx, cmd) => {
    const path = join(ctx.cwd!, 'node_modules');
    if (cmd === 'first') { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'evidence.txt'), 'required evidence'); }
    if (cmd === 'erase') unlinkSync(join(path, 'evidence.txt'));
    return ok;
  });
  await r.start();
  assert.equal(r.result?.flow3?.passed, false);
  const first = f.run.flowState!.checkpoints.filter(c => c.kind === 'final').at(-1)!.results.find(r => r.command === 'first')!;
  assert.equal(first.outcome, 'invalidated'); assert.match(first.output, /evidence changed or disappeared/);
  f.run.settings.flow3!.finalChecks = ['first']; f.run.settings.finalReview = 'run'; f.run.settings.finalReviewCmd = 'review';
  const reviewed = make(f, async (_task, ctx, cmd) => {
    if (cmd === 'first') { mkdirSync(join(ctx.cwd!, 'node_modules'), { recursive: true }); writeFileSync(join(ctx.cwd!, 'node_modules/evidence.txt'), 'new evidence'); }
    if (cmd === 'review') { unlinkSync(join(ctx.cwd!, 'node_modules/evidence.txt')); return { exitCode: 0, output: 'VERDICT: PASS' }; }
    return ok;
  });
  await reviewed.start(); assert.equal(reviewed.result?.flow3?.acceptanceStatus, 'failed'); assert.equal(reviewed.result?.flow3?.reviewStatus, 'error');

});

test('per-task review reports actual coverage and cannot pass an empty required review', async () => {
  const f = fixture([node('a'), node('b')]); f.run.settings.finalReview = 'per-task'; f.run.settings.finalReviewCmd = 'review';
  const r = make(f, async (_task, _ctx, cmd) => cmd === 'review' ? { exitCode: 0, output: 'VERDICT: FAIL: evidence requires adjudication' } : ok);
  await r.start(); assert.deepEqual(r.result?.finalReview?.reviewed, ['a']); assert.deepEqual(r.result?.finalReview?.failed, ['a']);
  assert.equal(f.run.flowState!.review!.results!.length, 1);
  const failedInvocation = make(f, async (task, _ctx, cmd) => {
    if (cmd === 'review') { if (task.id === 'b') throw Error('review invocation failed'); return { exitCode: 0, output: 'VERDICT: PASS: retained first review' }; }
    return ok;
  });
  await failedInvocation.start();
  assert.deepEqual(failedInvocation.result?.finalReview?.reviewed, ['a', 'b']);
  assert.deepEqual(failedInvocation.result?.finalReview?.failed, ['b']);
  assert.match(f.run.flowState!.review!.output!, /retained first review/);

  const empty = fixture([]); empty.run.settings.finalReview = 'per-task'; empty.run.settings.finalReviewCmd = 'review';
  empty.run.flowState = { version: 3, repairRound: 0, checkpoints: [], issues: [], review: { identity: 'prior', status: 'pending', output: 'earlier interrupted review evidence' } };
  const noReview = make(empty); await noReview.start();
  assert.equal(noReview.result?.flow3?.reviewStatus, 'error'); assert.equal(noReview.result?.flow3?.productComplete, false);
  assert.ok(empty.run.flowState!.reviewHistory!.some(r => r.status === 'error' && r.output?.includes('earlier interrupted review evidence')));
});


test('retained repair context does not run a sibling check after that owner becomes unfinished', async () => {
  const b = node('b'), a = node('a'); b.touches = a.touches = ['shared.txt'];
  const f = fixture([b, a], { repairCommand: 'repair' }); let fixed = false, siblingChecks = 0;
  const execute: Executor = async (_task, ctx, cmd) => {
    if (cmd === 'verify-a' && !fixed) return { exitCode: 1, output: 'AssertionError: shared contract defect' };
    if (cmd === 'verify-b') siblingChecks++;
    if (cmd === 'repair') writeFileSync(join(ctx.cwd!, 'shared.txt'), 'attempted repair');
    return ok;
  };
  await make(f, execute).start(); assert.equal(f.run.tasks.a.status, 'failed');
  assert.ok(f.run.tasks.a.nodeState!.repairContext!.owners.includes('b'));
  fixed = true; siblingChecks = 0;
  editTask(f.run, 'a', { spec: 'explicitly amended implementation requirement' }); retryTask(f.run, 'a');
  f.run.tasks.b.status = 'pending';
  const scoped = make(f, execute); await scoped.start(new Set(['a']));
  assert.equal(scoped.result?.flow3?.passed, true, JSON.stringify(scoped.result));
  assert.equal(siblingChecks, 0); assert.equal(f.run.tasks.b.status, 'pending');
});
