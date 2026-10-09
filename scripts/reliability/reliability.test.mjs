import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRun, addTask, saveRun, loadRun } from '../../dist/store.js';
import { git, hash, chooseBatch, preflight, guardDiff, DEFAULT_WORKERS, command, loadConfig, graphIdentity, sourceIdentity } from './contracts.mjs';
import { marker, taskFailure, validateReview, profileFor, fingerprint } from './protocol.mjs';
import { openLedger } from './ledger.mjs';
import { reliable } from './controller.mjs';
const cmd = (script) => ({ program: process.execPath, args: [script], timeoutMs: 15000, kind: 'deterministic' });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'dag-reliable-'));
    git(root, ['init']);
    git(root, ['config', 'user.email', 'test@localhost']);
    git(root, ['config', 'user.name', 'test']);
    writeFileSync(join(root, '.gitignore'), 'dag.run*\n');
    writeFileSync(join(root, 'value.txt'), 'bad');
    writeFileSync(join(root, 'worker.mjs'), "import fs from 'node:fs';if(fs.readFileSync('value.txt','utf8')!=='good'){console.log('DAG_FAILURE: '+JSON.stringify({version:1,code:'implementation',stage:'work',owner:'task_one',evidence:['wrong value']}));process.exit(1)}");
    writeFileSync(join(root, 'check.mjs'), "import fs from 'node:fs';process.exit(fs.readFileSync('value.txt','utf8')==='good'?0:1)");
    writeFileSync(join(root, 'repair.mjs'), "import fs from 'node:fs';fs.writeFileSync('value.txt','good')");
    writeFileSync(join(root, 'review.mjs'), "console.log('DAG_REVIEW: '+JSON.stringify({verdict:'pass',findings:[]}))");
    writeFileSync(join(root, 'diagnose.mjs'), "console.log('DAG_DIAGNOSIS: '+JSON.stringify({failure:{version:1,code:'implementation',stage:'work',owner:'task_one',evidence:['value must be good']},requestedFiles:[]}))");
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'fixture']);
    const run = newRun('reliability fixture');
    run.settings.finalReviewMode = 'off';
    addTask(run, { id: 'task_one', title: 'value', spec: 'Set value to good. R1 requires good.', cmd: `\"${process.execPath.replaceAll('\\', '/')}\" worker.mjs`, maxAttempts: 5, reviewRounds: 3 });
    saveRun(run, join(root, 'dag.run.json'));
    const cfg = { version: 1, runFile: 'dag.run.json', policy: { wallMs: 180000 }, commands: { diagnose: cmd('diagnose.mjs'), repair: cmd('repair.mjs'), review: cmd('review.mjs') }, tasks: { task_one: { deterministic: true, entryPoint: 'value.txt', reviewBoundary: 'R1', requirements: ['R1'], files: [{ path: 'value.txt', role: 'implementation' }, { path: 'check.mjs', role: 'frozen', digest: hash(readFileSync(join(root, 'check.mjs'))) }], checks: [cmd('check.mjs')] } } };
    const path = join(root, 'reliability.json');
    writeFileSync(path, JSON.stringify(cfg));
    return { root, run, cfg, path };
}
test('typed failures do not classify quota text from test output', () => { assert.equal(taskFailure({ id: 'x', failureKind: 'exit', result: 'quota exceeded in fixture' }).code, 'unknown'); assert.equal(marker('noise DAG_FAILURE: {}', 'DAG_FAILURE'), null); });
test('model escalation respects repeated attempts and excludes Astra', () => { const p = { workers: DEFAULT_WORKERS }; assert.equal(profileFor(p, 2).model, 'gpt-6-luna'); assert.equal(profileFor(p, 3).reasoning, 'medium'); assert.equal(profileFor(p, 6).reasoning, 'xhigh'); assert.throws(() => profileFor(p, 10)); });
test('review blockers need an accepted requirement and evidence', () => { assert.throws(() => validateReview({ verdict: 'fail', findings: [{ severity: 'blocker', reason: 'style' }] }, ['R1'])); assert.equal(validateReview({ verdict: 'pass', findings: [{ severity: 'suggestion', reason: 'style' }] }, ['R1']).verdict, 'pass'); });
test('failure identity ignores arbitrary transcript differences', () => { const f = { code: 'implementation', stage: 'work', owner: 'x' }; assert.equal(fingerprint({ ...f, evidence: ['a'] }, 'v'), fingerprint({ ...f, evidence: ['b'] }, 'v')); });
test('review display labels preserve exact registered ownership and genuine rejection', () => {
    const finding = { severity: 'blocker', requirement: 'R1 — fixed registry', reason: 'runtime mutation', evidence: ['observed mutation'], codePath: 'value.txt' };
    const review = validateReview({ verdict: 'fail', findings: [finding] }, ['R1']);
    assert.equal(review.verdict, 'fail');
    assert.equal(finding.requirement, 'R1');
    assert.equal(finding.requirementLabel, 'R1 — fixed registry');
    for (const requirement of ['R10 — fixed registry', 'R1 maybe', 'unknown — R1'])
        assert.throws(() => validateReview({ verdict: 'fail', findings: [{ ...finding, requirement }] }, ['R1']));
    assert.throws(() => validateReview({ verdict: 'fail', findings: [{ ...finding, evidence: [] }] }, ['R1']));
});
test('stopped continuation retains verified repair and counters, explicitly renews expired window', async () => {
    const f = fixture(), dir = join(f.root, 'dag.run.d', 'reliability');
    const l = openLedger(dir, f.run.id, hash(readFileSync(f.path, 'utf8')), { wallMs: 10000 });
    l.state.graphRevision = graphIdentity(f.run);
    l.state.deadline = 1;
    l.state.semanticCounts = { task_one: 2 };
    l.state.infrastructureCounts = { task_one: 1 };
    l.state.incidents.kept = { taskId: 'task_one', phase: 'review', worktree: f.root, verifiedSource: sourceIdentity(f.root, loadConfig(f.path).cfg), checkReceipts: [{ code: 0 }] };
    l.state.suspended.task_one = { failure: { code: 'review_dispute' } };
    l.save();
    await assert.rejects(reliable('continue', f.path, { release: ['task_one'], wallMs: 10000 }), /reason/);
    await assert.rejects(reliable('continue', f.path, { reason: 'authorized continuation', wallMs: 999999999 }), /window/);
    writeFileSync(join(f.root, 'value.txt'), 'changed since verification');
    await assert.rejects(reliable('continue', f.path, { reason: 'authorized continuation', release: ['task_one'], wallMs: 10000 }), /source changed/);
    writeFileSync(join(f.root, 'value.txt'), 'bad');
    const before = Date.now();
    await reliable('continue', f.path, { reason: 'authorized continuation', release: ['task_one'], wallMs: 10000 });
    const state = JSON.parse(readFileSync(join(dir, 'controller.json')));
    assert.equal(state.incidents.kept.phase, 'review');
    assert.deepEqual(state.incidents.kept.checkReceipts, [{ code: 0 }]);
    assert.equal(state.semanticCounts.task_one, 2);
    assert.equal(state.infrastructureCounts.task_one, 1);
    assert.equal(state.suspended.task_one, undefined);
    assert.ok(state.deadline >= before + 10000);
    assert.equal(state.history.at(-1).event, 'operator-continuation');
});
test('ledger deadline and budget survive reopening', () => { const root = mkdtempSync(join(tmpdir(), 'dag-ledger-')); const a = openLedger(root, 'r', 'v', { wallMs: 10000 }); a.state.attempts.x = [{ semanticRejected: true }]; a.save('attempt'); const b = openLedger(root, 'r', 'v', { wallMs: 999999 }); assert.equal(b.state.deadline, a.state.deadline); assert.equal(b.state.attempts.x.length, 1); });
test('scheduling prevents conflicting writes and resource overcommit', () => { const cfg = { policy: { concurrency: 3 }, capacities: { cpu: 1 }, tasks: { a: { files: [{ path: 'a', role: 'implementation' }], resources: { cpu: 1 } }, b: { files: [{ path: 'b', role: 'implementation' }], resources: { cpu: 1 } } } }; const run = { tasks: { a: { id: 'a', status: 'pending', deps: [], cmd: 'x' }, b: { id: 'b', status: 'pending', deps: [], cmd: 'x' } } }; assert.deepEqual(chooseBatch(cfg, run), ['a']); run.tasks.a.gate = { approved: false }; assert.deepEqual(chooseBatch(cfg, run), ['b']); });
test('unregistered producer and unowned edits fail closed', () => { const f = fixture(); f.cfg.tasks.task_one.inputs = [{ owner: 'future', contract: 'input' }]; assert.throws(() => preflight(f.cfg, f.run)); writeFileSync(join(f.root, 'outside.txt'), 'oops'); const base = git(f.root, ['rev-parse', 'HEAD']); assert.throws(() => guardDiff(f.cfg, 'task_one', f.root, base, ['value.txt'])); });
test('real CLI failure repairs in isolation, verifies, publishes and requeues', { timeout: 180000 }, async () => { const f = fixture(); const result = await reliable('run', f.path); assert.equal(loadRun(join(f.root, 'dag.run.json')).tasks.task_one.status, 'completed', JSON.stringify(result)); assert.equal(result.metrics.automaticallyResolved, 1); assert.equal(readFileSync(join(f.root, 'value.txt'), 'utf8'), 'bad'); assert.equal(git(f.root, ['show', `dag/${f.run.id}:value.txt`]), 'good'); const again = await reliable('resume', f.path); assert.equal(again.metrics.automaticallyResolved, 1); });
for (const phase of ['verify', 'commit', 'publish', 'published'])
    test(`installed recovery resumes durable ${phase} boundary without duplicate publication`, { timeout: 180000 }, async () => {
        const f = fixture();
        const base = git(f.root, ['rev-parse', 'HEAD']);
        git(f.root, ['branch', `dag/${f.run.id}`, base]);
        f.run.tasks.task_one.status = 'failed';
        f.run.tasks.task_one.failureKind = 'exit';
        f.run.tasks.task_one.result = 'DAG_FAILURE: ' + JSON.stringify({ version: 1, code: 'implementation', stage: 'work', owner: 'task_one', evidence: ['bad value'] });
        saveRun(f.run, join(f.root, 'dag.run.json'));
        const dir = join(f.root, 'dag.run.d', 'reliability');
        mkdirSync(dir, { recursive: true });
        const wt = join(dir, 'incident_replay');
        git(f.root, ['worktree', 'add', '--detach', wt, base]);
        writeFileSync(join(wt, 'value.txt'), 'good');
        const rev = hash(readFileSync(f.path, 'utf8')), ledger = openLedger(dir, f.run.id, rev, { wallMs: 180000 });
        const i = { id: 'incident_replay', taskId: 'task_one', phase, base, worktree: wt, scope: ['value.txt'], profile: { model: 'gpt-6-luna', reasoning: 'xhigh' }, failure: { version: 1, code: 'implementation', stage: 'work', owner: 'task_one', evidence: ['bad value'] }, rejections: 0 };
        if (['publish', 'published'].includes(phase)) {
            git(wt, ['add', 'value.txt']);
            git(wt, ['commit', '-m', 'Reliability repair incident_replay']);
            i.receipt = { base, commit: git(wt, ['rev-parse', 'HEAD']) };
            if (phase === 'published')
                git(f.root, ['update-ref', `refs/heads/dag/${f.run.id}`, i.receipt.commit, base]);
        }
        ledger.state.incidents[i.id] = i;
        ledger.save('injected-crash-boundary');
        const result = await reliable('resume', f.path);
        assert.equal(result.completed, 1, JSON.stringify(result));
        assert.equal(result.metrics.automaticallyResolved, 1);
        assert.equal(Number(git(f.root, ['rev-list', '--count', `${base}..dag/${f.run.id}`])), 1);
    });
test('quota suspension preserves semantic budget and does not launch diagnosis', { timeout: 120000 }, async () => { const f = fixture(); f.run.tasks.task_one.status = 'failed'; f.run.tasks.task_one.failureKind = 'exit'; f.run.tasks.task_one.result = 'DAG_FAILURE: ' + JSON.stringify({ version: 1, code: 'quota', stage: 'work', evidence: ['Provider exhausted'] }); saveRun(f.run, join(f.root, 'dag.run.json')); const result = await reliable('run', f.path); assert.equal(result.suspended.task_one.failure.code, 'quota'); assert.equal(result.metrics.semanticRejections, 0); assert.equal(result.metrics.uniqueIncidents, 0); });
test('contract amendment requires a reason and preserves counters', async () => { const f = fixture(); const dir = join(f.root, 'dag.run.d', 'reliability'), l = openLedger(dir, f.run.id, hash(readFileSync(f.path, 'utf8')), { wallMs: 10000 }); l.state.semanticCounts = { task_one: 3 }; l.save(); f.cfg.tasks.task_one.reviewBoundary = 'amended'; writeFileSync(f.path, JSON.stringify(f.cfg)); await assert.rejects(reliable('amend', f.path), /reason/); const r = await reliable('amend', f.path, { reason: 'Clarified boundary' }); assert.equal(r.budgetsPreserved, true); const state = JSON.parse(readFileSync(join(dir, 'controller.json'))); assert.equal(state.semanticCounts.task_one, 3); assert.equal(state.deadline, l.state.deadline); });
test('verified lease rejects a second controller', async () => {
    const { lease } = await import('./ledger.mjs');
    const root = mkdtempSync(join(tmpdir(), 'dag-lease-'));
    const release = lease(root);
    try {
        assert.throws(() => lease(root), /owns this run/);
    }
    finally {
        release();
    }
});
test('typed test role protects existing assertions regardless of filename', () => { const f = fixture(); const path = 'acceptance.mjs'; writeFileSync(join(f.root, path), "test('must remain',()=>assert.equal(value,1));"); git(f.root, ['add', path, 'reliability.json']); git(f.root, ['commit', '-m', 'acceptance']); const base = git(f.root, ['rev-parse', 'HEAD']); f.cfg.tasks.task_one.files.push({ path, role: 'test' }); writeFileSync(join(f.root, path), "test('must remain',()=>assert.equal(value,2));"); assert.throws(() => guardDiff(f.cfg, 'task_one', f.root, base, [path]), /acceptance changed/); });
test('bounded command drains inherited pipes and terminates verified descendants', { timeout: 60000 }, async () => { const { runCommand, sameProcess, identity } = await import('./process.mjs'); const r = await runCommand({ program: process.execPath, args: ['-e', `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});console.log('CHILD: '+c.pid);c.unref();setTimeout(()=>process.exit(0),4000);`], timeoutMs: 20000 }); assert.equal(r.code, 0); const child = Number(r.output.match(/CHILD: (\d+)/)[1]); assert.equal(identity(child), null, 'Inherited pipe holder must be reaped'); assert.ok(r.elapsedMs < 20000); });
test('check reuse is invalidated by source, command and environment changes', async () => { const { checked } = await import('./checks.mjs'); const f = fixture(), dir = join(f.root, 'dag.run.d', 'reliability'); f.cfg.policy = { reuseChecks: true }; f.cfg.commands.environment = { program: 'environment', args: [], timeoutMs: 1000 }; let count = 0, digest = 'a'.repeat(64); const execute = async (c) => c.program === 'environment' ? { code: 0, output: 'DAG_ENVIRONMENT: ' + JSON.stringify({ digest }) } : (count++, { code: 0, output: 'pass' }); const context = { cfg: f.cfg, revision: 'v', cwd: f.root, directory: dir, execute }; await checked(cmd('check.mjs'), context); assert.equal((await checked(cmd('check.mjs'), context)).reused, true); assert.equal(count, 1); writeFileSync(join(f.root, 'value.txt'), 'changed'); assert.equal((await checked(cmd('check.mjs'), context)).reused, false); assert.equal(count, 2); digest = 'b'.repeat(64); await checked(cmd('check.mjs'), context); assert.equal(count, 3); await checked(cmd('other.mjs'), context); assert.equal(count, 4); });
test('a reviewer cannot mutate sources after checks passed', { timeout: 180000 }, async () => { const f = fixture(); writeFileSync(join(f.root, 'review.mjs'), "import fs from 'node:fs';fs.writeFileSync('value.txt','bad');console.log('DAG_REVIEW: '+JSON.stringify({verdict:'pass',findings:[]}))"); git(f.root, ['add', 'review.mjs']); git(f.root, ['commit', '-m', 'adversarial review']); const result = await reliable('run', f.path); assert.equal(result.completed, 0); assert.equal(result.suspended.task_one.failure.code, 'review_dispute'); assert.equal(git(f.root, ['show', `dag/${f.run.id}:value.txt`]), 'bad'); });
test('a real controller process killed during verification resumes and publishes once', { timeout: 180000 }, async () => {
    const { spawnSync } = await import('node:child_process');
    const f = fixture();
    const flag = join(f.root, 'dag.run.d', 'crash-once');
    mkdirSync(join(f.root, 'dag.run.d'), { recursive: true });
    const script = `import fs from 'node:fs';if(fs.readFileSync('value.txt','utf8')!=='good')process.exit(1);if(!fs.existsSync(${JSON.stringify(flag)})){fs.writeFileSync(${JSON.stringify(flag)},'killed');process.kill(process.ppid,'SIGKILL');}process.exit(0);`;
    writeFileSync(join(f.root, 'check.mjs'), script);
    f.cfg.tasks.task_one.files.find(x => x.path === 'check.mjs').digest = hash(readFileSync(join(f.root, 'check.mjs')));
    writeFileSync(f.path, JSON.stringify(f.cfg));
    git(f.root, ['add', 'check.mjs']);
    git(f.root, ['commit', '-m', 'crash fixture']);
    const cli = new URL('../../dist/cli.js', import.meta.url);
    const invoke = action => spawnSync(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'reliable', action, '--config', f.path], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
    const first = invoke('run');
    assert.notEqual(first.status, 0);
    assert.equal(readFileSync(flag, 'utf8'), 'killed');
    const ledgerPath = join(f.root, 'dag.run.d', 'reliability', 'controller.json'), before = JSON.parse(readFileSync(ledgerPath));
    const second = invoke('resume');
    assert.equal(second.status, 0, second.stderr + '\n' + second.stdout);
    const after = JSON.parse(readFileSync(ledgerPath));
    assert.equal(after.deadline, before.deadline);
    assert.equal(loadRun(join(f.root, 'dag.run.json')).tasks.task_one.status, 'completed');
    assert.equal(after.history.filter(e => e.event === 'published').length, 1);
});
test('consumer probe repairs a registered producer through a bounded scope request', { timeout: 180000 }, async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'producer.txt'), 'bad');
    writeFileSync(join(f.root, 'producer-check.mjs'), "import fs from 'node:fs';process.exit(fs.readFileSync('producer.txt','utf8')==='good'?0:1)");
    writeFileSync(join(f.root, 'repair.mjs'), "import fs from 'node:fs';const scope=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(!scope.files.includes('producer.txt')){console.log('DAG_SCOPE_REQUEST: '+JSON.stringify({files:['producer.txt'],reason:'Consumed producer contract is broken'}));process.exit(1)}fs.writeFileSync('producer.txt','good');fs.writeFileSync('value.txt','good');");
    git(f.root, ['add', 'producer.txt', 'producer-check.mjs', 'repair.mjs']);
    git(f.root, ['commit', '-m', 'producer fixture']);
    addTask(f.run, { id: 'task_producer', title: 'producer', spec: 'R2 must produce good', cmd: 'node producer-check.mjs' });
    f.run.tasks.task_producer.status = 'completed';
    f.run.tasks.task_one.deps = ['task_producer'];
    saveRun(f.run, join(f.root, 'dag.run.json'));
    f.cfg.tasks.task_producer = { deterministic: true, entryPoint: 'producer.txt', reviewBoundary: 'R2', requirements: ['R2'], files: [{ path: 'producer.txt', role: 'implementation' }, { path: 'producer-check.mjs', role: 'frozen', digest: hash(readFileSync(join(f.root, 'producer-check.mjs'))) }], checks: [cmd('producer-check.mjs')] };
    f.cfg.tasks.task_one.inputs = [{ owner: 'task_producer', contract: 'producer contract', check: cmd('producer-check.mjs') }];
    f.cfg.commands.repair.args.push('{scopeFile}');
    writeFileSync(f.path, JSON.stringify(f.cfg));
    const result = await reliable('run', f.path);
    assert.equal(result.completed, 2, JSON.stringify(result));
    const state = JSON.parse(readFileSync(join(f.root, 'dag.run.d', 'reliability', 'controller.json')));
    assert.equal(state.history.filter(e => e.event === 'scope-authorized').length, 1);
    assert.equal(git(f.root, ['show', `dag/${f.run.id}:producer.txt`]), 'good');
});
test('test protection includes helpers and imports, not just assertion bodies', () => {
    const f = fixture(), path = 'acceptance.mjs';
    writeFileSync(join(f.root, path), "const expected=1; test('contract',()=>assert.equal(value,expected));");
    git(f.root, ['add', path, 'reliability.json']);
    git(f.root, ['commit', '-m', 'helper baseline']);
    const base = git(f.root, ['rev-parse', 'HEAD']);
    f.cfg.tasks.task_one.files.push({ path, role: 'test' });
    writeFileSync(join(f.root, path), "const expected=2; test('contract',()=>assert.equal(value,expected));");
    assert.throws(() => guardDiff(f.cfg, 'task_one', f.root, base, [path]), /acceptance changed/);
});

test('environment repair retries preserve the selected semantic tier',{timeout:180000},async()=>{
 const f=fixture();writeFileSync(join(f.root,'repair.mjs'),"import fs from 'node:fs';const flag=process.argv[2]+'.infra';if(!fs.existsSync(flag)){fs.writeFileSync(flag,'retry');console.log('DAG_FAILURE: '+JSON.stringify({version:1,code:'environment',stage:'prepare',evidence:['Temporary runtime unavailable']}));process.exit(1)}fs.writeFileSync('value.txt','good');");git(f.root,['add','repair.mjs']);git(f.root,['commit','-m','environment fixture']);f.cfg.commands.repair.args.push('{scopeFile}');writeFileSync(f.path,JSON.stringify(f.cfg));const result=await reliable('run',f.path);assert.equal(result.completed,1,JSON.stringify(result));assert.equal(result.metrics.infrastructureRetries,1);assert.equal(result.metrics.semanticRejections,1);const state=JSON.parse(readFileSync(join(f.root,'dag.run.d','reliability','controller.json')));assert.ok(state.attempts.task_one.filter(a=>a.kind==='repair').every(a=>a.profile.model==='gpt-6-luna'));
});
test('registered long acceptance cycle has explicit bounded command and engine deadlines', () => {
 const f=fixture();f.cfg.policy.engineTimeoutMs=7200000;f.cfg.commands.repair.timeoutMs=3600000;writeFileSync(f.path,JSON.stringify(f.cfg));assert.equal(loadConfig(f.path).cfg.policy.engineTimeoutMs,7200000);assert.equal(command(f.cfg.commands.repair).timeoutMs,3600000);assert.throws(()=>command({...f.cfg.commands.repair,timeoutMs:7200001}),/deadline/);f.cfg.policy.engineTimeoutMs=7200001;writeFileSync(f.path,JSON.stringify(f.cfg));assert.throws(()=>loadConfig(f.path),/deadline/);
});
test('repair does not demand a future unit merely because it shares the acceptance file',{timeout:180000},async()=>{
 const f=fixture();writeFileSync(join(f.root,'shared.test.mjs'),"test('accepted baseline',()=>{});");git(f.root,['add','shared.test.mjs']);git(f.root,['commit','-m','shared acceptance baseline']);f.cfg.tasks.task_one.files.push({path:'shared.test.mjs',role:'test'});addTask(f.run,{id:'task_future',title:'future owner',spec:'R2 future',cmd:'node worker.mjs',deps:['task_one']});f.run.tasks.task_future.gate={question:'Later phase',approved:false};saveRun(f.run,join(f.root,'dag.run.json'));f.cfg.tasks.task_future={deterministic:true,entryPoint:'shared.test.mjs',reviewBoundary:'R2',requirements:['R2'],files:[{path:'shared.test.mjs',role:'test'}],checks:[{program:process.execPath,args:['-e','process.exit(9)'],timeoutMs:15000}]};writeFileSync(f.path,JSON.stringify(f.cfg));const result=await reliable('run',f.path);assert.equal(loadRun(join(f.root,'dag.run.json')).tasks.task_one.status,'completed',JSON.stringify(result));assert.equal(loadRun(join(f.root,'dag.run.json')).tasks.task_future.status,'pending');assert.equal(result.metrics.automaticallyResolved,1);
});
test('a failed input probe after publication opens bounded recovery and preserves the accepted receipt', {timeout:90000}, async()=>{
 const f=fixture();writeFileSync(join(f.root,'value.txt'),'good');writeFileSync(join(f.root,'input-probe.mjs'),"process.exit(1)");writeFileSync(join(f.root,'diagnose.mjs'),"console.log('DAG_DIAGNOSIS: '+JSON.stringify({failure:{version:1,code:'contract',stage:'preflight',owner:'task_producer',evidence:['Broken probe contract requires amendment']},requestedFiles:[]}))");git(f.root,['add','.']);git(f.root,['commit','-m','published input fixture']);addTask(f.run,{id:'task_producer',title:'producer',spec:'R1 good producer',cmd:'node check.mjs'});f.run.tasks.task_producer.status='completed';f.run.tasks.task_one.deps=['task_producer'];saveRun(f.run,join(f.root,'dag.run.json'));f.cfg.tasks.task_producer={...f.cfg.tasks.task_one,deterministic:true};f.cfg.tasks.task_one.inputs=[{owner:'task_producer',contract:'compiled producer',check:cmd('input-probe.mjs')}];f.cfg.policy.wallMs=60000;writeFileSync(f.path,JSON.stringify(f.cfg));const dir=join(f.root,'dag.run.d','reliability');const ledger=openLedger(dir,f.run.id,hash(readFileSync(f.path,'utf8')),{wallMs:60000});const base=git(f.root,['rev-parse','HEAD']);ledger.state.incidents.published={id:'published',taskId:'task_one',phase:'requeued',failure:{version:1,code:'ownership',stage:'preflight',evidence:['Original producer repaired']},receipt:{base,commit:base}};ledger.save();const result=await reliable('resume',f.path);assert.equal(result.stopReason,'suspended');const state=JSON.parse(readFileSync(join(dir,'controller.json')));assert.equal(state.incidents.published.receipt.commit,base);assert.equal(state.history.filter(e=>e.event==='post-publication-probe-failed').length,1);assert.equal(state.history.filter(e=>e.event==='stage-start'&&e.stage==='preflight').length,1);assert.equal(result.suspended.task_one.failure.code,'contract');
});
test('diagnosis after an engine failure sees a recreated accepted integration checkout', {timeout:180000}, async()=>{
 const f=fixture();writeFileSync(join(f.root,'diagnose.mjs'),"import fs from 'node:fs';import{spawnSync}from'node:child_process';const i=JSON.parse(fs.readFileSync(process.argv[2]));const id=JSON.parse(fs.readFileSync(i.runFile)).id;const r=spawnSync('git',['worktree','list','--porcelain'],{encoding:'utf8'});if(!r.stdout.includes('branch refs/heads/dag/'+id)){console.log('DAG_FAILURE: '+JSON.stringify({version:1,code:'environment',stage:'diagnose',evidence:['Accepted integration checkout missing after cleanup']}));process.exit(1)}console.log('DAG_DIAGNOSIS: '+JSON.stringify({failure:{version:1,code:'implementation',stage:'work',owner:'task_one',evidence:['Existing checkout proves value must be good']},requestedFiles:[]}));");git(f.root,['add','diagnose.mjs']);git(f.root,['commit','-m','diagnostic caller fixture']);f.cfg.commands.diagnose.args.push('{incidentFile}');writeFileSync(f.path,JSON.stringify(f.cfg));const result=await reliable('run',f.path);assert.equal(result.completed,1,JSON.stringify(result));assert.equal(result.metrics.infrastructureRetries,0);const s=JSON.parse(readFileSync(join(f.root,'dag.run.d/reliability/controller.json')));assert.equal(Object.values(s.incidents)[0].diagnosticReceipt.code,0);assert.equal(s.history.filter(e=>e.event==='stage-start'&&e.stage==='diagnose').length,1);
});
