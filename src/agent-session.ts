import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codexSessionArgs } from './codex-transport.js';

export interface WorkerSession { id?: string; harness?: string }
const tool = (file: string) => basename(file.replaceAll('\\', '/')).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();

/** Continue only an explicit session belonging to this worker and harness. */
export function agentSessionArgs(file: string, args: string[], session?: WorkerSession): string[] {
  if (!session) return args;
  const name = tool(file);
  if (session.harness && session.harness !== name) delete session.id;
  session.harness = name;
  if (name === 'codex') return codexSessionArgs(file, args, session);
  if (name === 'opencode' && args[0] === 'run') {
    if (args.some(a => ['--session', '-s', '--continue', '-c'].includes(a))) return args;
    const cleaned = args.slice(1).filter((a, i, rest) => a !== '--format' && rest[i - 1] !== '--format' && !a.startsWith('--format='));
    return ['run', '--format', 'json', ...(session.id ? ['--session', session.id] : []), ...cleaned];
  }
  if (name === 'claude' && args.some(a => a === '-p' || a === '--print')) {
    if (args.some(a => ['--session-id', '--resume', '-r', '--continue', '-c'].includes(a))) return args;
    if (session.id) return ['--resume', session.id, ...args];
    session.id = randomUUID();
    return ['--session-id', session.id, ...args];
  }
  return args;
}

export function captureSessionEvent(file: string, session: WorkerSession, event: Record<string, unknown>): void {
  const name = tool(file);
  if (name === 'codex' && event.type === 'thread.started' && typeof event.thread_id === 'string' && /^[a-f0-9-]{36}$/i.test(event.thread_id)) session.id = event.thread_id;
  if (name === 'opencode' && typeof event.sessionID === 'string' && /^ses_[a-z0-9]+$/i.test(event.sessionID)) session.id = event.sessionID;
}
