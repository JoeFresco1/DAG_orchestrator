// Types shared between the server composition root and the view/route helpers.
import type { DagRunner } from './runner.js';
import type { DepFailurePolicy, GatePolicy } from './types.js';

// One runtime per RUN, not per project: two runs in one repository are two
// independent runners with their own locks and integration branches.
export interface RunRuntime {
  runId: string;
  projectDir: string;
  file: string;
  archived: boolean;
  runner: DagRunner | null;
  releaseLock: (() => void) | null;
  jobStartedAt: string | null;
  activeScope: string[] | null;
  starting: boolean;
}

export interface StartOptions {
  ids?: string[] | null;
  concurrency?: number;
  timeoutMs?: number;
  silenceMs?: number;
  maxAttempts?: number;
  onDepFailure?: DepFailurePolicy;
  onGateBlocked?: GatePolicy;
  maxWallClockMs?: number;
  notifyCmd?: string;
  model?: string;
  variant?: string;
  worktree?: 'none' | 'task';
  worktreePrepareCmd?: string;
  force?: boolean;
}

export interface StartResult {
  started: boolean;
  scope?: string[];
  skippedManual?: string[];
  error?: string;
  code?: number;
}
