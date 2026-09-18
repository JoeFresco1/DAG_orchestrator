import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCommand } from './command-resolution.js';
import {
  commitAll,
  createTaskWorktree,
  ensureIntegrationWorktree,
  git,
  isDirty,
  isGitRepo,
  mergeIntoIntegration,
  removeWorktree,
  snapshotExcludes,
  worktreeRoot,
  type SnapshotExcludes,
} from './git-worktree.js';
import {
  depsMet,
  describeDeps,
  gateBlocks,
  isTerminal,
  topoSort,
  transitiveDependentIds,
} from './graph.js';
import { attemptsForChain, planAttempt, type HarnessCandidate } from './harness-chain.js';
import { findHarness } from './harnesses.js';
import {
  decideReviewers,
  summarizeVerdicts,
  type DiffStats,
  type Reviewer,
} from './review-policy.js';
import {
  acquireLock,
  attemptLogPath,
  heartbeatPath,
  lockHeldBy,
  logEvent,
  recoverInterrupted,
  runPaths,
  skipBlocked,
  skipGated,
  type RecoveryResult,
} from './store.js';
import {
  ATTEMPT_LOG_CAP_DEFAULT,
  DEFAULT_SETTINGS,
  OUTPUT_TAIL_LIMIT,
  PLAN_LIMIT,
  RESULT_LIMIT,
  type DagEvent,
  type DepFailurePolicy,
  type FailureKind,
  type FinalReviewMode,
  type GatePolicy,
  describeSettingsProblems,
  validateSettingsPatch,
  type TaskCoverage,
  type Run,
  type Task,
} from './types.js';

// In-process ownership: the lock's pid check treats "same pid" as re-entrant,
// which is right for a CLI wrapper reusing its own lock but wrong for a second
// runner in the same process. This set closes that gap.
const ownedFiles = new Set<string>();

const refuseMessage = (file: string): string =>
  `run file is locked (${file}) — a run is in progress. ` +
  'Parallel workers live inside a run: raise --concurrency (up to 64). ' +
  'Independent graphs need their own run file (dag launch --all).';

/**
 * Values a `{token}` in a command or spec can expand to. The runner fills only
 * the fields a given phase actually produced; `renderTokens` substitutes them.
 */
export interface TokenContext {
  // Path to the current attempt's captured plan (the `{planFile}` token).
  planFile?: string;
  // Chain review: facts about the tasks this task covers.
  coverage?: string;
  coverageManifest?: string;
  coverageDir?: string;
  coverageStat?: string;
  coverageFiles?: string;
  // End-of-run review: where the diff is, and the range it covers.
  diffFile?: string;
  diffBase?: string;
  diffHead?: string;
  diffStat?: string;
  files?: string;
  // Upstream evidence: direct deps, the transitive roll-up, and a file with both.
  deps?: string;
  depsAll?: string;
  depsFile?: string;
  // The prior attempt's rejection reason, fed into a redo prompt.
  lastRejection?: string | null;
}

export interface ExecContext extends TokenContext {
  // The executor contract: stream output for the heartbeat/log, hand the runner
  // a kill hook and the live pid, and ask whether a stop/kill already claimed
  // this task before treating a termination as the task's own outcome.
  onOutput: (chunk: string) => void;
  // Registered so the runner can kill this process on stop/timeout/stall.
  registerKill: (fn: () => void) => void;
  // True once the runner has recorded a kill reason for this task.
  aborted: () => boolean;
  // Persist the process id so a crashed run can later spot orphans.
  setPid: (pid: number | null) => void;
  // Per-task working directory (worktree isolation); falls back to the
  // executor's default when undefined.
  cwd?: string;
  // Path to the current attempt's plan file, for the `{planFile}` token.
  planFile?: string;
  // Upstream evidence, for `{deps}` / `{depsAll}` / `{depsFile}`.
  deps?: string;
  depsAll?: string;
  depsFile?: string;
}

/**
 * Result of one executed phase. `exitCode` is null only when the process died
 * by signal; an ordinary non-zero exit is an outcome the runner's policy judges.
 */
export interface ExecOutcome {
  output: string;
  exitCode: number | null;
}

// `cmdOverride` lets the runner reuse the executor for reviewer commands.
export type Executor = (task: Task, ctx: ExecContext, cmdOverride?: string) => Promise<ExecOutcome>;

// Promise-based timer: the scheduler polls with this and retries back off on it.
export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// One timestamp format everywhere (events, task state, reviews): ISO-8601 UTC.
export const nowIso = (): string => new Date().toISOString();

// Head-truncation, for text whose beginning matters (plans, specs). Agent
// output needs truncateTail instead: its verdict is at the end.
export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n… [truncated ${s.length - n} chars]`;
}

// Verdicts and summaries live at the END of an agent's output; keeping the
// head meant losing the very line that decides pass/fail.
export function truncateTail(s: string, n: number): string {
  return s.length <= n ? s : `… [truncated ${s.length - n} chars]\n${s.slice(-n)}`;
}

// A reviewer's verdict must be machine-readable, because a harness exits 0
// after a successful session no matter what it concluded. Accepted forms:
//   VERDICT: PASS
//   VERDICT: FAIL: <reason>
export function parseVerdict(output: string): { kind: 'pass' | 'fail' | 'none'; reason: string } {
  const matches = [...output.matchAll(/^[^\S\n]*VERDICT[^\S\n]*:[^\S\n]*(PASS|FAIL)\b[^\S\n]*:?[^\S\n]*(.*)$/gim)];
  // The LAST verdict line wins: an agent's transcript can echo an early PASS
  // and only conclude FAIL at the end, and the conclusion is the verdict.
  const last = matches[matches.length - 1];
  if (!last) return { kind: 'none', reason: '' };
  const kind = last[1].toUpperCase() === 'PASS' ? 'pass' : 'fail';
  return { kind, reason: (last[2] ?? '').trim() };
}

// Captured phase output is fed back into later prompts, so terminal chrome
// (ANSI colors, cursor moves) must not travel with it.
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '');
}

// Kill the whole process tree. Windows: child.kill() only terminates the
// direct child, so npm.cmd -> node would survive. taskkill /T /F does not.
export function killTree(child: ChildProcess): void {
  if (child.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL'); // detached => own process group
      return;
    } catch {
      // fall through to direct kill
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

export function shellSplit(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (escaped) {
      cur += c;
      escaped = false;
      continue;
    }
    // Only `\"` and `\\` are escapes; a lone backslash is a path separator.
    if (c === '\\' && quoted && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) {
      escaped = true;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

// Task fields can be injected into a command without any shell quoting:
// `opencode run --auto {spec}` becomes argv ['opencode','run','--auto','<the spec>'].
// `{plan}` is the planning phase's output; `{planFile}` is a file holding it.
// Model and reasoning effort are settings, not text: a command writes
// `-m {model} --variant {variant}` and the effective values come from the
// task, falling back to the run. When a value is empty the flag is removed
// rather than left dangling (an empty argv element would eat the next token).
export function resolveHarness(
  cmd: string,
  task: Pick<Task, 'model' | 'variant'>,
  settings: { model?: string; variant?: string },
): string {
  const model = (task.model ?? settings.model ?? '').trim();
  const variant = (task.variant ?? settings.variant ?? '').trim();
  let out = cmd;
  out = model
    ? out.replace(/\{model\}/g, model)
    : out.replace(/(?:-m|--model)[=\s]+\{model\}\s?/g, '');
  out = variant
    ? out.replace(/\{variant\}/g, variant)
    : out.replace(/--variant[=\s]+\{variant\}\s?/g, '');
  return out;
}

export function renderTokens(token: string, task: Task, ctx?: TokenContext): string {
  if (!token.includes('{')) return token;
  const values: Record<string, string> = {
    id: task.id,
    title: task.title,
    spec: task.spec ?? '',
    plan: task.plan ?? '(no plan)',
    planFile: ctx?.planFile ?? '',
    diffFile: ctx?.diffFile ?? '',
    diffBase: ctx?.diffBase ?? '',
    diffHead: ctx?.diffHead ?? '',
    diffStat: ctx?.diffStat ?? '',
    files: ctx?.files ?? '',
    coverage: ctx?.coverage ?? '',
    coverageManifest: ctx?.coverageManifest ?? '',
    coverageDir: ctx?.coverageDir ?? '',
    coverageStat: ctx?.coverageStat ?? '',
    coverageFiles: ctx?.coverageFiles ?? '',
    deps: ctx?.deps ?? '(no dependencies)',
    depsAll: ctx?.depsAll ?? '(no upstream tasks)',
    depsFile: ctx?.depsFile ?? '',
    lastRejection: task.lastRejection ?? '(none)',
  };
  // One pass, so a token appearing inside an injected value (a spec that
  // mentions "{deps}") is text, not a substitution.
  const rendered = token.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? values[name] : match,
  );
  // A substituted value that starts with "-" would be read as a CLI flag by
  // the spawned program (yargs/commander print usage and exit 1). A leading
  // newline keeps it a positional without changing what the agent reads.
  if (rendered.startsWith('-') && !token.startsWith('-')) return `\n${rendered}`;
  return rendered;
}

// Spawn without a shell: no quoting/injection surprises. Streams output so
// the runner can treat stdout/stderr activity as a heartbeat.
// `cwd` matters: without it an agent started from the viewer would work in
// whatever directory the server happened to be launched from.
export function shellExecutor(cwd?: string): Executor {
  return (task, ctx, cmdOverride) =>
    new Promise((resolve, reject) => {
      const command = cmdOverride ?? task.cmd;
      if (!command) {
        reject(Object.assign(new Error('no cmd'), { kind: 'manual' as FailureKind }));
        return;
      }
      const [file, ...args] = shellSplit(command).map((token) => renderTokens(token, task, ctx));
      const resolved = resolveCommand(file);
      let child: ChildProcess;
      try {
        child = spawn(resolved.file, [...resolved.args, ...args], {
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: ctx.cwd ?? cwd,
        });
      } catch (err) {
        reject(Object.assign(err as Error, { kind: 'spawn' as FailureKind }));
        return;
      }
      ctx.setPid(child.pid ?? null);
      ctx.registerKill(() => killTree(child));
      // Keep a rolling window of the tail, never the head: verdicts and failure
      // reasons are at the end of the output, and a head-truncated transcript
      // let an early "VERDICT: PASS" outvote a late "VERDICT: FAIL".
      let output = '';
      const onData = (buf: Buffer): void => {
        const chunk = buf.toString();
        output += chunk;
        if (output.length > CAPTURE_LIMIT * 2) output = output.slice(-CAPTURE_LIMIT * 2);
        ctx.onOutput(chunk);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => {
        ctx.setPid(null);
        reject(Object.assign(err, { kind: 'spawn' as FailureKind }));
      });
      child.on('close', (code, signal) => {
        ctx.setPid(null);
        const captured =
          output.length > CAPTURE_LIMIT
            ? truncateTail(output, CAPTURE_LIMIT)
            : output;
        if (ctx.aborted()) {
          reject(Object.assign(new Error('aborted'), { kind: 'killed' as FailureKind }));
          return;
        }
        if (code === null || signal) {
          // Died by signal: infrastructure, not a task outcome; the exit policy
          // never sees it and the attempt is retried like any other failure.
          reject(
            Object.assign(new Error(`killed by ${signal ?? 'unknown signal'}${tailOf(captured)}`), {
              kind: 'exit' as FailureKind,
              signal: signal ?? null,
            }),
          );
          return;
        }
        // Ordinary termination — including a nonzero exit — is an outcome. The
        // exit policy is applied once, by the runner, before anything lands.
        resolve({ output: captured, exitCode: code });
      });
    });
}

// Bytes of an attempt's output kept for the task result. The executor holds a
// larger rolling window while streaming but truncates to this on settlement.
const CAPTURE_LIMIT = 64 * 1024;

// Short tail of captured output, prefixed with a newline so it appends cleanly
// to an error message. Empty string when the phase produced no output at all.
function tailOf(output: string): string {
  const tail = output.trim();
  return tail ? `\n${truncateTail(tail, 600)}` : '';
}

/**
 * Everything the runner may be told that is not part of the run file itself.
 * All optional: an unset value falls back to the run's settings, then defaults.
 */
export interface RunnerOptions {
  executor?: Executor;
  persist?: (run: Run) => void;
  onEvent?: (ev: DagEvent) => void;
  concurrency?: number;
  timeoutMs?: number;
  silenceMs?: number;
  maxAttempts?: number;
  onDepFailure?: DepFailurePolicy;
  onGateBlocked?: GatePolicy;
  maxWallClockMs?: number;
  logCapBytes?: number;
  stopGraceMs?: number;
  persistThrottleMs?: number;
  // Run file path; enables per-attempt log files and sets the default cwd.
  file?: string;
  // Working directory for spawned commands. Defaults to the run file's dir.
  cwd?: string;
}

/** Final buckets for a settled run, plus recovery and end-of-run review facts. */
export interface RunSummary {
  scope: string[];
  completed: string[];
  failed: string[];
  skipped: string[];
  unfinished: string[];
  stopped: boolean;
  budgetReached: boolean;
  interrupted: RecoveryResult;
  // End-of-run review outcome, when one was configured.
  finalReview: FinalReviewSummary | null;
}

/** Verdict of the end-of-run review (per-task or whole-run), when configured. */
export interface FinalReviewSummary {
  mode: FinalReviewMode;
  verdict: 'pass' | 'fail' | 'error' | 'skipped';
  reason: string;
  reviewed: string[];
  failed: string[];
  requeued: string[];
}

// Live state of an open per-attempt log file. `written` counts actual bytes
// (not UTF-16 code units) so the cap is a real byte cap, and `capped` makes the
// one-time truncation notice print exactly once.
interface AttemptLog {
  stream: WriteStream;
  written: number;
  capped: boolean;
}

/** The execution engine for one run: schedule, execute, review, and land tasks. */
export class DagRunner {
  // Task ids currently being executed, whether or not their process is alive.
  private inFlight = new Set<string>();
  // Kill hooks installed by executors, keyed by task id.
  private kills = new Map<string, () => void>();
  // Why a task is being killed; read by the settlement path to classify the failure.
  private reasons = new Map<string, FailureKind>();
  // Per-attempt generation counter: bumping it makes a late settlement from an
  // earlier attempt a no-op. Checked by beginAttempt/endAttempt callers.
  private tokens = new Map<string, number>();
  // Open per-attempt log files.
  private logs = new Map<string, AttemptLog>();
  // Attempt number for the open log file, used when lazily creating it.
  private attemptByTask = new Map<string, number>();
  // Lifecycle flags for stop()/start().
  private stopping = false;
  private active = false;
  // Coalesced-persist state: `dirty` marks a write pending, `flushTimer` holds
  // the scheduled flush while one is pending.
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void> | null = null;
  private summary: RunSummary | null = null;
  // Rejected by stop() to release tasks whose executor ignores the kill.
  private stopGate: Promise<never> = new Promise<never>(() => {});
  private rejectStopGate: ((err: Error) => void) | null = null;
  private budgetReached = false;
  // Interrupted tasks requeued and orphan pids spotted at start, reported at end.
  private recovery: RecoveryResult = { requeued: [], orphanPids: [] };
  // Releases the run-file lock on teardown; null when the caller already held it.
  private releaseLock: (() => void) | null = null;
  // Per-task worktree path, and the integration commit the worktree branched from.
  private worktrees = new Map<string, string>();
  private worktreeBases = new Map<string, string>();
  // The shared integration worktree and the commit the run started from.
  private integration: { path: string; branch: string } | null = null;
  private integrationBase: string | null = null;
  // Repository root for git operations (null when isolation is off).
  private repoDir: string | null = null;
  // Paths excluded from the worktree snapshot, so run artifacts stay out of git.
  private excludes: SnapshotExcludes | undefined;
  // Serializes merges into the integration branch: only one writer at a time.
  private landChain: Promise<void> = Promise.resolve();
  // Counters for end-of-run review rounds (current round vs the configured cap).
  private reviewRound = 0;
  private reviewRounds = 0;
  // Latest end-of-run review outcome, surfaced in the run summary.
  private finalReview: FinalReviewSummary | null = null;
  // Coverage bundles are deterministic once their covered tasks finish, so cache
  // them per chain-review task rather than rebuilding on every attempt.
  private coverageCache = new Map<string, TaskCoverage | null>();

  constructor(
    readonly state: Run,
    private readonly opts: RunnerOptions = {},
  ) {}

  get isRunning(): boolean {
    return this.active;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  get current(): string[] {
    return [...this.inFlight];
  }

  get result(): RunSummary | null {
    return this.summary;
  }

  // Resolves when the run settles or stops. Never rejects.
  async start(scope: Set<string> | null = null): Promise<void> {
    if (this.active) return this.loopPromise ?? Promise.resolve();

    // A run file can be hand-edited or written by an older version: an
    // invalid policy must refuse execution instead of silently changing the
    // execution model (an unknown isolation mode used to mean "unisolated").
    {
      const problems = validateSettingsPatch(
        this.state.settings as unknown as Record<string, unknown>,
      );
      if (problems.length > 0) {
        this.log('note', null, `not starting: invalid settings — ${describeSettingsProblems(problems)}`);
        this.summary = {
          scope: [],
          completed: [],
          failed: [],
          skipped: [],
          unfinished: [],
          stopped: true,
          budgetReached: false,
          interrupted: { requeued: [], orphanPids: [] },
          finalReview: null,
        };
        this.active = false;
        this.stopping = false;
        this.flush();
        return;
      }
    }

    // One runner owns the file. If the caller (CLI, server) already holds the
    // lock we reuse it; otherwise take it here so programmatic use is safe too.
    if (this.opts.file) {
      const file = this.opts.file;
      let refusal: string | null = null;
      if (ownedFiles.has(file)) {
        refusal = refuseMessage(file);
      } else if (!lockHeldBy(file)) {
        try {
          this.releaseLock = acquireLock(file, 'runner');
        } catch (err) {
          refusal = err instanceof Error ? err.message : String(err);
        }
      }
      if (refusal) {
        this.log('note', null, `not starting: ${refusal}`);
        this.summary = {
          scope: [],
          completed: [],
          failed: [],
          skipped: [],
          unfinished: [],
          stopped: true,
          budgetReached: false,
          interrupted: { requeued: [], orphanPids: [] },
          finalReview: null,
        };
        this.flush();
        return Promise.resolve();
      }
      ownedFiles.add(file);
    }

    this.active = true;
    this.stopping = false;
    this.budgetReached = false;
    this.summary = null;
    this.inFlight.clear();
    this.kills.clear();
    this.reasons.clear();
    this.tokens.clear();
    this.stopGate = new Promise<never>((_, reject) => {
      this.rejectStopGate = reject;
    });
    // Marked handled now: stop() may reject it with no racer attached.
    this.stopGate.catch(() => undefined);

    this.recovery = recoverInterrupted(this.state);
    this.log('run-start', null, scope ? `run started for ${scope.size} task(s)` : 'run started (all tasks)');
    if (this.recovery.requeued.length > 0) {
      this.log(
        'note',
        null,
        `recovered ${this.recovery.requeued.length} interrupted task(s): ${this.recovery.requeued.join(', ')}`,
      );
    }
    if (this.recovery.orphanPids.length > 0) {
      this.log(
        'note',
        null,
        `possible orphan process(es) from before the restart: ${this.recovery.orphanPids.join(', ')} (run 'dag kill-orphans' to clean up)`,
      );
    }
    try {
      await this.setupIsolation();
    } catch (err) {
      // Isolation was explicitly requested: refuse to run without it rather
      // than letting agents loose in the real working tree.
      const message = err instanceof Error ? err.message : String(err);
      this.log('note', null, `not starting: ${message}`);
      this.summary = {
        scope: [],
        completed: [],
        failed: [],
        skipped: [],
        unfinished: [],
        stopped: true,
        budgetReached: false,
        interrupted: { requeued: [], orphanPids: [] },
        finalReview: null,
      };
      // Never leave the runner wedged: a refused start must be retryable.
      this.active = false;
      this.stopping = false;
      this.flush();
      this.releaseLock?.();
      this.releaseLock = null;
      if (this.opts.file) ownedFiles.delete(this.opts.file);
      return;
    }
    this.flush();

    this.loopPromise = this.loop(scope)
      .catch((err) => {
        this.log('note', null, `runner crashed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.active = false;
        this.stopping = false;
        this.flush();
        this.closeAllLogs();
        for (const taskId of [...this.worktrees.keys()]) this.dropWorktree(taskId);
        this.cleanupIsolation();
        this.releaseLock?.();
        this.releaseLock = null;
        if (this.opts.file) ownedFiles.delete(this.opts.file);
      });
    return this.loopPromise;
  }

  // Kills the whole tree, waits a bounded grace period, then force-settles
  // anything still "running" so the loop cannot hang.
  async stop(): Promise<void> {
    if (!this.active || this.stopping) {
      await (this.loopPromise ?? Promise.resolve());
      return;
    }
    this.stopping = true;
    this.log('run-stop', null, 'stop requested; killing running tasks');
    this.flush();
    for (const id of [...this.inFlight]) this.killTask(id, 'killed');

    const grace = this.opts.stopGraceMs ?? 5000;
    const deadline = Date.now() + grace;
    while (this.inFlight.size > 0 && Date.now() < deadline) await sleep(50);

    // Force-settle stragglers: bumping the token makes late settlements no-ops.
    for (const id of [...this.inFlight]) {
      const task = this.state.tasks[id];
      if (task && task.status === 'running') {
        task.status = 'pending';
        task.result = 'stopped by user';
        task.failureKind = 'killed';
        task.finishedAt = nowIso();
        task.pid = null;
        this.log('task-killed', id, 'force-stopped; requeued as pending');
      }
      // Preserve anything the agent had written before the kill.
      this.salvageWorktree(id, 'stopped');
      this.tokens.set(id, (this.tokens.get(id) ?? 0) + 1);
      this.inFlight.delete(id);
      this.kills.delete(id);
      this.reasons.delete(id);
      this.closeLog(id);
      this.dropWorktree(id);
    }
    // Release any executor still parked on a promise it never settles.
    this.rejectStopGate?.(Object.assign(new Error('stopped by user'), { kind: 'killed' as FailureKind }));
    this.rejectStopGate = null;
    await (this.loopPromise ?? Promise.resolve());
    this.log('note', null, 'run stopped');
    this.flush();
  }

  // Kills one task's process tree and remembers why, so the settlement path
  // reports the right failure kind.
  private killTask(id: string, reason: FailureKind): void {
    this.reasons.set(id, reason);
    const kill = this.kills.get(id);
    if (kill) {
      try {
        kill();
      } catch {
        // already dead
      }
    }
  }

  // Records an event on the run and forwards it to the live viewer, if any.
  private log(type: DagEvent['type'], taskId: string | null, message: string): void {
    const ev = logEvent(this.state, type, taskId, message);
    this.opts.onEvent?.(ev);
  }

  // Coalesced persist: bursts of transitions cost one write per window.
  private persist(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.flush();
    }, this.opts.persistThrottleMs ?? 200);
  }

  // Persists the current state now; the coalesced form is `persist`.
  private flush(): void {
    this.dirty = false;
    this.state.updatedAt = nowIso();
    this.opts.persist?.(this.state);
  }

  // Retry delay that also wakes early when stop() is called.
  private async backoff(ms: number): Promise<void> {
    await Promise.race([sleep(ms), this.stopGate.catch(() => undefined)]);
  }

  // Streams a chunk to the task's attempt log, opening the file lazily and
  // enforcing the byte cap (once capped, later output is dropped).
  private appendLog(taskId: string, chunk: string): void {
    const file = this.opts.file;
    if (!file) return;
    const attempt = this.attemptByTask.get(taskId) ?? 1;
    let entry = this.logs.get(taskId);
    if (!entry) {
      try {
        mkdirSync(runPaths(file).logs, { recursive: true });
        entry = {
          stream: createWriteStream(attemptLogPath(file, taskId, attempt), { flags: 'a' }),
          written: 0,
          capped: false,
        };
        entry.stream.on('error', () => {
          // logging must never break a run
        });
        this.logs.set(taskId, entry);
      } catch {
        return;
      }
    }
    if (!entry) return;
    const cap = this.opts.logCapBytes ?? this.state.settings.logCapBytes ?? ATTEMPT_LOG_CAP_DEFAULT;
    if (entry.written >= cap) {
      if (!entry.capped) {
        entry.capped = true;
        entry.stream.write(`\n… [log capped at ${cap} bytes; full output is in the task result]\n`);
      }
      return;
    }
    entry.written += Buffer.byteLength(chunk);
    entry.stream.write(chunk);
  }

  // Closes and forgets one task's attempt-log stream.
  private closeLog(taskId: string): void {
    const entry = this.logs.get(taskId);
    if (!entry) return;
    this.logs.delete(taskId);
    try {
      entry.stream.end();
    } catch {
      // best effort
    }
  }

  // Closes every open attempt log (run teardown).
  private closeAllLogs(): void {
    for (const id of [...this.logs.keys()]) this.closeLog(id);
  }

  // Applies the run's dep-failure/gate policy and returns how many tasks were
  // skipped. Scope-restricted: a scoped run must not skip outside its scope.
  private policySkip(scope: Set<string> | null): number {
    const run = this.state;
    const dep = this.opts.onDepFailure ?? run.settings.onDepFailure ?? 'block';
    const gate = this.opts.onGateBlocked ?? run.settings.onGateBlocked ?? 'wait';
    // Scope-restricted: a scoped run must not skip tasks outside its scope.
    const only = scope ?? undefined;
    let skipped = 0;
    if (dep === 'skip') skipped += skipBlocked(run, 'dependency failed', only).length;
    if (gate === 'skip') skipped += skipGated(run, only).length;
    return skipped;
  }

  // The outer driver: run the graph to convergence, then repeat if the
  // end-of-run review sends completed work back for fixes.
  private async loop(scope: Set<string> | null): Promise<void> {
    const run = this.state;
    // Agents run in the run file's directory unless the caller overrides it,
    // so a viewer-started run still works in the right project.
    const cwd = this.opts.cwd ?? (this.opts.file ? dirname(this.opts.file) : undefined);
    const execute = this.opts.executor ?? shellExecutor(cwd);
    const concurrency = Math.max(
      1,
      this.opts.concurrency ?? run.settings.concurrency ?? DEFAULT_SETTINGS.concurrency,
    );
    const budgetMs =
      this.opts.maxWallClockMs ?? run.settings.maxWallClockMs ?? DEFAULT_SETTINGS.maxWallClockMs;
    const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;

    // Work converges, then an end-of-run review may send some of it back and
    // we go around again — that is the only reason this is a loop of loops.
    const reviewMode = run.settings.finalReview ?? 'off';
    const roundsLeftOf = (): number =>
      Math.max(0, (run.settings.finalReviewRounds ?? 1) - this.reviewRounds);
    for (;;) {
      await this.runTasks(execute, scope, concurrency, deadline);
      if (reviewMode === 'off' || this.stopping || this.budgetReached) {
        this.finalReview = null;
        break;
      }
      const outcome = await this.finalReviewPass(execute, scope, concurrency, reviewMode, roundsLeftOf());
      this.finalReview = outcome;
      if (outcome.verdict === 'pass' || outcome.verdict === 'skipped' || outcome.verdict === 'error') break;
      if (outcome.requeued.length === 0) break;
      this.reviewRounds += 1;
      this.log('run-review', null, `round ${this.reviewRounds}: ${outcome.requeued.length} task(s) sent back for fixes`);
    }
    this.summarize(scope);
  }

  // The scheduler: launches ready tasks up to the concurrency limit and refills
  // slots as soon as any finishes, honoring the wall-clock budget and the
  // dep-failure policy.
  private async runTasks(
    execute: Executor,
    scope: Set<string> | null,
    concurrency: number,
    deadline: number,
  ): Promise<void> {
    const run = this.state;
    // Completion-driven: a slot freed by a fast task is refilled immediately
    // instead of waiting for its whole batch (which used to idle workers).
    const running = new Set<Promise<void>>();
    const launch = (task: Task): void => {
      const promise = this.executeTask(task, execute, scope).finally(() => {
        running.delete(promise);
      });
      running.add(promise);
    };

    for (;;) {
      if (deadline > 0 && Date.now() > deadline) {
        this.budgetReached = true;
        this.log('note', null, 'wall clock budget reached; not launching more tasks');
        break;
      }
      if (this.stopping && running.size === 0 && this.inFlight.size === 0) break;

      // Apply failure policy before deciding what to launch; skipping may
      // unlock convergence for this iteration or a later one.
      if (!this.stopping && this.policySkip(scope) > 0) {
        this.persist();
        continue;
      }

      if (!this.stopping) {
        // topoSort gives a deterministic order (depth, then seq), so tasks
        // that become ready together start together in the same order.
        for (const task of topoSort(run)) {
          if (running.size >= concurrency) break;
          if (scope !== null && !scope.has(task.id)) continue;
          if (task.status !== 'pending' && task.status !== 'ready') continue;
          if (this.inFlight.has(task.id)) continue;
          if (gateBlocks(task) || !depsMet(task, run.tasks)) continue;
          if (
            task.deps.some((d) => {
              const dep = run.tasks[d];
              return !dep || dep.status === 'failed' || dep.status === 'skipped';
            })
          ) {
            continue;
          }
          launch(task);
        }
      }

      if (running.size === 0) {
        if (this.inFlight.size === 0) break;
        await sleep(50);
        continue;
      }
      await Promise.race([...running]);
    }
  }

  // Builds the final RunSummary, logs it, and fires the run-end notification.
  private summarize(scope: Set<string> | null): void {
    const run = this.state;
    const scoped =
      scope === null
        ? Object.keys(run.tasks).filter((id) => run.tasks[id])
        : [...scope].filter((id) => run.tasks[id]);
    const completed = scoped.filter((id) => run.tasks[id].status === 'completed');
    const failed = scoped.filter((id) => run.tasks[id].status === 'failed');
    const skipped = scoped.filter((id) => run.tasks[id].status === 'skipped');
    const unfinished = scoped.filter((id) => !isTerminal(run.tasks[id].status));
    this.summary = {
      scope: scoped,
      completed,
      failed,
      skipped,
      unfinished,
      stopped: this.stopping,
      budgetReached: this.budgetReached,
      interrupted: this.recovery,
      finalReview: this.finalReview,
    };
    const parts = [`${completed.length} completed`];
    if (failed.length > 0) parts.push(`${failed.length} failed`);
    if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
    if (unfinished.length > 0) parts.push(`${unfinished.length} unfinished`);
    const review = this.finalReview;
    if (review && review.verdict !== 'skipped') {
      parts.push(`review ${review.verdict}${review.failed.length > 0 ? `: ${review.failed.join(', ')}` : ''}`);
    }
    const line = `settled: ${parts.join(', ')}`;
    this.log('run-end', null, line);
    // Always notify on run end: an unattended run finishing cleanly is the
    // signal the operator is waiting for.
    this.notify(this.stopping ? 'run-stop' : 'run-end', null, line);
  }

  // Workers that write files instead of streaming output can still prove
  // liveness: `dag heartbeat --id X` touches a marker the watchdog stats.
  private heartbeatMtime(taskId: string): number {
    const file = this.opts.file;
    if (!file) return 0;
    try {
      const path = heartbeatPath(file, taskId);
      return existsSync(path) ? statSync(path).mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  // --- end-of-run review ---------------------------------------------------

  // One reviewer per completed task (needs the per-task diff that worktree
  // isolation provides), or a single reviewer for the integrated result.
  // A rejection sends the task back with the review notes as {lastRejection},
  // bounded by finalReviewRounds; with no rounds left the task fails.
  private async finalReviewPass(
    execute: Executor,
    scope: Set<string> | null,
    concurrency: number,
    mode: FinalReviewMode,
    roundsLeft: number,
  ): Promise<FinalReviewSummary> {
    const run = this.state;
    const isolation = (run.settings.worktree ?? 'none') === 'task';
    // Without isolation every task's changes are the same working tree, so a
    // per-task review would review the same thing N times.
    const effective: FinalReviewMode = mode === 'per-task' && !isolation ? 'run' : mode;
    if (effective !== mode) {
      this.log('note', null, 'end-of-run review: per-task needs worktree isolation; reviewing the run as a whole');
    }
    const first = Object.values(run.tasks)[0] ?? null;
    const cmdTemplate = this.reviewCommand(effective === 'per-task' ? first : null);
    if (!cmdTemplate) {
      this.log('note', null, 'end-of-run review skipped: no review command (set --final-review-cmd)');
      return { mode: effective, verdict: 'skipped', reason: 'no review command', reviewed: [], failed: [], requeued: [] };
    }
    this.reviewRound += 1;
    const round = this.reviewRound;
    const reviewed: string[] = [];
    const failed: string[] = [];
    const requeued: string[] = [];
    const errors: string[] = [];

    const candidates = Object.keys(run.tasks).filter(
      (id) =>
        (scope === null || scope.has(id)) &&
        run.tasks[id].status === 'completed' &&
        // Chain-review tasks are reviews: reviewing them reviews the reviewer.
        !run.tasks[id].covers &&
        run.tasks[id].finalReview?.verdict !== 'pass',
    );

    // Fail-closed: only an explicit PASS passes. A missing VERDICT line is a
    // rejection, never silent approval.
    const verdictOf = (output: string): { verdict: 'pass' | 'fail'; reason: string } => {
      const parsed = parseVerdict(stripAnsi(output));
      if (parsed.kind === 'pass') return { verdict: 'pass', reason: parsed.reason };
      return {
        verdict: 'fail',
        reason: (parsed.reason || 'no VERDICT line in the review output').slice(0, 400),
      };
    };

    if (effective === 'run') {
      const head =
        git(this.integration?.path ?? this.repoDir ?? '.', ['rev-parse', 'HEAD']).stdout || null;
      const base = first?.diffBase ?? this.integrationBase ?? null;
      const diff = this.writeReviewDiff('run', base, head);
      // The prompt goes in as {spec}; the diff travels as {diffFile}.
      const promptTask = { ...(first ?? ({} as Task)), id: first?.id ?? run.id, spec: this.runReviewPrompt(diff.ctx) };
      this.log('run-review', null, `end-of-run review: whole run (round ${round})`);
      try {
        const outcome = await this.runPhase(promptTask, execute, cmdTemplate, 'review', undefined, undefined, diff.ctx);
        const verdict = verdictOf(outcome.output);
        if (verdict.verdict === 'pass') {
          this.log('run-review', null, 'run review passed');
          return { mode: effective, verdict: 'pass', reason: verdict.reason, reviewed: candidates, failed: [], requeued: [] };
        }
        this.log('run-review', null, `run review failed: ${verdict.reason.slice(0, 200)}`);
        return { mode: effective, verdict: 'fail', reason: verdict.reason, reviewed: candidates, failed: candidates, requeued: [] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log('run-review', null, `run review could not run: ${message.slice(0, 200)}`);
        return { mode: effective, verdict: 'error', reason: message.slice(0, 400), reviewed, failed, requeued };
      }
    }

    const reviewOne = async (task: Task): Promise<void> => {
      const diff = this.writeReviewDiff(task.id, task.diffBase, task.diffHead);
      const promptTask = { ...task, spec: this.reviewPrompt(task, diff.ctx) };
      this.log(
        'task-review-start',
        task.id,
        `reviewing ${task.diffBase?.slice(0, 8) ?? '(no base)'}..${task.diffHead?.slice(0, 8) ?? '(no head)'}`,
      );
      try {
        const outcome = await this.runPhase(promptTask, execute, cmdTemplate, 'review', undefined, undefined, diff.ctx);
        const verdict = verdictOf(outcome.output);
        reviewed.push(task.id);
        if (verdict.verdict === 'pass') {
          task.finalReview = { verdict: 'pass', reason: verdict.reason, at: nowIso(), round };
          this.log('task-review-pass', task.id, `review passed${verdict.reason ? `: ${verdict.reason.slice(0, 120)}` : ''}`);
          return;
        }
        failed.push(task.id);
        if (roundsLeft > 0) {
          // Redo it: the review notes become the fix prompt's {lastRejection}.
          task.lastRejection = `end-of-run review: ${verdict.reason}`;
          task.finalReview = null;
          task.status = 'pending';
          task.failureKind = null;
          task.result = 'sent back by the end-of-run review';
          task.diffBase = null;
          task.diffHead = null;
          this.log('task-review-fail', task.id, `review rejected the work; requeued: ${verdict.reason.slice(0, 200)}`);
          requeued.push(task.id);
        } else {
          task.finalReview = { verdict: 'fail', reason: verdict.reason, at: nowIso(), round };
          task.status = 'failed';
          task.failureKind = 'review';
          task.result = `end-of-run review failed: ${verdict.reason}`.slice(0, RESULT_LIMIT);
          this.log('task-review-fail', task.id, `review failed (no rounds left): ${verdict.reason.slice(0, 200)}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        task.finalReview = { verdict: 'error', reason: message.slice(0, 400), at: nowIso(), round };
        errors.push(`${task.id}: ${message.slice(0, 120)}`);
        this.log('task-review-fail', task.id, `review could not run: ${message.slice(0, 200)}`);
      }
      this.persist();
    };

    this.log(
      'run-review',
      null,
      `end-of-run review: ${candidates.length} task(s) (round ${round})${roundsLeft > 0 ? '' : ', advisory only'}`,
    );
    const queue = [...candidates];
    const workers = Math.min(concurrency, Math.max(1, queue.length));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (;;) {
          const id = queue.shift();
          const task = id ? run.tasks[id] : undefined;
          if (!task || this.stopping) return;
          await reviewOne(task);
        }
      }),
    );

    if (errors.length > 0 && failed.length === 0) {
      return {
        mode: effective,
        verdict: 'error',
        reason: errors.join('; ').slice(0, 400),
        reviewed,
        failed,
        requeued,
      };
    }
    return {
      mode: effective,
      verdict: failed.length > 0 || errors.length > 0 ? 'fail' : 'pass',
      reason: failed.length > 0 ? `${failed.length} task(s) rejected by review` : errors.join('; '),
      reviewed,
      failed,
      requeued,
    };
  }

  // The command used for the end-of-run review: an explicit setting wins, then
  // the named task/run harness preset, then any known reviewer preset.
  private reviewCommand(task: Task | null): string | null {
    const explicit = this.state.settings.finalReviewCmd;
    if (explicit) return explicit;
    const chain: HarnessCandidate[] =
      (task?.harnessChain?.length ? task.harnessChain : null) ??
      (this.state.settings.harnessChain?.length ? this.state.settings.harnessChain : []);
    const named = task?.harness ?? chain[chain.length - 1]?.harness ?? null;
    const harness = named ? findHarness(named) : undefined;
    if (harness?.reviewCmd) return harness.reviewCmd;
    for (const candidate of ['opencode', 'claude', 'codex', 'cursor-agent', 'gemini']) {
      const preset = findHarness(candidate);
      if (preset?.reviewCmd) return preset.reviewCmd;
    }
    return null;
  }

  // The prompt for a per-task end-of-run review, pointing at the written diff.
  private reviewPrompt(task: Task, diff: TokenContext): string {
    return [
      `Code review of one task from an automated run (task ${task.id}: ${task.title}).`,
      `The unified diff this task merged is in ${diff.diffFile ?? '(unavailable)'}` +
        (diff.diffBase && diff.diffHead ? ` (git diff ${diff.diffBase} ${diff.diffHead}).` : '.'),
      diff.files ? `Files changed:\n${diff.files}` : '',
      diff.diffStat ? `Change summary:\n${diff.diffStat}` : '',
      'Read the real files, not just the diff, and judge correctness and whether the spec is met.',
      'Report concrete findings with file:line. Do not modify any file.',
      `Spec: ${task.spec || '(none)'}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  // The prompt for a whole-run review, listing every task and the integrated diff.
  private runReviewPrompt(diff: TokenContext): string {
    const run = this.state;
    const tasks = Object.values(run.tasks)
      .map((t) => `- ${t.id} [${t.status}] ${t.title}`)
      .join('\n');
    return [
      `Code review of a whole automated run (${run.id}: ${run.objective}).`,
      `The integrated diff is in ${diff.diffFile ?? '(unavailable)'}` +
        (diff.diffBase && diff.diffHead ? ` (git diff ${diff.diffBase} ${diff.diffHead}).` : '.'),
      'Judge the work as a whole: correctness, consistency between tasks, obvious gaps.',
      'Report concrete findings with file:line. Do not modify any file.',
      'Tasks:',
      tasks,
    ].join('\n');
  }

  // Writes the diff where the reviewer can read it (mirrors {planFile}), and
  // returns the token context that points at it.
  private writeReviewDiff(
    name: string,
    base: string | null,
    head: string | null,
  ): { ctx: TokenContext } {
    const dir = this.opts.file
      ? join(runPaths(this.opts.file).dir, 'reviews')
      : join(tmpdir(), 'dag-reviews');
    const repo = this.repoDir ?? this.opts.cwd ?? (this.opts.file ? dirname(this.opts.file) : process.cwd());
    let body = '';
    let stat = '';
    let files = '';
    if (base && head) {
      const diff = git(repo, ['diff', base, head]);
      const statRes = git(repo, ['diff', '--stat', base, head]);
      const names = git(repo, ['diff', '--name-only', base, head]);
      body = diff.code === 0 ? diff.stdout : `(diff unavailable: ${diff.stderr})`;
      stat = statRes.code === 0 ? statRes.stdout : '';
      files = names.code === 0 ? names.stdout : '';
    } else {
      const diff = git(repo, ['diff', 'HEAD']);
      body = [
        '(no recorded diff for this task: it produced no changes, or the run used no worktree isolation)',
        diff.code === 0 ? diff.stdout : '',
      ].join('\n');
    }
    const file = join(dir, `${name}.diff`);
    const limit = 400_000;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, body.length > limit ? `${body.slice(0, limit)}\n… [truncated]` : `${body}\n`, 'utf8');
    } catch {
      // best effort: the reviewer can still inspect the tree
    }
    return { ctx: { diffFile: file, diffBase: base ?? '', diffHead: head ?? '', diffStat: stat, files } };
  }

  // Fires the configured notify command, detached, with DAG_* env vars. A
  // broken notify command must never take the run down.
  private notify(event: string, taskId: string | null, message: string): void {
    const cmd = this.state.settings.notifyCmd;
    if (!cmd) return;
    this.log('notify', taskId, `${event}: ${truncate(message, 200)}`);
    try {
      const [file, ...args] = shellSplit(cmd);
      const child = spawn(file, args, {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          DAG_EVENT: event,
          DAG_TASK: taskId ?? '',
          DAG_MESSAGE: message,
          DAG_FILE: this.opts.file ?? '',
          DAG_RUN: this.state.id,
        },
      });
      // A broken notify command must never take the run down.
      child.on('error', () => undefined);
      child.unref();
    } catch {
      // notifications must never break a run
    }
  }

  // Worktree preparation: provision the environment a suite reviewer needs.
  // Runs once per attempt (worktrees are per attempt) and only in worktree
  // mode — a prepare step must never mutate the user's own checkout.
  private async prepareWorktree(
    task: Task,
    execute: Executor,
    worktreePath?: string,
    planFile?: string,
    depsContext?: TokenContext,
  ): Promise<'ok' | 'fail' | 'skipped'> {
    const cmd = task.prepareCmd ?? this.state.settings.worktreePrepareCmd ?? '';
    if (!cmd.trim()) return 'skipped';
    if (!worktreePath) {
      this.log('note', task.id, 'worktreePrepareCmd set but worktree isolation is off; skipping it');
      return 'skipped';
    }
    this.log('task-plan', task.id, `preparing the worktree: ${truncate(cmd, 120)}`);
    this.appendLog(task.id, '\n--- prepare ---\n');
    try {
      const outcome = await this.runPhase(task, execute, cmd, 'plan', worktreePath, planFile, depsContext);
      const out = stripAnsi(outcome.output).trim();
      if (out) this.appendLog(task.id, `\n${truncateTail(out, 2000)}\n`);
      this.log('note', task.id, 'worktree ready');
      return 'ok';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.stopping) {
        task.status = 'pending';
        task.failureKind = 'killed';
        task.result = 'stopped by user';
        return 'fail';
      }
      task.failureKind = 'setup';
      task.result = `worktree prepare failed: ${truncate(message, RESULT_LIMIT)}`;
      this.log('task-fail', task.id, `worktree prepare failed: ${truncate(message, 200)}`);
      return 'fail';
    }
  }

  // Planning phase: produce the plan the work phase should follow. A plan
  // command that fails fails the task (retryable) — proceeding unplanned
  // defeats the point of configuring one.
  private async plan(
    task: Task,
    execute: Executor,
    worktreePath?: string,
    planFile?: string,
    depsContext?: TokenContext,
    cmdOverride?: string | null,
  ): Promise<'ok' | 'fail'> {
    this.log('task-plan', task.id, 'planning phase starting');
    this.appendLog(task.id, '\n--- plan ---\n');
    let outcome: ExecOutcome;
    try {
      outcome = await this.runPhase(task, execute, cmdOverride ?? task.planCmd, 'plan', worktreePath, planFile, depsContext);
    } catch (err) {
      // Rethrow so the attempt's retry/fallback logic sees it: a broken planner
      // tool is exactly when the next harness in the chain should get a turn.
      this.reasons.set(task.id, 'plan');
      throw err;
    }
    task.plan = truncate(stripAnsi(outcome.output).trim(), PLAN_LIMIT) || '(empty plan)';
    this.log('task-plan', task.id, `plan ready (${task.plan.length} chars)`);
    return 'ok';
  }

  // Where this attempt's captured plan is written (for the {planFile} token).
  private planFilePath(task: Task, attempt: number): string | undefined {
    const file = this.opts.file;
    if (!file) return undefined;
    const dir = join(runPaths(file).dir, 'plans');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return undefined;
    }
    return join(dir, `${task.id}.${attempt}.md`);
  }

  // Where the upstream evidence for {depsFile} is written.
  private depsFilePath(task: Task, attempt: number): string | undefined {
    const file = this.opts.file;
    if (!file) return undefined;
    const dir = join(runPaths(file).dir, 'deps');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return undefined;
    }
    return join(dir, `${task.id}.${attempt}.md`);
  }

  // One phase (main command or reviewer) with its own timeout/silence watchdog.
  private async runPhase(
    task: Task,
    execute: Executor,
    cmd: string | null,
    label: 'run' | 'review' | 'plan',
    worktreePath?: string,
    planFile?: string,
    depsContext?: TokenContext,
    specOverride?: string,
  ): Promise<ExecOutcome> {
    const timeoutMs = task.timeoutMs ?? this.opts.timeoutMs ?? this.state.settings.timeoutMs;
    const silenceMs = task.silenceMs ?? this.opts.silenceMs ?? this.state.settings.silenceMs;
    let lastOutputMs = Date.now();
    let warnCount = 0;
    let reap: (err: Error) => void = () => {};
    const reaper = new Promise<never>((_, reject) => {
      reap = reject;
    });

    const hardTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            this.killTask(task.id, 'timeout');
            reap(
              Object.assign(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s`), {
                kind: 'timeout' as FailureKind,
              }),
            );
          }, timeoutMs)
        : null;

    const watchTimer =
      silenceMs > 0
        ? setInterval(
            () => {
              if (task.status !== 'running') return;
              const beat = this.heartbeatMtime(task.id);
              if (beat > lastOutputMs) {
                lastOutputMs = beat;
                task.lastOutputAt = new Date(beat).toISOString();
                return;
              }
              const elapsed = Date.now() - lastOutputMs;
              const kill = (this.state.settings.silenceAction ?? 'warn') === 'kill';
              const role = label === 'review' ? 'reviewer' : label === 'plan' ? 'planner' : 'worker';
              const report = (): void => {
                warnCount += 1;
                const secs = Math.round(elapsed / 1000);
                this.log(
                  'task-stall-warning',
                  task.id,
                  `${role} quiet for ${secs}s` +
                    (kill
                      ? ` (killed at ${Math.round(silenceMs / 1000)}s unless it logs or heartbeats)`
                      : ` (silenceAction=warn: not killing; timeout at ${Math.round(timeoutMs / 1000)}s)`) +
                    (warnCount > 1 ? ` [warning ${warnCount}]` : ''),
                );
                this.notify('task-quiet', task.id, `${role} quiet for ${secs}s`);
              };

              // Past the full window: kill, or report again and keep waiting.
              if (elapsed > silenceMs) {
                if (!kill) {
                  report();
                  lastOutputMs = Date.now();
                  return;
                }
                this.killTask(task.id, 'stalled');
                reap(
                  Object.assign(new Error(`no output for ${Math.round(silenceMs / 1000)}s`), {
                    kind: 'stalled' as FailureKind,
                  }),
                );
                return;
              }
              // Half the window: the first heads-up (heartbeats reset this).
              if (elapsed > silenceMs / 2 && warnCount === 0) report();
            },
            Math.max(250, Math.min(silenceMs, 5000)),
          )
        : null;

    const ctx: ExecContext = {
      onOutput: (chunk) => {
        lastOutputMs = Date.now();
        task.lastOutputAt = nowIso();
        const merged = (task.lastOutput ?? '') + chunk;
        task.lastOutput =
          merged.length > OUTPUT_TAIL_LIMIT ? merged.slice(-OUTPUT_TAIL_LIMIT) : merged;
        this.appendLog(task.id, chunk);
        this.persist();
      },
      registerKill: (fn) => this.kills.set(task.id, fn),
      aborted: () => this.reasons.has(task.id),
      setPid: (pid) => {
        task.pid = pid;
        this.persist();
      },
      cwd: worktreePath,
      planFile,
      lastRejection: task.lastRejection,
      coverage: depsContext?.coverage,
      coverageManifest: depsContext?.coverageManifest,
      coverageDir: depsContext?.coverageDir,
      coverageStat: depsContext?.coverageStat,
      coverageFiles: depsContext?.coverageFiles,
      deps: depsContext?.deps,
      depsAll: depsContext?.depsAll,
      depsFile: depsContext?.depsFile,
      diffFile: depsContext?.diffFile,
      diffBase: depsContext?.diffBase,
      diffHead: depsContext?.diffHead,
      diffStat: depsContext?.diffStat,
      files: depsContext?.files,
    };

    try {
      const resolved = cmd === null ? null : resolveHarness(cmd, task, this.state.settings);
      // A rendered spec rides in on a copy: the real task keeps its template.
      const tokenTask = specOverride === undefined ? task : { ...task, spec: specOverride };
      const execPromise = execute(tokenTask, ctx, resolved ?? undefined);
      execPromise.catch(() => {
        // losing branch of the race; the winner reports it
      });
      const outcome = await Promise.race([execPromise, reaper, this.stopGate]);
      const killReason = this.reasons.get(task.id);
      if (killReason) {
        throw Object.assign(new Error(`killed: ${killReason}`), { kind: killReason });
      }
      return outcome;
    } finally {
      if (hardTimer) clearTimeout(hardTimer);
      if (watchTimer) clearInterval(watchTimer);
      this.kills.delete(task.id);
      this.reasons.delete(task.id);
    }
  }

  // Every reviewer that applies to this task. The legacy single `reviewCmd`
  // is just a reviewer named "review".
  private reviewersFor(task: Task): Reviewer[] {
    const list: Reviewer[] = [...(task.reviewers ?? [])];
    if (task.reviewCmd && !list.some((r) => r.name === 'review')) {
      list.push({ name: 'review', cmd: task.reviewCmd, when: 'always' });
    }
    return list;
  }

  // What the task's work changed, for diff-gated reviewers. Needs worktree
  // isolation: without it there is no per-task diff to measure.
  private diffStats(task: Task): DiffStats | null {
    const path = this.worktrees.get(task.id);
    const base = this.worktreeBases.get(task.id);
    if (!path || !base) return null;
    // --numstat must see new files, so stage the worktree first. It is
    // disposable (committed then dropped right after), so staging is harmless.
    git(path, ['add', '-A']);
    const numstat = git(path, ['diff', '--cached', '--numstat', base]);
    if (numstat.code !== 0) return null;
    let lines = 0;
    const files: string[] = [];
    for (const row of numstat.stdout.split('\n')) {
      const [added, removed, file] = row.split('\t');
      if (!file) continue;
      files.push(file);
      lines += (Number(added) || 0) + (Number(removed) || 0);
    }
    return { lines, files };
  }

  // Reviewers run in order. The first rejection stops the always-on reviewers
  // (the work will be redone) but still runs the on-reject triage ones, whose
  // diagnosis is fed to the redo through {lastRejection}.
  private async reviewPass(
    task: Task,
    execute: Executor,
    scope: Set<string> | null,
    worktreePath?: string,
    planFile?: string,
    depsContext?: TokenContext,
  ): Promise<'pass' | 'requeue' | 'fail'> {
    const round = task.reviews + 1;
    const total = task.reviewRounds + 1;
    const reviewers = this.reviewersFor(task);
    const diff = this.diffStats(task);
    const decisions = decideReviewers(reviewers, diff, false);
    this.log(
      'task-review',
      task.id,
      `review ${round}/${total} starting with ${reviewers.length} reviewer(s)` +
        (diff ? ` against a ${diff.lines}-line diff` : ''),
    );
    task.reviewerVerdicts = {};

    let rejected: { name: string; reason: string } | null = null;
    for (const decision of decisions) {
      const reviewer = decision.reviewer;
      if (!decision.run && !decision.onReject) {
        task.reviewerVerdicts[reviewer.name] = {
          verdict: 'skipped',
          reason: decision.reason,
          at: nowIso(),
        };
        this.log('task-review', task.id, `skip reviewer "${reviewer.name}": ${decision.reason}`);
        continue;
      }
      if (decision.onReject && !rejected) {
        task.reviewerVerdicts[reviewer.name] = {
          verdict: 'skipped',
          reason: 'no rejection to triage',
          at: nowIso(),
        };
        continue;
      }
      // After a rejection, only the triage reviewers are worth spending on.
      if (rejected && !decision.onReject) {
        task.reviewerVerdicts[reviewer.name] = {
          verdict: 'skipped',
          reason: 'work is being redone',
          at: nowIso(),
        };
        continue;
      }

      this.appendLog(task.id, `\n--- review ${round}/${total}: ${reviewer.name} ---\n`);
      let cleaned = '';
      let reviewerExit: number | null = null;
      try {
        const outcome = await this.runPhase(task, execute, reviewer.cmd, 'review', worktreePath, planFile, depsContext);
        reviewerExit = outcome.exitCode;
        task.reviewExitCode = outcome.exitCode;
        cleaned = stripAnsi(outcome.output).trim();
      } catch (err) {
        const reason: FailureKind =
          this.reasons.get(task.id) ?? (err as { kind?: FailureKind }).kind ?? 'exit';
        const message = err instanceof Error ? err.message : String(err);
        if (this.stopping) {
          task.status = 'pending';
          task.failureKind = 'killed';
          task.result = 'stopped by user';
          this.log('task-killed', task.id, 'stopped during review; requeued as pending');
          return 'requeue';
        }
        task.reviewerVerdicts[reviewer.name] = { verdict: 'error', reason: truncate(message, 300), at: nowIso() };
        task.reviewExitCode = (err as { exitCode?: number | null }).exitCode ?? null;
        if (reason === 'timeout' || reason === 'stalled' || reason === 'spawn') {
          task.status = 'failed';
          task.failureKind = reason;
          task.result = truncate(`reviewer "${reviewer.name}" ${reason}: ${message}`, RESULT_LIMIT);
          task.reviewResult = summarizeVerdicts(task.reviewerVerdicts);
          const type =
            reason === 'timeout' ? 'task-timeout' : reason === 'stalled' ? 'task-stalled' : 'task-fail';
          this.log(type, task.id, `reviewer "${reviewer.name}" failed (${reason}): ${truncate(message, 200)}`);
          if (!this.tryRepair(task, scope)) this.notify(type, task.id, `reviewer ${reason}: ${message}`);
          return 'fail';
        }
        return this.handleRejection(task, `reviewer "${reviewer.name}" failed: ${message}`, scope);
      }

      const mode = reviewer.verdict ?? this.state.settings.reviewVerdict ?? 'marker';
      const verdict = parseVerdict(cleaned);
      const exit = reviewerExit ?? 0;
      // A non-zero exit is a rejection whatever the verdict mode says: shell
      // reviewers signal failure that way, and an executor may report it
      // without throwing.
      if (exit !== 0) {
        const tail = cleaned
          ? cleaned.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? `exit ${exit}`
          : `exit ${exit}`;
        task.reviewExitCode = exit;
        task.reviewerVerdicts[reviewer.name] = {
          verdict: 'fail',
          reason: truncate(tail, 300),
          at: nowIso(),
        };
        rejected = { name: reviewer.name, reason: `exit ${exit}: ${tail}` };
        this.log('task-review', task.id, `reviewer "${reviewer.name}" failed (exit ${exit})`);
        continue;
      }
      if (mode === 'exit-code') {
        task.reviewerVerdicts[reviewer.name] = {
          verdict: 'pass',
          reason: cleaned ? truncateTail(cleaned, 300).replace(/\s+/g, ' ') : 'exit 0',
          at: nowIso(),
        };
        this.log('task-review', task.id, `reviewer "${reviewer.name}" passed (exit 0)`);
        continue;
      }
      if (verdict.kind === 'pass') {
        task.reviewerVerdicts[reviewer.name] = { verdict: 'pass', reason: verdict.reason, at: nowIso() };
        this.log('task-review', task.id, `reviewer "${reviewer.name}" passed (VERDICT: PASS)`);
        continue;
      }
      if (verdict.kind === 'fail') {
        task.reviewExitCode = 1;
        task.reviewerVerdicts[reviewer.name] = {
          verdict: 'fail',
          reason: verdict.reason || '(no reason given)',
          at: nowIso(),
        };
        rejected = { name: reviewer.name, reason: verdict.reason || 'reviewer failed the work' };
        this.log(
          'task-review',
          task.id,
          `reviewer "${reviewer.name}" returned VERDICT: FAIL — ${truncate(rejected.reason, 200)}`,
        );
        // Keep going only for the triage (on-reject) reviewers below.
        continue;
      }
      // Fail closed: an unreadable review must never count as approval.
      task.reviewExitCode = 1;
      task.reviewerVerdicts[reviewer.name] = {
        verdict: 'error',
        reason: 'produced no VERDICT line',
        at: nowIso(),
      };
      this.log(
        'task-review',
        task.id,
        `reviewer "${reviewer.name}" produced no VERDICT line (expected "VERDICT: PASS" or "VERDICT: FAIL: reason")`,
      );
      return this.handleRejection(task, `reviewer "${reviewer.name}" produced no machine-readable verdict`, scope);
    }

    task.reviewResult = summarizeVerdicts(task.reviewerVerdicts);
    if (!rejected) return 'pass';
    task.lastRejection = truncate(`${rejected.name}: ${rejected.reason}`, 800);
    return this.handleRejection(task, `${rejected.name}: ${rejected.reason}`, scope);
  }

  // A reviewer rejected the work: redo it while review rounds remain, otherwise
  // fail it and give an integration node the chance to repair its upstream.
  private handleRejection(task: Task, message: string, scope: Set<string> | null): 'requeue' | 'fail' {
    task.reviews += 1;
    if (task.reviews <= task.reviewRounds) {
      this.log(
        'task-review',
        task.id,
        `reviewer rejected the work (${task.reviews}/${task.reviewRounds + 1}): ${truncate(message, 200)} — redoing the task`,
      );
      task.status = 'pending';
      task.failureKind = null;
      task.result = null;
      task.exitCode = null;
      return 'requeue';
    }
    task.status = 'failed';
    task.failureKind = 'review';
    task.result = `review rejected after ${task.reviews} round(s): ${truncate(message, 500)}`;
    // An integration node that says "this doesn't mesh" gets its upstream
    // redone, bounded by repairRounds.
    if (this.tryRepair(task, scope)) return 'requeue';
    this.log('task-fail', task.id, `failed (review): reviewer rejected the work ${task.reviews} time(s)`);
    this.notify('task-fail', task.id, `review rejected: ${truncate(message, 200)}`);
    return 'fail';
  }

  // Repair only touches upstream tasks that the current run can actually
  // relaunch: requeueing an out-of-scope dep would deadlock the scope.
  private tryRepair(task: Task, scope: Set<string> | null = null): boolean {
    if (task.repairRounds <= 0 || task.repairs >= task.repairRounds || task.deps.length === 0) {
      return false;
    }
    const requeued: string[] = [];
    for (const dep of task.deps) {
      const upstream = this.state.tasks[dep];
      if (!upstream) continue;
      if (scope !== null && !scope.has(dep)) continue;
      if (upstream.status === 'pending' || upstream.status === 'ready' || upstream.status === 'running') {
        continue;
      }
      upstream.status = 'pending';
      upstream.result = null;
      upstream.failureKind = null;
      upstream.exitCode = null;
      upstream.startedAt = null;
      upstream.finishedAt = null;
      upstream.lastOutputAt = null;
      upstream.lastOutput = null;
      upstream.pid = null;
      // Fresh review budget: the repair is what makes a redo possible.
      upstream.reviews = 0;
      upstream.reviewResult = null;
      upstream.reviewExitCode = null;
      requeued.push(upstream.id);
    }
    if (requeued.length === 0) return false;
    task.repairs += 1;
    task.status = 'pending';
    task.failureKind = null;
    task.result = null;
    task.exitCode = null;

    // Work that already completed against the old upstream output is stale:
    // B consumed A v1, so when A is redone B must not stay "verified". This is
    // deliberately conservative — everything downstream of a repaired task is
    // redone, in depth order — because without input versioning we cannot tell
    // which descendants actually depend on what changed.
    const stale: string[] = [];
    for (const upstreamId of requeued) {
      for (const dependentId of transitiveDependentIds(this.state, upstreamId)) {
        if (dependentId === task.id || requeued.includes(dependentId)) continue;
        if (scope !== null && !scope.has(dependentId)) continue;
        const dependent = this.state.tasks[dependentId];
        if (dependent.status !== 'completed') continue;
        dependent.status = 'pending';
        dependent.result = null;
        dependent.failureKind = null;
        dependent.exitCode = null;
        dependent.startedAt = null;
        dependent.finishedAt = null;
        dependent.lastOutputAt = null;
        dependent.lastOutput = null;
        dependent.pid = null;
        dependent.diffBase = null;
        dependent.diffHead = null;
        dependent.coverage = null;
        // Its approval was for the old inputs.
        dependent.finalReview = null;
        stale.push(dependent.id);
      }
    }
    for (const upstream of requeued) {
      const t = this.state.tasks[upstream];
      t.diffBase = null;
      t.diffHead = null;
      t.coverage = null;
      t.finalReview = null;
    }
    if (stale.length > 0) {
      this.log(
        'task-repair',
        task.id,
        `inputs changed: ${stale.length} completed downstream task(s) requeued (${stale.join(', ')})`,
      );
    }
    this.log(
      'task-repair',
      task.id,
      `repair round ${task.repairs}/${task.repairRounds}: requeued upstream ${requeued.join(', ')}`,
    );
    return true;
  }

  // --- chain coverage (tasks whose subject is other tasks) ----------------

  // Gathers what a chain-review task needs to see: one diff per covered task,
  // a manifest describing them, and the rolled-up file list. Written once per
  // attempt so the reviewer can work incrementally instead of reading one
  // enormous blob.
  private materializeCoverage(task: Task): TaskCoverage | null {
    const covers = task.covers;
    if (!covers || covers.length === 0) return null;
    const cached = this.coverageCache.get(task.id);
    if (cached !== undefined) return cached;
    const run = this.state;
    const covered = covers.filter((id) => run.tasks[id]);
    const dir = this.opts.file
      ? join(runPaths(this.opts.file).dir, 'reviews', `chain-${task.id}`)
      : join(tmpdir(), 'dag-reviews', `chain-${task.id}`);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // best effort
    }
    const repo = this.repoDir ?? this.opts.cwd ?? (this.opts.file ? dirname(this.opts.file) : process.cwd());
    const manifest: string[] = [
      `Chain review bundle for ${task.id} "${task.title}"`,
      `Covered tasks: ${covered.length}`,
      '',
    ];
    const files = new Set<string>();
    const stats: string[] = [];
    let base: string | null = null;
    let head: string | null = null;
    const oneLine = (s: string, n: number): string => {
      const flat = s.replace(/\s+/g, ' ').trim();
      return flat.length > n ? `${flat.slice(0, n)}…` : flat;
    };
    for (const id of covered) {
      const t = run.tasks[id];
      manifest.push(`## ${id} — ${t.title} [${t.status}]`);
      manifest.push(`spec: ${oneLine(t.spec || '(none)', 400)}`);
      if (t.finalReview) manifest.push(`final review: ${t.finalReview.verdict} ${oneLine(t.finalReview.reason, 200)}`);
      if (t.failureKind) manifest.push(`failure: ${t.failureKind} ${oneLine(t.result ?? '', 200)}`);
      else if (t.result) manifest.push(`result: ${oneLine(t.result, 300)}`);
      if (t.diffBase && t.diffHead) {
        const diff = git(repo, ['diff', t.diffBase, t.diffHead]);
        const names = git(repo, ['diff', '--name-only', t.diffBase, t.diffHead]);
        const stat = git(repo, ['diff', '--stat', t.diffBase, t.diffHead]);
        const file = join(dir, `${id}.diff`);
        try {
          writeFileSync(file, diff.code === 0 ? `${diff.stdout}\n` : `(diff unavailable: ${diff.stderr})\n`, 'utf8');
        } catch {
          // best effort
        }
        if (names.code === 0) for (const f of names.stdout.split('\n').filter(Boolean)) files.add(f);
        if (stat.code === 0 && stat.stdout) stats.push(`${id}: ${oneLine(stat.stdout, 200)}`);
        manifest.push(`diff: ${file}  (git diff ${t.diffBase} ${t.diffHead})`);
        if (!base) base = t.diffBase;
        head = t.diffHead;
      } else {
        manifest.push('diff: (none recorded — it produced no changes, or ran without isolation)');
      }
      if (t.commit) manifest.push(`commit: ${t.commit}`);
      manifest.push('');
    }
    const manifestFile = join(dir, 'manifest.md');
    try {
      writeFileSync(manifestFile, `${manifest.join('\n')}\n`, 'utf8');
    } catch {
      // best effort
    }
    const coverage: TaskCoverage = {
      dir,
      manifest: manifestFile,
      base,
      head,
      stat: stats.join('\n'),
      files: [...files].sort().join('\n'),
      tasks: covered,
    };
    this.coverageCache.set(task.id, coverage);
    this.log('note', task.id, `chain bundle written: ${manifestFile} (${covered.length} task(s), ${files.size} file(s))`);
    return coverage;
  }

  // The spec of a chain task is a template: it is rendered here, with the
  // covered tasks' facts, before the command is rendered — so {coverage*}
  // tokens work inside the spec itself.
  private renderCoverageSpec(task: Task, coverage: TaskCoverage | null): string {
    if (!coverage) return task.spec;
    const template = task.spec;
    if (!template.includes('{')) return template;
    const values: Record<string, string> = {
      coverage: coverage.tasks
        .map((id) => {
          const t = this.state.tasks[id];
          return `- ${id} [${t.status}] ${t.title}`;
        })
        .join('\n'),
      coverageManifest: coverage.manifest,
      coverageDir: coverage.dir,
      coverageStat: coverage.stat,
      coverageFiles: coverage.files,
    };
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? values[name] : match));
  }

  // --- worktree isolation -------------------------------------------------

  // Establishes worktree isolation up front. If it was requested but cannot be
  // set up, this throws so the run refuses to start rather than run in place.
  private async setupIsolation(): Promise<void> {
    const setting = this.state.settings.worktree ?? 'none';
    if (setting === 'none') return;
    if (setting !== 'task') {
      throw new Error(`unknown worktree mode "${setting}" — refusing to run unisolated`);
    }
    const repoDir = this.opts.cwd ?? (this.opts.file ? dirname(this.opts.file) : process.cwd());
    if (!isGitRepo(repoDir)) {
      throw new Error(`worktree isolation requested but ${repoDir} is not a git repository`);
    }
    // Keep the run's own artifacts out of the snapshot even when --file points
    // somewhere other than dag.run.json (the lock holds a live pid).
    this.excludes = this.opts.file
      ? snapshotExcludes(this.opts.file, repoDir)
      : undefined;
    try {
      const integration = ensureIntegrationWorktree(repoDir, this.state.id, undefined, this.excludes);
      this.repoDir = repoDir;
      this.integration = { path: integration.path, branch: integration.branch };
      this.integrationBase = integration.base;
      const dirty = isDirty(repoDir, this.excludes);
      this.log(
        'note',
        null,
        `worktree isolation on: integration branch ${integration.branch}` +
          `${dirty ? ' (based on a snapshot of the current working tree)' : ''}` +
          ` at ${integration.path}`,
      );
    } catch (err) {
      // Isolation was explicitly requested: never silently run in place.
      throw new Error(
        `worktree isolation could not be established: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Returns the worktree path, or null when isolation is off. Throws when
  // isolation is on but the worktree cannot be created: running the agent in
  // the real working tree instead would be the one outcome isolation exists
  // to prevent.
  private makeTaskWorktree(task: Task): string | null {
    if (!this.repoDir || !this.integration) return null;
    const { path, branch } = createTaskWorktree(
      this.repoDir,
      this.state.id,
      task.id,
      this.integration.branch,
    );
    this.worktrees.set(task.id, path);
    this.worktreeBases.set(
      task.id,
      git(this.repoDir, ['rev-parse', this.integration.branch]).stdout,
    );
    task.branch = branch;
    task.commit = null;
    return path;
  }

  // Commit the task's work and fold it into the integration branch. A
  // conflict is a retryable failure: the task is redone on the new base.
  // Merges are serialized: the integration worktree has one writer.
  private landWorktree(task: Task): Promise<{ ok: boolean; conflict?: string }> {
    const run = (): { ok: boolean; conflict?: string } => {
      const path = this.worktrees.get(task.id);
      if (!path || !this.integration) return { ok: true };
      try {
        const committed = commitAll(path, `dag: ${task.id} ${task.title}`);
        if (committed.commit) {
          task.commit = committed.commit;
          this.log('note', task.id, `committed ${committed.files} file(s) as ${committed.commit.slice(0, 8)}`);
        }
        const before = git(this.integration.path, ['rev-parse', 'HEAD']).stdout;
        const merge = mergeIntoIntegration(this.integration.path, task.branch ?? '', task.id);
        if (!merge.merged) {
          this.log(
            'note',
            task.id,
            merge.conflict
              ? 'merge conflict with the integration branch; will redo on the merged base'
              : `merge failed: ${merge.detail}`,
          );
          return { ok: false, conflict: merge.detail };
        }
        const after = git(this.integration.path, ['rev-parse', 'HEAD']).stdout;
        if (before && after && before !== after) {
          task.diffBase = before;
          task.diffHead = after;
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, conflict: err instanceof Error ? err.message : String(err) };
      } finally {
        this.dropWorktree(task.id);
      }
    };
    // Queue this merge after the previous one whatever its outcome, and store a
    // chain that swallows errors so one bad merge cannot wedge every later merge.
    const next = this.landChain.then(run, run);
    this.landChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // A failed or stopped task may hold real work in its worktree. Commit it to
  // the task branch (never merged) so it can be inspected or cherry-picked
  // instead of being deleted with the worktree.
  private salvageWorktree(taskId: string, why: string): void {
    const path = this.worktrees.get(taskId);
    if (!path) return;
    const task = this.state.tasks[taskId];
    try {
      const saved = commitAll(path, `dag: WIP ${taskId} ${task?.title ?? ''} (${why})`);
      if (saved.commit && task) {
        task.commit = saved.commit;
        // Park the commit on its own ref: the next attempt force-resets the
        // task branch, which would otherwise leave this work unreachable.
        if (this.repoDir && this.state.id) {
          git(this.repoDir, [
            'update-ref',
            `refs/dag-salvage/${this.state.id}-${taskId}`,
            saved.commit,
          ]);
        }
        this.log(
          'note',
          taskId,
          `partial work salvaged to ${task.branch} @ ${saved.commit.slice(0, 8)} (${saved.files} file(s), not merged; also refs/dag-salvage/${this.state.id}-${taskId})`,
        );
      }
    } catch {
      // best effort: the worktree is still dropped afterwards
    }
  }

  // Frees the integration worktree (the branch survives) and the temp root.
  private cleanupIsolation(): void {
    if (!this.repoDir || !this.integration) return;
    const root = worktreeRoot(this.repoDir, this.state.id);
    try {
      removeWorktree(this.repoDir, this.integration.path);
    } catch {
      // best effort
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
    this.integration = null;
  }

  // Removes one task's worktree from disk and forgets its bookkeeping.
  private dropWorktree(taskId: string): void {
    const path = this.worktrees.get(taskId);
    if (!path || !this.repoDir) return;
    this.worktrees.delete(taskId);
    this.worktreeBases.delete(taskId);
    try {
      removeWorktree(this.repoDir, path);
    } catch {
      // best effort; git worktree prune runs inside removeWorktree
    }
  }

  // The harness chain that governs this task: its own, else the run's, else none.
  private effectiveChain(task: Task): HarnessCandidate[] | null {
    if (task.harnessChain && task.harnessChain.length > 0) return task.harnessChain;
    if (this.state.settings.harnessChain?.length) return this.state.settings.harnessChain;
    return null;
  }

  // A chain of N tools means N attempts at least, so a fallback can happen.
  private maxAttemptsFor(task: Task): number {
    return attemptsForChain(task.maxAttempts, this.effectiveChain(task));
  }

  // A chain overrides the task's own command for the current attempt: the
  // preset owns the command, the candidate owns the model.
  private applyHarnessChain(task: Task, attempt: number): { cmd: string | null; planCmd: string | null } {
    const chain = this.effectiveChain(task);
    const plan = planAttempt(chain, attempt);
    if (!plan) return { cmd: task.cmd, planCmd: task.planCmd };
    task.harness = plan.candidate.harness;
    if (plan.candidate.model !== undefined) task.model = plan.candidate.model;
    if (plan.candidate.variant !== undefined) task.variant = plan.candidate.variant;
    this.log(
      'task-start',
      task.id,
      plan.fellBack
        ? `falling back to ${plan.candidate.harness} (candidate ${plan.index}/${chain?.length})`
        : `using harness ${plan.candidate.harness}`,
    );
    return {
      cmd: plan.harness.cmd,
      planCmd: plan.harness.planCmd ?? task.planCmd,
    };
  }

  // Runs one attempt end to end: attempt bookkeeping, worktree, prepare/plan
  // phases, the work command, verdict/exit policy, reviewers, landing, then
  // either completion or the failure/retry path. Each step is delegated to a
  // named helper so this method reads as the attempt's shape.
  private async executeTask(
    task: Task,
    execute: Executor,
    scope: Set<string> | null,
  ): Promise<void> {
    if (this.stopping) return;
    const token = this.beginAttempt(task);

    let worktreePath: string | null = null;
    try {
      worktreePath = this.makeTaskWorktree(task);
    } catch (err) {
      // Isolation was explicitly requested: refuse to run the agent in the
      // real working tree.
      this.failWorktreeSetup(task, err);
      return;
    }
    if (worktreePath) {
      this.log('note', task.id, `worktree ${task.branch} at ${worktreePath}`);
    }
    const { chained, planFile, depsContext, specOverride } = this.attemptContext(
      task,
      task.attempts,
    );

    try {
      // Environment first: nothing else can run without it.
      const prepared = await this.prepareWorktree(task, execute, worktreePath ?? undefined, planFile, depsContext);
      if (prepared === 'fail') {
        if (this.tokens.get(task.id) !== token) return;
        task.status = 'failed';
        this.salvageWorktree(task.id, 'setup failed');
        const budget = this.maxAttemptsFor(task);
        const retryable = task.attempts < budget;
        if (retryable) {
          task.status = 'pending';
          task.failureKind = null;
          this.log('task-retry', task.id, `worktree prepare failed; attempt ${task.attempts}/${budget}`);
        } else if (!this.tryRepair(task, scope)) {
          this.notify('task-fail', task.id, 'worktree prepare failed');
        }
        this.persist();
        return;
      }

      // Planning phase first: the work command follows {plan} / {planFile}.
      if (chained.planCmd) {
        const planned = await this.plan(
          task,
          execute,
          worktreePath ?? undefined,
          planFile,
          depsContext,
          chained.planCmd,
        );
        if (this.tokens.get(task.id) !== token) return;
        if (planned !== 'ok') {
          this.dropWorktree(task.id);
          this.persist();
          return;
        }
        if (planFile && task.plan) {
          try {
            writeFileSync(planFile, task.plan, 'utf8');
          } catch {
            // the plan is also in the event log and the task record
          }
        }
      }

      const outcome = await this.runPhase(
        task,
        execute,
        chained.cmd,
        'run',
        worktreePath ?? undefined,
        planFile,
        depsContext,
        specOverride,
      );
      if (this.tokens.get(task.id) !== token) return;

      this.applyChainReviewVerdict(task, outcome, task.attempts);

      this.enforceExitPolicy(task, outcome);

      if (this.reviewersFor(task).length > 0) {
        const verdict = await this.reviewPass(task, execute, scope, worktreePath ?? undefined, planFile, depsContext);
        if (this.tokens.get(task.id) !== token) return;
        if (verdict !== 'pass') {
          this.dropWorktree(task.id);
          this.persist();
          return;
        }
      }

      // Worktree mode: land the work before declaring success.
      if (worktreePath) {
        const landed = await this.landWorktree(task);
        if (!landed.ok) {
          this.recordMergeConflict(task, landed.conflict, scope);
          return;
        }
      }

      this.completeAttempt(task, outcome);
    } catch (err) {
      await this.failAttempt(task, err, scope, token);
    } finally {
      this.endAttempt(task, token);
    }
  }

  // Opens one attempt: bumps the token (so a late settlement from a previous
  // attempt is ignored), resets the per-attempt fields, and writes the header
  // line to the attempt log before any output arrives. Returns the token the
  // rest of this attempt must check before touching shared state.
  private beginAttempt(task: Task): number {
    const token = (this.tokens.get(task.id) ?? 0) + 1;
    this.tokens.set(task.id, token);
    this.inFlight.add(task.id);

    const attempt = task.attempts + 1;
    task.attempts = attempt;
    this.attemptByTask.set(task.id, attempt);
    task.status = 'running';
    task.startedAt = nowIso();
    task.finishedAt = null;
    task.exitCode = null;
    task.failureKind = null;
    task.result = null;
    task.reviewResult = null;
    task.reviewExitCode = null;
    task.lastOutputAt = task.startedAt;
    task.lastOutput = null;
    task.pid = null;
    // This attempt produces a new output, so any approval earned by an earlier
    // one is void: it must be reviewed again before it counts as verified.
    task.finalReview = null;
    task.diffBase = null;
    task.diffHead = null;
    task.coverage = null;
    // Header first: every attempt gets a log file even with no output.
    this.appendLog(
      task.id,
      `# attempt ${attempt} started ${task.startedAt}\n# cmd: ${task.cmd ?? '(manual)'}${
        task.reviewCmd ? `\n# review: ${task.reviewCmd}` : ''
      }\n`,
    );
    this.log('task-start', task.id, `attempt ${attempt}/${this.maxAttemptsFor(task)}: ${task.title}`);
    this.persist();
    return token;
  }

  // Isolation was requested, so a failed worktree create fails the attempt
  // immediately rather than letting the agent loose in the real working tree.
  // This does not go through the normal retry path: the failure is setup, not
  // the command.
  private failWorktreeSetup(task: Task, err: unknown): void {
    task.status = 'failed';
    task.failureKind = 'worktree';
    task.result = `worktree create failed: ${err instanceof Error ? err.message : String(err)}`;
    this.log('task-fail', task.id, `failed (worktree): ${truncate(task.result, 200)}`);
    this.notify('task-fail', task.id, 'worktree create failed');
    this.dropWorktree(task.id);
    this.inFlight.delete(task.id);
    this.tokens.delete(task.id);
    this.closeLog(task.id);
    this.persist();
  }

  // Everything an attempt's commands need before they run: the harness
  // candidate chosen for this attempt, the plan file path, upstream evidence
  // for the {deps*} tokens, and (for chain-review tasks) the coverage bundle.
  private attemptContext(
    task: Task,
    attempt: number,
  ): {
    chained: { cmd: string | null; planCmd: string | null };
    planFile?: string;
    depsContext: TokenContext;
    specOverride?: string;
  } {
    const chained = this.applyHarnessChain(task, attempt);
    const planFile = chained.planCmd ? this.planFilePath(task, attempt) : undefined;
    // Upstream evidence for {deps} / {depsAll} / {depsFile}: deps are complete
    // by the time a task runs, so this is the real graph state, not a promise.
    const depsFile = task.deps.length > 0 ? this.depsFilePath(task, attempt) : undefined;
    const depsContext: TokenContext = {
      deps: describeDeps(this.state, task),
      depsAll: describeDeps(this.state, task, { transitive: true }),
      depsFile,
    };
    // Chain-review tasks: the covered tasks are done, so their facts are real.
    let specOverride: string | undefined;
    if (task.covers && task.covers.length > 0) {
      const coverage = this.materializeCoverage(task);
      task.coverage = coverage;
      specOverride = this.renderCoverageSpec(task, coverage);
      if (coverage) {
        depsContext.coverage = coverage.tasks
          .map((id) => `- ${id} [${this.state.tasks[id].status}] ${this.state.tasks[id].title}`)
          .join('\n');
        depsContext.coverageManifest = coverage.manifest;
        depsContext.coverageDir = coverage.dir;
        depsContext.coverageStat = coverage.stat;
        depsContext.coverageFiles = coverage.files;
      }
    }
    if (depsFile) {
      try {
        writeFileSync(
          depsFile,
          `# Upstream evidence for ${task.id} "${task.title}"\n\n` +
            `## Direct dependencies\n${depsContext.deps}\n\n` +
            `## All upstream tasks\n${depsContext.depsAll}\n`,
          'utf8',
        );
      } catch {
        // the inline tokens still carry the evidence
      }
    }
    return { chained, planFile, depsContext, specOverride };
  }

  // A chain-review task produces a judgement, not code: its VERDICT line
  // decides whether it passed. With its own reviewer configured, the reviewer
  // panel owns that decision instead. A missing verdict fails closed.
  private applyChainReviewVerdict(task: Task, outcome: ExecOutcome, attempt: number): void {
    if (
      !task.covers ||
      task.covers.length === 0 ||
      this.reviewersFor(task).length > 0 ||
      task.reviewCmd
    ) {
      return;
    }
    const verdict = parseVerdict(stripAnsi(outcome.output));
    if (verdict.kind !== 'pass') {
      const reason = verdict.reason || 'no VERDICT line in the review output';
      task.lastRejection = `chain review: ${reason}`;
      this.log('task-review-fail', task.id, `chain review rejected the covered work: ${reason.slice(0, 200)}`);
      throw Object.assign(new Error(`chain review failed: ${reason}`), { kind: 'review' as const });
    }
    task.finalReview = {
      verdict: 'pass',
      reason: verdict.reason,
      at: nowIso(),
      round: attempt,
    };
    this.log('task-review-pass', task.id, `chain review passed${verdict.reason ? `: ${verdict.reason.slice(0, 120)}` : ''}`);
  }

  // The exit policy is applied once, here, before reviewers and before
  // anything lands: rejected work must not reach the integration branch. A
  // judge (reviewer/verdict) owns the decision when one exists — agents
  // routinely exit non-zero after doing the work. `failOnNonZeroExit`
  // overrides both ways; unset means "strict unless a judge is present".
  private enforceExitPolicy(task: Task, outcome: ExecOutcome): void {
    const judges = this.reviewersFor(task).length > 0 || Boolean(task.reviewCmd);
    const policy = this.state.settings.failOnNonZeroExit;
    const failOnExit = policy === null || policy === undefined ? !judges : policy;
    if (failOnExit && outcome.exitCode !== null && outcome.exitCode !== 0) {
      throw Object.assign(
        new Error(`exit ${outcome.exitCode}${tailOf(stripAnsi(outcome.output))}`),
        { kind: 'exit' as const, exitCode: outcome.exitCode },
      );
    }
  }

  // A merge conflict is redone on the new integration base instead of being
  // charged against the command's attempt budget (bounded by mergeRounds).
  private recordMergeConflict(task: Task, conflict: string | undefined, scope: Set<string> | null): void {
    const budget = this.state.settings.mergeRounds ?? 2;
    if (task.mergeRetries < budget) {
      task.mergeRetries += 1;
      task.status = 'pending';
      task.failureKind = null;
      task.result = `merge conflict with the integration base; redoing on top of it (${task.mergeRetries}/${budget})`;
      this.log(
        'task-retry',
        task.id,
        `merge conflict; redoing on the merged base (${task.mergeRetries}/${budget})`,
      );
    } else {
      task.status = 'failed';
      task.failureKind = 'merge';
      task.result = `merge conflict after ${task.mergeRetries} redo(s): ${conflict ?? ''}`;
      this.log('task-fail', task.id, `failed (merge): ${truncate(conflict ?? '', 200)}`);
      if (!this.tryRepair(task, scope)) this.notify('task-fail', task.id, 'merge conflict');
    }
  }

  // Success: record the output tail (verdicts live at the end of an agent's
  // output) and mark the task done.
  private completeAttempt(task: Task, outcome: ExecOutcome): void {
    task.status = 'completed';
    task.exitCode = outcome.exitCode;
    task.result = truncateTail(stripAnsi(outcome.output).trim(), RESULT_LIMIT) || '(ok, no output)';
    task.finishedAt = nowIso();
    task.lastOutput = null;
    task.pid = null;
    this.log(
      'task-done',
      task.id,
      `completed${outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ''}${
        task.reviewCmd ? ' — review passed' : ''
      }`,
    );
  }

  // Failure path: salvage partial work, classify the failure, then retry with
  // backoff while attempts remain, or fail permanently (repairing upstream when
  // configured). A deliberate stop requeues instead of counting as a failure.
  private async failAttempt(
    task: Task,
    err: unknown,
    scope: Set<string> | null,
    token: number,
  ): Promise<void> {
    if (this.tokens.get(task.id) !== token) return;
    // The worktree may hold real work: save it before the worktree goes.
    this.salvageWorktree(task.id, this.stopping ? 'stopped' : 'failed');
    const reason: FailureKind =
      this.reasons.get(task.id) ?? (err as { kind?: FailureKind }).kind ?? 'exit';
    const message = err instanceof Error ? err.message : String(err);
    const exitCode = (err as { exitCode?: number | null }).exitCode ?? null;
    task.finishedAt = nowIso();
    task.result = truncate(message, RESULT_LIMIT);
    task.pid = null;
    if (reason === 'exit') task.exitCode = exitCode;

    // Everything except a deliberate stop or a missing command is retryable
    // while attempts remain. Stall and timeout included.
    const budget = this.maxAttemptsFor(task);
    const retryable = reason !== 'manual' && task.attempts < budget;
    if (this.stopping) {
      task.status = 'pending';
      task.failureKind = 'killed';
      task.result = 'stopped by user';
      this.log('task-killed', task.id, 'stopped; requeued as pending');
    } else if (retryable) {
      task.status = 'pending';
      task.failureKind = null;
      task.result = null;
      task.exitCode = null;
      this.log(
        'task-retry',
        task.id,
        `attempt ${task.attempts}/${budget} failed (${reason}: ${truncate(message, 120)}); backing off`,
      );
      // Exponential backoff capped at 60s, jittered to 50-100% so retries from
      // parallel tasks do not resynchronize into a thundering herd.
      const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, task.attempts - 1));
      await this.backoff(delay * (0.5 + Math.random() * 0.5));
    } else {
      task.status = 'failed';
      task.failureKind = reason;
      const type =
        reason === 'timeout' ? 'task-timeout' : reason === 'stalled' ? 'task-stalled' : 'task-fail';
      this.log(type, task.id, `failed (${reason}): ${truncate(message, 300)}`);
      if (!this.tryRepair(task, scope)) this.notify(type, task.id, truncate(message, 200));
    }
  }

  // Per-attempt cleanup, always run: close logs, drop bookkeeping, and mark the
  // task out of flight so a new attempt (or a stop) can pick it up.
  private endAttempt(task: Task, token: number): void {
    this.kills.delete(task.id);
    this.reasons.delete(task.id);
    this.closeLog(task.id);
    this.attemptByTask.delete(task.id);
    this.dropWorktree(task.id);
    if (this.tokens.get(task.id) === token) {
      this.inFlight.delete(task.id);
      this.tokens.delete(task.id);
      this.persist();
    }
  }
}
