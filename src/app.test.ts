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
  recoverInterrupted,
  removeTask,
  retryFailed,
  retryTask,
  runPaths,
  saveRun,
} from './store.js';
import {
  assertNoCycle,
  getBlocked,
  getReady,
  topoSort,
  transitiveBlocked,
} from './graph.js';
import { DagRunner, parseVerdict, renderTokens, resolveHarness, shellExecutor, sleep, type ExecContext } from './runner.js';
import { describeDeps } from './graph.js';
import { resolveCommand } from './command-resolution.js';
import {
  commitAll,
  createTaskWorktree,
  ensureIntegrationWorktree,
  git,
  mergeIntoIntegration,
  removeWorktree,
  snapshotCommit,
} from './git-worktree.js';
import { addProject, loadRegistry, projectId, removeProject } from './registry.js';
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

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dag-'));
}

describe('dag edits (the Orca gaps)', () => {
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
    assert.equal(reloaded.tasks[b.id].status, 'completed');
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

describe('projects and scheduling', () => {
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

describe('worktree isolation', () => {
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
    assert.match(run.tasks[a.id].reviewResult ?? '', /VERDICT: PASS/);
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
    assert.match(run.tasks[a.id].reviewResult ?? '', /VERDICT: PASS/);
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
    assert.match(run.tasks[a.id].reviewResult ?? '', /VERDICT: FAIL: missing migration/);
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
