import { createHash } from 'node:crypto';
import type { Run } from '../types.js';
import type { Phase, RepairDecision } from './contracts.js';

const normalized = (text: string) => text.replaceAll('\\', '/').toLowerCase();
const missing = /cannot find (?:module|package)|module not found|no module named|enoent|no such file|does not exist|could not find|missing (?:file|artifact|dependency|producer)/i;
const environment = /(?:usage|rate|quota) limit|quota (?:exhausted|exceeded)|too many requests|unauthenticated|unauthorized|authentication (?:failed|required)|invalid api key|\b(?:HTTP|status)\s*(?:401|403|429)\b|ECONN(?:RESET|REFUSED)|ENOTFOUND|ETIMEDOUT|spawn .*ENOENT|not recognized as .*command|command not found|executor did not stop|timed out after|idle watchdog/i;
const policy = /frozen (?:acceptance|source)|continuation control changed|contract (?:hash|revision).*changed|outside (?:the )?(?:owned|allowed) scope|repair policy violation|no .*checks configured|configure .*flow3\.(?:waveChecks|finalChecks)/i;
const implementation = /trailing whitespace|new blank line at EOF|SyntaxError|syntax error|unexpected token|\berror TS\d+\b|\bTS\d+:|type (?:mismatch|error)|compiler error|not assignable|missing exported API|AssertionError|assertion|\bnot ok \d|\bFAIL\b.*(?:test|expect)|expected .*(?:received|actual)|\b(?:E\s+assert|FAILED\s+\S+)/i;

/** Routing uses runner state and conservative diagnostics; agent prose cannot authorize graph edits. */
export function repairDecision(run: Run, input: {
  command: string; output: string; phase: Phase; kind?: string; requires?: string[];
}): RepairDecision {
  const { command, output, phase } = input;
  const fingerprint = createHash('sha256').update(command + '\n' + output.replace(/\r\n/g, '\n')).digest('hex');
  const decide = (action: RepairDecision['action'], category: RepairDecision['category'], reason: string, requires?: string[]): RepairDecision => ({ action, category, reason, fingerprint, ...(requires?.length ? { requires } : {}) });
  const prerequisites = [...new Set(input.requires ?? [])];
  const invalid = prerequisites.filter(id => !run.tasks[id]);
  if (invalid.length) return decide('hold', 'dependency', `Unknown producer IDs: ${invalid.join(', ')}`);
  const waiting = prerequisites.filter(id => run.tasks[id].status !== 'completed');
  if (waiting.length) return decide('defer', 'dependency', `Waiting for declared producers: ${waiting.join(', ')}`, waiting);
  if (['setup', 'advisory'].includes(phase) || ['timeout', 'stalled', 'spawn', 'killed', 'manual', 'budget', 'worktree'].includes(input.kind ?? '') || environment.test(output)) {
    return decide('hold', 'environment', 'Execution prerequisite or resource failure; a coding repair is not eligible');
  }
  if (policy.test(output)) return decide('hold', 'policy', 'Acceptance, configuration or file-boundary guard rejected this result');
  if (missing.test(output)) {
    const diagnostic = normalized(output);
    // Match actual declared artifact paths in the diagnostic, never arbitrary node IDs or guesses.
    const owners = new Set<string>();
    for (const task of Object.values(run.tasks)) for (const artifact of task.node?.creates ?? []) {
      const name = normalized(artifact);
      if (!/^[\w./-]+\.[\w-]+$/.test(name)) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(?:^|[\\s'"/:])${escaped}(?=$|[\\s'":),])`).test(diagnostic)) continue;
      const candidates = Object.values(run.tasks).filter(t => t.node?.creates.some(created => normalized(created) === name));
      if (candidates.length !== 1) return decide('hold', 'dependency', `Ambiguous producer for ${artifact}`);
      owners.add(task.id);
    }
    const pending = [...owners].filter(id => !['completed', 'failed', 'skipped'].includes(run.tasks[id].status));
    if (pending.length && (phase === 'checkpoint' || phase === 'integration')) {
      return decide('defer', 'dependency', `Missing artifact has an identified unfinished producer: ${pending.join(', ')}`, pending);
    }
    return decide('hold', 'dependency', 'Missing input needs producer/graph or environment diagnosis; no safe automatic coding repair');
  }
  if (implementation.test(output)) return decide('repair', 'implementation', 'Concrete formatting, syntax, type or behavioral check failure');
  return decide('hold', 'unknown', 'Failure is not classified as a scoped implementation defect');
}

/** Existing tests, contracts and check configuration cannot be rewritten to manufacture a pass. */
export function protectedRepairPath(path: string): boolean {
  const name = normalized(path);
  return /(?:^|\/)(?:__tests__|tests|specs|contracts|\.github)(?:\/|$)/.test(name) ||
    /(?:^|\/)(?:[^/]+[.-](?:test|spec)\.[^/]+|test_[^/]+\.py|conftest\.py|AGENTS\.md|package\.json|(?:pnpm-lock|yarn|package-lock|uv\.lock)[^/]*|pyproject\.toml|pytest\.ini|tsconfig[^/]*\.json|\.gitattributes|\.gitignore)$/i.test(name) ||
    /(?:^|\/)(?:check|verify|audit)[^/]*\.(?:[cm]?[jt]s|py)$/.test(name);
}

export function commandMentionsPath(command: string, path: string): boolean {
  const escaped = normalized(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s'"/=])${escaped}(?=$|[\\s'";:)])`).test(normalized(command));
}

/** Follow package-script indirection without executing it; script cycles terminate in the seen set. */
export function checkScriptCommands(commands: string[], scripts: Record<string, unknown>): string[] {
  const result = [...commands], seen = new Set<string>();
  for (let i = 0; i < result.length; i++) for (const [name, script] of Object.entries(scripts)) {
    if (typeof script !== 'string' || seen.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[\\s;&|])(?:npm|pnpm|yarn|bun)(?:\\s+run)?\\s+${escaped}(?=$|[\\s;&|])`).test(result[i])) {
      seen.add(name); result.push(script);
    }
  }
  return result;
}
