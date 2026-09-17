import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireLock,
  addTask,
  buildIntegrationSpec,
  editTask,
  loadRun,
  lockHeldBy,
  logEvent,
  mutate,
  newRun,
  readEventLog,
  readLock,
  recordHeartbeat,
  orphanedPids,
  recoverInterrupted,
  removeTask,
  retryFailed,
  retryTask,
  runPaths,
  saveRun,
} from './store.js';
import {
  assertNoCycle,
  computeDepths,
  getBlocked,
  getReady,
  topoSort,
  transitiveBlocked,
} from './graph.js';
import { DagRunner, parseVerdict, renderTokens, resolveHarness, shellExecutor, sleep, type ExecContext } from './runner.js';
import { parseHarnessChain } from './harness-chain.js';
import { describeDeps } from './graph.js';
import { decideReviewers, globMatches, parseWhen, type Reviewer } from './review-policy.js';
import { resolveCommand } from './command-resolution.js';
import {
  commitAll,
  createTaskWorktree,
  ensureIntegrationWorktree,
  git,
  mergeIntoIntegration,
  removeWorktree,
  snapshotCommit,
  snapshotExcludes,
} from './git-worktree.js';
import { addProject, loadRegistry, projectId, removeProject, saveRegistry } from './registry.js';
import { addJob, decideDue, jobArgsToArgv, loadSchedule, parseAt, removeJob, retryJob } from './scheduler.js';
import type { Run, Task } from './types.js';

function make(ids: string[]): { run: Run; [k: string]: unknown } {
  const run = newRun('t');
  const tasks: Record<string, Task> = {};
  for (const id of ids) tasks[id] = addTask(run, { title: id, spec: '' });
  return { run, ...tasks };
}

function never(_task: Task, _ctx: ExecContext): Promise<never> {
  return new Promise<never>(() => {});
}

function runsDir(file: string): string {
  return runPaths(file).dir;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dag-'));
}

describe('dag edits', () => {
  it('edits title/spec/deps in place', () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: 'sa' });
    const b = addTask(run, { title: 'b', spec: 'sb', deps: [a.id] });
    editTask(run, b.id, { title: 'b2', spec: 'sb2', deps: [] });
    assert.equal(run.tasks[b.id].title, 'b2');
    assert.deepEqual(run.tasks[b.id].deps, []);
  });

  it('rejects cycles on edit and rolls back', () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '', deps: [a.id] });
    assert.throws(() => editTask(run, a.id, { deps: [b.id] }), /cycle/);
    assert.deepEqual(run.tasks[a.id].deps, []);
  });

  it('deletes a node and strips it from dependents', () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '', deps: [a.id] });
    removeTask(run, a.id);
    assert.ok(!run.tasks[a.id]);
    assert.deepEqual(run.tasks[b.id].deps, []);
  });
});

describe('scheduling', () => {
  it('only surfaces deps-met tasks as ready, in topo order', () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '', deps: [a.id] });
    assert.deepEqual(getReady(run).map((t) => t.id), [a.id]);
    run.tasks[a.id].status = 'completed';
    assert.deepEqual(getReady(run).map((t) => t.id), [b.id]);
    assert.deepEqual(topoSort(run).map((t) => t.id), [a.id, b.id]);
    assertNoCycle(run);
  });

  it('marks downstream of failures blocked, transitively', () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '', deps: [a.id] });
    const c = addTask(run, { title: 'c', spec: '', deps: [b.id] });
    run.tasks[a.id].status = 'failed';
    const blocked = getBlocked(run).map((t) => t.id);
    assert.deepEqual(blocked, [b.id, c.id]);
    assert.ok(transitiveBlocked(run, c.id));
    assert.deepEqual(getReady(run), []);
  });

  it('launches independent tasks in deterministic order with concurrency 1', async () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '' });
    const c = addTask(run, { title: 'c', spec: '' });
    const order: string[] = [];
    const runner = new DagRunner(run, {
      concurrency: 1,
      executor: async (t) => {
        order.push(t.id);
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.deepEqual(order, [a.id, b.id, c.id]);
    assert.equal(runner.result?.failed.length, 0);
  });

  it('respects deps across parallel branches', async () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '' });
    const c = addTask(run, { title: 'c', spec: '', deps: [a.id, b.id] });
    const order: string[] = [];
    const runner = new DagRunner(run, {
      concurrency: 2,
      executor: async (t) => {
        order.push(t.id);
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[c.id].status, 'completed');
    assert.ok(order.indexOf(c.id) > order.indexOf(a.id));
    assert.ok(order.indexOf(c.id) > order.indexOf(b.id));
  });

  it('scoped runs only launch selected tasks', async () => {
    const { run, a, b } = make(['a', 'b']) as { run: Run; a: Task; b: Task };
    const runner = new DagRunner(run, {
      executor: async () => ({ output: 'ok', exitCode: 0 }),
    });
    await runner.start(new Set([a.id]));
    assert.equal(run.tasks[a.id].status, 'completed');
    assert.equal(run.tasks[b.id].status, 'pending');
  });

  it('scoped tasks wait on out-of-scope deps', async () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '', deps: [a.id] });
    const runner = new DagRunner(run, {
      executor: async () => ({ output: 'ok', exitCode: 0 }),
    });
    await runner.start(new Set([b.id]));
    assert.equal(run.tasks[b.id].status, 'pending');
  });
});

describe('watchdog and failures', () => {
  it('fails a task on hard timeout even if the executor never settles', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].timeoutMs = 80;
    const runner = new DagRunner(run, { executor: never });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'timeout');
    assert.ok(run.events.some((e) => e.type === 'task-timeout'));
  });

  it('fails a task on output silence when silenceAction is kill', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].timeoutMs = 0;
    run.tasks[a.id].silenceMs = 80;
    run.settings.silenceAction = 'kill';
    const runner = new DagRunner(run, { executor: never });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'stalled');
    assert.ok(run.events.some((e) => e.type === 'task-stalled'));
  });

  it('auto-retries until maxAttempts, then completes', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].maxAttempts = 2;
    let calls = 0;
    const runner = new DagRunner(run, {
      executor: async () => {
        calls += 1;
        if (calls === 1) throw new Error('flaky');
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(calls, 2);
    assert.equal(run.tasks[a.id].status, 'completed');
    assert.equal(run.tasks[a.id].attempts, 2);
    assert.ok(run.events.some((e) => e.type === 'task-retry'));
  });

  it('falls back to the next harness when an attempt fails', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].cmd = 'echo hand-written';
    run.tasks[a.id].harnessChain = parseHarnessChain('opencode,codex');
    const cmds: (string | undefined)[] = [];
    const runner = new DagRunner(run, {
      executor: async (_task, _ctx, cmdOverride) => {
        cmds.push(cmdOverride);
        // Presets run a plan phase first, so the 2nd call is attempt 1's work.
        // A non-zero exit is only recorded, so fail the way a broken CLI does:
        if (cmds.length === 2) throw new Error('spawn failed');
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    // maxAttempts defaults to 1; the chain itself buys the second attempt.
    assert.equal(cmds.length, 4);
    assert.match(cmds[1] ?? '', /opencode run/);
    assert.match(cmds[2] ?? '', /codex exec/);
    assert.match(cmds[3] ?? '', /codex exec/);
    assert.equal(run.tasks[a.id].status, 'completed');
    assert.equal(run.tasks[a.id].attempts, 2);
    assert.equal(run.tasks[a.id].harness, 'codex');
    assert.ok(run.events.some((e) => /falling back to codex/.test(e.message ?? '')));
  });

  it('uses the run-level chain when the task has none', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.settings.harnessChain = parseHarnessChain('codex:gpt-5-codex');
    let cmd = '';
    const runner = new DagRunner(run, {
      executor: async (_task, _ctx, cmdOverride) => {
        cmd = cmdOverride ?? '';
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.match(cmd, /codex exec/);
    assert.match(cmd, /gpt-5-codex/);
    assert.equal(run.tasks[a.id].harness, 'codex');
    assert.equal(run.tasks[a.id].model, 'gpt-5-codex');
  });

  it('falls back when a tool dies with a non-zero exit and nothing judges it', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].harnessChain = parseHarnessChain('opencode,codex');
    run.tasks[a.id].planCmd = null;
    const runner = new DagRunner(run, {
      executor: async () => ({ output: 'rate limited', exitCode: 1 }),
    });
    await runner.start();
    // Auto: the chain makes exit codes decisive, so both candidates get a turn.
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].attempts, 2);
    assert.equal(run.tasks[a.id].failureKind, 'exit');
  });

  it('leaves a non-zero exit alone when a reviewer is judging', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].harnessChain = parseHarnessChain('opencode,codex');
    run.tasks[a.id].planCmd = null;
    run.tasks[a.id].reviewCmd = 'judge';
    const runner = new DagRunner(run, {
      executor: async (_t, _c, command) =>
        command === 'judge'
          ? { output: 'VERDICT: PASS', exitCode: 0 }
          : { output: 'done, exit 1 on cleanup', exitCode: 1 },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'completed');
    assert.equal(run.tasks[a.id].attempts, 1);
  });

  it('records exit kind via the real shell executor', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].cmd = 'definitely-not-a-real-binary-xyz';
    run.tasks[a.id].maxAttempts = 1;
    const runner = new DagRunner(run, { executor: shellExecutor() });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'spawn');
  });
});

describe('stop', () => {
  it('kills running tasks and requeues them as pending', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].timeoutMs = 0;
    run.tasks[a.id].silenceMs = 0;
    const runner = new DagRunner(run, { executor: never, stopGraceMs: 120 });
    void runner.start();
    while (run.tasks[a.id].status !== 'running') await sleep(10);
    await runner.stop();
    assert.equal(runner.isRunning, false);
    assert.equal(run.tasks[a.id].status, 'pending');
    assert.equal(run.tasks[a.id].result, 'stopped by user');
    assert.equal(run.tasks[a.id].failureKind, 'killed');
    assert.ok(run.events.some((e) => e.type === 'run-stop'));
  });

  it('stops a real process tree', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].timeoutMs = 0;
    run.tasks[a.id].silenceMs = 0;
    run.tasks[a.id].cmd = `"${process.execPath}" -e "setTimeout(()=>{},60000)"`;
    const runner = new DagRunner(run, { executor: shellExecutor(), stopGraceMs: 3000 });
    void runner.start();
    while (run.tasks[a.id].status !== 'running') await sleep(10);
    await sleep(150); // let the child actually spawn
    const t0 = Date.now();
    await runner.stop();
    assert.equal(run.tasks[a.id].status, 'pending');
    assert.ok(Date.now() - t0 < 3000, 'stop should not wait for the full grace when the kill works');
  });
});

describe('recovery', () => {
  it('requeues a failed task and unblocks its subtree', () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '', deps: [a.id] });
    run.tasks[a.id].status = 'failed';
    assert.ok(transitiveBlocked(run, b.id));
    retryTask(run, a.id);
    assert.equal(run.tasks[a.id].status, 'pending');
    assert.ok(!transitiveBlocked(run, b.id));
  });

  it('retry-failed cascade requeues the whole failed subtree', () => {
    const run = newRun('t');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '', deps: [a.id] });
    run.tasks[a.id].status = 'failed';
    run.tasks[b.id].status = 'failed';
    retryFailed(run, true);
    assert.equal(run.tasks[a.id].status, 'pending');
    assert.equal(run.tasks[b.id].status, 'pending');
  });

  it('mutate serializes concurrent read-modify-write (no lost updates)', async () => {
    const dir = tempDir();
    const file = join(dir, 'run.json');
    saveRun(newRun('t'), file);
    try {
      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          mutate(file, (run) => {
            logEvent(run, 'note', null, String(i));
          }),
        ),
      );
      const events = readEventLog(file, 100);
      assert.equal(events.length, 25);
      assert.deepEqual(
        events.map((e) => e.message),
        Array.from({ length: 25 }, (_, i) => String(i)),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hardening', () => {
  it('persists definition and state separately, atomically, with a backup', () => {
    const dir = tempDir();
    const file = join(dir, 'dag.run.json');
    const run = newRun('split');
    const a = addTask(run, { title: 'a', spec: 'spec a' });
    saveRun(run, file);
    const paths = runPaths(file);
    assert.ok(existsSync(paths.state), 'state.json written');
    assert.ok(existsSync(paths.events), 'events.jsonl written');
    const def = JSON.parse(readFileSync(paths.file, 'utf8')) as Record<string, unknown>;
    assert.equal(def.storageVersion, 2);
    const defTasks = def.tasks as Record<string, Record<string, unknown>>;
    assert.equal(defTasks[a.id].spec, 'spec a');
    assert.equal(defTasks[a.id].status, undefined, 'definition holds no status');
    const state = JSON.parse(readFileSync(paths.state, 'utf8')) as Record<string, unknown>;
    const stateTasks = state.tasks as Record<string, Record<string, unknown>>;
    assert.equal(stateTasks[a.id].status, 'pending');
    assert.equal(stateTasks[a.id].spec, undefined, 'state holds no spec');
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a legacy single-file run without losing status or events', () => {
    const dir = tempDir();
    const file = join(dir, 'legacy.json');
    const legacy = {
      id: 'run_legacy',
      objective: 'old',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tasks: {
        task_one: {
          id: 'task_one',
          title: 'one',
          spec: 's',
          deps: [],
          status: 'completed',
          cmd: 'true',
          gate: null,
          result: 'ok',
        },
      },
      events: [{ ts: '2026-01-01T00:00:00.000Z', type: 'task-done', taskId: 'task_one', message: 'done' }],
    };
    writeFileSync(file, JSON.stringify(legacy), 'utf8');
    const run = loadRun(file);
    assert.equal(run.tasks.task_one.status, 'completed');
    assert.equal(run.tasks.task_one.result, 'ok');
    saveRun(run, file);
    const reloaded = loadRun(file);
    assert.equal(reloaded.tasks.task_one.status, 'completed');
    assert.ok(reloaded.eventSeq >= 1);
    assert.ok(readEventLog(file, 10).some((e) => e.message === 'done'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('recovers interrupted tasks after a crash', () => {
    const dir = tempDir();
    const file = join(dir, 'run.json');
    const run = newRun('crash');
    const a = addTask(run, { title: 'a', spec: '', cmd: 'true' });
    const b = addTask(run, { title: 'b', spec: '', cmd: 'true' });
    run.tasks[a.id].status = 'running';
    run.tasks[a.id].pid = 999999;
    run.tasks[b.id].status = 'completed';
    saveRun(run, file);
    const reloaded = loadRun(file);
    const recovery = recoverInterrupted(reloaded);
    assert.deepEqual(recovery.requeued, [a.id]);
    assert.deepEqual(recovery.orphanPids, [999999]);
    assert.equal(reloaded.tasks[a.id].status, 'pending');
    assert.equal(reloaded.tasks[a.id].failureKind, 'interrupted');
    // The pid is forgotten, or a later kill-orphans would tree-kill whatever
    // process the OS handed that pid to next.
    assert.equal(reloaded.tasks[a.id].pid, null);
    assert.equal(reloaded.tasks[b.id].status, 'completed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats every recorded pid as an orphan once we own the file', () => {
    const run = newRun('orphans');
    const a = addTask(run, { title: 'a', spec: '', cmd: 'true' });
    const b = addTask(run, { title: 'b', spec: '', cmd: 'true' });
    run.tasks[a.id].status = 'running';
    run.tasks[a.id].pid = 111;
    run.tasks[b.id].status = 'failed';
    run.tasks[b.id].pid = 222;
    // A caller that got past the lock owns the file: nothing here is alive.
    assert.deepEqual(orphanedPids(run).sort(), [111, 222]);
  });

  it('does not write or bump rev when a save changes nothing', () => {
    const dir = tempDir();
    const file = join(dir, 'run.json');
    const run = newRun('noop');
    addTask(run, { title: 'a', spec: '', cmd: 'true' });
    saveRun(run, file);
    const statePath = runPaths(file).state;
    const before = readFileSync(statePath, 'utf8');
    const rev = loadRun(file).rev;
    const reloaded = loadRun(file);
    saveRun(reloaded, file);
    assert.equal(readFileSync(statePath, 'utf8'), before, 'state file untouched');
    assert.equal(loadRun(file).rev, rev, 'rev unchanged');
    // A real change still writes.
    reloaded.tasks[Object.keys(reloaded.tasks)[0]].status = 'completed';
    saveRun(reloaded, file);
    assert.equal(loadRun(file).rev, rev + 1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a legacy event log once, not on every read', () => {
    const dir = tempDir();
    const file = join(dir, 'legacy2.json');
    writeFileSync(
      file,
      JSON.stringify({
        storageVersion: 1,
        id: 'run_legacy2',
        objective: 'old',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        tasks: {},
        events: [{ ts: '2026-01-01T00:00:00.000Z', type: 'task-done', taskId: 'x', message: 'done' }],
      }),
      'utf8',
    );
    loadRun(file);
    loadRun(file);
    loadRun(file);
    const lines = readFileSync(runPaths(file).events, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `one copy of the legacy event (got ${lines.length})`);
    assert.ok(existsSync(runPaths(file).state), 'migration records itself in state.json');
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips transitively blocked tasks and converges with the skip policy', async () => {
    const run = newRun('skip');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '', deps: [a.id] });
    const c = addTask(run, { title: 'c', spec: '', deps: [b.id] });
    const d = addTask(run, { title: 'd', spec: '' });
    const runner = new DagRunner(run, {
      onDepFailure: 'skip',
      executor: async (t) => {
        if (t.id === a.id) throw new Error('boom');
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[b.id].status, 'skipped');
    assert.equal(run.tasks[c.id].status, 'skipped');
    assert.equal(run.tasks[d.id].status, 'completed');
    assert.deepEqual(runner.result?.unfinished, []);
  });

  it('skips gated tasks when the gate policy says skip', async () => {
    const run = newRun('gates');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '' });
    run.tasks[b.id].gate = { question: 'ship?', options: ['yes'], approved: null };
    const runner = new DagRunner(run, {
      onGateBlocked: 'skip',
      executor: async () => ({ output: 'ok', exitCode: 0 }),
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'completed');
    assert.equal(run.tasks[b.id].status, 'skipped');
  });

  it('stops launching when the wall-clock budget is reached', async () => {
    const run = newRun('budget');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '' });
    const runner = new DagRunner(run, {
      concurrency: 1,
      maxWallClockMs: 60,
      executor: async () => {
        await sleep(120);
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(runner.result?.budgetReached, true);
    const states = [run.tasks[a.id].status, run.tasks[b.id].status];
    assert.ok(states.filter((s) => s === 'completed').length <= 1);
    assert.ok(runner.result?.unfinished.length ?? 0 > 0);
  });

  it('writes a per-attempt log with the task output', async () => {
    const dir = tempDir();
    const file = join(dir, 'run.json');
    const run = newRun('logs');
    const a = addTask(run, { title: 'a', spec: '', cmd: 'node -p 1' });
    saveRun(run, file);
    const runner = new DagRunner(run, {
      file,
      executor: shellExecutor(),
      persist: (state) => saveRun(state, file),
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'completed');
    await sleep(50); // let the stream flush
    const content = readFileSync(runPaths(file).logs + `/${a.id}.1.log`, 'utf8');
    assert.match(content, /1/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('retries stalled tasks when attempts remain', async () => {
    const run = newRun('stall-retry');
    const a = addTask(run, { title: 'a', spec: '' });
    run.tasks[a.id].silenceMs = 60;
    run.tasks[a.id].timeoutMs = 0;
    run.settings.silenceAction = 'kill';
    run.tasks[a.id].maxAttempts = 2;
    const runner = new DagRunner(run, { executor: never });
    await runner.start();
    assert.equal(run.tasks[a.id].attempts, 2);
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'stalled');
    assert.ok(run.events.some((e) => e.type === 'task-retry'));
  });

  it('refuses to steal a live lock and steals a stale one', () => {
    const dir = tempDir();
    const file = join(dir, 'run.json');
    saveRun(newRun('lock'), file);
    const paths = runPaths(file);
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 15000)'], { stdio: 'ignore' });
    try {
      writeFileSync(
        paths.lock,
        JSON.stringify({ pid: child.pid, host: hostname(), startedAt: 'x', note: 'test' }),
      );
      assert.throws(() => acquireLock(file, 'mine'), /locked by pid/);
      writeFileSync(
        paths.lock,
        JSON.stringify({ pid: 999999999, host: hostname(), startedAt: 'x', note: 'dead' }),
      );
      const release = acquireLock(file, 'mine');
      assert.equal(readLock(file)?.note, 'mine');
      release();
      assert.equal(readLock(file), null);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('end-of-run review', () => {
  it('is off by default: no extra agent runs', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].cmd = 'work';
    const ran: string[] = [];
    const runner = new DagRunner(run, {
      executor: async (_t, _c, cmd) => {
        ran.push(cmd ?? '');
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.deepEqual(ran, ['work']);
    assert.equal(runner.result?.finalReview, null);
  });

  it('reviews each completed task and sends a rejected one back once', async () => {
    const { run, a, b } = make(['a', 'b']) as { run: Run; a: Task; b: Task };
    run.tasks[a.id].cmd = 'work-a';
    run.tasks[b.id].cmd = 'work-b';
    run.tasks[a.id].diffBase = 'base1';
    run.tasks[a.id].diffHead = 'head1';
    run.tasks[b.id].diffBase = 'base2';
    run.tasks[b.id].diffHead = 'head2';
    run.settings.worktree = 'task';
    run.settings.finalReview = 'per-task';
    run.settings.finalReviewCmd = 'review {diffFile}';
    const reviews = new Map<string, number>();
    const prompts: string[] = [];
    const runner = new DagRunner(run, {
      executor: async (task, _c, cmd) => {
        if (cmd?.startsWith('review')) {
          reviews.set(task.id, (reviews.get(task.id) ?? 0) + 1);
          prompts.push(task.spec ?? '');
          const first = (reviews.get(task.id) ?? 0) === 1;
          return {
            output: first && task.id === b.id ? 'why: missing test\nVERDICT: FAIL: no test for the new branch' : 'VERDICT: PASS',
            exitCode: 0,
          };
        }
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].finalReview?.verdict, 'pass');
    assert.equal(run.tasks[b.id].finalReview?.verdict, 'pass', 'the rejected task is reviewed again after the fix');
    assert.equal(reviews.get(b.id), 2);
    assert.equal(run.tasks[b.id].attempts, 2, 'the fix is a real second attempt');
    // The review notes reached the redo prompt.
    assert.match(run.tasks[b.id].result ?? '', /ok|no output/i);
    assert.ok(run.events.some((e) => /end-of-run review/.test(e.message ?? '')));
    assert.ok(prompts.some((p) => p.includes('Code review of one task')));
    assert.equal(runner.result?.finalReview?.verdict, 'pass');
    // The final pass saw nothing failing: b was fixed and re-reviewed.
    assert.deepEqual(runner.result?.finalReview?.failed, []);
    assert.ok(run.events.some((e) => /review rejected the work; requeued/.test(e.message ?? '')));
  });

  it('fails the task when a rejection has no rounds left', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].cmd = 'work';
    run.tasks[a.id].diffBase = 'base';
    run.tasks[a.id].diffHead = 'head';
    run.settings.worktree = 'task';
    run.settings.finalReview = 'per-task';
    run.settings.finalReviewRounds = 0;
    run.settings.finalReviewCmd = 'review {diffFile}';
    const runner = new DagRunner(run, {
      executor: async (_t, _c, cmd) =>
        cmd?.startsWith('review')
          ? { output: 'VERDICT: FAIL: the migration is not reversible', exitCode: 0 }
          : { output: 'ok', exitCode: 0 },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'review');
    assert.match(run.tasks[a.id].result ?? '', /end-of-run review failed/);
    assert.equal(runner.result?.finalReview?.verdict, 'fail');
    assert.deepEqual(runner.result?.finalReview?.failed, [a.id]);
    assert.deepEqual(runner.result?.finalReview?.requeued, []);
  });

  it('reviews the whole run when isolation is off', async () => {
    const { run, a, b } = make(['a', 'b']) as { run: Run; a: Task; b: Task };
    run.tasks[a.id].cmd = 'work-a';
    run.tasks[b.id].cmd = 'work-b';
    run.settings.worktree = 'none';
    run.settings.finalReview = 'per-task';
    run.settings.finalReviewCmd = 'review {diffFile}';
    const calls: string[] = [];
    const runner = new DagRunner(run, {
      executor: async (_t, _c, cmd) => {
        calls.push(cmd ?? '');
        return cmd?.startsWith('review') ? { output: 'VERDICT: PASS', exitCode: 0 } : { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    // One run-level reviewer, not one per task.
    assert.equal(calls.filter((c) => c.startsWith('review')).length, 1);
    assert.equal(runner.result?.finalReview?.mode, 'run');
    assert.ok(run.events.some((e) => /reviewing the run as a whole/.test(e.message ?? '')));
  });

  it('honours an explicit review command and writes the diff where the reviewer can read it', async () => {
    const dir = tempDir();
    const file = join(dir, 'dag.run.json');
    const run = newRun('review-cmd');
    const a = addTask(run, { title: 'work', spec: 'do the thing', cmd: 'work' });
    run.tasks[a.id].diffBase = 'base';
    run.tasks[a.id].diffHead = 'head';
    run.settings.finalReview = 'per-task';
    run.settings.finalReviewCmd = 'my-reviewer {diffFile} {files}';
    saveRun(run, file);
    let seen = '';
    const runner = new DagRunner(run, {
      file,
      persist: (state) => saveRun(state, file),
      executor: async (_task, _c, cmd) => {
        seen = cmd ?? '';
        if (cmd?.startsWith('my-reviewer')) {
          return { output: 'VERDICT: PASS', exitCode: 0 };
        }
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.match(seen, /my-reviewer /);
    // No worktree isolation here, so the review covers the run as a whole.
    assert.ok(existsSync(join(runPaths(file).dir, 'reviews', 'run.diff')), 'diff file written');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('chain review tasks (tasks about other tasks)', () => {
  it('renders the coverage facts into the spec and lets the verdict decide', async () => {
    const dir = tempDir();
    const file = join(dir, 'dag.run.json');
    const run = newRun('chain');
    const a = addTask(run, { title: 'first', spec: 'do a', cmd: 'work' });
    const b = addTask(run, { title: 'second', spec: 'do b', cmd: 'work' });
    run.tasks[a.id].diffBase = 'base-a';
    run.tasks[a.id].diffHead = 'head-a';
    run.tasks[b.id].diffBase = 'base-b';
    run.tasks[b.id].diffHead = 'head-b';
    const chain = addTask(run, {
      title: 'review the chain',
      spec: 'Covered:\n{coverage}\nmanifest: {coverageManifest}\nfiles: {coverageFiles}',
      cmd: 'chain {spec}',
      deps: [a.id, b.id],
      covers: [a.id, b.id],
    });
    saveRun(run, file);
    let seenSpec = '';
    const runner = new DagRunner(run, {
      file,
      persist: (state) => saveRun(state, file),
      executor: async (task, _c, cmd) => {
        if (cmd?.startsWith('chain ')) {
          seenSpec = task.spec;
          return { output: 'looked at both diffs\nVERDICT: PASS', exitCode: 0 };
        }
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[chain.id].status, 'completed');
    assert.equal(run.tasks[chain.id].finalReview?.verdict, 'pass');
    // The template was rendered with the covered tasks' real state.
    assert.match(seenSpec, new RegExp(`- ${a.id} \\[completed\\] first`));
    assert.match(seenSpec, new RegExp(`- ${b.id} \\[completed\\] second`));
    assert.ok(!seenSpec.includes('{coverage'), 'no token is left unresolved');
    assert.ok(existsSync(join(runsDir(file), 'reviews', `chain-${chain.id}`, 'manifest.md')), 'manifest written');
    assert.ok(existsSync(join(runsDir(file), 'reviews', `chain-${chain.id}`, `${a.id}.diff`)), 'per-task diff written');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails with kind review when the chain verdict fails', async () => {
    const run = newRun('chain-fail');
    const a = addTask(run, { title: 'work', spec: '', cmd: 'work' });
    const chain = addTask(run, {
      title: 'review',
      spec: '{coverage}',
      cmd: 'chain',
      deps: [a.id],
      covers: [a.id],
    });
    const runner = new DagRunner(run, {
      executor: async (_t, _c, cmd) =>
        cmd === 'chain'
          ? { output: 'task A contradicts task B\nVERDICT: FAIL: the two modules disagree on units', exitCode: 0 }
          : { output: 'ok', exitCode: 0 },
    });
    await runner.start();
    assert.equal(run.tasks[chain.id].status, 'failed');
    assert.equal(run.tasks[chain.id].failureKind, 'review');
    assert.match(run.tasks[chain.id].result ?? '', /modules disagree on units/);
    assert.match(run.tasks[chain.id].lastRejection ?? '', /units/);
    assert.ok(run.events.some((e) => /chain review rejected/.test(e.message ?? '')));
  });

  it('is not itself reviewed by the end-of-run review', async () => {
    const run = newRun('chain-skip');
    const a = addTask(run, { title: 'work', spec: '', cmd: 'work' });
    const chain = addTask(run, {
      title: 'review',
      spec: '{coverage}',
      cmd: 'chain',
      deps: [a.id],
      covers: [a.id],
    });
    run.settings.finalReview = 'per-task';
    run.settings.finalReviewCmd = 'final {diffFile}';
    const calls: string[] = [];
    const runner = new DagRunner(run, {
      executor: async (_t, _c, cmd) => {
        calls.push(cmd ?? '');
        if (cmd?.startsWith('final')) return { output: 'VERDICT: PASS', exitCode: 0 };
        if (cmd === 'chain') return { output: 'VERDICT: PASS', exitCode: 0 };
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(calls.filter((c) => c.startsWith('final')).length, 1, 'only the work task was reviewed');
    assert.equal(run.tasks[chain.id].status, 'completed');
    assert.equal(runner.result?.finalReview?.reviewed.length, 1);
  });

  it('groups 500-task runs into waves and chunks so reviewers stay sane', () => {
    const run = newRun('waves');
    // 40 tasks in a chain: 40 waves, each one task.
    let prev: string | null = null;
    for (let i = 0; i < 40; i += 1) {
      const t = addTask(run, { title: `t${i}`, spec: '', cmd: 'work', deps: prev ? [prev] : [] });
      run.tasks[t.id].status = 'completed';
      prev = t.id;
    }
    const depths = computeDepths(run);
    assert.equal(new Set(depths.values()).size, 40);
    // A wave selection and a chunked --all both produce a sane number of tasks.
    const wave = Object.keys(run.tasks).filter((id) => (depths.get(id) ?? 0) === 7);
    assert.equal(wave.length, 1);
    const batches = Math.ceil(40 / 25);
    assert.equal(batches, 2);
  });
});

describe('projects and scheduling', () => {
  it('treats the same run file as one project however the path is spelled', () => {
    const dir = tempDir();
    process.env.DAG_REGISTRY = join(dir, 'projects.json');
    try {
      const file = join(dir, 'my-app', 'dag.run.json');
      const entry = addProject(file);
      // The viewer URL and the CLI disagree about separators; that must not
      // register the project twice (it made the hub report an ambiguous runId).
      const backslashes = file.replace(/\//g, '\\');
      const again = addProject(backslashes);
      assert.equal(again.file, entry.file);
      assert.equal(loadRegistry().projects.length, 1);
      // A registry already holding both spellings heals on load.
      saveRegistry({
        version: 1,
        projects: [
          { file, name: 'one', addedAt: '2026-01-01T00:00:00.000Z' },
          { file: backslashes, name: 'two', addedAt: '2026-01-01T00:00:00.000Z' },
        ],
      });
      assert.equal(loadRegistry().projects.length, 1);
    } finally {
      delete process.env.DAG_REGISTRY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers projects with stable ids and default names', () => {
    const dir = tempDir();
    process.env.DAG_REGISTRY = join(dir, 'projects.json');
    try {
      const entry = addProject(join(dir, 'my-app'));
      assert.equal(entry.name, 'my-app');
      assert.match(entry.file, /my-app[\\/]dag\.run\.json$/);
      assert.match(projectId(entry.file), /^proj_[0-9a-f]{8}$/);
      // Idempotent, and the id does not change.
      const again = addProject(join(dir, 'my-app'));
      assert.equal(again.file, entry.file);
      assert.equal(projectId(again.file), projectId(entry.file));
      assert.equal(loadRegistry().projects.length, 1);
      assert.ok(removeProject(projectId(entry.file)));
      assert.equal(loadRegistry().projects.length, 0);
    } finally {
      delete process.env.DAG_REGISTRY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('schedules jobs in order and gates them on predecessors', () => {
    const dir = tempDir();
    process.env.DAG_SCHEDULE = join(dir, 'schedule.json');
    process.env.DAG_REGISTRY = join(dir, 'projects.json');
    try {
      const first = addJob({
        name: 'first',
        file: join(dir, 'a.json'),
        at: null,
        after: null,
        args: { concurrency: 8 },
      });
      const second = addJob({
        name: 'second',
        file: join(dir, 'b.json'),
        at: null,
        after: 'first',
        args: {},
      });
      let schedule = loadSchedule();
      assert.equal(decideDue(schedule.jobs[0], schedule).due, true);
      assert.equal(decideDue(schedule.jobs[1], schedule).due, false, 'waits for predecessor');

      schedule.jobs[0].status = 'done';
      assert.equal(decideDue(schedule.jobs[1], schedule).due, true, 'runs after predecessor done');

      schedule.jobs[0].status = 'failed';
      const decision = decideDue(schedule.jobs[1], schedule);
      assert.equal(decision.due, false);
      assert.match(decision.blocked ?? '', /predecessor .* failed/);

      const future = addJob({
        name: 'timed',
        file: join(dir, 'c.json'),
        at: new Date(Date.now() + 60_000).toISOString(),
        after: null,
        args: {},
      });
      schedule = loadSchedule();
      assert.equal(decideDue(future, schedule).due, false, 'not due before its time');
      assert.equal(decideDue({ ...future, at: new Date(Date.now() - 1000).toISOString() }, schedule).due, true);

      assert.equal(jobArgsToArgv(first.args).join(' '), '--concurrency 8');
      assert.ok(removeJob(second.id));
      assert.equal(loadSchedule().jobs.length, 2);
    } finally {
      delete process.env.DAG_SCHEDULE;
      delete process.env.DAG_REGISTRY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses local and ISO schedule times', () => {
    // Local wall-clock input is interpreted in the local timezone.
    assert.equal(parseAt('2026-09-16 01:30'), new Date('2026-09-16T01:30:00').toISOString());
    assert.equal(parseAt('2026-09-16T01:30:00Z'), '2026-09-16T01:30:00.000Z');
    assert.throws(() => parseAt('not a time'), /cannot parse/);
  });
});

function gitRepo(): string {
  const dir = tempDir();
  const g = (args: string[]): ReturnType<typeof git> => git(dir, args);
  g(['init', '-q']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  writeFileSync(join(dir, 'tracked.txt'), 'tracked\n');
  g(['add', 'tracked.txt']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base']);
  return dir;
}

describe('worktree isolation', () => {
  it('snapshots a dirty tree without touching the caller index or branch', () => {
    const repo = gitRepo();
    try {
      writeFileSync(join(repo, 'tracked.txt'), 'tracked\nuncommitted edit\n');
      writeFileSync(join(repo, 'untracked.txt'), 'brand new\n');
      const before = git(repo, ['rev-parse', 'HEAD']).stdout;
      const snapshot = snapshotCommit(repo);
      assert.notEqual(snapshot, before, 'snapshot is a new commit');
      assert.equal(git(repo, ['rev-parse', 'HEAD']).stdout, before, 'HEAD unchanged');
      assert.match(git(repo, ['status', '--porcelain']).stdout, /uncommitted edit|M tracked/, 'tree still dirty');
      assert.equal(git(repo, ['show', `${snapshot}:untracked.txt`]).stdout, 'brand new', 'untracked included');
      assert.match(git(repo, ['show', `${snapshot}:tracked.txt`]).stdout, /uncommitted edit/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('re-attaches a worktree whose registration outlived a hard kill', () => {
    const repo = gitRepo();
    try {
      const integration = ensureIntegrationWorktree(repo, 'run_kill');
      const task = createTaskWorktree(repo, 'run_kill', 'task_wip', integration.branch);
      writeFileSync(join(task.path, 'wip.txt'), 'agent work\n');
      // A hard kill (power loss, taskkill /F) leaves the directory gone but the
      // registration in .git/worktrees: the next add used to fail with
      // "cannot force update the branch ... used by worktree".
      rmSync(task.path, { recursive: true, force: true });
      assert.match(git(repo, ['worktree', 'list']).stdout, /task_wip/);
      const again = createTaskWorktree(repo, 'run_kill', 'task_wip', integration.branch);
      assert.ok(existsSync(join(again.path, '.git')));
      rmSync(integration.path, { recursive: true, force: true });
      const integration2 = ensureIntegrationWorktree(repo, 'run_kill');
      assert.ok(existsSync(join(integration2.path, '.git')));
      removeWorktree(repo, again.path);
      removeWorktree(repo, integration2.path);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('works in a repo that has no commits yet', () => {
    const dir = tempDir();
    try {
      git(dir, ['init', '-q']);
      writeFileSync(join(dir, 'first.txt'), 'no commits yet\n');
      const snapshot = snapshotCommit(dir);
      assert.ok(snapshot, 'snapshot of an unborn HEAD');
      assert.equal(git(dir, ['show', `${snapshot}:first.txt`]).stdout, 'no commits yet');
      const integration = ensureIntegrationWorktree(dir, 'run_unborn');
      const task = createTaskWorktree(dir, 'run_unborn', 'task_first', integration.branch);
      assert.ok(existsSync(join(task.path, 'first.txt')));
      removeWorktree(dir, task.path);
      removeWorktree(dir, integration.path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps run artifacts out of the snapshot for any --file name', () => {
    const repo = gitRepo();
    try {
      mkdirSync(join(repo, 'sub'), { recursive: true });
      const runFile = join(repo, 'sub', 'myrun.json');
      writeFileSync(runFile, '{}\n');
      writeFileSync(`${runFile}.lock`, '{"pid":1234}\n');
      mkdirSync(join(repo, 'sub', 'myrun.d', 'logs'), { recursive: true });
      writeFileSync(join(repo, 'sub', 'myrun.d', 'state.json'), '{}\n');
      mkdirSync(join(repo, 'dag.runs', 'run_old'), { recursive: true });
      writeFileSync(join(repo, 'dag.runs', 'run_old', 'dag.run.json'), '{}\n');
      writeFileSync(join(repo, 'sub', 'dirty.txt'), 'work\n');
      writeFileSync(join(repo, 'root-dirty.txt'), 'work\n');
      const excludes = snapshotExcludes(runFile, repo);
      const commit = snapshotCommit(repo, excludes);
      const tree = git(repo, ['ls-tree', '-r', '--name-only', commit]).stdout.split('\n');
      assert.ok(!tree.some((p) => /myrun|dag\.runs/.test(p)), tree.join(' '));
      // The snapshot is repo-wide, not limited to the run file's directory.
      assert.ok(tree.includes('root-dirty.txt'), tree.join(' '));
      assert.ok(tree.includes('sub/dirty.txt'), tree.join(' '));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ignores the user\'s git hooks when committing agent work', () => {
    const repo = gitRepo();
    try {
      const integration = ensureIntegrationWorktree(repo, 'run_hooks');
      const task = createTaskWorktree(repo, 'run_hooks', 'task_h', integration.branch);
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
      writeFileSync(join(repo, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 1\n');
      writeFileSync(join(task.path, 'valuable.txt'), 'agent output\n');
      const saved = commitAll(task.path, 'dag: test');
      assert.ok(saved.commit, 'the work is committed even with failing hooks');
      assert.equal(git(task.path, ['show', `${saved.commit}:valuable.txt`]).stdout, 'agent output');
      removeWorktree(repo, task.path);
      removeWorktree(repo, integration.path);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('never deletes a directory git does not list as a worktree', () => {
    const repo = gitRepo();
    try {
      const plain = join(repo, 'plain-dir');
      mkdirSync(plain, { recursive: true });
      writeFileSync(join(plain, 'user-data.txt'), 'keep\n');
      removeWorktree(repo, plain);
      assert.ok(existsSync(join(plain, 'user-data.txt')));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('task branches never collide with the integration branch ref', () => {
    const repo = gitRepo();
    try {
      const integration = ensureIntegrationWorktree(repo, 'run_test');
      const task = createTaskWorktree(repo, 'run_test', 'task_abc', integration.branch);
      // The bug this guards: dag/<run> and dag/<run>/<task> cannot coexist.
      assert.ok(task.branch.startsWith('dag-task/'), task.branch);
      assert.equal(git(repo, ['rev-parse', '--verify', task.branch]).code, 0);
      assert.equal(git(repo, ['rev-parse', '--verify', integration.branch]).code, 0);
      removeWorktree(repo, task.path);
      removeWorktree(repo, integration.path);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('detects merge conflicts and merges clean work', () => {
    const repo = gitRepo();
    try {
      const integration = ensureIntegrationWorktree(repo, 'run_conflict');
      const t1 = createTaskWorktree(repo, 'run_conflict', 'task_one', integration.branch);
      const t2 = createTaskWorktree(repo, 'run_conflict', 'task_two', integration.branch);
      writeFileSync(join(t1.path, 'tracked.txt'), 'tracked\nfrom one\n');
      writeFileSync(join(t2.path, 'tracked.txt'), 'tracked\nfrom two\n');
      commitAll(t1.path, 'one');
      commitAll(t2.path, 'two');

      const first = mergeIntoIntegration(integration.path, t1.branch, 'task_one');
      assert.equal(first.merged, true, 'first merge is clean');
      const second = mergeIntoIntegration(integration.path, t2.branch, 'task_two');
      assert.equal(second.merged, false);
      assert.equal(second.conflict, true, 'second merge conflicts on the same file');
      // The integration worktree must not be left mid-merge.
      assert.equal(existsSync(join(integration.path, '.git', 'MERGE_HEAD')), false);
      removeWorktree(repo, t1.path);
      removeWorktree(repo, t2.path);
      removeWorktree(repo, integration.path);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('reviewer panel', () => {
  it('parses the when DSL and matches globs', () => {
    assert.equal(parseWhen('always').onReject, false);
    assert.equal(parseWhen(undefined).minLines, null);
    assert.equal(parseWhen('on-reject').onReject, true);
    assert.equal(parseWhen('diff-lines>250').minLines, 250);
    assert.deepEqual(parseWhen('diff-touches:src/api/**,src/routers/*').touches, [
      'src/api/**',
      'src/routers/*',
    ]);
    const both = parseWhen('diff-lines>10;diff-touches:src/**');
    assert.equal(both.minLines, 10);
    assert.deepEqual(both.touches, ['src/**']);
    assert.equal(parseWhen('whenever').invalid, 'whenever');

    assert.ok(globMatches('src/api/**', 'src/api/http/router.ts'));
    assert.ok(globMatches('src/api/**', 'src/api/router.ts'));
    assert.ok(globMatches('**/*.ts', 'deep/nested/file.ts'));
    assert.ok(globMatches('src/routers/*.ts', 'src/routers/cases.ts'));
    assert.ok(!globMatches('src/routers/*.ts', 'src/routers/nested/cases.ts'));
    assert.ok(!globMatches('src/api/**', 'frontend/api/router.ts'));
  });

  it('decides applicability from the diff, and runs what it cannot measure', () => {
    const reviewers: Reviewer[] = [
      { name: 'regression', cmd: 'x', when: 'always' },
      { name: 'quality', cmd: 'x', when: 'diff-lines>250' },
      { name: 'api', cmd: 'x', when: 'diff-touches:src/api/**' },
      { name: 'triage', cmd: 'x', when: 'on-reject' },
    ];
    const small = decideReviewers(reviewers, { lines: 40, files: ['src/util.ts'] }, false);
    assert.deepEqual(small.map((d) => d.run), [true, false, false, false]);
    assert.match(small[1].reason, /diff is 40 lines/);

    const big = decideReviewers(reviewers, { lines: 400, files: ['src/api/router.ts'] }, false);
    assert.deepEqual(big.map((d) => d.run), [true, true, true, false]);

    const afterReject = decideReviewers(reviewers, { lines: 40, files: [] }, true);
    assert.equal(afterReject[3].run, true, 'triage reviewer runs once something rejected');

    // No diff measurable (no worktree isolation): gates run rather than open.
    const unknown = decideReviewers(reviewers, null, false);
    assert.deepEqual(unknown.map((d) => d.run), [true, true, true, false]);
  });

  it('ands every when clause instead of stopping at the first match', () => {
    const both = decideReviewers(
      [{ name: 'r', cmd: 'c', when: 'diff-lines>10;diff-touches:src/**' }],
      { lines: 50, files: ['docs/readme.md'] },
      false,
    )[0];
    assert.equal(both.run, false, both.reason);
    const neither = decideReviewers(
      [{ name: 'r', cmd: 'c', when: 'on-reject;diff-lines>1000' }],
      { lines: 3, files: ['a.ts'] },
      true,
    )[0];
    assert.equal(neither.run, false, neither.reason);
    const ok = decideReviewers(
      [{ name: 'r', cmd: 'c', when: 'diff-lines>10;diff-touches:src/**' }],
      { lines: 50, files: ['src/app.ts'] },
      false,
    )[0];
    assert.equal(ok.run, true, ok.reason);
    // `always` inside a combined clause is not an unknown condition.
    assert.equal(parseWhen('always;diff-lines>10').invalid, null);
  });

  it('globs do not let ** swallow part of a file name', () => {
    assert.equal(globMatches('**/foo.ts', 'barfoo.ts'), false);
    assert.equal(globMatches('src/**/x.ts', 'src/ax.ts'), false);
    assert.equal(globMatches('src/**/x.ts', 'src/x.ts'), true);
    assert.equal(globMatches('src/**/x.ts', 'src/a/b/x.ts'), true);
    assert.equal(globMatches('src/**/*.ts', 'src/a/b/c.ts'), true);
    assert.equal(globMatches('*.ts', 'src/a.ts'), false);
  });

  it('passes only when every applicable reviewer passes', async () => {
    const run = newRun('panel-pass');
    const a = addTask(run, { title: 'work', spec: '', cmd: 'work' });
    run.tasks[a.id].reviewers = [
      { name: 'regression', cmd: 'pnpm test', when: 'always', verdict: 'exit-code' },
      { name: 'contract', cmd: 'agent', when: 'always' },
      { name: 'quality', cmd: 'agent', when: 'diff-lines>250' },
    ];
    const ran: string[] = [];
    const runner = new DagRunner(run, {
      executor: async (_t, _c, command) => {
        ran.push(command ?? '');
        if (command === 'agent') return { output: 'citations...\nVERDICT: PASS', exitCode: 0 };
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'completed');
    // quality is conditional; without a measurable diff it still runs (fail-closed).
    assert.deepEqual(ran.filter((c) => c !== 'work'), ['pnpm test', 'agent', 'agent']);
    const verdicts = run.tasks[a.id].reviewerVerdicts;
    assert.equal(verdicts.regression.verdict, 'pass');
    assert.equal(verdicts.contract.verdict, 'pass');
    assert.match(run.tasks[a.id].reviewResult ?? '', /regression: pass/);
  });

  it('stops at the first rejection and only triage reviewers run after it', async () => {
    const run = newRun('panel-reject');
    const a = addTask(run, { title: 'work', spec: '', cmd: 'work' });
    run.tasks[a.id].reviewers = [
      { name: 'regression', cmd: 'pnpm test', when: 'always', verdict: 'exit-code' },
      { name: 'contract', cmd: 'agent', when: 'always' },
      { name: 'quality', cmd: 'agent-q', when: 'always' },
      { name: 'triage', cmd: 'agent-triage', when: 'on-reject' },
    ];
    run.tasks[a.id].reviewRounds = 0; // reject once and stop
    const ran: string[] = [];
    const runner = new DagRunner(run, {
      executor: async (_t, _c, command) => {
        ran.push(command ?? '');
        if (command === 'pnpm test') return { output: 'failing', exitCode: 1 };
        if (command === 'agent-triage') return { output: 'cause: schema drift\nVERDICT: FAIL: schema drift', exitCode: 0 };
        return { output: 'VERDICT: PASS', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'review');
    // regression rejected (exit 1) -> contract/quality skipped, triage ran.
    assert.deepEqual(ran.filter((c) => c !== 'work'), ['pnpm test', 'agent-triage']);
    const verdicts = run.tasks[a.id].reviewerVerdicts;
    assert.equal(verdicts.regression.verdict, 'fail');
    assert.equal(verdicts.contract.verdict, 'skipped');
    assert.equal(verdicts.triage.verdict, 'fail');
    // The rejection reason is carried into the next attempt's prompt.
    assert.match(run.tasks[a.id].lastRejection ?? '', /schema drift/);
    assert.match(run.tasks[a.id].result ?? '', /schema drift/);
  });

  it('feeds the last rejection into the redo prompt via {lastRejection}', async () => {
    const dir = tempDir();
    const out = join(dir, 'argv.jsonl').replace(/\\/g, '/');
    const probe = `"${process.execPath}" -e "require('fs').appendFileSync('${out}', JSON.stringify(process.argv.slice(1)) + '\\n')"`;
    try {
      const run = newRun('panel-feedback');
      const a = addTask(run, { title: 'work', spec: 'do the thing', cmd: `${probe} -- {lastRejection}` });
      run.tasks[a.id].reviewers = [{ name: 'contract', cmd: 'agent', when: 'always' }];
      run.tasks[a.id].reviewRounds = 1;
      let workRuns = 0;
      const runner = new DagRunner(run, {
        executor: async (_task, _ctx, command) => {
          if (command?.startsWith('"')) {
            // Real argv path: split and render exactly like the shell executor.
            const { shellExecutor } = await import('./runner.js');
            const exec = shellExecutor();
            const ctx = {
              onOutput: () => undefined,
              registerKill: () => undefined,
              aborted: () => false,
              setPid: () => undefined,
            };
            workRuns += 1;
            return exec(run.tasks[a.id], ctx, command);
          }
          void workRuns;
          return workRuns === 1
            ? { output: 'VERDICT: FAIL: the migration is missing', exitCode: 0 }
            : { output: 'VERDICT: PASS', exitCode: 0 };
        },
      });
      await runner.start();
      assert.equal(run.tasks[a.id].status, 'completed');
      const prompts = readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[]);
      assert.equal(prompts.length, 2, 'work ran twice');
      assert.deepEqual(prompts[0], ['(none)'], 'first attempt has nothing to learn from');
      const second = prompts[1].join(' ');
      assert.match(second, /the migration is missing/, 'the redo is told why it was rejected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reviewer agents and integration repair', () => {
  it('completes when the reviewer accepts the work', async () => {
    const run = newRun('review-pass');
    const a = addTask(run, { title: 'build', spec: '' });
    run.tasks[a.id].reviewCmd = 'reviewer';
    let calls = 0;
    const runner = new DagRunner(run, {
      executor: async (_t, _ctx, command) => {
        calls += 1;
        return command === 'reviewer'
          ? { output: 'checked the files\nVERDICT: PASS', exitCode: 0 }
          : { output: 'built', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(calls, 2, 'ran the task and the reviewer');
    assert.equal(run.tasks[a.id].status, 'completed');
    assert.equal(run.tasks[a.id].reviewerVerdicts.review.verdict, 'pass');
    assert.match(run.tasks[a.id].reviewResult ?? '', /review: pass/);
    assert.ok(run.events.some((e) => e.type === 'task-review' && /passed/.test(e.message)));
  });

  it('redoes the work when the reviewer rejects it, bounded by reviewRounds', async () => {
    const run = newRun('review-reject');
    const a = addTask(run, { title: 'build', spec: '' });
    run.tasks[a.id].reviewCmd = 'reviewer';
    run.tasks[a.id].reviewRounds = 1;
    let workRuns = 0;
    const runner = new DagRunner(run, {
      executor: async (_t, _ctx, command) => {
        if (command !== 'reviewer') {
          workRuns += 1;
          return { output: `attempt ${workRuns}`, exitCode: 0 };
        }
        // Reject the first version, accept the redo.
        return workRuns === 1
          ? { output: 'VERDICT: FAIL: the acceptance test was not added', exitCode: 0 }
          : { output: 'VERDICT: PASS', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(workRuns, 2, 'the task was redone after rejection');
    assert.equal(run.tasks[a.id].status, 'completed');
    assert.equal(run.tasks[a.id].reviews, 1);
  });

  it('fails with kind review when rejection outlasts the rounds', async () => {
    const run = newRun('review-fail');
    const a = addTask(run, { title: 'build', spec: '' });
    run.tasks[a.id].reviewCmd = 'reviewer';
    run.tasks[a.id].reviewRounds = 1;
    const runner = new DagRunner(run, {
      executor: async (_t, _ctx, override) => {
        if (override) throw Object.assign(new Error('nope'), { kind: 'exit', exitCode: 1 });
        return { output: 'built', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'review');
    assert.equal(run.tasks[a.id].reviews, 2);
  });

  it('a reviewer that stalls fails the task without burning review rounds', async () => {
    const run = newRun('review-stall');
    const a = addTask(run, { title: 'build', spec: '' });
    run.tasks[a.id].reviewCmd = 'reviewer';
    run.tasks[a.id].silenceMs = 80;
    run.tasks[a.id].timeoutMs = 0;
    run.settings.silenceAction = 'kill';
    let workRuns = 0;
    const runner = new DagRunner(run, {
      executor: async (_t, _ctx, override) => {
        if (override) return never(_t, _ctx);
        workRuns += 1;
        return { output: 'built', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'stalled');
    assert.equal(workRuns, 1, 'work was not redone for an infrastructure failure');
  });

  it('an integration node requeues its upstream when it fails with repairRounds', async () => {
    const run = newRun('integration');
    const a = addTask(run, { title: 'part-a', spec: '' });
    const b = addTask(run, { title: 'part-b', spec: '', deps: [a.id] });
    const integration = addTask(run, { title: 'integration check', spec: '', deps: [a.id, b.id] });
    run.tasks[integration.id].repairRounds = 1;
    let integrationRuns = 0;
    const runner = new DagRunner(run, {
      executor: async (task) => {
        if (task.id === integration.id) {
          integrationRuns += 1;
          if (integrationRuns === 1) {
            throw Object.assign(new Error('pieces do not mesh'), { kind: 'exit', exitCode: 1 });
          }
          return { output: 'meshes now', exitCode: 0 };
        }
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(integrationRuns, 2, 'integration was retried after repair');
    assert.equal(run.tasks[integration.id].status, 'completed');
    assert.equal(run.tasks[integration.id].repairs, 1);
    assert.ok(run.events.some((e) => e.type === 'task-repair'));
  });

  it('heartbeats keep a quiet worker alive', async () => {
    const dir = tempDir();
    const file = join(dir, 'run.json');
    const run = newRun('heartbeat');
    const a = addTask(run, { title: 'quiet worker', spec: '', cmd: 'worker' });
    saveRun(run, file);
    try {
      run.settings.silenceMs = 250;
      run.settings.timeoutMs = 0;
      const runner = new DagRunner(run, {
        file,
        persist: (state) => saveRun(state, file),
        executor: async (task) => {
          for (let i = 0; i < 3; i++) {
            await sleep(150);
            recordHeartbeat(file, task.id);
          }
          return { output: 'done quietly', exitCode: 0 };
        },
      });
      await runner.start();
      assert.equal(run.tasks[a.id].status, 'completed', 'heartbeats prevented a stall kill');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds an integration spec that names the upstream tasks and the check', () => {
    const run = newRun('spec');
    const a = addTask(run, { title: 'API contract', spec: '' });
    const b = addTask(run, { title: 'client wiring', spec: '' });
    run.tasks[a.id].status = 'completed';
    run.tasks[a.id].result = 'openapi.json written';
    const spec = buildIntegrationSpec(run, [a.id, b.id], 'pnpm test integration');
    assert.match(spec, new RegExp(a.id));
    assert.match(spec, /API contract/);
    assert.match(spec, /openapi\.json written/);
    assert.match(spec, /pnpm test integration/);
    assert.match(spec, /dag show --id/);
  });

  it('manual retry resets review and repair budgets', () => {
    const run = newRun('budget');
    const a = addTask(run, { title: 'a', spec: '' });
    run.tasks[a.id].status = 'failed';
    run.tasks[a.id].failureKind = 'review';
    run.tasks[a.id].reviews = 3;
    run.tasks[a.id].repairs = 2;
    run.tasks[a.id].reviewResult = 'nope';
    retryTask(run, a.id);
    assert.equal(run.tasks[a.id].reviews, 0, 'review budget reset');
    assert.equal(run.tasks[a.id].repairs, 0, 'repair budget reset');
    assert.equal(run.tasks[a.id].reviewResult, null);
    assert.equal(run.tasks[a.id].failureKind, null);
  });

  it('stop during a review requeues without spending a review round', async () => {
    const run = newRun('stop-review');
    const a = addTask(run, { title: 'a', spec: '' });
    run.tasks[a.id].reviewCmd = 'reviewer';
    run.tasks[a.id].reviewRounds = 2;
    const runner = new DagRunner(run, {
      stopGraceMs: 100,
      executor: async (_t, ctx, override) => {
        if (override) return never(_t, ctx);
        return { output: 'ok', exitCode: 0 };
      },
    });
    void runner.start();
    for (let i = 0; i < 200; i++) {
      if (run.events.some((e) => e.type === 'task-review' && /starting/.test(e.message))) break;
      await sleep(10);
    }
    await runner.stop();
    assert.equal(run.tasks[a.id].status, 'pending');
    assert.equal(run.tasks[a.id].reviews, 0, 'a stop is not a rejection');
    assert.equal(run.tasks[a.id].failureKind, 'killed');
  });

  it('a scoped run does not skip tasks outside its scope', async () => {
    const run = newRun('scope-skip');
    const a = addTask(run, { title: 'a', spec: '' });
    const b = addTask(run, { title: 'b', spec: '', deps: [a.id] });
    const runner = new DagRunner(run, {
      onDepFailure: 'skip',
      executor: async () => {
        throw Object.assign(new Error('boom'), { kind: 'exit', exitCode: 1 });
      },
    });
    await runner.start(new Set([a.id]));
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[b.id].status, 'pending', 'out-of-scope dependent was not skipped');
  });

  it('a scoped run does not requeue out-of-scope upstream for repair', async () => {
    const run = newRun('scope-repair');
    const upstream = addTask(run, { title: 'upstream', spec: '' });
    run.tasks[upstream.id].status = 'completed';
    const integration = addTask(run, { title: 'integration', spec: '', deps: [upstream.id] });
    run.tasks[integration.id].repairRounds = 1;
    const runner = new DagRunner(run, {
      executor: async () => {
        throw Object.assign(new Error('no mesh'), { kind: 'exit', exitCode: 1 });
      },
    });
    await runner.start(new Set([integration.id]));
    assert.equal(run.tasks[upstream.id].status, 'completed', 'out-of-scope dep untouched');
    assert.equal(run.tasks[integration.id].status, 'failed');
    assert.equal(run.tasks[integration.id].repairs, 0);
  });

  it('writes an attempt log header even when the task produces no output', async () => {
    const dir = tempDir();
    const file = join(dir, 'run.json');
    const run = newRun('log-header');
    const a = addTask(run, { title: 'silent', spec: '', cmd: 'silent' });
    saveRun(run, file);
    try {
      const runner = new DagRunner(run, {
        file,
        persist: (state) => saveRun(state, file),
        executor: async () => ({ output: '', exitCode: 0 }),
      });
      await runner.start();
      await sleep(100);
      const content = readFileSync(join(runPaths(file).logs, `${a.id}.1.log`), 'utf8');
      assert.match(content, /# attempt 1 started/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a manual schedule retry unblocks dependents', () => {
    const dir = tempDir();
    process.env.DAG_SCHEDULE = join(dir, 'schedule.json');
    try {
      const first = addJob({ name: 'first', file: join(dir, 'a.json'), at: null, after: null, args: {} });
      const second = addJob({
        name: 'second',
        file: join(dir, 'b.json'),
        at: null,
        after: 'first',
        args: {},
      });
      let schedule = loadSchedule();
      schedule.jobs[0].status = 'failed';
      const decision = decideDue(schedule.jobs[1], schedule);
      assert.match(decision.blocked ?? '', /predecessor .* failed/);

      const requeued = retryJob(first.id);
      assert.equal(requeued?.status, 'pending');
      const after = loadSchedule();
      assert.equal(decideDue(after.jobs.find((j) => j.id === second.id)!, after).due, false, 'still waits');
      after.jobs.find((j) => j.id === first.id)!.status = 'done';
      assert.equal(decideDue(after.jobs.find((j) => j.id === second.id)!, after).due, true);
    } finally {
      delete process.env.DAG_SCHEDULE;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a second runner on the same file is refused, even programmatically', async () => {
    const dir = tempDir();
    const file = join(dir, 'run.json');
    const run = newRun('one-runner');
    addTask(run, { title: 'slow', spec: '', cmd: 'slow' });
    saveRun(run, file);
    const first = new DagRunner(run, {
      file,
      persist: (state) => saveRun(state, file),
      executor: () => new Promise(() => undefined),
      stopGraceMs: 50,
    });
    try {
      void first.start();
      await sleep(150);
      assert.ok(lockHeldBy(file), 'the runner owns the file');

      const second = new DagRunner(loadRun(file), {
        file,
        persist: (state) => saveRun(state, file),
        executor: async () => ({ output: 'x', exitCode: 0 }),
      });
      await second.start();
      assert.equal(second.isRunning, false, 'the second runner refused to start');
      assert.equal(second.result?.stopped, true);
      assert.ok(
        second.state.events.some((e) => e.type === 'note' && /not starting/.test(e.message)),
        'refusal is recorded in the event log',
      );
      const onlyTask = Object.keys(run.tasks)[0];
      assert.equal(run.tasks[onlyTask].status, 'running', 'first runner still owns the task');
    } finally {
      // Always stop the first runner: an abandoned run keeps its timers alive.
      await first.stop();
    }
    assert.equal(lockHeldBy(file), false, 'the lock is released when the run ends');
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves Windows .cmd shims to their real target', () => {
    const dir = tempDir();
    try {
      if (process.platform !== 'win32') {
        // Unix: resolution is a no-op.
        assert.deepEqual(resolveCommand('node'), { file: 'node', args: [] });
        return;
      }
      // A shim that launches an .exe (opencode's shape).
      const shimDir = join(dir, 'npm');
      const realDir = join(shimDir, 'node_modules', 'fake-cli', 'bin');
      mkdirSync(realDir, { recursive: true });
      const realExe = join(realDir, 'fake.exe');
      writeFileSync(realExe, '');
      writeFileSync(
        join(shimDir, 'fake.cmd'),
        [
          '@ECHO off',
          'GOTO start',
          ':find_dp0',
          'SET dp0=%~dp0',
          'EXIT /b',
          ':start',
          'SETLOCAL',
          'CALL :find_dp0',
          `"%dp0%\\node_modules\\fake-cli\\bin\\fake.exe"   %*`,
        ].join('\r\n'),
        'utf8',
      );

      const resolved = resolveCommand(join(shimDir, 'fake.cmd'));
      assert.equal(resolved.file, realExe, 'shim resolves to the real exe');
      assert.deepEqual(resolved.args, []);

      // A shim that launches a .js entry through node.
      const jsTarget = join(realDir, 'entry.js');
      writeFileSync(jsTarget, '');
      writeFileSync(
        join(shimDir, 'fakejs.cmd'),
        `@ECHO off\r\n"%dp0%\\node_modules\\fake-cli\\bin\\entry.js"   %*\r\n`,
        'utf8',
      );
      const resolvedJs = resolveCommand(join(shimDir, 'fakejs.cmd'));
      assert.equal(resolvedJs.file, process.execPath);
      assert.deepEqual(resolvedJs.args, [jsTarget]);

      // Real installed shims resolve too (best effort; skipped if absent).
      const opencode = resolveCommand('opencode');
      if (opencode.file !== 'opencode') {
        assert.ok(/\.exe$/i.test(opencode.file), `opencode resolved to an exe: ${opencode.file}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the planning phase first and hands the plan to the work command', async () => {
    const dir = tempDir();
    const file = join(dir, 'run.json');
    const run = newRun('plan-phase');
    const a = addTask(run, { title: 'planned work', spec: 'the spec', cmd: 'work {planFile}' });
    run.tasks[a.id].planCmd = 'planner';
    saveRun(run, file);
    try {
      const seen: { plan: string | null; planFile: string | undefined; cmd: string }[] = [];
      const runner = new DagRunner(run, {
        file,
        persist: (state) => saveRun(state, file),
        executor: async (task, ctx, command) => {
          if (command === 'planner') {
            return { output: '1. read files\n2. edit src/x.ts\n3. run tests', exitCode: 0 };
          }
          seen.push({ plan: task.plan, planFile: ctx.planFile, cmd: command ?? '' });
          return { output: 'done', exitCode: 0 };
        },
      });
      await runner.start();
      assert.equal(run.tasks[a.id].status, 'completed');
      assert.match(run.tasks[a.id].plan ?? '', /edit src\/x\.ts/, 'plan captured on the task');
      assert.equal(seen.length, 1, 'work phase ran once');
      assert.match(seen[0].plan ?? '', /read files/, 'work phase saw the plan');
      assert.ok(seen[0].planFile, 'work phase got a plan file path');
      assert.match(readFileSync(seen[0].planFile as string, 'utf8'), /edit src\/x\.ts/);
      assert.ok(run.events.some((e) => e.type === 'task-plan' && /plan ready/.test(e.message)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed planning phase fails the task without running the work', async () => {
    const run = newRun('plan-fail');
    const a = addTask(run, { title: 'planned work', spec: '', cmd: 'work' });
    run.tasks[a.id].planCmd = 'planner';
    let workRuns = 0;
    const runner = new DagRunner(run, {
      executor: async (_t, _ctx, command) => {
        if (command === 'planner') {
          throw Object.assign(new Error('cannot plan'), { kind: 'exit', exitCode: 1 });
        }
        workRuns += 1;
        return { output: 'done', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'plan');
    assert.equal(workRuns, 0, 'work never ran without a plan');
  });

  it('hands upstream evidence to a verifier through {deps}, {depsAll} and {depsFile}', async () => {
    const dir = tempDir();
    const file = join(dir, 'run.json');
    const run = newRun('deps-token');
    const a = addTask(run, { title: 'part A', spec: '', cmd: 'work' });
    const b = addTask(run, { title: 'part B', spec: '', deps: [a.id], cmd: 'work' });
    const verifier = addTask(run, { title: 'integration', spec: '', deps: [b.id], cmd: 'verify' });
    saveRun(run, file);
    try {
      const seen: Record<string, string> = {};
      const runner = new DagRunner(run, {
        file,
        persist: (state) => saveRun(state, file),
        executor: async (task, ctx, command) => {
          if (command === 'verify') {
            seen.deps = ctx.deps ?? '';
            seen.depsAll = ctx.depsAll ?? '';
            seen.depsFile = ctx.depsFile ?? '';
          }
          return { output: `${task.title} produced evidence-${task.id.slice(-4)}`, exitCode: 0 };
        },
      });
      await runner.start();
      assert.equal(run.tasks[verifier.id].status, 'completed');
      // Direct deps only in {deps}: B yes, A no.
      assert.match(seen.deps, /part B/);
      assert.doesNotMatch(seen.deps, /part A/);
      // Everything upstream in {depsAll}: A and B.
      assert.match(seen.depsAll, /part A/);
      assert.match(seen.depsAll, /part B/);
      // The file carries both sections, including each dep's result.
      const contents = readFileSync(seen.depsFile, 'utf8');
      assert.match(contents, /Direct dependencies/);
      assert.match(contents, /All upstream tasks/);
      assert.match(contents, /produced evidence-/, 'upstream results are included');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never injects a leading-dash token that a CLI would read as a flag', () => {
    const run = newRun('token-safety');
    const a = addTask(run, { title: 'upstream', spec: '' });
    const b = addTask(run, { title: 'downstream', spec: '', deps: [a.id] });
    run.tasks[a.id].status = 'completed';
    run.tasks[a.id].result = 'evidence';
    const deps = describeDeps(run, run.tasks[b.id]);
    assert.ok(!deps.startsWith('-'), `deps text must not start with a dash: ${deps.slice(0, 40)}`);
    const rendered = renderTokens('{deps}', run.tasks[b.id], { deps } as never);
    assert.ok(!rendered.startsWith('-'), 'rendered argv element must not start with a dash');
    // A spec that legitimately starts with a dash is also protected.
    run.tasks[b.id].spec = '--- task spec ---';
    const specRendered = renderTokens('{spec}', run.tasks[b.id]);
    assert.ok(!specRendered.startsWith('-') || specRendered.startsWith('\n'), 'spec is positional');
  });

  it('reports why a command failed, not just its exit code', async () => {
    const run = newRun('exit-detail');
    const a = addTask(run, {
      title: 'bad flags',
      spec: '',
      cmd: `"${process.execPath}" -e "console.log('usage: nope'); process.exit(1)"`,
    });
    const runner = new DagRunner(run, { executor: shellExecutor() });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.match(run.tasks[a.id].result ?? '', /usage: nope/, 'failure carries the output tail');
  });

  it('warns instead of killing a quiet worker by default', async () => {
    const run = newRun('silence-warn');
    const a = addTask(run, { title: 'buffered tool call', spec: '' });
    run.tasks[a.id].silenceMs = 150;
    run.tasks[a.id].timeoutMs = 0;
    run.settings.notifyCmd = `"${process.execPath}" -e ""`;
    const runner = new DagRunner(run, {
      executor: async () => {
        await sleep(500); // quiet, but working
        return { output: 'finished after the quiet spell', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'completed', 'a quiet-but-alive worker is not killed');
    assert.ok(
      run.events.some((e) => e.type === 'task-stall-warning' && /quiet/.test(e.message)),
      'the quiet spell is reported',
    );
    assert.ok(run.events.some((e) => e.type === 'notify' && /task-quiet/.test(e.message)));
  });

  it('kills a quiet worker when silenceAction is kill', async () => {
    const run = newRun('silence-kill');
    const a = addTask(run, { title: 'hung', spec: '' });
    run.tasks[a.id].silenceMs = 150;
    run.tasks[a.id].timeoutMs = 0;
    run.settings.silenceAction = 'kill';
    const runner = new DagRunner(run, { executor: () => new Promise(() => undefined) });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'stalled');
  });

  it('salvages partial work from a failed task worktree', async () => {
    const repo = tempDir();
    try {
      const g = (args: string[]): ReturnType<typeof git> => git(repo, args);
      g(['init', '-q']);
      g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
      writeFileSync(join(repo, 'seed.txt'), 'seed\n');
      g(['add', '-A']);
      g(['-c', 'user.name=t', 'user.email=t@t', 'commit', '-q', '-m', 'seed']);

      const file = join(repo, 'dag.run.json');
      const run = newRun('salvage');
      const a = addTask(run, { title: 'dies midway', spec: '' });
      run.settings.worktree = 'task';
      saveRun(run, file);
      const runner = new DagRunner(run, {
        file,
        persist: (state) => saveRun(state, file),
        executor: async (_t, ctx) => {
          writeFileSync(join(ctx.cwd as string, 'half-done.txt'), 'partial work\n');
          throw Object.assign(new Error('agent died'), { kind: 'exit', exitCode: 1 });
        },
      });
      await runner.start();
      const task = loadRun(file).tasks[a.id];
      assert.equal(task.status, 'failed');
      assert.ok(task.commit, 'a WIP commit was made');
      assert.equal(
        git(repo, ['show', `${task.branch}:half-done.txt`]).stdout,
        'partial work',
        'partial work is recoverable from the task branch',
      );
      const integration = git(repo, ['show', `dag/${run.id}:half-done.txt`]);
      assert.notEqual(integration.code, 0, 'salvage is never merged into the integration branch');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('resolves {model} and {variant} from the task, then the run', () => {
    const cmd = 'agent run --auto -m {model} --variant {variant} {spec}';
    const task = { model: null, variant: null } as Pick<Task, 'model' | 'variant'>;
    // Run default applies when the task has none.
    assert.equal(
      resolveHarness(cmd, task, { model: 'vendor/big', variant: 'xhigh' }),
      'agent run --auto -m vendor/big --variant xhigh {spec}',
    );
    // Task override wins.
    assert.equal(
      resolveHarness(cmd, { model: 'vendor/small', variant: null }, { model: 'vendor/big', variant: 'max' }),
      'agent run --auto -m vendor/small --variant max {spec}',
    );
    // Unset values drop the flag instead of leaving an empty argv element
    // (which would swallow the next token).
    const bare = resolveHarness(cmd, task, {});
    assert.equal(bare, 'agent run --auto {spec}');
    assert.ok(!/-m\s+--variant/.test(bare));
    assert.ok(!/\{model\}|\{variant\}/.test(bare));
    // Literal commands without tokens are untouched.
    assert.equal(resolveHarness('node -p 1', task, {}), 'node -p 1');
    // The `--model={model}` spelling is dropped too.
    assert.equal(resolveHarness('agent --model={model} {spec}', task, {}), 'agent {spec}');
    assert.equal(resolveHarness('agent --variant={variant} {spec}', task, {}), 'agent {spec}');
  });

  it('substitutes tokens in one pass, so injected text is not re-rendered', () => {
    const run = newRun('tokens');
    const task = addTask(run, { title: 'title', spec: 'read {deps} then stop' });
    const rendered = renderTokens('{spec}', task, { deps: 'D1' } as never);
    assert.equal(rendered, 'read {deps} then stop');
    assert.equal(renderTokens('{nope}', task), '{nope}');
    assert.equal(renderTokens('{id}', task), task.id);
  });

  it('drops the flag and its value when no model is configured', async () => {
    const run = newRun('no-model');
    const probe = `"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))"`;
    const a = addTask(run, { title: 'plain', spec: 'hello world', cmd: `${probe} -- -m {model} --variant {variant} {spec}` });
    const runner = new DagRunner(run, { executor: shellExecutor() });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'completed');
    // No model configured: both flags vanish, and the spec survives intact.
    assert.equal(run.tasks[a.id].result, '["hello world"]');
  });

  it('passes the run model and effort through to the agent argv', async () => {
    const run = newRun('with-model');
    run.settings.model = 'opencode-go/muse-spark-1.3-contributor';
    run.settings.variant = 'xhigh';
    const probe = `"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))"`;
    const a = addTask(run, { title: 'modelled', spec: 'hello world', cmd: `${probe} -- -m {model} --variant {variant} {spec}` });
    const runner = new DagRunner(run, { executor: shellExecutor() });
    await runner.start();
    assert.equal(
      run.tasks[a.id].result,
      '["-m","opencode-go/muse-spark-1.3-contributor","--variant","xhigh","hello world"]',
    );
  });

  it('reads verdicts from reviewer output, not just exit codes', () => {
    const pass = parseVerdict('blah\nVERDICT: PASS\n');
    assert.equal(pass.kind, 'pass');
    const fail = parseVerdict('checked the diff\nVERDICT: FAIL: tests/test_x.py still asserts the old shape');
    assert.equal(fail.kind, 'fail');
    assert.match(fail.reason, /still asserts the old shape/);
    // The last verdict wins if a reviewer restates itself.
    assert.equal(parseVerdict('VERDICT: FAIL: nope\nVERDICT: PASS').kind, 'pass');
    assert.equal(parseVerdict('no verdict here').kind, 'none');
  });

  it('accepts a reviewer only on VERDICT: PASS', async () => {
    const run = newRun('verdict-pass');
    const a = addTask(run, { title: 'work', spec: '', cmd: 'work' });
    run.tasks[a.id].reviewCmd = 'reviewer';
    let workRuns = 0;
    const runner = new DagRunner(run, {
      executor: async (_t, _c, command) => {
        if (command === 'reviewer') {
          return { output: 'I inspected the files.\nVERDICT: PASS', exitCode: 0 };
        }
        workRuns += 1;
        return { output: 'done', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'completed');
    assert.equal(workRuns, 1);
    assert.equal(run.tasks[a.id].reviewerVerdicts.review.verdict, 'pass');
    assert.match(run.tasks[a.id].reviewResult ?? '', /review: pass/);
  });

  it('treats VERDICT: FAIL as a rejection even though the agent exits 0', async () => {
    const run = newRun('verdict-fail');
    const a = addTask(run, { title: 'work', spec: '', cmd: 'work' });
    run.tasks[a.id].reviewCmd = 'reviewer';
    run.tasks[a.id].reviewRounds = 1;
    let workRuns = 0;
    const runner = new DagRunner(run, {
      executor: async (_t, _c, command) => {
        if (command === 'reviewer') {
          return { output: 'VERDICT: FAIL: the acceptance test is missing', exitCode: 0 };
        }
        workRuns += 1;
        return { output: 'done', exitCode: 0 };
      },
    });
    await runner.start();
    // Exit 0 but a FAIL verdict: rejected, redone once, then failed.
    assert.equal(workRuns, 2, 'the work was redone after the rejection');
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'review');
    assert.match(run.tasks[a.id].result ?? '', /acceptance test is missing/);
  });

  it('fails closed when a reviewer produces no verdict at all', async () => {
    const run = newRun('verdict-missing');
    const a = addTask(run, { title: 'work', spec: '', cmd: 'work' });
    run.tasks[a.id].reviewCmd = 'reviewer';
    const runner = new DagRunner(run, {
      executor: async (_t, _c, command) => {
        if (command === 'reviewer') return { output: 'looks good to me 👍', exitCode: 0 };
        return { output: 'done', exitCode: 0 };
      },
    });
    await runner.start();
    // The old behaviour was a silent pass. Unreviewed work must not merge.
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'review');
    assert.match(run.tasks[a.id].result ?? '', /no machine-readable verdict/);
    assert.ok(run.events.some((e) => /produced no VERDICT line/.test(e.message)));
  });

  it('still trusts exit codes for shell reviewers when asked', async () => {
    const run = newRun('verdict-exit-code');
    run.settings.reviewVerdict = 'exit-code';
    const a = addTask(run, { title: 'work', spec: '', cmd: 'work' });
    run.tasks[a.id].reviewCmd = 'pytest -q';
    const runner = new DagRunner(run, {
      executor: async (_t, _c, command) => {
        if (command === 'pytest -q') return { output: '5 passed in 1.2s', exitCode: 0 };
        return { output: 'done', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'completed');
  });

  it('keeps the tail of long review output so the verdict survives', async () => {
    const run = newRun('verdict-tail');
    const a = addTask(run, { title: 'work', spec: '', cmd: 'work' });
    run.tasks[a.id].reviewCmd = 'reviewer';
    const noise = 'reading files\n'.repeat(2000); // ~28k chars, well past the limit
    const runner = new DagRunner(run, {
      executor: async (_t, _c, command) => {
        if (command === 'reviewer') {
          return { output: `${noise}VERDICT: FAIL: missing migration`, exitCode: 0 };
        }
        return { output: 'done', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[a.id].reviewerVerdicts.review.verdict, 'fail');
    assert.match(run.tasks[a.id].reviewerVerdicts.review.reason, /missing migration/);
    assert.match(run.tasks[a.id].reviewResult ?? '', /review: fail — missing migration/);
  });

  it('a refused run does not wedge the runner', async () => {
    const dir = tempDir(); // not a git repo
    const file = join(dir, 'run.json');
    const run = newRun('no-git');
    addTask(run, { title: 'x', spec: '', cmd: 'true' });
    run.settings.worktree = 'task'; // isolation requested, impossible here
    saveRun(run, file);
    try {
      const runner = new DagRunner(loadRun(file), { file });
      await runner.start();
      assert.equal(runner.isRunning, false, 'refused to start without isolation');
      assert.equal(runner.result?.stopped, true);
      assert.ok(runner.state.events.some((e) => /not starting/.test(e.message)));

      // The refusal must not block a later attempt.
      await runner.start();
      assert.equal(runner.isRunning, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepares the worktree once before the phases, and fails as setup when it breaks', async () => {
    const repo = gitRepo();
    const file = join(repo, 'dag.run.json');
    try {
      const run = newRun('prepare');
      const a = addTask(run, { title: 'needs env', spec: '', cmd: 'work' });
      run.settings.worktree = 'task';
      run.settings.worktreePrepareCmd = 'provision';
      saveRun(run, file);
      const order: string[] = [];
      const runner = new DagRunner(run, {
        file,
        persist: (state) => saveRun(state, file),
        executor: async (_t, ctx, command) => {
          order.push(command ?? '');
          if (command === 'provision') {
            // stands in for uv sync / pnpm install
            writeFileSync(join(ctx.cwd as string, 'env.txt'), 'ready\n');
          }
          return { output: '', exitCode: 0 };
        },
      });
      await runner.start();
      assert.deepEqual(order, ['provision', 'work'], 'prepare runs before the work phase');
      assert.equal(run.tasks[a.id].status, 'completed');

      // A failing prepare fails the task as setup, and the work never runs.
      const run2 = newRun('prepare-fail');
      const b = addTask(run2, { title: 'bad env', spec: '', cmd: 'work' });
      run2.settings.worktree = 'task';
      run2.settings.worktreePrepareCmd = 'provision';
      saveRun(run2, join(repo, 'dag2.run.json'));
      const order2: string[] = [];
      const runner2 = new DagRunner(run2, {
        file: join(repo, 'dag2.run.json'),
        persist: (state) => saveRun(state, join(repo, 'dag2.run.json')),
        executor: async (_t, _c, command) => {
          order2.push(command ?? '');
          if (command === 'provision') {
            throw Object.assign(new Error('uv sync failed: no network'), { kind: 'exit', exitCode: 1 });
          }
          return { output: '', exitCode: 0 };
        },
      });
      await runner2.start();
      assert.deepEqual(order2, ['provision'], 'work never ran without an environment');
      assert.equal(run2.tasks[b.id].status, 'failed');
      assert.equal(run2.tasks[b.id].failureKind, 'setup');
      assert.match(run2.tasks[b.id].result ?? '', /uv sync failed/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('skips the prepare step when worktree isolation is off', async () => {
    const run = newRun('prepare-off');
    const a = addTask(run, { title: 'in place', spec: '', cmd: 'work' });
    run.settings.worktreePrepareCmd = 'provision';
    const ran: string[] = [];
    const runner = new DagRunner(run, {
      executor: async (_t, _c, command) => {
        ran.push(command ?? '');
        return { output: '', exitCode: 0 };
      },
    });
    await runner.start();
    assert.deepEqual(ran, ['work'], 'no worktree, no prepare — it would mutate the real checkout');
    assert.equal(run.tasks[a.id].status, 'completed');
    assert.ok(run.events.some((e) => /worktree isolation is off/.test(e.message)));
  });

  it('runs the notify command on permanent failure with event env vars', async () => {
    const dir = tempDir();
    const out = join(dir, 'notify.txt');
    const run = newRun('notify');
    const a = addTask(run, { title: 'breaks', spec: '' });
    run.settings.notifyCmd = `"${process.execPath}" -e "require('fs').appendFileSync(process.env.DAG_NOTIFY_OUT, process.env.DAG_EVENT + ' ' + process.env.DAG_TASK + '\\n')"`;
    const runner = new DagRunner(run, {
      executor: async () => {
        throw Object.assign(new Error('boom'), { kind: 'exit', exitCode: 2 });
      },
    });
    process.env.DAG_NOTIFY_OUT = out;
    try {
      await runner.start();
      // Notify children are detached; poll until the run-end alert lands.
      for (
        let i = 0;
        i < 60 && !(existsSync(out) && readFileSync(out, 'utf8').includes('run-end'));
        i++
      ) {
        await sleep(50);
      }
      assert.equal(run.tasks[a.id].status, 'failed');
      assert.ok(existsSync(out), 'notify command ran');
      const text = readFileSync(out, 'utf8');
      assert.match(text, /task-fail/);
      assert.match(text, new RegExp(a.id));
      assert.match(text, /run-end/, 'clean/failed run end always notifies');
      assert.ok(run.events.some((e) => e.type === 'notify'));
    } finally {
      delete process.env.DAG_NOTIFY_OUT;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
