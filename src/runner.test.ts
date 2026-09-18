import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addTask,
  logEvent,
  mutate,
  newRun,
  readEventLog,
  retryFailed,
  retryTask,
  saveRun,
} from './store.js';
import { transitiveBlocked } from './graph.js';
import { DagRunner, shellExecutor, sleep } from './runner.js';
import { parseHarnessChain } from './harness-chain.js';
import { git } from './git-worktree.js';
import { make, never, tempDir, gitRepo } from './test-helpers.js';
import type { Run, Task } from './types.js';
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

  it('keeps the output tail, so a late verdict outvotes an early one', async () => {
    // 75k of filler puts the transcript well past the 64 KiB capture window:
    // the early PASS must not survive while the real answer is dropped.
    const script = `process.stdout.write('VERDICT: PASS\\n'); process.stdout.write('x'.repeat(75000)); process.stdout.write('\\nVERDICT: FAIL: the migration drops rows\\n');`;
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].cmd = `"${process.execPath}" -e "${script}"`;
    run.tasks[a.id].reviewCmd = `"${process.execPath}" -e "console.log('VERDICT: FAIL: the migration drops rows')"`;
    const runner = new DagRunner(run, {
      executor: shellExecutor(),
    });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed', 'a truncated PASS must not win');
    assert.match(JSON.stringify(run.tasks[a.id].reviewerVerdicts), /drops rows/);
  });

  it('fails closed when the verdict is missing entirely', async () => {
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].cmd = `"${process.execPath}" -e "console.log('I looked at the code and it seems fine')"`;
    run.tasks[a.id].reviewCmd = `"${process.execPath}" -e "console.log('I looked at the code and it seems fine')"`;
    const runner = new DagRunner(run, { executor: shellExecutor() });
    await runner.start();
    assert.equal(run.tasks[a.id].status, 'failed');
    assert.equal(run.tasks[a.id].failureKind, 'review');
  });

  it('applies the exit policy the same way for real and mocked executors', async () => {
    const real = (cmd: string, settings: Partial<Run['settings']>): Promise<Run> => {
      const { run, a } = make(['a']) as { run: Run; a: Task };
      run.tasks[a.id].cmd = cmd;
      run.tasks[a.id].maxAttempts = 1;
      Object.assign(run.settings, settings);
      return new DagRunner(run, { executor: shellExecutor() }).start().then(() => run);
    };
    const exiting = (code: number): string =>
      `"${process.execPath}" -e "process.exit(${code})"`;

    // Strict by default when nothing judges the work.
    const strict = await real(exiting(1), {});
    assert.equal(strict.tasks[Object.keys(strict.tasks)[0]].status, 'failed');
    assert.equal(strict.tasks[Object.keys(strict.tasks)[0]].failureKind, 'exit');

    // An explicit opt-out is honoured by the real executor too.
    const lax = await real(exiting(1), { failOnNonZeroExit: false });
    assert.equal(lax.tasks[Object.keys(lax.tasks)[0]].status, 'completed');
    assert.equal(lax.tasks[Object.keys(lax.tasks)[0]].exitCode, 1);

    // With a judge, the verdict decides and the reviewer actually runs.
    let reviewed = 0;
    const { run, a } = make(['a']) as { run: Run; a: Task };
    run.tasks[a.id].cmd = exiting(1);
    run.tasks[a.id].reviewCmd = 'verify {spec}';
    run.settings.failOnNonZeroExit = null;
    const runner = new DagRunner(run, {
      executor: async (task, ctx, cmd) => {
        if (cmd?.startsWith('verify')) {
          reviewed += 1;
          return { output: 'VERDICT: PASS', exitCode: 0 };
        }
        return shellExecutor()(task, ctx, cmd);
      },
    });
    await runner.start();
    assert.equal(reviewed, 1, 'the reviewer runs despite the nonzero exit');
    assert.equal(run.tasks[a.id].status, 'completed');
    assert.equal(run.tasks[a.id].exitCode, 1, 'the exit is still recorded');
  });

  it('does not land work whose exit policy rejected it', async () => {
    const repo = gitRepo();
    try {
      mkdirSync(join(repo, 'sub'), { recursive: true });
      writeFileSync(join(repo, 'tracked.txt'), 'base\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'base2']);
      const base = git(repo, ['rev-parse', 'HEAD']).stdout;
      const { run, a } = make(['a']) as { run: Run; a: Task };
      // No shell here: '&&' would be an argv token, not an operator.
      run.tasks[a.id].cmd = `"${process.execPath}" -e "require('node:fs').writeFileSync('rejected.txt','nope');process.exit(1)"`;
      run.tasks[a.id].maxAttempts = 1;
      run.settings.worktree = 'task';
      const runner = new DagRunner(run, {
        cwd: repo,
        executor: shellExecutor(),
      });
      await runner.start();
      assert.equal(run.tasks[a.id].status, 'failed');
      // Salvage keeps the WIP on the task branch (that is intentional), but the
      // rejected change must never reach the integration branch.
      const integration = `dag/${run.id}`;
      if (git(repo, ['rev-parse', '--verify', integration]).code === 0) {
        const landed = git(repo, ['show', `${integration}:rejected.txt`]).code === 0;
        assert.equal(landed, false, 'rejected work reached the integration branch');
      }
      assert.equal(git(repo, ['rev-parse', 'HEAD']).stdout, base, 'no branch moved');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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
describe('scheduling throughput', () => {
  it('refills a freed slot immediately instead of waiting for the batch', async () => {
    // The probe that found this: with concurrency 2, [slow, fast] ran and the
    // third task waited for the slow one. A freed slot must be refilled.
    const run = newRun('slots');
    const slow = addTask(run, { title: 'slow', spec: '', cmd: 'slow' });
    const fast = addTask(run, { title: 'fast', spec: '', cmd: 'fast' });
    const next = addTask(run, { title: 'next', spec: '', cmd: 'next' });
    const startedAt = new Map<string, number>();
    const finishedAt = new Map<string, number>();
    const runner = new DagRunner(run, {
      concurrency: 2,
      executor: async (task) => {
        startedAt.set(task.id, Date.now());
        await sleep(task.id === slow.id ? 600 : task.id === fast.id ? 50 : 20);
        finishedAt.set(task.id, Date.now());
        return { output: 'ok', exitCode: 0 };
      },
    });
    await runner.start();
    const fastDone = finishedAt.get(fast.id) ?? 0;
    const nextStart = startedAt.get(next.id) ?? Number.MAX_SAFE_INTEGER;
    assert.ok(
      nextStart - fastDone < 200,
      `the third task started ${nextStart - fastDone}ms after the fast one finished (batch barrier)`,
    );
    assert.equal(run.tasks[next.id].status, 'completed');
    assert.ok((startedAt.get(next.id) ?? 0) >= (startedAt.get(slow.id) ?? 0));
  });
});
