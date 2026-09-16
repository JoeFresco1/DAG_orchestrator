import { spawnSync } from 'node:child_process';
import { resolveCommand } from './command-resolution.js';

// Model list from the user's own agent CLI, so the UI offers exactly what
// their harness can run (providers, subscriptions, free tiers included).
export interface AgentModelList {
  models: string[];
  error: string | null;
}

let cache: { at: number; value: AgentModelList } | null = null;
const TTL_MS = 5 * 60 * 1000;

export function listAgentModels(force = false): AgentModelList {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = query();
  cache = { at: Date.now(), value };
  return value;
}

function query(): AgentModelList {
  try {
    const resolved = resolveCommand('opencode');
    const res = spawnSync(resolved.file, [...resolved.args, 'models'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    if (res.status !== 0) {
      return {
        models: [],
        error: (res.stderr || res.stdout || `exit ${res.status}`).trim().slice(0, 300),
      };
    }
    const models = (res.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[\w.-]+\/[\w./-]+$/.test(l));
    return { models, error: null };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) };
  }
}
