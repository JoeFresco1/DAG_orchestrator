import type { SettingsProblem } from '../types.js';

export const PHASES = ['setup', 'work', 'verify', 'repair', 'land', 'resolve', 'checkpoint', 'integration', 'advisory'] as const;
export type Phase = typeof PHASES[number];
export const PHASE_TIMEOUTS: Record<Phase, number> = {
  setup: 300_000, work: 900_000, verify: 30_000, repair: 300_000, land: 120_000, resolve: 120_000,
  checkpoint: 180_000, integration: 900_000, advisory: 30_000,
};

export interface NodeBrief {
  goal: string;
  touches: string[];
  creates: string[];
  /** File names, symbols, or signatures supplied by declared prerequisites. */
  relies_on: string[];
  verify: string;
  /** Producers needed by this node's check; admission adds acyclic prerequisite edges. */
  verify_requires?: string[];
  /** Runner-authored checkpoint repair identity, retained across explicit retry. */
  repair_of?: string;
}
export interface FlowNode extends NodeBrief {
  id: string;
  depends_on: string[];
  cmd?: string;
}
export interface FlowSettings {
  phaseTimeouts?: Partial<Record<Phase, number>>;
  idleTimeoutMs?: number;
  cachePaths?: string[];
  waveChecks?: string[];
  finalChecks?: string[];
  /** Retained v2 acceptance checks, appended to the normal full integration suite. */
  additionalFinalChecks?: string[];
  /** These are worker commands with {spec}; advisory output never gates execution. */
  advisoryCommand?: string;
  repairCommand?: string;
  conflictCommand?: string;
  repairRounds?: number;
  /** In-place verification repairs per node, independent of implementation attempts. Default 1. */
  nodeRepairRounds?: number;
  /** Commands may wait for these producer IDs without consuming a repair round. */
  checkPrerequisites?: Record<string, string[]>;
  /** Additional immutable acceptance/configuration paths during agent repair. */
  repairProtectedPaths?: string[];
}
export interface FlowPlan {
  version: 3;
  title: string;
  nodes: FlowNode[];
  settings?: FlowSettings;
  cmd?: string;
}
export interface Candidate {
  commit: string;
  base: string;
  attempt: number;
  definition: string;
}
export interface NodeState {
  candidate?: Candidate;
  worker?: string;
  session?: string;
  repairAttempts?: number;
  repairFailures?: string[];
  decision?: RepairDecision;
  /** Identifies a checkpoint repair whose whole work phase needs scope enforcement. */
  repairCheckpoint?: string;
}
export interface RepairDecision {
  action: 'repair' | 'defer' | 'hold';
  category: 'implementation' | 'dependency' | 'environment' | 'policy' | 'unknown' | 'no-progress';
  reason: string;
  requires?: string[];
  fingerprint: string;
}
export interface CheckResult {
  command: string;
  passed: boolean;
  output: string;
  decision?: RepairDecision;
}
export interface Checkpoint {
  id: string;
  kind: 'wave' | 'final';
  head: string;
  nodes: string[];
  results: CheckResult[];
  passed: boolean;
}
export interface FlowState {
  version: 3;
  repairRound: number;
  checkpoints: Checkpoint[];
  advisory?: { status: 'started' | 'finished' | 'warning'; output?: string };
  issues: string[];
  repairFailures?: string[];
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function safeRelativePath(v: unknown): v is string {
  return typeof v === 'string' && !!v && !/^[A-Za-z]:|^[\\/]|[\0\r\n]/.test(v) &&
    !v.replaceAll('\\', '/').split('/').some(p => !p || p === '..' || p === '.git');
}
export function validateFlowSettings(value: unknown): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  const fail = (field: string, reason: string) => problems.push({ field: `flow3.${field}`, reason });
  if (!record(value)) return [{ field: 'flow3', reason: 'must be an object' }];
  const allowed = new Set(['phaseTimeouts', 'idleTimeoutMs', 'cachePaths', 'waveChecks', 'finalChecks', 'additionalFinalChecks', 'advisoryCommand', 'repairCommand', 'conflictCommand', 'repairRounds', 'nodeRepairRounds', 'checkPrerequisites', 'repairProtectedPaths']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(key, 'unknown setting');
  if (value.phaseTimeouts !== undefined) {
    if (!record(value.phaseTimeouts)) fail('phaseTimeouts', 'must be an object');
    else for (const [phase, ms] of Object.entries(value.phaseTimeouts)) {
      const max = phase === 'verify' ? 60_000 : phase === 'advisory' ? 60_000 : 86_400_000;
      if (!PHASES.includes(phase as Phase) || !Number.isSafeInteger(ms) || Number(ms) < 1 || Number(ms) > max) {
        fail(`phaseTimeouts.${phase}`, `must name a phase and be between 1 and ${max} milliseconds`);
      }
    }
  }
  if (value.idleTimeoutMs !== undefined && (!Number.isSafeInteger(value.idleTimeoutMs) || Number(value.idleTimeoutMs) < 1 || Number(value.idleTimeoutMs) > 86_400_000)) fail('idleTimeoutMs', 'must be 1..86400000');
  if (value.repairRounds !== undefined && (!Number.isInteger(value.repairRounds) || Number(value.repairRounds) < 0 || Number(value.repairRounds) > 2)) fail('repairRounds', 'must be 0..2');
  if (value.nodeRepairRounds !== undefined && (!Number.isInteger(value.nodeRepairRounds) || Number(value.nodeRepairRounds) < 0 || Number(value.nodeRepairRounds) > 2)) fail('nodeRepairRounds', 'must be 0..2');
  if (value.repairProtectedPaths !== undefined && (!Array.isArray(value.repairProtectedPaths) || !value.repairProtectedPaths.every(safeRelativePath))) fail('repairProtectedPaths', 'must contain repository relative paths');
  if (value.checkPrerequisites !== undefined) {
    if (!record(value.checkPrerequisites)) fail('checkPrerequisites', 'must map check commands to producer ID arrays');
    else for (const [command, ids] of Object.entries(value.checkPrerequisites)) {
      if (!command.trim() || /[\0\r\n]/.test(command) || !Array.isArray(ids) || !ids.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))) fail('checkPrerequisites', 'must map check commands to producer ID arrays');
    }
  }
  for (const key of ['waveChecks', 'finalChecks', 'additionalFinalChecks'] as const) if (value[key] !== undefined &&
    (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(v => typeof v === 'string' && !!v.trim() && !v.includes('\0')))) fail(key, 'must be an array of commands');
  if (value.cachePaths !== undefined && (!Array.isArray(value.cachePaths) || !(value.cachePaths as unknown[]).every(safeRelativePath))) fail('cachePaths', 'must contain repository relative paths');
  for (const key of ['advisoryCommand', 'repairCommand', 'conflictCommand']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !(value[key] as string).trim() || (value[key] as string).includes('\0'))) fail(key, 'must be a nonempty command');
  return problems;
}
