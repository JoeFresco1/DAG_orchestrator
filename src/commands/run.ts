// Run-lifecycle commands: execute the graph, recover after a crash, retry or
// skip work, apply run-wide settings, and the end-of-run review.
import { DagRunner } from '../runner.js';
import {
  killOrphans,
  loadRun,
  orphanedPids,
  recoverInterrupted,
  retryFailed,
  retryTask,
  saveRun,
  setSettings,
  skipBlocked,
  skipGated,
} from '../store.js';
import { evaluateConvergence, summarize } from '../graph.js';
import { parseHarnessChain } from '../harness-chain.js';
import {
  countFlag,
  emit,
  flag,
  guard,
  has,
  numberFlag,
  parseList,
  policyFlags,
  retriesToMaxAttempts,
  secondsToMs,
  taskTimingFlags,
  wantsJson,
} from '../cli-args.js';
import {
  MAX_CONCURRENCY,
  describeSettingsProblems,
  validateSettingsPatch,
} from '../types.js';

// Builds a runner whose events stream live to the terminal: JSON mode routes
// progress to stderr so stdout stays parseable. `pad` aligns the event type for
// the wider spacing the review commands use.
function buildRunner(
  run: ReturnType<typeof loadRun>,
  file: string,
  argv: string[],
  pad = 12,
): DagRunner {
  return new DagRunner(run, {
    file,
    persist: (state) => saveRun(state, file),
    onEvent: (ev) => {
      const where = ev.taskId ? `${ev.taskId} ` : '';
      const line = `[${ev.ts.slice(11, 19)}] ${ev.type.padEnd(pad)} ${where}${ev.message}`;
      if (wantsJson(argv)) console.error(line);
      else console.log(line);
    },
  });
}

// `run` executes the graph to convergence. It resolves the scope from --only,
// skips manual tasks (no cmd, no chain), optionally kills orphaned process
// trees from a previous crash, then reports the final summary. A non-zero exit
// code is set when anything failed or is unfinished, so schedulers notice.
export async function runCmd(argv: string[]): Promise<void> {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const requested = countFlag(argv, 'concurrency', 1) ?? run.settings.concurrency;
  if (requested > MAX_CONCURRENCY) throw new Error(`--concurrency max is ${MAX_CONCURRENCY}`);
  const concurrency = Math.max(1, requested);
  run.settings.concurrency = concurrency;
  if (concurrency > MAX_CONCURRENCY) {
    console.log(`concurrency capped at ${MAX_CONCURRENCY}`);
  }
  const only = argv.includes('--only') ? new Set(parseList(flag(argv, 'only'))) : null;
  if (only !== null) {
    const unknown = [...only].filter((id) => !run.tasks[id]);
    if (unknown.length > 0) throw new Error(`unknown tasks: ${unknown.join(', ')}`);
  }
  if (has(argv, 'dry-run')) {
    console.log(summarize(run));
    console.log(`convergence: ${evaluateConvergence(run)}`);
    return;
  }
  const timing = taskTimingFlags(argv);
  if (timing.maxAttempts !== undefined) run.settings.maxAttempts = timing.maxAttempts;
  if (timing.timeoutMs !== undefined && timing.timeoutMs !== null) {
    run.settings.timeoutMs = timing.timeoutMs;
  }
  if (timing.silenceMs !== undefined && timing.silenceMs !== null) {
    run.settings.silenceMs = timing.silenceMs;
  }
  Object.assign(run.settings, policyFlags(argv));
  const maxHours = numberFlag(argv, 'max-hours', 0);
  if (maxHours !== undefined) run.settings.maxWallClockMs = Math.round(Number(maxHours) * 3600_000);
  const worktree = flag(argv, 'worktree');
  if (worktree !== undefined) {
    if (worktree !== 'none' && worktree !== 'task') {
      throw new Error(`--worktree must be none|task (got ${worktree})`);
    }
    run.settings.worktree = worktree;
  }
  const silenceAction = flag(argv, 'silence-action');
  if (silenceAction !== undefined) {
    if (silenceAction !== 'warn' && silenceAction !== 'kill') {
      throw new Error(`--silence-action must be warn|kill (got ${silenceAction})`);
    }
    run.settings.silenceAction = silenceAction;
  }

  const candidates = only === null ? Object.keys(run.tasks) : [...only];
  // A harness chain supplies the command at run time, so it counts as runnable.
  const runnable = (id: string): boolean =>
    Boolean(
      run.tasks[id].cmd ||
        run.tasks[id].harnessChain?.length ||
        run.settings.harnessChain?.length,
    );
  const manual = candidates.filter(
    (id) =>
      !runnable(id) &&
      (run.tasks[id].status === 'pending' || run.tasks[id].status === 'ready'),
  );
  const scope = candidates.filter((id) => runnable(id));
  if (scope.length === 0) {
    console.log(
      manual.length > 0
        ? `nothing to run: manual task(s) without cmd: ${manual.join(', ')}`
        : 'nothing to run: no task selected',
    );
    console.log(summarize(run));
    process.exitCode = 1;
    return;
  }
  if (manual.length > 0) {
    console.log(`skipping ${manual.length} manual task(s) without cmd: ${manual.join(', ')}`);
  }
  if (has(argv, 'kill-orphans')) {
    // Recover first: only then do the crashed run's tasks carry the pids we
    // are about to kill (and the runner's own recovery pass is idempotent).
    recoverInterrupted(run);
    const killed = killOrphans(run);
    const n = killed.filter((k) => k.killed).length;
    if (n > 0) console.log(`killed ${n} orphan process(es)`);
  }

  const runner = buildRunner(run, file, argv);
  const onSignal = (): void => {
    console.log('\nstopping (signal received)…');
    void runner.stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  await runner.start(new Set(scope));
  saveRun(run, file);
  const summary = runner.result;
  emit(
    argv,
    {
      runId: run.id,
      completed: summary?.completed ?? [],
      failed: summary?.failed ?? [],
      skipped: summary?.skipped ?? [],
      unfinished: summary?.unfinished ?? [],
      budgetReached: summary?.budgetReached ?? false,
      interrupted: summary?.interrupted ?? { requeued: [], orphanPids: [] },
      finalReview: summary?.finalReview ?? null,
    },
    () => summarize(run),
  );
  if (summary && summary.budgetReached) {
    console.log('note: wall clock budget reached before finishing');
  }
  if (!summary) {
    // The runner refused to start (isolation unavailable, bad graph): say so
    // and fail, because a scheduler treats exit 0 as success.
    console.error('run did not start; nothing was executed');
    process.exitCode = 1;
    return;
  }
  // Exit non-zero when the run did not fully converge, so schedulers and CI
  // treat a failed or unfinished run as a failure.
  const review = summary.finalReview;
  if (review && review.verdict !== 'pass' && review.verdict !== 'skipped') {
    process.exitCode = 1;
  }
  if (summary.failed.length > 0 || summary.unfinished.length > 0) {
    process.exitCode = 1;
  }
}

// `resume` requeues tasks that were interrupted by a crash/restart, and
// optionally reaps the process trees that survived.
export function resumeCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const recovery = recoverInterrupted(run);
  saveRun(run, file);
  if (has(argv, 'kill-orphans')) {
    const killed = killOrphans(run);
    saveRun(run, file);
    console.log(`killed ${killed.filter((k) => k.killed).length} orphan process(es)`);
  }
  if (recovery.requeued.length === 0) {
    emit(argv, recovery, () => 'nothing to recover');
  } else {
    emit(argv, recovery, () => {
      const lines = [
        `requeued ${recovery.requeued.length} interrupted task(s): ${recovery.requeued.join(', ')}`,
      ];
      if (recovery.orphanPids.length > 0) {
        lines.push(
          `possible orphan pid(s): ${recovery.orphanPids.join(', ')} — run 'dag kill-orphans' to kill them`,
        );
      }
      return lines.join('\n');
    });
  }
  if (!wantsJson(argv)) console.log(summarize(run));
}

// `skip-blocked` marks blocked/gated tasks skipped so a run whose dependencies
// will never be met still converges.
export function skipBlockedCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const skipped = [...skipBlocked(run), ...skipGated(run)];
  saveRun(run, file);
  emit(
    argv,
    { skipped },
    () => (skipped.length > 0 ? `skipped ${skipped.length} task(s): ${skipped.join(', ')}` : 'nothing to skip'),
  );
}

// `kill-orphans` kills process trees recorded by a run that died hard.
export function killOrphansCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const pids = orphanedPids(run);
  if (pids.length === 0) {
    emit(argv, { killed: [] }, () => 'no orphan pids recorded');
    return;
  }
  const killed = killOrphans(run);
  saveRun(run, file);
  emit(argv, { killed }, () => killed.map((k) => `pid ${k.pid}: ${k.killed ? 'killed' : 'not found'}`).join('\n'));
}

// `retry --id X [--cascade]` requeues one failed task (and, with --cascade, the
// failed subtree that depended on it).
export function retryCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const id = flag(argv, 'id');
  if (!id) throw new Error('--id is required (or use retry-failed)');
  const touched = retryTask(run, id, has(argv, 'cascade'));
  saveRun(run, file);
  emit(argv, { requeued: touched }, () => `requeued: ${touched.join(', ')}`);
}

// `retry-failed [--cascade]` requeues every failed task.
export function retryFailedCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const touched = retryFailed(run, has(argv, 'cascade'));
  saveRun(run, file);
  emit(
    argv,
    { requeued: touched },
    () => (touched.length > 0 ? `requeued: ${touched.join(', ')}` : 'no failed tasks'),
  );
}

// `settings` patches the run-wide settings, validating each value before it is
// stored so a typo cannot silently change the execution model.
export function settingsCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const patch: Parameters<typeof setSettings>[1] = {};
  const concurrency = countFlag(argv, 'concurrency', 1);
  if (concurrency !== undefined) {
    if (concurrency > MAX_CONCURRENCY) {
      throw new Error(`--concurrency max is ${MAX_CONCURRENCY}`);
    }
    patch.concurrency = concurrency;
  }
  const maxAttempts = retriesToMaxAttempts(flag(argv, 'retries'));
  if (maxAttempts !== undefined) patch.maxAttempts = maxAttempts;
  const timeoutMs = secondsToMs(flag(argv, 'timeout'));
  if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
  const silenceMs = secondsToMs(flag(argv, 'silence'));
  if (silenceMs !== undefined) patch.silenceMs = silenceMs;
  const maxHours = numberFlag(argv, 'max-hours', 0);
  if (maxHours !== undefined) patch.maxWallClockMs = Math.round(maxHours * 3600_000);
  const notify = flag(argv, 'notify');
  if (notify !== undefined) patch.notifyCmd = notify;
  const worktree = flag(argv, 'worktree');
  if (worktree !== undefined) {
    if (worktree !== 'none' && worktree !== 'task') {
      throw new Error(`--worktree must be none|task (got ${worktree})`);
    }
    patch.worktree = worktree;
  }
  const silenceAction = flag(argv, 'silence-action');
  if (silenceAction !== undefined) {
    if (silenceAction !== 'warn' && silenceAction !== 'kill') {
      throw new Error(`--silence-action must be warn|kill (got ${silenceAction})`);
    }
    patch.silenceAction = silenceAction;
  }
  const prepare = flag(argv, 'worktree-prepare');
  if (prepare !== undefined) patch.worktreePrepareCmd = prepare;
  const chain = flag(argv, 'harness-chain');
  if (chain !== undefined) patch.harnessChain = chain ? parseHarnessChain(chain) : [];
  if (has(argv, 'fail-on-exit')) patch.failOnNonZeroExit = true;
  if (has(argv, 'no-fail-on-exit')) patch.failOnNonZeroExit = false;
  if (has(argv, 'auto-fail-on-exit')) patch.failOnNonZeroExit = null;
  const finalReview = flag(argv, 'final-review');
  if (finalReview !== undefined) {
    if (finalReview !== 'off' && finalReview !== 'per-task' && finalReview !== 'run') {
      throw new Error(`--final-review must be off|per-task|run (got ${finalReview})`);
    }
    patch.finalReview = finalReview;
  }
  const finalReviewRounds = countFlag(argv, 'final-review-rounds', 0);
  if (finalReviewRounds !== undefined) patch.finalReviewRounds = finalReviewRounds;
  if (has(argv, 'final-review-cmd')) {
    patch.finalReviewCmd = flag(argv, 'final-review-cmd') ?? null;
  }
  const model = flag(argv, 'model');
  if (model !== undefined) patch.model = model;
  const variant = flag(argv, 'variant');
  if (variant !== undefined) patch.variant = variant;
  Object.assign(patch, policyFlags(argv));
  if (Object.keys(patch).length === 0) {
    throw new Error(
      'nothing to set; use --concurrency, --retries, --timeout, --silence, --max-hours, --worktree, --model, ...',
    );
  }
  const problems = validateSettingsPatch(patch as Record<string, unknown>);
  if (problems.length > 0) {
    throw new Error(`invalid settings: ${describeSettingsProblems(problems)}`);
  }
  const settings = setSettings(run, patch);
  saveRun(run, file);
  console.log(JSON.stringify(settings, null, 2));
}

// `final-review` runs the end-of-run code review without re-running work: the
// scope is exactly the tasks that already completed (a task the review sends
// back is re-executed by the same id).
export async function finalReviewCmd(argv: string[]): Promise<void> {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const mode = flag(argv, 'mode') ?? run.settings.finalReview ?? 'off';
  if (mode !== 'per-task' && mode !== 'run') {
    throw new Error('nothing to review: use --mode per-task|run (or dag settings --final-review)');
  }
  run.settings.finalReview = mode;
  const rounds = countFlag(argv, 'rounds', 0);
  if (rounds !== undefined) run.settings.finalReviewRounds = rounds;
  if (has(argv, 'cmd')) run.settings.finalReviewCmd = flag(argv, 'cmd') ?? null;
  saveRun(run, file);
  const runner = buildRunner(run, file, argv, 18);
  const reviewScope = new Set(
    Object.keys(run.tasks).filter((id) => run.tasks[id].status === 'completed'),
  );
  await runner.start(reviewScope);
  saveRun(run, file);
  const summary = runner.result;
  emit(
    argv,
    {
      runId: run.id,
      review: summary?.finalReview ?? null,
      failed: summary?.failed ?? [],
    },
    () => {
      const review = summary?.finalReview;
      if (!review) return 'no review ran';
      return `review ${review.verdict}${review.reason ? `: ${review.reason}` : ''}` +
        `\n  reviewed: ${review.reviewed.join(', ') || '(none)'}` +
        `\n  failed: ${review.failed.join(', ') || '(none)'}`;
    },
  );
  if (summary?.finalReview && summary.finalReview.verdict !== 'pass' && summary.finalReview.verdict !== 'skipped') {
    process.exitCode = 1;
  }
}
