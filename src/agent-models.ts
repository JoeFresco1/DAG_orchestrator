import { spawn } from 'node:child_process';
import { resolveCommand } from './command-resolution.js';

// Model list from the user's own agent CLI, so the UI offers exactly what
// their harness can run (providers, subscriptions, free tiers included).
export interface AgentModelList {
  models: string[];
  error: string | null;
}

let cache: { at: number; value: AgentModelList } | null = null;
const TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 30_000;

// Concurrent callers share one probe: the CLI can take seconds to answer, and
// the server must not run a synchronous child process inside a request handler.
let inflight: Promise<AgentModelList> | null = null;

export function listAgentModels(force = false): Promise<AgentModelList> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.value);
  if (inflight) return inflight;
  inflight = query()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function query(): Promise<AgentModelList> {
  return new Promise((resolve) => {
    const finish = (value: AgentModelList): void => resolve(value);
    try {
      const resolved = resolveCommand('opencode');
      const child = spawn(resolved.file, [...resolved.args, 'models'], {
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        finish({ models: [], error: `opencode models timed out after ${TIMEOUT_MS}ms` });
      }, TIMEOUT_MS);
      child.stdout?.on('data', (c: Buffer) => {
        stdout += c;
      });
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c;
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish({ models: [], error: err.message });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          finish({
            models: [],
            error: (stderr || stdout || `exit ${code}`).trim().slice(0, 300),
          });
          return;
        }
        const models = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^[\w.-]+\/[\w./-]+$/.test(l));
        finish({ models, error: null });
      });
    } catch (err) {
      finish({ models: [], error: err instanceof Error ? err.message : String(err) });
    }
  });
}
