/** Versioned negative evidence, scoped to repository code and verified assumptions. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJsonFileWithBackup, runPaths } from '../store.js';

export type NegativeEvidenceStatus = 'disproven' | 'known-non-issue';

/** Code that proves one recorded assumption behind a negative finding. */
export interface NegativeEvidenceReference {
  assumption: string;
  path: string;
  sha256: string;
  sourceCommit: string;
  lineStart?: number;
  lineEnd?: number;
  symbol?: string;
}

/** A disproven hypothesis or a recurring reviewer false-positive pattern. */
export interface NegativeEvidenceEntry {
  id: string;
  pattern: string;
  status: NegativeEvidenceStatus;
  reason: string;
  /** Repository-relative glob, e.g. `src/case/**`. */
  scope: string;
  verifiedAtCommit: string;
  evidence: NegativeEvidenceReference[];
}

/** Persisted independently from the run definition and mutable run state. */
export interface NegativeEvidenceStore {
  schemaVersion: 1;
  repositoryRoot: string;
  repositoryVersion: string;
  entries: NegativeEvidenceEntry[];
}

export interface NegativeEvidenceInput extends Omit<NegativeEvidenceEntry, 'id' | 'verifiedAtCommit'> {
  id?: string;
}

export interface NegativeEvidenceEvaluation {
  evaluatedAtCommit: string;
  reusable: NegativeEvidenceEntry[];
  invalidated: Array<{ entry: NegativeEvidenceEntry; reason: string }>;
}

const STORE_FILE = 'negative-evidence-v1.json';
const SHA256 = /^[a-f0-9]{64}$/i;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/** Create an empty store associated with a repository and full Git revision. */
export function createNegativeEvidenceStore(options: {
  repositoryRoot: string;
  repositoryVersion: string;
}): NegativeEvidenceStore {
  if (!COMMIT.test(options.repositoryVersion)) throw new Error('repositoryVersion must be a full Git commit hash');
  return {
    schemaVersion: 1,
    repositoryRoot: path.resolve(options.repositoryRoot),
    repositoryVersion: options.repositoryVersion,
    entries: [],
  };
}

/** Add an evidence-backed record at the store's current repository version. */
export function recordNegativeEvidence(
  store: NegativeEvidenceStore,
  input: NegativeEvidenceInput,
): NegativeEvidenceEntry {
  validateNegativeEvidenceStore(store);
  const id = input.id?.trim() || `negative:v1:${sha256(`${input.status}\n${input.pattern}\n${input.scope}\n${store.repositoryVersion}`)}`;
  const entry: NegativeEvidenceEntry = {
    ...input,
    id,
    verifiedAtCommit: store.repositoryVersion,
  };
  validateEntry(entry);
  if (store.entries.some((existing) => existing.id === entry.id)) {
    throw new Error(`duplicate negative evidence id: ${entry.id}`);
  }
  store.entries.push(entry);
  return entry;
}

/** Persist beside this run without changing the public run or state formats. */
export function saveNegativeEvidence(runFile: string, store: NegativeEvidenceStore): string {
  validateNegativeEvidenceStore(store);
  const file = path.join(runPaths(runFile).factory, STORE_FILE);
  atomicWriteJson(file, store);
  return file;
}

/** Load only a supported, evidence-valid artifact. */
export function loadNegativeEvidence(runFile: string): NegativeEvidenceStore | null {
  const file = path.join(runPaths(runFile).factory, STORE_FILE);
  const raw = readJsonFileWithBackup<unknown>(file);
  if (raw === null) return null;
  validateNegativeEvidenceStore(raw);
  return raw;
}

/**
 * Reuse a record only when no changed file matches its declared scope and all
 * source files still match the hashes that supported its assumptions.
 */
export function evaluateNegativeEvidence(
  store: NegativeEvidenceStore,
  currentCommit: string,
  changedPaths: readonly string[],
  options: { repositoryRoot?: string } = {},
): NegativeEvidenceEvaluation {
  validateNegativeEvidenceStore(store);
  if (!COMMIT.test(currentCommit)) throw new Error('currentCommit must be a full Git commit hash');
  const root = path.resolve(options.repositoryRoot ?? store.repositoryRoot);
  const changed = changedPaths.map(normalizeRepoPath);
  const reusable: NegativeEvidenceEntry[] = [];
  const invalidated: NegativeEvidenceEvaluation['invalidated'] = [];
  for (const entry of store.entries) {
    const scopedChange = changed.find((file) => matchesGlob(file, entry.scope));
    if (scopedChange) {
      invalidated.push({ entry, reason: `scoped source changed since ${entry.verifiedAtCommit}: ${scopedChange}` });
      continue;
    }
    const reason = evidenceInvalidationReason(entry, root);
    if (reason) invalidated.push({ entry, reason });
    else reusable.push(entry);
  }
  return { evaluatedAtCommit: currentCommit, reusable, invalidated };
}

/** Validate imported or persisted evidence before it can influence review. */
export function validateNegativeEvidenceStore(value: unknown): asserts value is NegativeEvidenceStore {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('unsupported negative evidence schema: expected schemaVersion 1');
  }
  if (typeof value.repositoryRoot !== 'string' || !value.repositoryRoot.trim() ||
      typeof value.repositoryVersion !== 'string' || !COMMIT.test(value.repositoryVersion) ||
      !Array.isArray(value.entries)) {
    throw new Error('invalid negative evidence store header');
  }
  const ids = new Set<string>();
  for (const entry of value.entries) {
    validateEntry(entry);
    if (ids.has(entry.id)) throw new Error(`duplicate negative evidence id: ${entry.id}`);
    ids.add(entry.id);
    if (entry.verifiedAtCommit !== value.repositoryVersion && !COMMIT.test(entry.verifiedAtCommit)) {
      throw new Error(`invalid repository version for negative evidence ${entry.id}`);
    }
  }
}

function validateEntry(value: unknown): asserts value is NegativeEvidenceEntry {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() ||
      typeof value.pattern !== 'string' || !value.pattern.trim() ||
      (value.status !== 'disproven' && value.status !== 'known-non-issue') ||
      typeof value.reason !== 'string' || !value.reason.trim() ||
      typeof value.scope !== 'string' || !validRepoPath(value.scope) ||
      typeof value.verifiedAtCommit !== 'string' || !COMMIT.test(value.verifiedAtCommit) ||
      !Array.isArray(value.evidence) || value.evidence.length === 0) {
    throw new Error('invalid negative evidence entry: pattern, reason, scope, version, and evidence are required');
  }
  for (const evidence of value.evidence) {
    if (!isRecord(evidence) || typeof evidence.assumption !== 'string' || !evidence.assumption.trim() ||
        typeof evidence.path !== 'string' || !validRepoPath(evidence.path) ||
        typeof evidence.sha256 !== 'string' || !SHA256.test(evidence.sha256) ||
        evidence.sourceCommit !== value.verifiedAtCommit ||
        (evidence.lineStart !== undefined && (!Number.isInteger(evidence.lineStart) || evidence.lineStart < 1)) ||
        (evidence.lineEnd !== undefined && (!Number.isInteger(evidence.lineEnd) || evidence.lineEnd < (evidence.lineStart ?? 1))) ||
        (evidence.symbol !== undefined && (typeof evidence.symbol !== 'string' || !evidence.symbol.trim()))) {
      throw new Error(`invalid evidence for negative evidence entry ${value.id}`);
    }
  }
}

function evidenceInvalidationReason(entry: NegativeEvidenceEntry, root: string): string | null {
  for (const evidence of entry.evidence) {
    const absolute = path.resolve(root, evidence.path);
    if (!isWithin(root, absolute)) return `evidence path escapes repository: ${evidence.path}`;
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch {
      return `assumption evidence is unavailable: ${evidence.path}`;
    }
    if (sha256(bytes) !== evidence.sha256) return `assumption evidence changed: ${evidence.path}`;
  }
  return null;
}

function validRepoPath(value: string): boolean {
  const normalized = normalizeRepoPath(value);
  return value.trim().length > 0 && normalized === value.replace(/\\/g, '/') &&
    !path.posix.isAbsolute(normalized) && normalized !== '..' && !normalized.startsWith('../');
}

function normalizeRepoPath(value: string): string {
  return path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '');
}

function matchesGlob(file: string, glob: string): boolean {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      index += 1;
      if (glob[index + 1] === '/') {
        index += 1;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(file);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
