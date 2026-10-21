import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquirePathLock, atomicWriteJson, loadRun, runPaths } from './store.js';
import { digest } from './planning/contracts.js';
import type { Run } from './types.js';

export interface FollowupProposal {
  id: string; message: string; evidence: string[]; references: string[];
  requirements?: string[]; suggestedOwner?: string; acceptance?: string; blocking?: boolean;
}
export interface FollowupOrigin { taskId?: string; attempt?: number; stage: string; source?: string }
export interface FollowupDecision {
  disposition: 'blocker' | 'existing-task' | 'follow-up' | 'dismissed';
  reason: string; owner?: string; acceptance?: string; duplicateOf?: string;
}
export interface Followup {
  id: string; proposal: FollowupProposal; candidateOwners: string[];
  occurrences: { key: string; at: string; origin: FollowupOrigin; revision?: string; proposal: FollowupProposal }[];
  decisions: (FollowupDecision & { at: string })[];
}
interface Ledger { version: 1; runId: string; items: Followup[] }
/** Native CLIs may print the same final response twice. Advisory prose is evidence, never an authoritative link. */
export function workerFollowupProposals(output: string, run: Run): FollowupProposal[] {
  const packets = output.split(/\r?\n/).filter(line => line.startsWith('DAG_FOLLOW_UPS:'))
    .map(line => JSON.parse(line.slice('DAG_FOLLOW_UPS:'.length)) as FollowupProposal[]);
  if (!packets.length) return [];
  const unique = new Map(packets.map(packet => [digest(packet), packet]));
  if (unique.size !== 1) throw Error('Conflicting worker discovery packets');
  const proposals = [...unique.values()][0]!;
  if (!Array.isArray(proposals)) throw Error('Follow-up packet must be an array');
  return proposals.map(proposal => {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) || !Array.isArray(proposal.evidence)) return proposal;
    const normalized = { ...proposal, evidence: [...proposal.evidence] };
    const unresolved: { suggestedOwner?: string; requirements?: string[] } = {};
    if (typeof proposal.suggestedOwner === 'string' && proposal.suggestedOwner.trim() && !run.tasks[proposal.suggestedOwner]) {
      unresolved.suggestedOwner = proposal.suggestedOwner; delete normalized.suggestedOwner;
    }
    if (Array.isArray(proposal.requirements) && proposal.requirements.every(id => typeof id === 'string' && Boolean(id.trim()))) {
      const known = new Set(run.planning?.manifest.requirements.map(req => req.id));
      unresolved.requirements = proposal.requirements.filter(id => !known.has(id));
      normalized.requirements = proposal.requirements.filter(id => known.has(id));
      if (!unresolved.requirements.length) delete unresolved.requirements;
    }
    if (Object.keys(unresolved).length) normalized.evidence.push(`Unresolved worker linkage hints (coordinator triage required): ${JSON.stringify(unresolved)}`);
    return normalized;
  });
}
const ledgerPath = (file: string) => join(runPaths(file).dir, 'followups.json');
function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw Error(`Follow-up ${label} must be nonempty text`);
}
function strings(value: unknown, label: string, required = false): asserts value is string[] {
  if (!Array.isArray(value) || (required && !value.length)) throw Error(`Follow-up ${label} must be ${required ? 'a nonempty' : 'an'} array`);
  value.forEach(item => nonempty(item, label));
}
function owner(run: Run, value: string | undefined): void {
  if (value !== undefined && !run.tasks[value]) throw Error(`Unknown follow-up owner: ${value}`);
}
function validate(run: Run, proposal: FollowupProposal): void {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw Error('Invalid follow-up proposal');
  nonempty(proposal.id, 'id'); nonempty(proposal.message, 'message');
  if (proposal.id.length > 128) throw Error('Follow-up id exceeds 128 characters');
  strings(proposal.evidence, 'evidence', true); strings(proposal.references, 'references', true);
  if (proposal.blocking !== undefined && typeof proposal.blocking !== 'boolean') throw Error('Follow-up blocking must be boolean');
  if (proposal.acceptance !== undefined) nonempty(proposal.acceptance, 'acceptance');
  owner(run, proposal.suggestedOwner);
  if (proposal.requirements !== undefined) {
    strings(proposal.requirements, 'requirements');
    for (const id of proposal.requirements) if (!run.planning?.manifest.requirements.some(req => req.id === id)) throw Error(`Unknown follow-up requirement: ${id}`);
  }
}
function read(file: string, run: Run): Ledger {
  const path = ledgerPath(file);
  if (!existsSync(path)) return { version: 1, runId: run.id, items: [] };
  const ledger = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  if (ledger.version !== 1 || ledger.runId !== run.id || !Array.isArray(ledger.items) || ledger.items.some(item =>
    !item || typeof item.id !== 'string' || !item.proposal || !Array.isArray(item.occurrences) || !Array.isArray(item.decisions))) {
    throw Error('Invalid follow-up ledger or run identity');
  }
  return ledger;
}
export function listFollowups(file: string): Followup[] { return read(file, loadRun(file)).items; }

/** Findings are observations, never scheduler instructions. Validate a packet before writing any of it. */
export function proposeFollowups(file: string, proposals: FollowupProposal[], origin: FollowupOrigin, snapshot?: Run): Followup[] {
  const run = snapshot ?? loadRun(file);
  nonempty(origin.stage, 'origin stage'); owner(run, origin.taskId);
  if (origin.source !== undefined) nonempty(origin.source, 'origin source');
  if (origin.attempt !== undefined && (!Number.isInteger(origin.attempt) || origin.attempt < 0)) throw Error('Invalid follow-up attempt');
  if (!Array.isArray(proposals)) throw Error('Follow-up packet must be an array');
  const ids = new Set<string>();
  for (const proposal of proposals) {
    validate(run, proposal);
    if (ids.has(proposal.id)) throw Error(`Duplicate follow-up id in packet: ${proposal.id}`);
    ids.add(proposal.id);
  }
  const release = acquirePathLock(`${ledgerPath(file)}.lock`, 'follow-up capture');
  try {
    const ledger = read(file, run);
    const results = proposals.map(proposal => {
      // Scope identity to requirements and references, not wording, attempt or reporter.
      const id = `followup_${digest({ id: proposal.id, references: [...new Set(proposal.references)].sort(),
        requirements: [...new Set(proposal.requirements ?? [])].sort() }).slice(0, 20)}`;
      let record = ledger.items.find(item => item.id === id);
      if (!record) {
        record = { id, proposal, candidateOwners: [], occurrences: [], decisions: [] };
        ledger.items.push(record);
      }
      const candidates = new Set(record.candidateOwners);
      if (proposal.suggestedOwner) candidates.add(proposal.suggestedOwner);
      for (const ref of proposal.references) {
        if (run.tasks[ref]) candidates.add(ref);
        const path = ref.replace(/:\d+(?::\d+)?$/, '').replace(/\\/g, '/');
        for (const task of run.planning?.manifest.tasks ?? []) if (
          task.provides?.some(cap => cap.id === ref || cap.check.id === ref) || task.checks.some(check => check.id === ref) ||
          task.files?.some(file => file.path.replace(/\\/g, '/') === path)
        ) candidates.add(task.id);
        for (const criterion of run.planning?.manifest.criteria ?? []) if (criterion.id === ref ||
          (criterion.requirement && proposal.requirements?.includes(criterion.requirement))) candidates.add(criterion.owner);
      }
      record.candidateOwners = [...candidates].sort();
      const key = digest({ origin, proposal });
      if (!record.occurrences.some(occurrence => occurrence.key === key)) record.occurrences.push({
        key, at: new Date().toISOString(), origin, revision: run.planning?.revision, proposal,
      });
      return record;
    });
    atomicWriteJson(ledgerPath(file), ledger);
    return results;
  } finally { release(); }
}

/** Coordinator decisions retain history; graph admission remains an explicit planning amendment. */
export function triageFollowup(file: string, id: string, decision: FollowupDecision): Followup {
  const run = loadRun(file);
  nonempty(decision.reason, 'decision reason'); owner(run, decision.owner);
  if (!['blocker', 'existing-task', 'follow-up', 'dismissed'].includes(decision.disposition)) throw Error('Invalid follow-up disposition');
  if (['blocker', 'existing-task'].includes(decision.disposition) && !decision.owner) throw Error('Follow-up disposition requires an existing owner');
  const release = acquirePathLock(`${ledgerPath(file)}.lock`, 'follow-up triage');
  try {
    const ledger = read(file, run), record = ledger.items.find(item => item.id === id);
    if (!record) throw Error(`Unknown follow-up: ${id}`);
    const acceptance = decision.acceptance ?? record.proposal.acceptance;
    if (decision.disposition === 'follow-up') nonempty(acceptance, 'acceptance');
    if (decision.acceptance !== undefined) nonempty(decision.acceptance, 'acceptance');
    if (decision.duplicateOf !== undefined) {
      let target = ledger.items.find(item => item.id === decision.duplicateOf);
      const visited = new Set([id]);
      if (!target) throw Error('Unknown duplicate follow-up');
      while (target) {
        if (visited.has(target.id)) throw Error('Follow-up duplicate cycle');
        visited.add(target.id);
        const next: string | undefined = target.decisions.at(-1)?.duplicateOf;
        target = next ? ledger.items.find(item => item.id === next) : undefined;
      }
    }
    record.decisions.push({ ...decision, acceptance, at: new Date().toISOString() });
    atomicWriteJson(ledgerPath(file), ledger);
    return record;
  } finally { release(); }
}
