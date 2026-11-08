import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FlowRunner } from './runner.js';
import { compileFlowPlan } from './graph.js';
import type { Executor } from '../runner.js';
import { git } from '../git-worktree.js';
import { gitRepo } from '../test-helpers.js';
import { loadRun, saveRun } from '../store.js';

const ok = { exitCode: 0, output: 'verification passed\n' };

function fixture() {
  const repo = gitRepo();
  const file = join(repo, 'dag.run.json');
  const { run } = compileFlowPlan({
    version: 3,
    title: 'Flow 3 candidate evidence',
    nodes: [{
      id: 'alpha', goal: 'Write and verify alpha', depends_on: [],
      touches: ['alpha.txt'], creates: ['alpha.txt'], relies_on: [],
      cmd: 'write-alpha', verify: 'verify-alpha',
    }],
    settings: { waveChecks: [], finalChecks: [], repairRounds: 0, nodeRepairRounds: 0 },
  });
  saveRun(run, file);
  return { repo, file, run };
}

async function waitForMarker(file: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`runner exited before the crash marker (exit ${child.exitCode}, signal ${child.signalCode})`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
  }
  throw Error(`timed out waiting for crash marker ${file}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once('exit', () => resolveExit());
    child.once('error', rejectExit);
  });
}

function assertCandidateEvidence(runId: string, task: ReturnType<typeof loadRun>['tasks'][string]) {
  const candidate = task.nodeState?.candidate;
  assert.ok(candidate, 'accepted task must retain its verified candidate');
  assert.ok(candidate.evidenceRef, 'candidate must reference its verifier JSON');
  assert.match(candidate.evidenceHash, /^[a-f0-9]{64}$/);
  const bytes = readFileSync(candidate.evidenceRef);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), candidate.evidenceHash);
  const evidence = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  assert.equal(evidence.runId, runId);
  assert.equal(evidence.task, task.id);
  assert.equal(evidence.phase, 'verify');
  assert.equal(evidence.command, task.node?.verify);
  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.attempt, candidate.attempt);
  assert.equal(evidence.attemptId, candidate.attemptId);
  assert.ok(task.dispatchHistory?.some(dispatch => dispatch.attempt === candidate.attempt &&
    dispatch.attemptId === candidate.attemptId && dispatch.phase === 'work'));
  assert.equal(evidence.definitionDigest, candidate.definition);
  assert.equal(evidence.sourceCommit, candidate.commit);
  assert.equal(evidence.candidateCommit, candidate.commit);
  assert.equal(candidate.integratedCommit, task.diffHead);
  return { candidate, evidence };
}

test('accepted verification evidence survives a hard crash after landing and candidate recovery', { timeout: 60_000 }, async () => {
  const f = fixture();
  const readyFile = join(f.repo, 'crash-ready.json');
  const runnerModule = pathToFileURL(resolve('src/flow3/runner.ts')).href;
  const storeModule = pathToFileURL(resolve('src/store.ts')).href;
  const childCode = `
    const { FlowRunner } = await import(${JSON.stringify(runnerModule)});
    const { loadRun, saveRun } = await import(${JSON.stringify(storeModule)});
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const file = ${JSON.stringify(f.file)}, repo = ${JSON.stringify(f.repo)};
    const run = loadRun(file);
    const executor = async (_task, context, command) => {
      if (command === 'write-alpha') writeFileSync(join(context.cwd, 'alpha.txt'), 'accepted\\n');
      const output = 'ran ' + command + '\\n';
      context.onOutput(output);
      return { exitCode: 0, output };
    };
    await new FlowRunner(run, { cwd: repo, file, executor, persist: state => saveRun(state, file) }, new Set()).start();
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DAG_FLOW3_TEST_CRASH_BOUNDARY: 'merge',
      DAG_FLOW3_TEST_CRASH_READY_FILE: readyFile,
      DAG_FLOW3_TEST_CRASH_RELEASE_FILE: `${readyFile}.release`,
    },
  });

  try {
    await waitForMarker(readyFile, child);
    const marker = JSON.parse(readFileSync(readyFile, 'utf8')) as { boundary: string; taskId: string };
    assert.equal(marker.boundary, 'merge');
    assert.equal(marker.taskId, 'alpha');
    child.kill('SIGKILL');
    await waitForExit(child);

    const interrupted = loadRun(f.file);
    const interruptedTask = interrupted.tasks.alpha;
    assert.equal(interruptedTask.status, 'running');
    const before = assertCandidateEvidence(interrupted.id, interruptedTask);
    assert.ok(before.candidate.integratedCommit);
    assert.equal(git(f.repo, ['cat-file', '-e', `${before.candidate.commit}^{commit}`]).code, 0);
    assert.equal(git(f.repo, ['cat-file', '-e', `${before.candidate.integratedCommit}^{commit}`]).code, 0);
    assert.equal(git(f.repo, ['merge-base', '--is-ancestor', before.candidate.commit, before.candidate.integratedCommit]).code, 0);

    const dispatched: string[] = [];
    const recoveredRunner = new FlowRunner(interrupted, {
      cwd: f.repo,
      file: f.file,
      persist: state => saveRun(state, f.file),
      executor: async (_task, context, command) => {
        dispatched.push(`${context.env?.DAG_PHASE}:${command}`);
        return ok;
      },
    }, new Set());
    await recoveredRunner.start();

    const recovered = loadRun(f.file);
    assert.equal(recovered.tasks.alpha.status, 'completed');
    assert.deepEqual(dispatched, ['integration:verify-alpha'], 'candidate recovery must skip work and local verify while retaining final acceptance checks');
    const after = assertCandidateEvidence(recovered.id, recovered.tasks.alpha);
    assert.equal(after.candidate.commit, before.candidate.commit);
    assert.equal(after.candidate.attemptId, before.candidate.attemptId);
    assert.equal(after.candidate.evidenceRef, before.candidate.evidenceRef);
    assert.equal(after.candidate.evidenceHash, before.candidate.evidenceHash);
    assert.equal(after.candidate.integratedCommit, before.candidate.integratedCommit);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
  }
});

test('failed node verification keeps diagnostic evidence but creates no accepted candidate', async () => {
  const f = fixture();
  const executor: Executor = async (_task, context, command) => {
    if (command === 'write-alpha') writeFileSync(join(context.cwd!, 'alpha.txt'), 'unaccepted\n');
    const outcome = command === 'verify-alpha' ? { exitCode: 1, output: 'verification failed\n' } : ok;
    context.onOutput(outcome.output);
    return outcome;
  };
  const runner = new FlowRunner(f.run, {
    cwd: f.repo,
    file: f.file,
    executor,
    persist: state => saveRun(state, f.file),
  }, new Set());
  await runner.start();

  const saved = loadRun(f.file);
  const task = saved.tasks.alpha;
  assert.equal(task.status, 'failed');
  assert.equal(task.nodeState?.candidate, undefined);
  const failed = task.nodeState?.latestFailedChecks?.at(-1);
  assert.equal(failed?.passed, false);
  assert.ok(failed?.evidenceRef, 'the failed verifier should retain its diagnostic evidence file');
  const evidence = JSON.parse(readFileSync(failed.evidenceRef!, 'utf8')) as { task: string; phase: string; exitCode: number };
  assert.equal(evidence.task, 'alpha');
  assert.equal(evidence.phase, 'verify');
  assert.equal(evidence.exitCode, 1);
});
