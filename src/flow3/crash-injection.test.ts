import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { FlowRunner, CRASH_BOUNDARIES, type CrashBoundary, type CrashBoundaryEvent, type FlowCrashProbe } from './runner.js';
import { compileFlowPlan } from './graph.js';
import { git } from '../git-worktree.js';
import { gitRepo } from '../test-helpers.js';
import { loadRun, runPaths, saveRun } from '../store.js';
import type { Executor } from '../runner.js';

const testBoundary = 'DAG_FLOW3_TEST_CRASH_BOUNDARY';
const testReadyFile = 'DAG_FLOW3_TEST_CRASH_READY_FILE';
const testReleaseFile = 'DAG_FLOW3_TEST_CRASH_RELEASE_FILE';

function fixture() {
  const repo = gitRepo();
  const file = join(repo, 'dag.run.json');
  const { run } = compileFlowPlan({
    version: 3,
    title: 'Flow 3 crash boundary probes',
    nodes: [{
      id: 'alpha',
      goal: 'Write and verify alpha',
      depends_on: [],
      touches: ['alpha.txt'],
      creates: ['alpha.txt'],
      relies_on: [],
      cmd: 'write-alpha',
      verify: 'verify-alpha',
    }],
    settings: { waveChecks: ['wave-check'], finalChecks: ['final-check'], repairRounds: 0 },
  });
  run.settings.finalReview = 'off';
  saveRun(run, file);
  return { repo, file, run };
}

const executor: Executor = async (_task, context, command) => {
  const output = `ran ${command}\n`;
  if (command === 'write-alpha') writeFileSync(join(context.cwd!, 'alpha.txt'), 'accepted\n');
  context.onOutput(output);
  return { exitCode: 0, output };
};

function runner(f: ReturnType<typeof fixture>, crashProbe?: FlowCrashProbe) {
  return new FlowRunner(f.run, {
    cwd: f.repo,
    file: f.file,
    executor,
    persist: state => saveRun(state, f.file),
    crashProbe,
  }, new Set());
}

async function clearTestProbeEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const names = [testBoundary, testReadyFile, testReleaseFile];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try { return await run(); }
  finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function expectDurablePlacement(f: ReturnType<typeof fixture>, boundary: CrashBoundary, event: CrashBoundaryEvent) {
  assert.equal(event.runId, f.run.id);
  const saved = loadRun(f.file);
  const task = saved.tasks.alpha;
  if (boundary === 'finalization') {
    assert.equal(event.taskId, undefined);
    assert.equal(event.attemptId, undefined);
    assert.equal(event.attempt, 0);
    assert.equal(event.durableRef, runPaths(f.file).state);
    assert.equal(task.status, 'completed');
    assert.equal(saved.flowState?.acceptanceStatus, 'passed');
  } else {
    assert.ok(event.attemptId, `${boundary} should identify its attempt`);
    assert.equal(event.attempt, 1);
    assert.equal(event.attemptId, task.dispatchHistory?.find(record => record.phase === 'work')?.attemptId);
  }
  if (boundary === 'worker-launch') {
    assert.equal(task.status, 'running');
    assert.equal(task.dispatchHistory?.at(-1)?.disposition, 'not-dispatched');
    assert.equal(event.durableRef, runPaths(f.file).state);
    assert.ok(existsSync(event.durableRef));
  } else if (boundary === 'result-capture') {
    assert.equal(task.dispatchHistory?.at(-1)?.disposition, 'ambiguous');
    assert.equal(task.dispatchHistory?.at(-1)?.terminalAt, undefined);
    assert.ok(event.durableRef && existsSync(event.durableRef), 'captured output log should be durable');
  } else if (boundary === 'verdict-persistence') {
    assert.equal(task.dispatchHistory?.at(-1)?.disposition, 'captured');
    assert.ok(event.durableRef && existsSync(event.durableRef), 'verification evidence should be durable');
    const evidence = JSON.parse(readFileSync(event.durableRef!, 'utf8')) as { exitCode: number; phase: string };
    assert.equal(evidence.phase, 'verify');
    assert.equal(evidence.exitCode, 0);
  } else if (boundary === 'commit') {
    assert.ok(event.durableRef?.startsWith('refs/heads/dag-node/'));
    assert.equal(git(f.repo, ['show-ref', '--verify', event.durableRef!]).code, 0, 'candidate ref should exist before candidate state is saved');
    assert.equal(task.nodeState?.candidate, undefined);
  } else if (boundary === 'merge') {
    assert.equal(task.status, 'running', 'the accepted task status is written after the merge boundary');
    assert.equal(task.diffHead, event.durableRef);
    assert.ok(task.nodeState?.candidate);
  }
}

test('FlowRunner exposes each boundary immediately after its durable operation', async () => {
  await clearTestProbeEnvironment(async () => {
    const f = fixture();
    const observed: { boundary: CrashBoundary; event: CrashBoundaryEvent }[] = [];
    const crashProbe: FlowCrashProbe = {
      async afterDurableBoundary(boundary, event) {
        expectDurablePlacement(f, boundary, event);
        observed.push({ boundary, event });
      },
    };

    await runner(f, crashProbe).start();

    assert.deepEqual(observed.map(item => item.boundary), CRASH_BOUNDARIES);
    assert.equal(f.run.tasks.alpha.status, 'completed');
  });
});

test('crash hooks are disabled by default', async () => {
  await clearTestProbeEnvironment(async () => {
    const f = fixture();
    const marker = join(f.repo, 'unexpected-crash-marker.json');

    await runner(f).start();

    assert.equal(f.run.tasks.alpha.status, 'completed');
    assert.equal(existsSync(marker), false);
  });
});

async function waitForMarker(file: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(file)) return;
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`CLI exited before publishing its crash marker (exit ${child.exitCode}, signal ${child.signalCode})`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
  }
  throw Error(`Timed out waiting for crash marker ${file}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once('exit', () => resolveExit());
    child.once('error', rejectExit);
  });
}

test('real CLI publishes the launch marker before the parent terminates it', { timeout: 20_000 }, async () => {
  const f = fixture();
  const readyFile = join(f.repo, 'crash-ready.json');
  const cli = resolve(process.cwd(), 'src/cli.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'run', '--file', f.file, '--json'], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      [testBoundary]: 'worker-launch',
      [testReadyFile]: readyFile,
      [testReleaseFile]: `${readyFile}.release`,
    },
  });
  try {
    await waitForMarker(readyFile, child, 15_000);
    const event = JSON.parse(readFileSync(readyFile, 'utf8')) as CrashBoundaryEvent & { boundary: CrashBoundary };
    assert.equal(event.boundary, 'worker-launch');
    assert.equal(event.runId, f.run.id);
    assert.equal(event.taskId, 'alpha');
    assert.equal(event.attempt, 1);
    const saved = loadRun(f.file);
    assert.equal(saved.tasks.alpha.status, 'running');
    assert.equal(saved.tasks.alpha.dispatchHistory?.at(-1)?.disposition, 'not-dispatched');

    child.kill('SIGKILL');
    await waitForExit(child);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
  }
});
