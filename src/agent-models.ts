// Agent model discovery: asks the user's own agent CLI (`opencode models`)
// which models it can run, so the UI offers exactly what their subscriptions
// and providers allow. Results are TTL-cached and concurrent callers share one
// in-flight probe.

import { spawn } from 'node:child_process';
import { resolveCommand } from './command-resolution.js';

// Model list from the user's own agent CLI, so the UI offers exactly what
// their harness can run (providers, subscriptions, free tiers included).
export interface AgentModelList {
  models: string[];
  error: string | null;
}

// Last result and when it was taken; the CLI is slow enough that serving a
// few-minutes-stale list beats blocking a request on it.
let cache: { at: number; value: AgentModelList } | null = null;
const TTL_MS = 5 * 60 * 1000;
// Hard cap on one probe: the CLI is known to hang when logged out.
const TIMEOUT_MS = 30_000;

// Concurrent callers share one probe: the CLI can take seconds to answer, and
// the server must not run a synchronous child process inside a request handler.
let inflight: Promise<AgentModelList> | null = null;

/**
 * Resolve the model list. Returns the cache while fresh, joins an in-flight
 * probe when one exists, and otherwise starts a new one. `force` bypasses only
 * the freshness check, not the shared probe.
 */
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

// Spawn `opencode models` once and settle the promise exactly once: whichever
// of timeout / stdout-close / error fires first wins, guarded by `settled`.
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
        // Keep only provider/model lines; CLIs mix banners, hints and blank
        // lines into the same stream.
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
