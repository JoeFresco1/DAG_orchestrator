// Run-lifecycle commands: execute the graph, recover after a crash, retry or
// skip work, apply run-wide settings, and the end-of-run review.
import { DagRunner, type RunnerOptions } from '../runner.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  killOrphans,
  loadRun,
  orphanedPids,
  recoverInterrupted,
  retryFailed,
  retryTask,
  renewTaskExecutionBudget,
  restoreRunCheckpoint,
  saveRun,
  setSettings,
  skipBlocked,
  skipGated,
} from '../store.js';
import { evaluateConvergence, summarize } from '../graph.js';
import { parseHarnessChain } from '../harness-chain.js';
import { executionProfilePatch } from '../execution-policy.js';
import {
  countFlag,
  emit,
  flag,
  flagRequired,
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
  type Run,
  type Task,
} from '../types.js';

// Builds a runner whose events stream live to the terminal: JSON mode routes
// progress to stderr so stdout stays parseable. `pad` aligns the event type for
// the wider spacing the review commands use.
function buildRunner(
  run: ReturnType<typeof loadRun>,
  file: string,
  argv: string[],
  pad = 12,
  extras: Partial<RunnerOptions> = {},
): DagRunner {
  return new DagRunner(run, {
    file,
    ...extras,
    persist: (state) => saveRun(state, file),
    onEvent: (ev) => {
      const where = ev.taskId ? `${ev.taskId} ` : '';
      const line = `[${ev.ts.slice(11, 19)}] ${ev.type.padEnd(pad)} ${where}${ev.message}`;
      if (wantsJson(argv)) console.error(line);
      else console.log(line);
    },
  });
}

function sharedBudgetFlags(argv: string[]): Partial<ReturnType<typeof loadRun>['settings']> {
  const patch: Partial<ReturnType<typeof loadRun>['settings']> = {};
  const attempts = countFlag(argv, 'implementation-attempts', 1);
  const infrastructure = countFlag(argv, 'infrastructure-retries', 0);
  const deadline = flag(argv, 'task-deadline');
  if (attempts !== undefined) patch.implementationAttempts = attempts;
  if (infrastructure !== undefined) patch.infrastructureRetries = infrastructure;
  if (deadline !== undefined) patch.taskDeadlineMs = secondsToMs(deadline) ?? undefined;
  const problems = validateSettingsPatch(patch);
  if (problems.length) throw new Error(describeSettingsProblems(problems));
  return patch;
}

// `run` executes the graph to convergence. It resolves the scope from --only,
// skips manual tasks (no cmd, no chain), optionally kills orphaned process
// trees from a previous crash, then reports the final summary. A non-zero exit
// code is set when anything failed or is unfinished, so schedulers notice.
export async function runCmd(argv: string[]): Promise<void> {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  let extras: Partial<RunnerOptions> = {};
  const reliability = flag(argv, 'reliability-config');
  if (reliability) {
    // Validate controller ownership before allowing its historical execution policy.
    // @ts-expect-error Packaged JavaScript adapter supplies the runner hooks.
    const adapter = await import('../../scripts/reliability/engine-adapter.mjs');
    extras = await adapter.runnerHooks(reliability, run, file);
  }
  const profile = flag(argv, 'profile');
  if (profile !== undefined) Object.assign(run.settings, executionProfilePatch(profile));
  if (!extras.controllerManaged && run.settings.executionProfile !== 'lean' && run.settings.executionProfile !== 'flow3') {
    throw new Error('This saved run uses the retired execution policy. Upgrade the stopped run with --profile lean and an explicit --implementation-attempts limit; historical attempts remain counted.');
  }
  Object.assign(run.settings, sharedBudgetFlags(argv));
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
  const scope = run.settings.executionProfile === 'flow3' ? candidates : candidates.filter((id) => runnable(id));
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
  if (manual.length > 0 && run.settings.executionProfile !== 'flow3') {
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

  const runner = buildRunner(run, file, argv, 12, extras);
  const onSignal = (): void => {
    console.log('\nstopping (signal received)…');
    void runner.stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try { await runner.start(new Set(scope)); }
  finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
  saveRun(run, file);
  const summary = runner.result;
  emit(
    argv,
    {
      runId: run.id,
      completed: summary?.completed ?? [],
      failed: summary?.failed ?? [],
      stopped: summary?.stopped ?? true,
      skipped: summary?.skipped ?? [],
      unfinished: summary?.unfinished ?? [],
      budgetReached: summary?.budgetReached ?? false,
      interrupted: summary?.interrupted ?? { requeued: [], orphanPids: [] },
      finalReview: summary?.finalReview ?? null,
      flow3: summary?.flow3 ?? null,
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
  if (summary.stopped || summary.budgetReached || summary.failed.length > 0 || summary.unfinished.length > 0) {
    process.exitCode = 1;
  }
  if (summary.flow3 && !summary.flow3.passed) process.exitCode = 1;
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

// Recover a damaged sidecar from a full persisted checkpoint and the
// append-only evidence written after it. This is intentionally conservative:
// completed tasks require both a terminal event and an integrity-checked
// published integration receipt. Active tasks are restored as running so the
// normal kill-orphans/resume path handles them.
export function recoverCheckpointCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const checkpointFile = resolve(flagRequired(argv, 'checkpoint'));
  const eventsFile = resolve(flag(argv, 'events') ?? join(dirname(file), `${file.split(/[\\/]/).pop()}.d`, 'events.jsonl'));
  const receiptsDir = resolve(flag(argv, 'receipts') ?? join(dirname(file), `${file.split(/[\\/]/).pop()}.d`, 'integration'));
  const journal = JSON.parse(readFileSync(checkpointFile, 'utf8')) as { stage?: string; previousRun?: Run };
  const checkpoint = journal.previousRun;
  if (journal.stage !== 'committed' || !checkpoint?.id || !checkpoint.tasks) {
    throw new Error('Checkpoint source must be a committed planning-amendment journal with previousRun');
  }
  const events = readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as { seq: number; ts: string; type: string; taskId: string | null; message: string });
  const after = events.filter((event) => event.seq > checkpoint.eventSeq).sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < after.length; i++) {
    if (after[i].seq !== checkpoint.eventSeq + i + 1) throw new Error('Event log does not provide a contiguous history after the checkpoint');
  }
  const receipts = readdirSync(receiptsDir).filter((name) => name.endsWith('.json')).flatMap((name) => {
    try {
      const receipt = JSON.parse(readFileSync(join(receiptsDir, name), 'utf8')) as Record<string, unknown>;
      const { stage, integrity, ...accepted } = receipt;
      const expected = createHash('sha256').update(JSON.stringify(accepted)).digest('hex');
      if (stage !== 'published' || integrity !== expected || receipt.runId !== checkpoint.id ||
          !receipt.verification || (receipt.verification as { passed?: boolean }).passed !== true) return [];
      return [{ path: join(receiptsDir, name), receipt }];
    } catch { return []; }
  });
  const overrides: Record<string, Partial<Task>> = {};
  const ids = [...new Set(after.map((event) => event.taskId).filter((id): id is string => Boolean(id)))];
  for (const id of ids) {
    const history = after.filter((event) => event.taskId === id);
    const starts = history.filter((event) => event.type === 'task-start');
    const lifecycle = history.filter((event) => ['task-start', 'task-done', 'task-fail', 'task-killed', 'task-interrupted'].includes(event.type));
    const latest = lifecycle.at(-1);
    if (!latest) continue;
    const attemptNumbers = starts.map((event) => Number(event.message.match(/attempt (\d+)/)?.[1] ?? 0));
    const attempts = Math.max(checkpoint.tasks[id]?.attempts ?? 0, ...attemptNumbers);
    const latestStart = starts.at(-1);
    const cycle = latestStart?.message.match(/cycle (\d+)\/(\d+)/);
    const previousBudget = checkpoint.tasks[id]?.executionBudget as Task['executionBudget'] | undefined;
    let renewedDeadline: string | undefined;
    let renewedLimit: number | undefined;
    for (const event of history.filter((entry) => entry.type === 'edit')) {
      const renewed = event.message.match(/execution deadline renewed .*? -> (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
      if (renewed) renewedDeadline = renewed[1];
      const limit = event.message.match(/attempt limit \d+ -> (\d+)/);
      if (limit) renewedLimit = Number(limit[1]);
    }
    const firstDispatchAt = starts[0]?.ts ?? previousBudget?.firstDispatchAt ?? new Date().toISOString();
    const defaultDeadline = new Date(Date.parse(firstDispatchAt) + (checkpoint.settings.taskDeadlineMs ?? 2_700_000)).toISOString();
    const executionBudget: Task['executionBudget'] = previousBudget ? { ...previousBudget } : {
      version: 1, firstDispatchAt, deadlineAt: renewedDeadline ?? defaultDeadline,
      limit: renewedLimit ?? checkpoint.settings.implementationAttempts ?? 3, used: attempts, infrastructureRetries: {},
    };
    if (executionBudget) {
      if (renewedDeadline) executionBudget.deadlineAt = renewedDeadline;
      if (renewedLimit !== undefined) executionBudget.limit = renewedLimit;
      executionBudget.used = Math.max(executionBudget.used, attempts);
    }
    const common: Partial<Task> = {
      attempts,
      attemptsInCycle: cycle ? Number(cycle[1]) : checkpoint.tasks[id]?.attemptsInCycle,
      ...(executionBudget ? { executionBudget } : {}),
      pid: null,
    };
    if (latest.type === 'task-done') {
      const receiptEntry = receipts.find(({ receipt }) => receipt.taskId === id && receipt.attempt === attempts);
      if (!receiptEntry) throw new Error(`Cannot restore completed task ${id}: no matching verified published integration receipt`);
      const receipt = receiptEntry.receipt as { sourceCommit: string; candidateCommit: string; attempt: number };
      overrides[id] = { ...common, status: 'completed', startedAt: latestStart?.ts ?? null, finishedAt: latest.ts,
        exitCode: 0, failureKind: null, result: latest.message, commit: receipt.sourceCommit,
        integrationReceipt: resolve(receiptEntry.path) };
    } else if (latest.type === 'task-start') {
      overrides[id] = { ...common, status: 'running', startedAt: latest.ts, finishedAt: null, exitCode: null, failureKind: null };
    } else if (latest.type === 'task-fail') {
      overrides[id] = { ...common, status: 'failed', finishedAt: latest.ts, exitCode: null,
        failureKind: latest.message.includes('(budget)') ? 'budget' : null, result: latest.message };
    } else {
      overrides[id] = { ...common, status: 'pending', startedAt: null, finishedAt: null, pid: null };
    }
  }
  const run = restoreRunCheckpoint(file, checkpoint, overrides, events.at(-1)?.seq ?? checkpoint.eventSeq);
  const report = { runId: run.id, checkpointSeq: checkpoint.eventSeq, restoredThroughSeq: run.eventSeq,
    restoredTasks: Object.keys(overrides).length,
    counts: Object.values(run.tasks).reduce<Record<string, number>>((counts, task) => {
      counts[task.status] = (counts[task.status] ?? 0) + 1; return counts;
    }, {}) };
  emit(argv, report, () => `restored ${report.restoredTasks} task states from verified checkpoint and event history`);
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
  if (has(argv, 'additional-attempts') && !has(argv, 'renew-budget')) throw new Error('--additional-attempts requires --renew-budget and --reason');
  if (has(argv, 'renew-budget')) renewTaskExecutionBudget(run, id, flagRequired(argv, 'reason'), Date.now(), numberFlag(argv, 'additional-attempts') ?? 0);
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
  if (has(argv, 'effective')) {
    const run = loadRun(file);
    console.log(JSON.stringify({ settings: run.settings, lastExecution: run.executionPolicy ?? null }, null, 2));
    return;
  }
  // Inspection is read-only and remains available while another process runs.
  if (argv.every((value, index) => value === '--json' || value === '--file' || argv[index - 1] === '--file')) {
    console.log(JSON.stringify(loadRun(file).settings, null, 2));
    return;
  }
  guard(file, argv);
  const run = loadRun(file);
  const patch: Parameters<typeof setSettings>[1] = {};
  const profile = flag(argv, 'profile');
  if (profile !== undefined) Object.assign(patch, executionProfilePatch(profile));
  Object.assign(patch, sharedBudgetFlags(argv));
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
  const flowConfig = flag(argv, 'flow-config');
  if (flowConfig !== undefined) patch.flow3 = JSON.parse(readFileSync(flowConfig, 'utf8'));
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
  const mergeRounds = countFlag(argv, 'merge-rounds', 0);
  if (mergeRounds !== undefined) patch.mergeRounds = mergeRounds;
  if (has(argv, 'final-review-cmd')) {
    patch.finalReviewCmd = flag(argv, 'final-review-cmd') ?? null;
  }
  const model = flag(argv, 'model');
  if (model !== undefined) patch.model = model;
  const variant = flag(argv, 'variant');
  if (variant !== undefined) patch.variant = variant;
  // Plan-by-default policy: --plan auto|off (aliases --auto-plan/--no-auto-plan).
  const planMode = flag(argv, 'plan');
  if (planMode !== undefined) {
    if (planMode !== 'auto' && planMode !== 'off') {
      throw new Error(`--plan must be auto|off (got ${planMode})`);
    }
    patch.autoPlan = planMode === 'auto';
  }
  if (has(argv, 'auto-plan')) patch.autoPlan = true;
  if (has(argv, 'no-auto-plan')) patch.autoPlan = false;
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
