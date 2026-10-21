import { basename, join } from 'node:path';
import { digest } from './planning/contracts.js';
import { atomicWriteJson } from './store.js';

/** Coding-agent prompts are data files; command flags and small arguments stay in argv. */
export function fileBackedAgentArgs(file: string, args: string[], directory: string): {
  args: string[]; payloads: Array<{ path: string; bytes: number; sha256: string }>;
} {
  if (!/^(?:claude|opencode|gemini|cursor-agent)(?:\.(?:exe|cmd|bat))?$/i.test(basename(file.replaceAll('\\', '/')))) return { args, payloads: [] };
  const payloads: Array<{ path: string; bytes: number; sha256: string }> = [];
  const textFlags = new Set(['-p', '--prompt', '--print', '--system-prompt', '--append-system-prompt']);
  const transported = args.map((argument, index) => {
    // Preserve machine-readable option values such as JSON schemas and model IDs.
    if (argument.startsWith('-') || args[index - 1]?.startsWith('-') && !textFlags.has(args[index - 1]!)) return argument;
    if (Buffer.byteLength(argument, 'utf8') < 2048) return argument;
    const sha256 = digest(argument), path = join(directory, `${sha256}.json`);
    atomicWriteJson(path, { version: 1, payload: argument });
    payloads.push({ path, bytes: Buffer.byteLength(argument, 'utf8'), sha256 });
    return `Read the complete payload in ${path} and use it in place of this argument. Preserve every instruction and acceptance criterion.`;
  });
  return { args: transported, payloads };
}
