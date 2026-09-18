// Graph scheduling and project-registry tests: ready/blocked computation, topo
// order, scoped runs, project identity, job ordering, and time parsing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { addTask, newRun } from './store.js';
import { assertNoCycle, getBlocked, getReady, topoSort, transitiveBlocked } from './graph.js';
import { DagRunner } from './runner.js';
import { addProject, loadRegistry, projectId, removeProject, saveRegistry } from './registry.js';
import { addJob, decideDue, jobArgsToArgv, loadSchedule, parseAt, removeJob } from './scheduler.js';
import { make, tempDir } from './test-helpers.js';
import type { Run, Task } from './types.js';
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
describe('projects and scheduling', () => {
  it('treats the same run file as one project however the path is spelled', () => {
    const dir = tempDir();
    // Point the registry at a throwaway file so the user's projects are safe.
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
