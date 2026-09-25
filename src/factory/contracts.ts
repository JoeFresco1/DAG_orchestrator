/** Stable namespaces shared by the factory's four linked domain graphs. */
export type FactoryEntityKind = 'requirement' | 'code' | 'execution' | 'defect';

/**
 * Versioned, deterministic identifier. The suffix is an opaque stable key,
 * scoped to the entity kind (for example `requirement:v1:auth.login`).
 */
export type FactoryEntityId = `${FactoryEntityKind}:v1:${string}`;

export type FactoryEvidenceKind =
  | 'spec'
  | 'file'
  | 'task-attempt'
  | 'review'
  | 'command'
  | 'git'
  | 'external';

/** A content-addressed pointer to the source supporting a factory claim. */
export interface FactoryEvidenceRef {
  id: `evidence:v1:${string}`;
  kind: FactoryEvidenceKind;
  /** Stable URI or run-relative path; payloads remain in their owning store. */
  uri: string;
  /** Lowercase SHA-256 of the referenced bytes, without a prefix. */
  sha256: string;
}

/** A versioned domain-graph artifact owned by the run's factory sidecar. */
export interface FactoryArtifactRef {
  /** Path relative to `<run>.d/factory/`. */
  path: string;
  sha256: string;
}

/** Factory-owned index; its schema version evolves independently of Run. */
export interface FactorySidecarManifest {
  schemaVersion: 1;
  runId: string;
  artifacts: FactoryArtifactRef[];
  evidence: FactoryEvidenceRef[];
}

const ENTITY_ID = /^(requirement|code|execution|defect):v1:([A-Za-z0-9][A-Za-z0-9._/-]*)$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Runtime guard for IDs read from sidecars or imported graph artifacts. */
export function isFactoryEntityId(value: unknown): value is FactoryEntityId {
  if (typeof value !== 'string') return false;
  const match = ENTITY_ID.exec(value);
  if (!match) return false;
  const key = match[2];
  return key !== undefined && !key.split('/').some((part) => part === '.' || part === '..');
}

/** Runtime guard for persisted evidence references; does not fetch the URI. */
export function isFactoryEvidenceRef(value: unknown): value is FactoryEvidenceRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Partial<FactoryEvidenceRef>;
  return (
    typeof ref.id === 'string' &&
    /^evidence:v1:[a-f0-9]{64}$/.test(ref.id) &&
    typeof ref.kind === 'string' &&
    ['spec', 'file', 'task-attempt', 'review', 'command', 'git', 'external'].includes(ref.kind) &&
    typeof ref.uri === 'string' &&
    ref.uri.length > 0 &&
    typeof ref.sha256 === 'string' &&
    SHA256.test(ref.sha256) &&
    ref.id === `evidence:v1:${ref.sha256}`
  );
}
