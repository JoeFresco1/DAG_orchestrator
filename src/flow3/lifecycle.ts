import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../types.js';
import type { ExecOutcome } from '../runner.js';
import type { AcceptanceIdentity, CompletionScope, FlowSettings } from './contracts.js';

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Unclassified nodes stay required for whole-product completion. Explicit selections declare a new scoped target. */
export function completionScope(run: Run, selected: Set<string>, explicitSelection: boolean): CompletionScope {
  const configured = run.settings.flow3?.completion;
  const optional = configured?.optional ?? run.flowState?.completion?.optional ?? [];
  const all = Object.keys(run.tasks).filter(id => !run.tasks[id].node?.repair_of);
  const mode = explicitSelection ? 'scoped' : run.flowState?.completion?.mode ?? configured?.mode ?? 'whole-product';
  const required = new Set(mode === 'whole-product' ? all.filter(id => !optional.includes(id)) : explicitSelection ? [...selected].filter(id => !optional.includes(id)) : configured?.required ?? [...selected].filter(id => !optional.includes(id)));
  if (!explicitSelection) for (const id of [...(configured?.required ?? []), ...(run.flowState?.completion?.required ?? [])]) required.add(id);
  const visit = (id: string) => {
    if (!run.tasks[id]) throw Error(`Unknown completion task ${id}`);
    for (const dep of [...run.tasks[id].deps, ...(run.tasks[id].node?.verify_requires ?? [])]) if (!required.has(dep)) { required.add(dep); visit(dep); }
  };
  for (const id of required) visit(id);
  for (const id of optional) if (!run.tasks[id]) throw Error(`Unknown optional task ${id}`);
  return { mode, required: [...required], optional: optional.filter(id => !required.has(id)), excluded: all.filter(id => !selected.has(id) && !required.has(id)) };
}

function inputIdentity(root: string, path: string, ancestors = new Set<string>()): unknown {
  const file = join(root, path);
  if (!existsSync(file)) return [path, '(missing)'];
  const link = lstatSync(file).isSymbolicLink() ? readlinkSync(file) : undefined;
  const stat = statSync(file), real = realpathSync(file);
  if (ancestors.has(real)) return [path, link, '(cycle)'];
  if (stat.isDirectory()) {
    const visited = new Set(ancestors); visited.add(real);
    return [path, link, readdirSync(file).sort().map(name => inputIdentity(root, `${path}/${name}`, visited))];
  }
  return [path, link, createHash('sha256').update(readFileSync(file)).digest('hex')];
}

export function acceptanceIdentity(run: Run, settings: FlowSettings, root: string, source: string, commands: string[]): AcceptanceIdentity {
  const value = {
    source,
    requirements: digest({ objective: run.objective, manifest: run.planning?.manifest, completion: run.flowState?.completion,
      nodes: Object.values(run.tasks).filter(t => !t.node?.repair_of).map(t => ({ id: t.id, node: t.node, deps: t.deps, spec: t.spec, cmd: t.cmd, harnessChain: t.harnessChain, reviewers: t.reviewers, reviewCmd: t.reviewCmd })) }),
    checks: digest({ commands, settings, review: [run.settings.finalReview, run.settings.finalReviewCmd, run.settings.finalReviewRounds],
      execution: { harnessChain: run.settings.harnessChain, silenceMs: run.settings.silenceMs, reviewVerdict: run.settings.reviewVerdict } }),
    inputs: digest((settings.acceptanceInputs ?? []).map(path => inputIdentity(root, path))),
    environment: digest({ identity: settings.environmentIdentity, platform: process.platform, arch: process.arch, node: process.version,
      prepare: run.settings.worktreePrepareCmd }),
  };
  return { ...value, digest: digest(value) };
}

/** Exit zero alone cannot override missing, empty or inconclusive execution evidence. */
export function evidenceFailure(command: string, result: ExecOutcome, settings: FlowSettings, root: string, started?: number, expandedCommand = command): string | undefined {
  if (result.exitCode !== 0) return `Check exited ${result.exitCode ?? 'without an exit code'}`;
  const output = result.output.replace(/\u001b\[[0-9;]*m/g, '');
  // Test names and captured fixtures describe behavior; they are not execution outcomes.
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(line => line &&
    !/^(?:# Subtest:|ok \d+\b|[\u2714\u2713\u2716\u00d7]|[\u2502\u251c\u2514])/u.test(line));
  const diagnostics = lines.join('\n');
  const testCommand = /\b(?:pytest|vitest|jest|mocha)\b|\bnode\b.*--test|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(expandedCommand);
  if (lines.some(line => /^not ok \d+\b/i.test(line)) || lines.some(line => /^# fail [1-9]\d*\b/i.test(line)) || testCommand && lines.some(line => /^(?:(?:Tests?|Test Suites):?\s*)?[1-9]\d* (?:failing|failed)\b/i.test(line) || /^=+.*\b[1-9]\d* failed\b/i.test(line))) return 'Check reported failed tests despite a zero exit code';
  if (lines.some(line => /^(?:(?:Tests?|Test Suites):?\s*)?0 (?:passing|passed)\b/i.test(line))) return 'Zero executed passing tests; acceptance is inconclusive';
  if (/^# pass 0\b/im.test(diagnostics) && /^# fail 0\b/im.test(diagnostics)) return 'Zero executed passing or failing tests; skipped/todo checks do not establish acceptance';
  if (lines.some(line => /^(?:(?:result|outcome|status|DAG_CHECK_OUTCOME)\s*:\s*)?(?:inconclusive|cancelled|canceled|interrupted|missing required evidence)\b/i.test(line) ||
    /^(?:#\s*)?(?:no (?:tests?|test files?) (?:(?:were|was) )?(?:found|collected|ran|executed)|0 tests?\b|tests?\s*[:=]?\s*0\b)/i.test(line) && !/\b0 (?:failed|skipped)\b/i.test(line) ||
    /^(?:Tests?|Test Files):?.*\b0 total\b/i.test(line) ||
    /^=+\s*no tests? (?:ran|collected)\b/i.test(line) ||
    /^# (?:cancelled|canceled) [1-9]\d*\b/i.test(line))) return 'Check did not establish conclusive evidence: ' + output.slice(-1000);
  if (testCommand && !/(?:\b[1-9]\d*\s+(?:passed|passing|tests?)\b|\btests?\s*[:=]\s*[1-9]\d*|^# tests [1-9]\d*)/im.test(diagnostics)) return 'Missing executed-test evidence; test check is inconclusive';
  for (const path of settings.requiredEvidence?.[command] ?? []) {
    const file = join(root, path);
    if (!existsSync(file) || !lstatSync(file).isFile() || !lstatSync(file).size) return `Missing required evidence: ${path}`;
    if (started !== undefined && lstatSync(file).mtimeMs < started) return `Missing current required evidence: ${path} predates this check`;
  }
  return undefined;
}

/** Later checks cannot silently delete or replace required evidence for an earlier result. */
export function evidenceArtifacts(command: string, settings: FlowSettings, root: string): Record<string, string> {
  return Object.fromEntries((settings.requiredEvidence?.[command] ?? []).map(path => {
    const file = join(root, path);
    return [path, existsSync(file) && lstatSync(file).isFile() ? createHash('sha256').update(readFileSync(file)).digest('hex') : '(missing)'];
  }));
}
