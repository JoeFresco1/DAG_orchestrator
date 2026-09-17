export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'ready',
  'running',
  'completed',
  'failed',
  'skipped',
];

export type FinalReviewMode = 'off' | 'per-task' | 'run';

// Facts about the tasks a chain-review task covers, gathered when it runs.
export interface TaskCoverage {
  dir: string;
  manifest: string;
  base: string | null;
  head: string | null;
  stat: string;
  files: string;
  tasks: string[];
}

export interface FinalReviewVerdict {
  verdict: 'pass' | 'fail' | 'error';
  reason: string;
  at: string;
  round: number;
}

export type TerminalStatus = 'completed' | 'failed' | 'skipped';

// What the UI/CLI show: real status plus two derived states.
export type DisplayStatus = TaskStatus | 'blocked' | 'gated';

export type FailureKind =
  | 'exit'
  | 'spawn'
  | 'timeout'
  | 'stalled'
  | 'killed'
  | 'manual'
  | 'interrupted'
  | 'review'
  | 'merge'
  | 'worktree'
  | 'setup'
  | 'plan';

export type EventType =
  | 'run-start'
  | 'run-stop'
  | 'run-end'
  | 'task-start'
  | 'task-done'
  | 'task-fail'
  | 'task-retry'
  | 'task-timeout'
  | 'task-stalled'
  | 'task-killed'
  | 'task-skip'
  | 'task-interrupted'
  | 'task-review'
  | 'task-repair'
  | 'task-plan'
  | 'task-stall-warning'
  | 'task-review-start'
  | 'task-review-pass'
  | 'task-review-fail'
  | 'run-review'
  | 'notify'
  | 'edit'
  | 'note';

export interface DagEvent {
  // Absolute monotonic cursor; survives ring rotation.
  seq: number;
  ts: string;
  type: EventType;
  taskId: string | null;
  message: string;
}

import type { Reviewer } from './review-policy.js';
import type { HarnessCandidate } from './harness-chain.js';

export interface ReviewerVerdict {
  verdict: 'pass' | 'fail' | 'skipped' | 'error';
  reason: string;
  at: string;
}

export interface ApprovalGate {
  question: string;
  options: string[];
  approved: boolean | null;
}

export interface Task {
  id: string;
  title: string;
  // Self-contained instructions: inputs, outputs, acceptance criteria.
  spec: string;
  deps: string[];
  status: TaskStatus;
  // Shell command the runner executes. Null = manual task, never auto-run.
  cmd: string | null;
  gate: ApprovalGate | null;
  result: string | null;
  createdAt: string;
  // Monotonic creation order; deterministic tiebreak for launch order.
  seq: number;
  attempts: number;
  maxAttempts: number;
  // 0 = no limit. Null = inherit run settings.
  timeoutMs: number | null;
  silenceMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  failureKind: FailureKind | null;
  // Liveness: touched on every stdout/stderr chunk, persisted throttled.
  lastOutputAt: string | null;
  lastOutput: string | null;
  // Child pid while running; used for orphan detection after a crash.
  pid: number | null;
  // Postcondition reviewer: run after the command succeeds. A non-zero exit
  // means the work is not accepted and gets redone (bounded by reviewRounds).
  reviewCmd: string | null;
  reviewRounds: number;
  reviews: number;
  reviewResult: string | null;
  reviewExitCode: number | null;
  // Integration repair: on permanent failure, requeue upstream deps and redo
  // this node, bounded by repairRounds.
  repairRounds: number;
  repairs: number;
  // Worktree isolation (set when the run uses worktrees): the branch this
  // task's work was committed to and its commit sha.
  branch: string | null;
  commit: string | null;
  // Merge-conflict redos used (separate from command attempts: a conflict is
  // an artifact of parallel work, not a failed command).
  mergeRetries: number;
  // Planning phase: the plan text and where it was written, so the work
  // command can follow it (`{plan}` / `{planFile}` tokens).
  planCmd: string | null;
  plan: string | null;
  // Per-reviewer outcomes for the last review pass, keyed by reviewer name.
  reviewerVerdicts: Record<string, ReviewerVerdict>;
  // Why the previous attempt was rejected, fed back to the redo via {lastRejection}.
  lastRejection: string | null;
  // Per-task override for the worktree prepare command.
  prepareCmd: string | null;
  // Reviewers for this task: each emits its own verdict, and the task passes
  // only if every applicable one passes. `when` decides applicability.
  reviewers: Reviewer[];
  // Fallback chain: each attempt advances to the next tool. Null = inherit
  // the run default; [] = no chain (use cmd as written).
  harnessChain: HarnessCandidate[] | null;
  // Tool used by the last attempt, when a chain applied.
  harness: string | null;
  // End-of-run review: the diff this task merged (integration before/after).
  diffBase: string | null;
  diffHead: string | null;
  finalReview: FinalReviewVerdict | null;
  // A task whose subject is other tasks ("review the chain"): the ids it
  // covers. Its spec is a template, rendered with the covered tasks' facts
  // when it runs (see {coverage} tokens), and its verdict decides its status.
  covers: string[] | null;
  coverage: TaskCoverage | null;
  // Model selection: null = use the run default. Commands reference these as
  // {model} / {variant}, so the UI can retarget tasks without editing text.
  model: string | null;
  variant: string | null;
}

// What happens to tasks whose dependency failed. 'block' waits for a human;
// 'skip' marks them skipped so unattended runs still converge.
export type DepFailurePolicy = 'block' | 'skip';
// What happens to tasks sitting on an unapproved gate.
export type GatePolicy = 'wait' | 'skip';

// Settings that arrive from an API body, a CLI flag or a hand-edited file
// are validated in one place: a wrong value must not silently change the
// execution model (an unknown isolation mode used to mean "no isolation").
export interface SettingsProblem {
  field: string;
  reason: string;
}

const PROBLEM = (field: string, reason: string): SettingsProblem => ({ field, reason });

export function validateSettingsPatch(patch: Record<string, unknown>): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  const num = (field: string, min: number, max: number, integer = true): void => {
    const value = patch[field];
    if (value === undefined || value === null) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(PROBLEM(field, 'must be a finite number'));
      return;
    }
    if (integer && !Number.isInteger(value)) problems.push(PROBLEM(field, 'must be an integer'));
    if (value < min || value > max) problems.push(PROBLEM(field, `must be between ${min} and ${max}`));
  };
  const oneOf = (field: string, allowed: readonly string[]): void => {
    const value = patch[field];
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || !allowed.includes(value)) {
      problems.push(PROBLEM(field, `must be one of ${allowed.join('|')}`));
    }
  };
  const text = (field: string, maxLength: number, allowNull = true): void => {
    const value = patch[field];
    if (value === undefined) return;
    if (value === null) {
      if (!allowNull) problems.push(PROBLEM(field, 'cannot be null'));
      return;
    }
    if (typeof value !== 'string') problems.push(PROBLEM(field, 'must be a string'));
    else if (value.length > maxLength) problems.push(PROBLEM(field, `must be at most ${maxLength} characters`));
  };

  num('concurrency', 1, 64);
  num('maxAttempts', 1, 100);
  num('timeoutMs', 0, 24 * 3600_000);
  num('silenceMs', 0, 24 * 3600_000);
  num('maxWallClockMs', 0, 30 * 24 * 3600_000);
  num('finalReviewRounds', 0, 50);
  num('reviewRounds', 0, 50);
  num('repairRounds', 0, 50);
  oneOf('worktree', ['none', 'task']);
  oneOf('finalReview', ['off', 'per-task', 'run']);
  oneOf('silenceAction', ['warn', 'kill']);
  oneOf('onDepFailure', ['block', 'skip']);
  oneOf('onGateBlocked', ['wait', 'skip']);
  // null is meaningful (auto) for the exit policy.
  if (patch.failOnNonZeroExit !== undefined && patch.failOnNonZeroExit !== null &&
      typeof patch.failOnNonZeroExit !== 'boolean') {
    problems.push(PROBLEM('failOnNonZeroExit', 'must be true, false or null'));
  }
  text('model', 300);
  text('variant', 100);
  text('notifyCmd', 4000);
  text('finalReviewCmd', 8000);
  text('worktreePrepareCmd', 4000);
  // harnessChain is an array of candidates, validated by parseHarnessChain.
  return problems;
}

export function describeSettingsProblems(problems: SettingsProblem[]): string {
  return problems.map((p) => `${p.field}: ${p.reason}`).join('; ');
}

export interface RunSettings {
  concurrency: number;
  timeoutMs: number;
  silenceMs: number;
  // How a reviewer's verdict is read. 'marker' requires a machine-readable
  // VERDICT: PASS / VERDICT: FAIL: reason line (agent harnesses exit 0
  // either way); 'exit-code' trusts the exit status alone (shell reviewers).
  reviewVerdict: 'marker' | 'exit-code';
  // What a quiet task means. Agents legitimately go minutes without output
  // (buffered tool calls: pytest, mypy, long model turns), so the default is
  // to warn and let the hard timeout bound the task, not to kill on silence.
  silenceAction: 'warn' | 'kill';
  maxAttempts: number;
  onDepFailure: DepFailurePolicy;
  onGateBlocked: GatePolicy;
  // 0 = unlimited. Reaching it stops launching new tasks gracefully.
  maxWallClockMs: number;
  // Per-attempt log file cap.
  logCapBytes: number;
  // Command run on failures/stalls/run end; DAG_EVENT/DAG_TASK/DAG_MESSAGE
  // are set in its environment. Empty = no notifications.
  notifyCmd: string;
  // Model and effort used wherever a command references {model} /
  // {variant}; an individual task can override either.
  model: string;
  variant: string;
  // Command run once per task worktree before the phases (uv sync, pnpm
  // install, …). Without it a suite reviewer in a fresh checkout has no
  // environment to run in. Non-zero exit fails the task as `setup`.
  worktreePrepareCmd: string;
  // Fallback chain for every task that does not define its own; empty = none.
  harnessChain: HarnessCandidate[];
  // End-of-run review: off, one reviewer per task, or one for the whole run.
  finalReview: FinalReviewMode;
  // How many times a failed end-of-run review may send work back.
  finalReviewRounds: number;
  // Command override for the end-of-run reviewer (defaults to the preset).
  finalReviewCmd: string | null;
  // Treat a non-zero work exit as a failure. null = auto: on when a chain is
  // set (a dead tool should hand over), off otherwise (agents lie about codes).
  failOnNonZeroExit: boolean | null;
  // 'task' gives every task its own git worktree on a per-run integration
  // branch; 'none' runs agents directly in the project directory.
  worktree: 'none' | 'task';
  // How many times a task may be redone after a merge conflict with the
  // integration branch (worktree mode only).
  mergeRounds: number;
}

export const DEFAULT_SETTINGS: RunSettings = {
  concurrency: 4,
  timeoutMs: 60 * 60 * 1000,
  silenceMs: 10 * 60 * 1000,
  silenceAction: 'warn',
  reviewVerdict: 'marker',
  maxAttempts: 1,
  onDepFailure: 'block',
  onGateBlocked: 'wait',
  maxWallClockMs: 0,
  logCapBytes: 1024 * 1024,
  notifyCmd: '',
  model: '',
  variant: '',
  worktree: 'none',
  worktreePrepareCmd: '',
  harnessChain: [],
  failOnNonZeroExit: null,
  finalReview: 'off',
  finalReviewRounds: 1,
  finalReviewCmd: null,
  mergeRounds: 2,
};

export interface Run {
  storageVersion: number;
  id: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  // Bumped on every persist; viewers use it to skip unchanged polls.
  rev: number;
  // Highest event seq ever written; the ring may hold fewer.
  eventSeq: number;
  settings: RunSettings;
  tasks: Record<string, Task>;
  // Ring of recent events for the API; full history lives in events.jsonl.
  events: DagEvent[];
}

export const STORAGE_VERSION = 2;
// One runner, many workers: this caps how many workers it can run at once.
export const MAX_CONCURRENCY = 64;
export const EVENT_RING_LIMIT = 200;
export const EVENT_LOG_ROTATE_BYTES = 20 * 1024 * 1024;
export const RESULT_LIMIT = 4000;
export const OUTPUT_TAIL_LIMIT = 2000;
export const ATTEMPT_LOG_CAP_DEFAULT = 1024 * 1024;

export const DEFINITION_FIELDS = [
  'id',
  'title',
  'spec',
  'deps',
  'cmd',
  'gate',
  'createdAt',
  'seq',
  'maxAttempts',
  'timeoutMs',
  'silenceMs',
  'reviewCmd',
  'reviewRounds',
  'repairRounds',
  'planCmd',
  'model',
  'variant',
  'reviewers',
  'prepareCmd',
  'harnessChain',
  'covers',
] as const;

export const DYNAMIC_FIELDS = [
  'status',
  'result',
  'attempts',
  'startedAt',
  'finishedAt',
  'exitCode',
  'failureKind',
  'lastOutputAt',
  'lastOutput',
  'pid',
  'reviews',
  'reviewResult',
  'reviewExitCode',
  'repairs',
  'branch',
  'commit',
  'mergeRetries',
  'plan',
  'reviewerVerdicts',
  'lastRejection',
  'harness',
  'diffBase',
  'diffHead',
  'finalReview',
  'coverage',
] as const;

export const PLAN_LIMIT = 20000;

export type DagConvergence = 'empty' | 'all-done' | 'active';
