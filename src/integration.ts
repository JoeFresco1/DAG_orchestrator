import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { git, headCommit, mergeIntoIntegration, removeWorktree, worktreeRoot } from './git-worktree.js';

export interface IntegrationVerification {
  passed: boolean;
  detail?: string;
  checks?: unknown[];
}

export interface IntegrationReceipt {
  version: 1;
  taskId: string;
  attempt: number;
  integrationRef: string;
  expectedHead: string;
  sourceCommit: string;
  candidateCommit: string;
  verification: IntegrationVerification;
  runId?: string;
  attemptId?: string;
  evidence?: Record<string, unknown>;
  integrity?: string;
  stage: 'intent' | 'published';
}

export interface IntegrationOptions {
  repoDir: string;
  integrationWorktree: string;
  integrationBranch: string;
  taskBranch: string;
  taskId: string;
  attempt: number;
  receiptFile: string;
  runId?: string;
  attemptId?: string;
  evidence?: Record<string, unknown>;
  isCurrentAttempt: () => boolean;
  verify: (candidatePath: string, candidateCommit: string) => Promise<IntegrationVerification>;
}

export interface IntegrationResult {
  merged: boolean;
  conflict: boolean;
  detail: string;
  commit?: string;
  receipt?: IntegrationReceipt;
}

type RejectedReceipt = Omit<IntegrationReceipt, 'stage'> & { stage: 'rejected' };

function receiptIntegrity(receipt: IntegrationReceipt | RejectedReceipt): string {
  const { stage: _stage, integrity: _integrity, ...acceptedInputs } = receipt;
  return createHash('sha256').update(JSON.stringify(acceptedInputs)).digest('hex');
}

function writeReceipt(file: string, receipt: IntegrationReceipt | RejectedReceipt): void {
  receipt.integrity = receiptIntegrity(receipt);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx');
  try {
    writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  // Directory fsync is unavailable on some Windows filesystems.
  try {
    const directory = openSync(dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { /* file contents were flushed before the atomic rename */ }
}

function refFor(branch: string): string {
  const ref = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
  return ref;
}

function resolveCommit(repo: string, ref: string): string {
  const result = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (result.code !== 0) throw new Error(`Cannot resolve integration commit ${ref}: ${result.stderr}`);
  return result.stdout;
}

function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]).code === 0;
}

/** Recover a flushed intent after a crash between ref publication and state persistence. */
export function reconcileIntegrationReceipt(options: Pick<IntegrationOptions,
  'repoDir' | 'integrationBranch' | 'taskId' | 'attempt' | 'receiptFile' | 'isCurrentAttempt' | 'attemptId' | 'runId' | 'evidence'>): IntegrationResult | null {
  if (!existsSync(options.receiptFile)) return null;
  const receipt = JSON.parse(readFileSync(options.receiptFile, 'utf8')) as IntegrationReceipt;
  if (receipt.version !== 1 || receipt.taskId !== options.taskId || receipt.attempt !== options.attempt ||
      receipt.integrationRef !== refFor(options.integrationBranch) ||
      (options.attemptId !== undefined && receipt.attemptId !== options.attemptId) ||
      (options.runId !== undefined && receipt.runId !== options.runId) || !options.isCurrentAttempt()) {
    throw new Error('Integration receipt belongs to a stale or different task attempt');
  }
  if (!receipt.verification?.passed || !['intent', 'published'].includes(receipt.stage) ||
      receipt.integrity !== receiptIntegrity(receipt) ||
      ![receipt.expectedHead, receipt.sourceCommit, receipt.candidateCommit].every((sha) => /^[0-9a-f]{40,64}$/.test(sha))) {
    throw new Error('Invalid integration acceptance receipt');
  }
  for (const fingerprint of ['manifestFingerprint', 'policyFingerprint']) {
    if (options.evidence?.[fingerprint] !== undefined && options.evidence[fingerprint] !== receipt.evidence?.[fingerprint]) {
      throw new Error(`Integration receipt ${fingerprint} differs from current acceptance context`);
    }
  }
  const accepted = resolveCommit(options.repoDir, receipt.integrationRef);
  if (!isAncestor(options.repoDir, receipt.expectedHead, receipt.candidateCommit) ||
      !isAncestor(options.repoDir, receipt.sourceCommit, receipt.candidateCommit)) {
    throw new Error('Integration receipt candidate does not contain its recorded inputs');
  }
  if (isAncestor(options.repoDir, receipt.candidateCommit, accepted)) {
    if (receipt.stage !== 'published') {
      receipt.stage = 'published';
      try { writeReceipt(options.receiptFile, receipt); } catch {
        // The flushed intent plus accepted ref already proves publication.
        return { merged: true, conflict: false, detail: 'Recovered publication; receipt finalization remains pending', commit: receipt.candidateCommit, receipt };
      }
    }
    return { merged: true, conflict: false, detail: 'Recovered published integration acceptance', commit: receipt.candidateCommit, receipt };
  }
  if (receipt.stage === 'published') throw new Error('Published integration receipt is absent from accepted history');
  // Publication never happened. The next attempt must build and verify on current H.
  unlinkSync(options.receiptFile);
  return null;
}

/** Detach only the designated, clean orchestrator checkout before changing its ref. */
function detachIntegration(options: IntegrationOptions): void {
  const ref = refFor(options.integrationBranch);
  const listed = git(options.repoDir, ['worktree', 'list', '--porcelain']);
  if (listed.code !== 0) throw new Error(`Cannot inspect integration worktrees: ${listed.stderr}`);
  for (const record of listed.stdout.split(/\r?\n\r?\n/)) {
    const lines = record.split(/\r?\n/);
    if (!lines.includes(`branch ${ref}`)) continue;
    const path = lines.find((line) => line.startsWith('worktree '))?.slice(9);
    if (!path || resolve(path).toLowerCase() !== resolve(options.integrationWorktree).toLowerCase() ||
        resolve(path).toLowerCase() === resolve(options.repoDir).toLowerCase()) {
      throw new Error('Integration branch is checked out outside the orchestrator checkout');
    }
    const status = git(path, ['status', '--porcelain']);
    if (status.code !== 0 || status.stdout) throw new Error('Integration checkout has unsaved changes');
    const detach = git(path, ['checkout', '--detach', 'HEAD']);
    if (detach.code !== 0) throw new Error(`Cannot detach integration checkout: ${detach.stderr}`);
  }
}

/** Caller serializes these operations; update-ref still rejects cross-process races. */
export async function integrateVerifiedCandidate(options: IntegrationOptions): Promise<IntegrationResult> {
  const recovered = reconcileIntegrationReceipt(options);
  if (recovered) return recovered;
  if (!options.isCurrentAttempt()) return { merged: false, conflict: false, detail: 'Stale task attempt' };
  const ref = refFor(options.integrationBranch);
  const expectedHead = resolveCommit(options.repoDir, ref);
  const sourceCommit = resolveCommit(options.repoDir, options.taskBranch);
  const root = worktreeRoot(options.repoDir, options.integrationBranch);
  mkdirSync(root, { recursive: true });
  const candidatePath = join(root, `candidate-${randomUUID().slice(0, 12)}`);
  const add = git(options.repoDir, ['worktree', 'add', '--detach', candidatePath, expectedHead]);
  if (add.code !== 0) throw new Error(`Cannot create integration candidate: ${add.stderr}`);
  try {
    const merge = mergeIntoIntegration(candidatePath, sourceCommit, options.taskId);
    if (!merge.merged) return merge;
    const candidateCommit = headCommit(candidatePath);
    // Keep rejected candidates inspectable after the throwaway checkout is removed.
    const candidateKey = createHash('sha256').update(`${ref}:${options.taskId}:${options.attemptId ?? options.attempt}:${candidateCommit}`).digest('hex');
    const pin = git(options.repoDir, ['update-ref', `refs/dag-candidates/${candidateKey}`, candidateCommit]);
    if (pin.code !== 0) throw new Error(`Cannot preserve integration candidate: ${pin.stderr}`);
    const reject = (verification: IntegrationVerification): IntegrationResult => {
      writeReceipt(`${options.receiptFile}.rejected.json`, { version: 1, taskId: options.taskId,
        attempt: options.attempt, integrationRef: ref, expectedHead, sourceCommit, candidateCommit,
        verification, stage: 'rejected', runId: options.runId, attemptId: options.attemptId, evidence: options.evidence });
      return { merged: false, conflict: false, commit: candidateCommit, detail: verification.detail ?? 'Integration candidate verification failed' };
    };
    let verification: IntegrationVerification;
    try { verification = await options.verify(candidatePath, candidateCommit); } catch (error) {
      return reject({ passed: false, detail: `Integration verification threw: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (!verification.passed) return reject(verification);
    const status = git(candidatePath, ['status', '--porcelain']);
    if (headCommit(candidatePath) !== candidateCommit || status.code !== 0 || status.stdout) {
      return reject({ ...verification, passed: false, detail: 'Integration verification changed the candidate checkout' });
    }
    if (!options.isCurrentAttempt()) return { merged: false, conflict: false, commit: candidateCommit, detail: 'Stale task attempt after integration verification' };
    detachIntegration(options);
    const receipt: IntegrationReceipt = { version: 1, taskId: options.taskId, attempt: options.attempt,
      integrationRef: ref, expectedHead, sourceCommit, candidateCommit, verification, stage: 'intent',
      runId: options.runId, attemptId: options.attemptId, evidence: options.evidence };
    writeReceipt(options.receiptFile, receipt);
    if (!options.isCurrentAttempt()) return { merged: false, conflict: false, detail: 'Stale task attempt before publication' };
    const published = git(options.repoDir, ['update-ref', ref, candidateCommit, expectedHead]);
    if (published.code !== 0) return { merged: false, conflict: true, detail: `Accepted integration head changed before publication: ${published.stderr}` };
    receipt.stage = 'published';
    try { writeReceipt(options.receiptFile, receipt); } catch {
      return { merged: true, conflict: false, detail: 'Verified candidate published; receipt finalization remains pending', commit: candidateCommit, receipt };
    }
    return { merged: true, conflict: false, detail: 'Verified integration candidate published', commit: candidateCommit, receipt };
  } finally {
    removeWorktree(options.repoDir, candidatePath);
  }
}
