import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class QuotaUnavailable extends Error { }
export interface QuotaReading { remainingPercent: number; resetAt?: number; observedAt: number }
export type QuotaProbe = () => Promise<QuotaReading>;

// Only worker/harness failures can enter quota recovery. General HTTP 429,
// authentication, test output and transport errors are not confirmation.
export function quotaSignal(output: string): boolean {
  return /^(?:error:\s*)?(?:you(?:'ve| have) hit your usage limit\b|usage limit (?:exceeded|reached)\b|quota exhausted\b)/im.test(output)
    || /"code"\s*:\s*"(?:usage_limit_reached|insufficient_quota)"/.test(output);
}

/** One bounded read from the installed Codex app-server. Never submits a model request. */
export const codexQuota: QuotaProbe = () => new Promise((resolve, reject) => {
  const child = spawn(process.platform === 'win32' ? 'codex.exe' : 'codex', ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  let done = false;
  function finish(error?: Error, reading?: QuotaReading) {
    if (done) return;
    done = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
    if (reading) resolve(reading); else reject(error);
  }
  const timer = setTimeout(() => finish(Error('Quota probe timed out')), 10000);
  child.on('error', e => finish((e as NodeJS.ErrnoException).code === 'ENOENT' ? new QuotaUnavailable('Codex quota probe executable unavailable') : e)); child.stdin.on('error', e => finish(e));
  child.on('close', () => finish(Error('Quota probe closed')));
  const send = (body: object) => child.stdin.write(JSON.stringify(body) + '\n');
  lines.on('line', line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (!m || done || (m.id !== 1 && m.id !== 2)) return;
    if (m.error) return finish(m.error.code === -32601 ? new QuotaUnavailable('Installed harness does not expose quota readings') : Error('Quota provider rejected usage request'));
    if (m.id === 1) {
      send({ method: 'initialized', params: {} }); send({ id: 2, method: 'account/rateLimits/read', params: {} }); return;
    }
    const b = m.result?.rateLimitsByLimitId?.codex ?? m.result?.rateLimits;
    const windows = [b?.primary, b?.secondary].filter(Boolean);
    if (!windows.length || windows.some(w => !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100)) return finish(Error('Unavailable quota reading'));
    const limiting = windows.reduce((a, b) => a.usedPercent >= b.usedPercent ? a : b);
    finish(undefined, { remainingPercent: 100 - limiting.usedPercent, observedAt: Date.now(), resetAt: Number.isFinite(limiting.resetsAt) ? limiting.resetsAt * 1000 : undefined });
  });
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'lightweight_dag', version: '1' } } });
});
