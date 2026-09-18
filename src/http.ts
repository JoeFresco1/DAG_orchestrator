// Low-level HTTP plumbing shared by the viewer routes: body reading/parsing,
// JSON responses, the origin check, and a tiny sleep used while a run spins up.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 1024 * 1024;

export const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c;
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

// Malformed JSON is the caller's fault, not a server error.
export function parseBody(req: IncomingMessage, raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  const type = String(req.headers['content-type'] ?? '');
  if (!type.includes('application/json')) {
    throw Object.assign(new Error('content-type must be application/json'), { code: 415 });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw Object.assign(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`), {
      code: 400,
    });
  }
}

// Browsers can reach localhost from any page, and the server can spawn
// processes (notifyCmd, worktreePrepareCmd). Only accept mutations from our own
// origin: this blocks CSRF and DNS-rebinding without a token.
export function checkOrigin(req: IncomingMessage, port: number): string | null {
  const host = String(req.headers.host ?? '');
  const hostOk =
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ||
    host === `localhost:${port}` ||
    host === `127.0.0.1:${port}`;
  if (!hostOk) return `host not allowed: ${host}`;
  const origin = req.headers.origin;
  if (origin) {
    const ok =
      origin === `http://localhost:${port}` ||
      origin === `http://127.0.0.1:${port}` ||
      origin === `http://[::1]:${port}`;
    if (!ok) return `origin not allowed: ${origin}`;
  }
  return null;
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
