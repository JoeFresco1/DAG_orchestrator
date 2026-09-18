// Shared CLI argument parsing and output helpers.
//
// Every `dag <cmd>` handler receives the raw argv slice that followed the
// command name and reads its flags through these helpers, so parsing rules and
// their error messages stay consistent no matter which command is asking.
import { acquireLock } from './store.js';
import type { DepFailurePolicy, GatePolicy } from './types.js';

// A handler is one `dag <cmd>` implementation. `cmd` is passed alongside the
// flags because a couple of commands (`approve`/`reject`) share a handler and
// need to know which name they were invoked under.
export type CommandHandler = (argv: string[], cmd: string) => void | Promise<void>;

export const wantsJson = (argv: string[]): boolean => argv.includes('--json');

// Human-readable by default, JSON when --json is present. Callers supply the
// structured value once and a formatter for the terminal so the two views
// cannot drift apart.
export const emit = (argv: string[], data: unknown, human: () => string): void => {
  console.log(wantsJson(argv) ? JSON.stringify(data, null, 2) : human());
};

// A value that looks like another flag means the value is missing. Without
// this, `set --cmd --file X` stores the literal string "--file" as the command.
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  if (next === undefined || (next.startsWith('--') && next !== '--')) return undefined;
  return next;
}

// For flags whose value is required: `--cmd` with nothing after it is a
// mistake, not a request to clear the field.
export function flagRequired(argv: string[], name: string): string {
  const v = flag(argv, name);
  if (v === undefined) throw new Error(`--${name} needs a value`);
  return v;
}

// --cmd takes a value: a missing one is a mistake, an empty string an explicit clear.
export function cmdFlag(argv: string[]): string | null | undefined {
  if (!argv.includes('--cmd')) return undefined;
  const value = flagRequired(argv, 'cmd');
  return value.trim() === '' ? null : value;
}

export function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

// `-n` is not a --flag, so it needs its own reader.
export function shortN(argv: string[]): number | undefined {
  const i = argv.indexOf('-n');
  if (i < 0) return undefined;
  const raw = argv[i + 1];
  if (raw === undefined || raw.startsWith('-')) throw new Error('-n needs a value');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`-n must be an integer >= 0 (got ${raw})`);
  return n;
}

// Every command defaults to the run file in the current project directory.
export function fileOf(argv: string[]): string {
  return flag(argv, 'file') ?? 'dag.run.json';
}

// Comma-separated id lists, de-duplicated so `--deps a,a,b` is just [a, b].
export function parseList(v: string | undefined): string[] {
  const seen = new Set<string>();
  for (const item of v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []) {
    seen.add(item);
  }
  return [...seen];
}

// CLI accepts seconds; the file stores ms. 0 = no limit.
export function secondsToMs(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid seconds value: ${v}`);
  return Math.round(n * 1000);
}

// Counts and budgets: reject junk instead of silently storing NaN/null.
export function countFlag(argv: string[], name: string, min = 0): number | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`--${name} must be an integer >= ${min} (got ${raw})`);
  }
  return n;
}

export function numberFlag(argv: string[], name: string, min = 0): number | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`--${name} must be a number >= ${min} (got ${raw})`);
  }
  return n;
}

export function retriesToMaxAttempts(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid --retries value: ${v}`);
  return n + 1;
}

// The timing/verification flags shared by `add`, `edit`, `review` and `run`.
// Only the keys actually present on the command line are returned, so callers
// can distinguish "leave as is" from "set to null".
export function taskTimingFlags(argv: string[]): {
  maxAttempts?: number;
  timeoutMs?: number | null;
  silenceMs?: number | null;
  reviewCmd?: string | null;
  planCmd?: string | null;
  reviewRounds?: number;
  repairRounds?: number;
} {
  const out: {
    maxAttempts?: number;
    timeoutMs?: number | null;
    silenceMs?: number | null;
    reviewCmd?: string | null;
    planCmd?: string | null;
    reviewRounds?: number;
    repairRounds?: number;
  } = {};
  const maxAttempts = retriesToMaxAttempts(flag(argv, 'retries'));
  if (maxAttempts !== undefined) out.maxAttempts = maxAttempts;
  if (has(argv, 'timeout')) out.timeoutMs = secondsToMs(flagRequired(argv, 'timeout'));
  if (has(argv, 'silence')) out.silenceMs = secondsToMs(flagRequired(argv, 'silence'));
  if (has(argv, 'review-cmd')) out.reviewCmd = flag(argv, 'review-cmd') ?? null;
  if (has(argv, 'plan-cmd')) out.planCmd = flag(argv, 'plan-cmd') ?? null;
  const reviewRounds = countFlag(argv, 'review-rounds');
  if (reviewRounds !== undefined) out.reviewRounds = reviewRounds;
  const repairRounds = countFlag(argv, 'repair-rounds');
  if (repairRounds !== undefined) out.repairRounds = repairRounds;
  return out;
}

// Run-level failure policies, accepted by both `settings` and `run`.
export function policyFlags(argv: string[]): {
  onDepFailure?: DepFailurePolicy;
  onGateBlocked?: GatePolicy;
} {
  const out: { onDepFailure?: DepFailurePolicy; onGateBlocked?: GatePolicy } = {};
  const dep = flag(argv, 'on-dep-failure');
  if (dep !== undefined) {
    if (dep !== 'block' && dep !== 'skip') {
      throw new Error(`--on-dep-failure must be block|skip (got ${dep})`);
    }
    out.onDepFailure = dep;
  }
  const gates = flag(argv, 'gates');
  if (gates !== undefined) {
    if (gates !== 'wait' && gates !== 'skip') {
      throw new Error(`--gates must be wait|skip (got ${gates})`);
    }
    out.onGateBlocked = gates;
  }
  return out;
}

// Every mutating command owns the run file for its (short) lifetime, so two
// CLI processes can never interleave writes. Read-only commands don't lock.
// The lock is released on exit; a killed process leaves a stale lock that the
// next command steals automatically.
export function guard(file: string, argv: string[]): void {
  const note = `dag ${process.argv[2] ?? 'edit'}`;
  const release = acquireLock(file, note, has(argv, 'force'));
  process.on('exit', release);
}
