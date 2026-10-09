import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { newRun, addTask, saveRun, loadRun } from '../../dist/store.js';
import { git, hash, guardDiff, graphIdentity } from './contracts.mjs';
import { openLedger } from './ledger.mjs';

const baseline = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('protected original acceptance', () => { assert.equal(2 + 2, 4); });\n";
const invalid = baseline + "const addedHelper = () => 'good';\ntest('new regression', () => { assert.equal(addedHelper(), 'good'); });\n";
const corrected = baseline + "test('new regression', () => { const addedHelper = () => 'good'; assert.equal(addedHelper(), 'good'); });\n";
const cmd = (script, ...args) => ({ program: process.execPath, args: [script, ...args], timeoutMs: 15000, kind: 'deterministic' });
const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'dag-guard-recovery-'));
    git(root, ['init']);
    git(root, ['config', 'user.email', 'test@localhost']);
    git(root, ['config', 'user.name', 'test']);
    mkdirSync(join(root, 'dag.run.d'), { recursive: true });
    const repairAudit = join(root, 'dag.run.d', 'repairs.jsonl');
    const reviewAudit = join(root, 'dag.run.d', 'reviews.jsonl');
    writeFileSync(join(root, '.gitignore'), 'dag.run*\n');
    writeFileSync(join(root, '.gitattributes'), '* text eol=lf\n');
    writeFileSync(join(root, 'value.txt'), 'bad');
    writeFileSync(join(root, 'acceptance.test.mjs'), baseline);
    writeFileSync(join(root, 'worker.mjs'), `import fs from 'node:fs';
if (fs.readFileSync('value.txt', 'utf8') !== 'good') {
 console.log('DAG_FAILURE: ' + JSON.stringify({version:1,code:'implementation',stage:'work',owner:'task_one',evidence:['value.txt must contain good']})); process.exit(1);
}
console.log('Fresh task accepted repaired value');`);
    writeFileSync(join(root, 'check.mjs'), `import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
if (fs.readFileSync('value.txt', 'utf8') !== 'good') process.exit(1);
const checked = spawnSync(process.execPath, ['--test', 'acceptance.test.mjs'], {encoding:'utf8',windowsHide:true});
console.log(checked.stdout); console.error(checked.stderr); process.exit(checked.status ?? 1);`);
    writeFileSync(join(root, 'diagnose.mjs'), "console.log('DAG_DIAGNOSIS: '+JSON.stringify({failure:{version:1,code:'implementation',stage:'work',owner:'task_one',evidence:['value.txt must contain good']},requestedFiles:[]}));");
    writeFileSync(join(root, 'repair.mjs'), `import fs from 'node:fs'; import assert from 'node:assert/strict';
const incident = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(incident.phase, 'repair', 'Repair must receive the current phase after same-call diagnosis');
assert.ok(incident.scope.includes('value.txt') && incident.scope.includes('acceptance.test.mjs'), 'Repair must receive the current authorized scope');
const before = fs.readFileSync('acceptance.test.mjs', 'utf8');
fs.appendFileSync(${JSON.stringify(repairAudit)}, JSON.stringify({lastFailure:incident.lastFailure ?? null,before})+'\\n');
if (!incident.lastFailure) { fs.writeFileSync('acceptance.test.mjs', ${JSON.stringify(invalid)}); process.exit(0); }
assert.equal(incident.lastFailure.code, 'implementation');
assert.equal(incident.lastFailure.validationRule, 'test_support');
assert.ok(incident.lastFailure.evidence.some(e => e.includes('acceptance.test.mjs') && e.includes('New test support code')));
assert.equal(before, ${JSON.stringify(invalid)}, 'Rejected source must survive for correction');
fs.writeFileSync('acceptance.test.mjs', ${JSON.stringify(corrected)});
fs.writeFileSync('value.txt', 'good');`);
    writeFileSync(join(root, 'review.mjs'), `import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const checked = spawnSync(process.execPath, ['check.mjs'], {encoding:'utf8',windowsHide:true});
fs.appendFileSync(${JSON.stringify(reviewAudit)}, JSON.stringify({code:checked.status,output:checked.stdout})+'\\n');
if (checked.status !== 0) { console.error(checked.stderr); process.exit(1); }
console.log('DAG_REVIEW: '+JSON.stringify({verdict:'pass',findings:[]}));`);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'guard recovery fixture']);
    const run = newRun('guard recovery fixture');
    run.settings.finalReviewMode = 'off';
    addTask(run, { id: 'task_one', title: 'repair guarded tests', spec: 'R1 requires good value and preserved original acceptance.', cmd: `"${process.execPath.replaceAll('\\', '/')}" worker.mjs`, maxAttempts: 5, reviewRounds: 3 });
    saveRun(run, join(root, 'dag.run.json'));
    const cfg = { version: 1, runFile: 'dag.run.json', policy: { wallMs: 180000 }, commands: { diagnose: cmd('diagnose.mjs'), repair: cmd('repair.mjs', '{incidentFile}'), review: cmd('review.mjs') }, tasks: { task_one: { deterministic: true, entryPoint: 'value.txt', reviewBoundary: 'R1', requirements: ['R1'], files: [{ path: 'value.txt', role: 'implementation' }, { path: 'acceptance.test.mjs', role: 'test' }, { path: 'check.mjs', role: 'frozen', digest: hash(readFileSync(join(root, 'check.mjs'))) }], checks: [cmd('check.mjs')] } } };
    const path = join(root, 'reliability.json');
    writeFileSync(path, JSON.stringify(cfg));
    git(root, ['add', 'reliability.json']);
    git(root, ['commit', '-m', 'register guard recovery contract']);
    return { root, run, cfg, path, repairAudit, reviewAudit };
}

function invoke(f, action) {
    const r = spawnSync(process.execPath, [cli, 'reliable', action, '--config', f.path, '--json'], { encoding: 'utf8', windowsHide: true, timeout: 150000 });
    assert.equal(r.error, undefined, r.error?.message);
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
    return JSON.parse(readFileSync(join(f.root, 'dag.run.d', 'reliability', 'controller.json'), 'utf8'));
}

function lines(path) {
    assert.ok(existsSync(path), `Expected actual command invocation in ${path}`);
    return readFileSync(path, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
}

function assertPublished(f, state, repairAttempts, semanticRejections) {
    assert.equal(loadRun(join(f.root, 'dag.run.json')).tasks.task_one.status, 'completed');
    assert.deepEqual(state.suspended, {});
    assert.equal(state.semanticCounts.task_one, semanticRejections);
    assert.equal(state.attempts.task_one.filter(a => a.kind === 'repair').length, repairAttempts);
    assert.equal(Object.values(state.incidents).length, 1);
    const incident = Object.values(state.incidents)[0];
    assert.equal(incident.phase, 'resolved');
    assert.equal(incident.rejections, 1);
    assert.equal(incident.review.verdict, 'pass');
    assert.equal(incident.reviewReceipt.code, 0);
    assert.ok(incident.checkReceipts.length > 0);
    assert.ok(incident.checkReceipts.every(r => r.code === 0));
    assert.equal(state.history.filter(e => e.event === 'published').length, 1);
    // Repair review and the fresh task's independent postcondition both run.
    assert.equal(lines(f.reviewAudit).length, 2);
    assert.equal(lines(f.reviewAudit)[0].code, 0);
    assert.match(lines(f.reviewAudit)[0].output, /protected original acceptance/);
    assert.equal(git(f.root, ['show', `dag/${f.run.id}:value.txt`]), 'good');
    assert.equal(git(f.root, ['show', `dag/${f.run.id}:acceptance.test.mjs`]), corrected.trim());
    assert.equal(readFileSync(join(f.root, 'acceptance.test.mjs'), 'utf8'), baseline);
    assert.equal(readFileSync(join(f.root, 'value.txt'), 'utf8'), 'bad');
    assert.equal(state.metrics.manualInterventions, 0);
}

test('real CLI corrects rejected new test support, reviews, publishes and completes a fresh task', { timeout: 180000 }, () => {
    const f = fixture();
    const state = invoke(f, 'run');
    assertPublished(f, state, 2, 2);
    const repairs = lines(f.repairAudit);
    assert.equal(repairs.length, 2);
    assert.equal(repairs[0].lastFailure, null);
    assert.equal(repairs[1].lastFailure.validationRule, 'test_support');
    assert.equal(repairs[1].before, invalid);
    assert.equal(state.attempts.task_one[0].semanticRejected, true);
    const resumed = invoke(f, 'resume');
    assertPublished(f, resumed, 2, 2);
    assert.equal(lines(f.repairAudit).length, 2);
});

test('resume reclassifies retained legacy test-support suspension without operator release', { timeout: 180000 }, () => {
    const f = fixture();
    const base = git(f.root, ['rev-parse', 'HEAD']);
    git(f.root, ['branch', `dag/${f.run.id}`, base]);
    f.run.tasks.task_one.status = 'failed';
    f.run.tasks.task_one.failureKind = 'exit';
    const failure = { version: 1, code: 'implementation', stage: 'work', owner: 'task_one', evidence: ['value.txt must contain good'] };
    f.run.tasks.task_one.result = 'DAG_FAILURE: ' + JSON.stringify(failure);
    saveRun(f.run, join(f.root, 'dag.run.json'));
    const dir = join(f.root, 'dag.run.d', 'reliability');
    mkdirSync(dir, { recursive: true });
    const worktree = join(dir, 'incident_legacy');
    git(f.root, ['worktree', 'add', '--detach', worktree, base]);
    writeFileSync(join(worktree, 'acceptance.test.mjs'), invalid);
    const ledger = openLedger(dir, f.run.id, hash(readFileSync(f.path, 'utf8')), { wallMs: 180000 });
    ledger.state.graphRevision = graphIdentity(f.run);
    ledger.state.semanticCounts = {};
    ledger.state.infrastructureCounts = {};
    ledger.state.attempts.task_one = [];
    ledger.state.incidents.incident_legacy = { id: 'incident_legacy', taskId: 'task_one', phase: 'repair', base, worktree, scope: ['value.txt', 'acceptance.test.mjs'], failure, rejections: 0, infraRetries: 0 };
    ledger.state.suspended.task_one = { failure: { version: 1, code: 'contract', stage: 'recovery', owner: 'task_one', evidence: ['New test support code requires a separate registered file: acceptance.test.mjs'] }, reason: 'suspend_decision', at: Date.now() };
    ledger.save('injected-legacy-suspension');
    const deadline = ledger.state.deadline;
    const state = invoke(f, 'resume');
    assertPublished(f, state, 1, 1);
    assert.equal(state.deadline, deadline);
    const repairs = lines(f.repairAudit);
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0].lastFailure.validationRule, 'test_support');
    assert.equal(repairs[0].before, invalid);
});

for (const [rule, source] of [['test_support', invalid], ['acceptance_modified', baseline.replace('2 + 2, 4', '2 + 2, 5')]]) {
    test(`test guard exposes typed implementation failure for ${rule}`, () => {
        const f = fixture();
        const base = git(f.root, ['rev-parse', 'HEAD']);
        writeFileSync(join(f.root, 'acceptance.test.mjs'), source);
        assert.throws(() => guardDiff(f.cfg, 'task_one', f.root, base, ['value.txt', 'acceptance.test.mjs']), e => {
            assert.equal(e.failure.code, 'implementation');
            assert.equal(e.failure.validationRule, rule);
            assert.ok(e.failure.evidence.some(x => x.includes('acceptance.test.mjs')));
            return true;
        });
    });
}

test('frozen contract mutation and changed Git history remain hard stops', () => {
    const f = fixture();
    const base = git(f.root, ['rev-parse', 'HEAD']);
    const original = readFileSync(join(f.root, 'check.mjs'));
    writeFileSync(join(f.root, 'check.mjs'), 'process.exit(0);');
    assert.throws(() => guardDiff(f.cfg, 'task_one', f.root, base, ['check.mjs']), e => {
        assert.match(e.message, /Frozen contract changed/);
        assert.notEqual(e.failure?.code, 'implementation');
        return true;
    });
    writeFileSync(join(f.root, 'check.mjs'), original);
    git(f.root, ['commit', '--allow-empty', '-m', 'unauthorized worker history']);
    assert.throws(() => guardDiff(f.cfg, 'task_one', f.root, base, ['value.txt']), e => {
        assert.match(e.message, /Worker changed Git history/);
        assert.notEqual(e.failure?.code, 'implementation');
        return true;
    });
});

test('quota during repair does not count retained invalid test support as another rejection', { timeout: 180000 }, () => {
    const f = fixture();
    writeFileSync(join(f.root, 'repair.mjs'), `import fs from 'node:fs';
fs.writeFileSync('acceptance.test.mjs', ${JSON.stringify(invalid)});
console.log('DAG_FAILURE: '+JSON.stringify({version:1,code:'quota',stage:'repair',owner:'task_one',evidence:['provider exhausted']}));process.exit(1);`);
    git(f.root, ['add', 'repair.mjs']);
    git(f.root, ['commit', '-m', 'quota with retained test violation']);
    const r = spawnSync(process.execPath, [cli, 'reliable', 'run', '--config', f.path, '--json'], { encoding: 'utf8', windowsHide: true, timeout: 150000 });
    assert.equal(r.status, 1, r.stderr);
    const state = JSON.parse(readFileSync(join(f.root, 'dag.run.d', 'reliability', 'controller.json')));
    assert.equal(state.suspended.task_one.failure.code, 'quota');
    assert.equal(state.semanticCounts.task_one, 1, 'Only the original implementation failure is charged');
    assert.equal(state.attempts.task_one.find(a => a.kind === 'repair').semanticRejected, false);
    assert.equal(Object.values(state.incidents)[0].rejections, 0);
});
