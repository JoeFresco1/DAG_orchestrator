// Deterministic execution-policy regression benchmark; no coding model is invoked.
// Reproduce after npm run build: node scripts/lean-batch-benchmark.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DagRunner } from '../dist/runner.js';
import { compilePlan } from '../dist/planning/compile.js';
import { digest } from '../dist/planning/contracts.js';
import { executionProfilePatch } from '../dist/execution-policy.js';
import { executionReport } from '../dist/execution-report.js';
import { git, headCommit } from '../dist/git-worktree.js';
import { saveRun } from '../dist/store.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(project, 'docs/build/recommendations-lean-batch.json'));
const repo = mkdtempSync(join(tmpdir(), 'dag-lean-batch-'));
git(repo, ['init', '-q']);
writeFileSync(join(repo, 'baseline.txt'), 'fixed synthetic lean batch baseline v1\n');
git(repo, ['add', 'baseline.txt']);
const initial = git(repo, ['-c', 'user.name=synthetic-benchmark', '-c', 'user.email=benchmark@localhost',
  '-c', 'core.hooksPath=', 'commit', '-q', '-m', 'fixed baseline'],
  { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
assert.equal(initial.code, 0, initial.stderr);
const baseline = headCommit(repo);
const tasks = [];
for (let component = 0; component < 8; component++) {
  for (const member of ['a', 'b', 'consumer']) {
    const id = `task_c${component}_${member}`;
    const names = member === 'consumer' ? [`c${component}_a`, `c${component}_b`, `c${component}_consumer`] : [`c${component}_${member}`];
    const check = { id: `check_c${component}_${member}`, program: process.execPath,
      args: ['-e', `const fs=require('fs');for(const n of ${JSON.stringify(names)}){if(fs.readFileSync('docs/'+n+'.txt','utf8')!==n)throw Error('wrong output '+n)}`], timeoutMs: 10_000 };
    tasks.push({ id, title: `Component ${component} ${member}`, objective: `Produce ${member} document`,
      reviewBoundary: `Component ${component} ${member} document only`, requirements: [id.replace('task_', 'req_')],
      acceptance: [id.replace('task_', 'criterion_')], checks: [check],
      files: [{ path: `docs/c${component}_${member}.txt`, role: 'implementation' }], cmd: `fixture-${id}`,
      ...(member === 'consumer' ? { inputs: ['a', 'b'].map(producer => ({ capability: `c${component}_${producer}`, contract: `Component ${component} ${producer} document exists` })) }
        : { provides: [{ id: `c${component}_${member}`, contract: `Component ${component} ${member} document exists`, check }] }) });
  }
}
const manifest = { version: 2, id: 'fixed-lean-batch-v1', title: 'Fixed synthetic 24 task batch', sources: [], semanticReview: { mode: 'off' },
  requirements: tasks.map(task => ({ id: task.requirements[0], title: task.title, description: task.objective, acceptance: task.acceptance })),
  criteria: tasks.map(task => ({ id: task.acceptance[0], requirement: task.requirements[0], owner: task.id,
    text: task.objective, stage: 'local', contributors: [task.id], checks: [task.checks[0].id] })), tasks };
const run = compilePlan(manifest);
Object.assign(run.settings, executionProfilePatch('lean'), { concurrency: 3, implementationAttempts: 1,
  taskDeadlineMs: 900_000, timeoutMs: 60_000, silenceMs: 0, infrastructureRetries: 0 });
const file = join(repo, 'dag.run.json');
saveRun(run, file);
const observedConsumers = [], events = [];
let workers = 0, checks = 0;
const startedAt = new Date().toISOString(), started = performance.now();
const runner = new DagRunner(run, { cwd: repo, file, persist: state => saveRun(state, file),
  onEvent: event => { events.push(event); if (event.type === 'task-done') console.log(`accepted ${event.taskId ?? event.task ?? ''}`); },
  executor: async (task, context, command) => {
    if (command?.startsWith('fixture-')) {
      workers++;
      const name = task.id.slice('task_'.length), component = name.match(/^c\d+/)[0];
      if (name.endsWith('_consumer')) {
        for (const producer of ['a', 'b']) assert.equal(readFileSync(join(context.cwd, `docs/${component}_${producer}.txt`), 'utf8'), `${component}_${producer}`);
        observedConsumers.push(task.id);
      }
      mkdirSync(join(context.cwd, 'docs'), { recursive: true });
      writeFileSync(join(context.cwd, `docs/${name}.txt`), name);
      return { exitCode: 0, output: `deterministic fixture wrote ${name}` };
    }
    const payload = command?.match(/--file ["']([^"']+)["']/)?.[1];
    assert.ok(payload, `Unexpected benchmark command ${command}`);
    checks++;
    const check = JSON.parse(readFileSync(payload, 'utf8'));
    const checked = spawnSync(check.program, check.args, { cwd: context.cwd, encoding: 'utf8', windowsHide: true });
    return { exitCode: checked.status, output: (checked.stdout ?? '') + (checked.stderr ?? '') };
  } });
await runner.start();
const wallClockMs = Math.round(performance.now() - started);
const report = executionReport(run, { root: repo });
const failures = Object.values(run.tasks).filter(task => task.status !== 'completed').map(task => ({ id: task.id, status: task.status, result: task.result }));
const result = { version: 1, kind: 'synthetic-deterministic-regression', startedAt, finishedAt: new Date().toISOString(),
  command: 'npm run build && node scripts/lean-batch-benchmark.mjs', argv: process.argv, platform: process.platform,
  node: process.version, gitVersion: git(repo, ['--version']).stdout, fixtureRepo: repo, runFile: file,
  baselineCommit: baseline, acceptedCommit: git(repo, ['rev-parse', `dag/${run.id}`]).stdout,
  manifestFingerprint: digest(manifest), settings: run.settings, executionBuild: run.executionPolicy?.build,
  components: 8, taskCount: 24, concurrency: 3, deterministicWorkerDispatches: workers, deterministicCheckDispatches: checks,
  observedConsumerCount: observedConsumers.length, wallClockMs, failures,
  protocolFailures: Object.values(run.tasks).filter(task => task.failureKind === 'review-protocol').length,
  implementationRetries: Object.values(run.tasks).reduce((total, task) => total + Math.max(0, task.attempts - 1), 0),
  repairEvents: events.filter(event => event.type === 'task-repair').length,
  scope: 'Actual Git worktrees, canonical check payloads, integration rechecks, CAS publication and durable receipts. Fixture workers write small documentation files. No language model calls or semantic reviewer performance is measured.',
  report };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, wallClockMs, completed: 24 - failures.length, checks, consumers: observedConsumers.length,
  timeToFirstIntegratedMs: report.timeToFirstIntegratedMs, criteriaPerHour: report.acceptance.criteriaPerHour }));
assert.deepEqual(failures, []);
assert.equal(observedConsumers.length, 8);
assert.equal(report.integration.publishedReceiptTasks.length, 24);
assert.equal(headCommit(repo), baseline, 'User baseline must remain unchanged');
