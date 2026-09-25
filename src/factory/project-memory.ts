/** Versioned, evidence-backed subsystem memory stored in the existing run sidecar. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { atomicWriteJson, readJsonFileWithBackup, runPaths } from '../store.js';

export type MemoryValue = string | number | boolean | null | MemoryValue[] | { [key: string]: MemoryValue };

export interface MemoryEvidence {
  /** Repository-relative file path used to support this claim. */
  path: string;
  /** SHA-256 of the exact file bytes at reviewedAtCommit. */
  sha256: string;
  sourceCommit: string;
  lineStart?: number;
  lineEnd?: number;
  symbol?: string;
}

export interface EvidenceBackedFact {
  id: string;
  value: MemoryValue;
  evidence: MemoryEvidence[];
}

/** Fields mirror SPEC 14, with each claim carrying auditable source evidence. */
export interface SubsystemMemory {
  component: string;
  entry_points: EvidenceBackedFact[];
  critical_paths: EvidenceBackedFact[];
  contracts: EvidenceBackedFact[];
  known_invariants: EvidenceBackedFact[];
  risk_profile: Record<string, EvidenceBackedFact>;
  historic_findings: EvidenceBackedFact[];
  historic_root_causes: EvidenceBackedFact[];
  false_positive_patterns: EvidenceBackedFact[];
  reviewed_at_commit: string;
  architecture_hash: string;
}

export interface ProjectMemory {
  schemaVersion: 1;
  runId: string;
  repositoryRoot: string;
  reviewedAtCommit: string;
  subsystems: Record<string, SubsystemMemory>;
}

export type SubsystemMemoryInput = Omit<SubsystemMemory, 'reviewed_at_commit' | 'architecture_hash'>;

export interface ProjectMemoryResume {
  reviewedAtCommit: string;
  currentCommit: string;
  changesSince: string[];
  /** Claims with unchanged evidence, ready to seed the next run's context. */
  knownArchitecture: SubsystemMemory[];
  invalidatedFacts: Array<{ component: string; section: string; factId: string; reason: string }>;
}

const MEMORY_FILE = 'project-memory-v1.json';
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const ARCHITECTURE_SECTIONS = ['entry_points', 'critical_paths', 'contracts', 'known_invariants', 'risk_profile'] as const;
const ALL_SECTIONS = [...ARCHITECTURE_SECTIONS, 'historic_findings', 'historic_root_causes', 'false_positive_patterns'] as const;

/** Construct schema-v1 memory and derive stable architecture hashes. */
export function createProjectMemory(options: {
  runId: string;
  repositoryRoot: string;
  reviewedAtCommit: string;
  subsystems: SubsystemMemoryInput[];
}): ProjectMemory {
  if (!options.runId.trim()) throw new Error('project memory requires a runId');
  if (!COMMIT.test(options.reviewedAtCommit)) throw new Error('reviewedAtCommit must be a full Git commit hash');
  const subsystems: Record<string, SubsystemMemory> = {};
  for (const input of options.subsystems) {
    if (!input.component.trim()) throw new Error('subsystem component cannot be empty');
    if (subsystems[input.component]) throw new Error(`duplicate subsystem: ${input.component}`);
    const subsystem: SubsystemMemory = {
      ...input,
      reviewed_at_commit: options.reviewedAtCommit,
      architecture_hash: '',
    };
    validateSubsystem(subsystem, options.reviewedAtCommit);
    subsystem.architecture_hash = architectureHash(subsystem);
    subsystems[input.component] = subsystem;
  }
  return {
    schemaVersion: 1,
    runId: options.runId,
    repositoryRoot: path.resolve(options.repositoryRoot),
    reviewedAtCommit: options.reviewedAtCommit,
    subsystems,
  };
}

/** Persist beside this run without changing the public run or state formats. */
export function saveProjectMemory(runFile: string, memory: ProjectMemory): string {
  validateProjectMemory(memory);
  const file = path.join(runPaths(runFile).factory, MEMORY_FILE);
  atomicWriteJson(file, memory);
  return file;
}

/** Load only a supported and internally consistent memory artifact. */
export function loadProjectMemory(runFile: string, expectedRunId?: string): ProjectMemory | null {
  const file = path.join(runPaths(runFile).factory, MEMORY_FILE);
  const raw = readJsonFileWithBackup<unknown>(file);
  if (raw === null) return null;
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw new Error(`unsupported project memory schema in ${file}`);
  }
  const memory = raw as unknown as ProjectMemory;
  validateProjectMemory(memory);
  if (expectedRunId !== undefined && memory.runId !== expectedRunId) {
    throw new Error(`project memory belongs to run ${memory.runId}, expected ${expectedRunId}`);
  }
  return memory;
}

/**
 * Return the architecture that remains supported after a repository change.
 * Facts lose validity when any cited source changed; unchanged facts carry on
 * with their original commit and hash as explicit provenance.
 */
export function resumeProjectMemory(
  memory: ProjectMemory,
  currentCommit: string,
  changesSince: string[],
  options: { repositoryRoot?: string } = {},
): ProjectMemoryResume {
  validateProjectMemory(memory);
  if (!COMMIT.test(currentCommit)) throw new Error('currentCommit must be a full Git commit hash');
  const changed = new Set(changesSince.map(normalizeRepoPath));
  const knownArchitecture: SubsystemMemory[] = [];
  const invalidatedFacts: ProjectMemoryResume['invalidatedFacts'] = [];
  const root = options.repositoryRoot ?? memory.repositoryRoot;

  for (const original of Object.values(memory.subsystems)) {
    const retained = { ...original, risk_profile: { ...original.risk_profile } };
    for (const section of ALL_SECTIONS) {
      if (section === 'risk_profile') {
        for (const [key, fact] of Object.entries(retained.risk_profile)) {
          const reason = invalidationReason(fact, changed, root);
          if (reason) {
            invalidatedFacts.push({ component: original.component, section: `${section}.${key}`, factId: fact.id, reason });
            delete retained.risk_profile[key];
          }
        }
      } else {
        const facts = retained[section] as EvidenceBackedFact[];
        retained[section] = facts.filter((fact) => {
          const reason = invalidationReason(fact, changed, root);
          if (reason) {
            invalidatedFacts.push({ component: original.component, section, factId: fact.id, reason });
            return false;
          }
          return true;
        }) as never;
      }
    }
    retained.architecture_hash = architectureHash(retained);
    knownArchitecture.push(retained);
  }
  return {
    reviewedAtCommit: memory.reviewedAtCommit,
    currentCommit,
    changesSince: [...changed].sort(),
    knownArchitecture,
    invalidatedFacts,
  };
}

/** Get changed paths from the saved commit through a target commit and its working tree. */
export function gitChangesSince(repositoryRoot: string, reviewedAtCommit: string, currentCommit = 'HEAD'): string[] {
  if (!COMMIT.test(reviewedAtCommit)) throw new Error('reviewedAtCommit must be a full Git commit hash');
  const changed = new Set<string>();
  const committed = runGit(repositoryRoot, ['diff', '--name-only', '--diff-filter=ACDMRTUXB', `${reviewedAtCommit}..${currentCommit}`], 'git diff');
  const working = runGit(repositoryRoot, ['diff', '--name-only', '--diff-filter=ACDMRTUXB', currentCommit], 'git diff');
  const untracked = runGit(repositoryRoot, ['ls-files', '--others', '--exclude-standard'], 'git ls-files');
  for (const name of [...committed, ...working, ...untracked]) if (name) changed.add(normalizeRepoPath(name));
  return [...changed].sort();
}

function runGit(cwd: string, args: string[], operation: string): string[] {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`could not read repository changes: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${operation} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function invalidationReason(fact: EvidenceBackedFact, changed: Set<string>, root: string): string | null {
  for (const evidence of fact.evidence) {
    const evidencePath = normalizeRepoPath(evidence.path);
    if (changed.has(evidencePath)) return `source changed since ${evidence.sourceCommit}`;
    const absolute = path.resolve(root, evidencePath);
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch {
      return `evidence source is unavailable: ${evidencePath}`;
    }
    if (sha256(bytes) !== evidence.sha256) return `source hash changed: ${evidencePath}`;
  }
  return null;
}

function validateProjectMemory(memory: ProjectMemory): void {
  if (memory.schemaVersion !== 1) throw new Error(`unsupported project memory schema version: ${String(memory.schemaVersion)}`);
  if (!memory.runId || !memory.repositoryRoot || !COMMIT.test(memory.reviewedAtCommit) || !isRecord(memory.subsystems)) {
    throw new Error('invalid project memory header');
  }
  for (const [key, subsystem] of Object.entries(memory.subsystems)) {
    validateSubsystem(subsystem, memory.reviewedAtCommit);
    if (key !== subsystem.component) throw new Error(`subsystem key does not match component: ${key}`);
    if (subsystem.architecture_hash !== architectureHash(subsystem)) {
      throw new Error(`architecture hash mismatch for subsystem ${key}`);
    }
  }
}

function validateSubsystem(subsystem: SubsystemMemory, reviewedAtCommit: string): void {
  if (!subsystem.component || subsystem.reviewed_at_commit !== reviewedAtCommit) {
    throw new Error(`invalid commit or component for subsystem ${subsystem.component || '(empty)'}`);
  }
  for (const section of ALL_SECTIONS) {
    const facts = section === 'risk_profile' ? Object.values(subsystem.risk_profile) : subsystem[section] as EvidenceBackedFact[];
    if (!Array.isArray(facts)) throw new Error(`subsystem ${subsystem.component} has invalid ${section}`);
    for (const fact of facts) {
      if (!fact.id || !Array.isArray(fact.evidence) || fact.evidence.length === 0) {
        throw new Error(`fact in ${subsystem.component}.${section} must include evidence`);
      }
      for (const evidence of fact.evidence) {
        const normalizedPath = normalizeRepoPath(evidence.path);
        if (!evidence.path || normalizedPath !== evidence.path.replace(/\\/g, '/') ||
            path.posix.isAbsolute(normalizedPath) || normalizedPath === '..' || normalizedPath.startsWith('../') ||
            !SHA256.test(evidence.sha256) || evidence.sourceCommit !== reviewedAtCommit) {
          throw new Error(`invalid evidence for fact ${fact.id} in ${subsystem.component}.${section}`);
        }
        if ((evidence.lineStart !== undefined && (!Number.isInteger(evidence.lineStart) || evidence.lineStart < 1)) ||
            (evidence.lineEnd !== undefined && (!Number.isInteger(evidence.lineEnd) || evidence.lineEnd < (evidence.lineStart ?? 1)))) {
          throw new Error(`invalid evidence line range for fact ${fact.id}`);
        }
      }
    }
  }
}

function architectureHash(subsystem: SubsystemMemory): string {
  const architecture = Object.fromEntries(ARCHITECTURE_SECTIONS.map((section) => [section,
    section === 'risk_profile'
      ? Object.fromEntries(Object.entries(subsystem.risk_profile).sort(([a], [b]) => a.localeCompare(b)))
      : subsystem[section],
  ]));
  return sha256(stableJson(architecture));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizeRepoPath(value: string): string {
  return path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '');
}

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
