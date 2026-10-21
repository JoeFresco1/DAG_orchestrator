import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run, RunSettings } from './types.js';
import { attemptsForChain } from './harness-chain.js';
import { effectivePlanCmd } from './harnesses.js';
import { PHASE_TIMEOUTS } from './flow3/contracts.js';

/** A preset is applied once; explicit subsequent settings continue to win. */
export function executionProfilePatch(profile = 'flow3'): Partial<RunSettings> {
  if (profile === 'flow3') return {
    executionProfile: 'flow3', autoPlan: false, worktree: 'task', maxAttempts: 2,
    timeoutMs: 900_000, silenceMs: 180_000, silenceAction: 'kill',
    onDepFailure: 'block', finalReview: 'off', finalReviewRounds: 0,
  };
  if (profile !== 'lean') {
    throw new Error(`The legacy execution preset is retired. Use --profile lean to upgrade a stopped run (got ${profile}).`);
  }
  return {
    executionProfile: 'lean', autoPlan: false, worktree: 'task', timeoutMs: 900_000,
    reviewVerdict: 'structured', mergeRounds: 1,
    implementationAttempts: 3, taskDeadlineMs: 2_700_000, infrastructureRetries: 2, maxAttempts: 3,
    finalReview: 'off',
    finalReviewRounds: 0,
  };
}

export interface ExecutionPolicySnapshot {
  capturedAt: string;
  mode: 'ordinary' | 'controller-managed';
  build: { version: string; moduleRoot: string; sha256: string; entrypoint: string; node: string };
  settings: RunSettings;
  flow3Repair?: { nodeRounds: number; checkpointRounds: number; timeoutMs: number };
  tasks: Record<string, {
    timeoutMs: number; maxAttempts: number; planCmd: string | null;
    savedMaxAttempts: number; savedPlanCmd: string | null;
    reviewCmd: string | null; reviewRounds: number; repairRounds: number;
    savedReviewRounds: number; savedRepairRounds: number;
    harnessChain: RunSettings['harnessChain']; reviewers: Run['tasks'][string]['reviewers'];
  }>;
}

// Hash the executing module tree, not git HEAD: local source and stale dist
// builds must have different identities even when package versions match.
export function installedBuildIdentity(): ExecutionPolicySnapshot['build'] {
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const hash = createHash('sha256');
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:js|ts)$/.test(entry.name) && !/\.(?:test|d)\.(?:js|ts)$/.test(entry.name)) {
        hash.update(relative(moduleRoot, path).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(readFileSync(path));
        hash.update('\0');
      }
    }
  };
  visit(moduleRoot);
  const pkg = JSON.parse(readFileSync(join(moduleRoot, '..', 'package.json'), 'utf8'));
  return { version: pkg.version, moduleRoot, sha256: hash.digest('hex'),
    entrypoint: resolve(process.argv[1] ?? fileURLToPath(import.meta.url)), node: process.version };
}

/** Preserve the policies used at start even if settings are edited afterward. */
export function captureExecutionPolicy(run: Run, mode: ExecutionPolicySnapshot['mode'] = 'ordinary'): ExecutionPolicySnapshot {
  const tasks: ExecutionPolicySnapshot['tasks'] = {};
  for (const task of Object.values(run.tasks)) {
    tasks[task.id] = {
      timeoutMs: task.timeoutMs ?? run.settings.timeoutMs,
      maxAttempts: mode === 'controller-managed' ? 1 : run.settings.executionProfile === 'flow3' ? Math.min(2, Math.max(1, task.maxAttempts)) : task.executionBudget || run.settings.executionProfile === 'lean'
        ? task.executionBudget?.limit ?? run.settings.implementationAttempts ?? 3
        : attemptsForChain(task.maxAttempts, task.harnessChain ?? run.settings.harnessChain),
      savedMaxAttempts: task.maxAttempts,
      planCmd: mode === 'controller-managed' || run.settings.executionProfile === 'flow3' ? null : effectivePlanCmd(task, run.settings), savedPlanCmd: task.planCmd, reviewCmd: run.settings.executionProfile === 'flow3' ? null : task.reviewCmd,
      reviewRounds: ['lean', 'flow3'].includes(run.settings.executionProfile ?? '') ? 0 : task.reviewRounds,
      repairRounds: ['lean', 'flow3'].includes(run.settings.executionProfile ?? '') ? 0 : task.repairRounds,
      savedReviewRounds: task.reviewRounds, savedRepairRounds: task.repairRounds,
      harnessChain: task.harnessChain ?? run.settings.harnessChain,
      reviewers: task.reviewers,
    };
  }
  return structuredClone({ capturedAt: new Date().toISOString(), mode,
    ...(mode === 'ordinary' && run.settings.executionProfile === 'flow3' ? { flow3Repair: {
      nodeRounds: run.settings.flow3?.nodeRepairRounds ?? 1,
      checkpointRounds: run.settings.flow3?.repairRounds ?? 2,
      timeoutMs: run.settings.flow3?.phaseTimeouts?.repair ?? PHASE_TIMEOUTS.repair,
    } } : {}), build: installedBuildIdentity(), settings: run.settings, tasks });
}
