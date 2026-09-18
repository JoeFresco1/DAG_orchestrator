// Storage and runner-policy tests: the definition/state file split, legacy-run
// migration, crash recovery and locking, skip/gate/budget policies, and
// settings validation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  addTask,
  editTask,
  loadRun,
  newRun,
  readEventLog,
  readLock,
  orphanedPids,
  recoverInterrupted,
  removeTask,
  retryTask,
  runPaths,
  saveRun,
} from './store.js';
import { DagRunner, shellExecutor, sleep } from './runner.js';
import { validateSettingsPatch } from './types.js';
import { make, never, tempDir, gitRepo } from './test-helpers.js';
import type { Run, Task } from './types.js';
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
// Files that are atomic, migratable, recoverable after a crash, and never
// silently lose state; plus the non-crash policy paths (skip, gates, budget).
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
    // A pre-split run file: definition, state and events all in one JSON blob,
    // the way an older version wrote it.
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
    // A real live process to point the lock at: a lock owned by a live pid must
    // be refused, while one owned by a dead pid is stolen.
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
// Repair invalidates already-completed descendants, and an approval must be
// re-earned whenever the underlying output changes.
describe('stale work and approvals', () => {
  it('redoes completed descendants when an upstream task is repaired', async () => {
    const run = newRun('invalidate');
    const a = addTask(run, { title: 'a', spec: '', cmd: 'work-a' });
    const b = addTask(run, { title: 'b', spec: '', cmd: 'work-b', deps: [a.id] });
    const c = addTask(run, { title: 'c', spec: '', cmd: 'work-c', deps: [a.id] });
    run.tasks[c.id].reviewCmd = 'judge-c';
    run.tasks[c.id].repairRounds = 1;
    run.tasks[a.id].maxAttempts = 3;
    run.tasks[b.id].maxAttempts = 3;
    run.tasks[c.id].maxAttempts = 3;
    let cReviews = 0;
    const runner = new DagRunner(run, {
      executor: async (_task, _ctx, cmd) => {
        if (cmd === 'judge-c') {
          cReviews += 1;
          return cReviews === 1
            ? { output: 'VERDICT: FAIL: the ledger does not match the spec', exitCode: 0 }
            : { output: 'VERDICT: PASS', exitCode: 0 };
        }
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    assert.equal(run.tasks[c.id].status, 'completed');
    // A was redone by the repair, so B's earlier completion is void: it was
    // verified against an upstream output that no longer exists.
    assert.equal(run.tasks[a.id].attempts, 2, 'upstream redone');
    assert.equal(run.tasks[b.id].attempts, 2, 'stale descendant redone');
    assert.equal(run.tasks[c.id].attempts, 2, 'the repaired task redone');
    assert.ok(run.events.some((e) => /inputs changed: 1 completed downstream/.test(e.message ?? '')));
  });

  it('a retry must earn a fresh approval', async () => {
    // The run file lives in a git repo: per-task review needs a real worktree.
    const dir = gitRepo();
    const file = join(dir, 'dag.run.json');
    const run = newRun('fresh-approval');
    const a = addTask(run, { title: 'a', spec: '', cmd: 'work' });
    // Per-task review needs a per-task diff, which needs isolation.
    run.tasks[a.id].diffBase = 'base';
    run.tasks[a.id].diffHead = 'head';
    run.settings.worktree = 'task';
    saveRun(run, file);
    let reviews = 0;
    const runner = new DagRunner(run, {
      file,
      persist: (state) => saveRun(state, file),
      executor: async (_task, _ctx, cmd) => {
        if (cmd?.startsWith('judge')) {
          reviews += 1;
          return { output: 'VERDICT: PASS', exitCode: 0 };
        }
        return { output: 'ok', exitCode: 0 };
      },
    });
    run.settings.finalReview = 'per-task';
    run.settings.finalReviewCmd = 'judge {diffFile}';
    await runner.start();
    assert.equal(run.tasks[a.id].finalReview?.verdict, 'pass');
    assert.equal(reviews, 1);

    // Retry: the approval belonged to the previous output.
    retryTask(run, a.id);
    assert.equal(run.tasks[a.id].finalReview, null, 'retry clears the approval');
    await runner.start();
    assert.equal(reviews, 2, 'the retried work is reviewed again');
    assert.equal(run.tasks[a.id].finalReview?.verdict, 'pass');
    rmSync(dir, { recursive: true, force: true });
  });
});
describe('settings validation', () => {
  it('rejects wrong values, not just unknown keys', () => {
    const bad = validateSettingsPatch({
      concurrency: 'banana',
      worktree: 'typo',
      finalReview: 'sometimes',
      timeoutMs: -5,
      failOnNonZeroExit: 'yes',
      model: 42,
    });
    const fields = bad.map((p) => p.field).sort();
    assert.deepEqual(fields, [
      'concurrency',
      'failOnNonZeroExit',
      'finalReview',
      'model',
      'timeoutMs',
      'worktree',
    ]);
    // A valid patch is clean, and so are the defaults.
    assert.deepEqual(validateSettingsPatch({ concurrency: 4, worktree: 'task', model: null }), []);
    assert.deepEqual(
      validateSettingsPatch(newRun('ok').settings as unknown as Record<string, unknown>),
      [],
    );
  });

  it('refuses to run a file whose stored policy is corrupt', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].cmd = 'work';
    // Hand-edited or written by an older version: an unknown isolation mode
    // must not quietly become "no isolation".
    (run.settings as unknown as Record<string, unknown>).worktree = 'typo';
    const runner = new DagRunner(run, {
      executor: async () => ({ output: 'ok', exitCode: 0 }),
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'pending', 'nothing ran');
    assert.ok(run.events.some((e) => /invalid settings.*worktree/.test(e.message ?? '')));
    assert.equal(runner.result?.scope.length, 0);
  });
});
