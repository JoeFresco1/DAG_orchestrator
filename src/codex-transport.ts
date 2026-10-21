import { basename } from 'node:path';

/** Lean Codex workers edit their workspace without disabling the process sandbox. */
export function codexWorkArgs(file: string, args: string[], sandbox: 'workspace-write' | 'read-only' = 'workspace-write'): string[] {
  if (!/^codex(?:\.(?:exe|cmd|bat))?$/i.test(basename(file.replaceAll('\\', '/'))) || args[0] !== 'exec') return args;
  const sandboxFlags = ['--sandbox', '-s'];
  const cleaned = args.filter((argument, index) => !sandboxFlags.includes(argument) && !sandboxFlags.includes(args[index - 1] ?? '') &&
    !['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--approve-for-me', '--full-auto'].includes(argument) && !argument.startsWith('--sandbox='));
  return [cleaned[0]!, '--sandbox', sandbox, ...cleaned.slice(1)];
}

/** A final response artifact excludes progress logs, echoed prompts and tool transcripts. */
export function codexReviewArgs(file: string, args: string[], outputFile: string, schemaFile?: string): string[] {
  if (!/^codex(?:\.(?:exe|cmd|bat))?$/i.test(basename(file.replaceAll('\\', '/'))) || args[0] !== 'exec' || ['resume', 'fork', 'review'].includes(args[1] ?? '')) return args;
  const replaced = ['--output-last-message', '-o', '--output-schema', '--sandbox', '-s'];
  const cleaned = args.filter((arg, i) => !replaced.includes(arg) && !replaced.includes(args[i - 1] ?? '') &&
    !['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--approve-for-me', '--full-auto'].includes(arg) &&
    !arg.startsWith('--output-last-message=') && !arg.startsWith('--output-schema=') && !arg.startsWith('--sandbox='));
  return [cleaned[0]!, '--sandbox', 'read-only', '--output-last-message', outputFile, ...(schemaFile ? ['--output-schema', schemaFile] : []), ...cleaned.slice(1)];
}

/** Codex accepts '-' as its prompt on stdin. Keep model/config options in argv. */
export function codexStdin(file: string, args: string[]): { args: string[]; prompt: string } | null {
  if (!/^codex(?:\.(?:exe|cmd|bat))?$/i.test(basename(file.replaceAll('\\', '/'))) || args[0] !== 'exec') return null;
  // These subcommands and explicit stdin commands already have their own input contract.
  if (['fork', 'review'].includes(args[1] ?? '') || args.at(-1) === '-' || args.some(a => a === '-i' || a === '--image' || a.startsWith('--image='))) return null;
  const valued = new Set(['-m', '--model', '-c', '--config', '-C', '--cd', '-s', '--sandbox', '-p', '--profile', '--output-schema', '--output-last-message', '-o', '--color', '--add-dir', '--enable', '--disable', '--local-provider']);
  const switches = new Set(['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--approve-for-me', '--strict-config', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--full-auto', '--json', '--ephemeral', '--oss']);
  const options = ['exec'];
  let i = 1;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === 'resume') {
      const session = args[i + 1];
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(session ?? '') || i + 2 >= args.length) return null;
      return { args: [...options, 'resume', session!, '-'], prompt: args.slice(i + 2).join(' ') };
    }
    if (['fork', 'review'].includes(arg)) return null;
    if (arg === '--') { i++; break; }
    if (valued.has(arg)) {
      if (i + 1 >= args.length) throw Error(`Missing Codex option value: ${arg}`);
      options.push(arg, args[++i]!); continue;
    }
    if (switches.has(arg) || arg.startsWith('--') && arg.includes('=') && valued.has(arg.split('=')[0]!)) { options.push(arg); continue; }
    if (arg.startsWith('-')) return null; // Preserve unknown command shapes unchanged.
    break;
  }
  if (i === args.length) return null;
  return { args: [...options, '-'], prompt: args.slice(i).join(' ') };
}

/** Explicit thread IDs keep parallel workers from crossing conversations. */
export function codexSessionArgs(file: string, args: string[], session?: { id?: string }): string[] {
  if (!session || !/^codex(?:\.(?:exe|cmd|bat))?$/i.test(basename(file.replaceAll('\\', '/'))) || args[0] !== 'exec') return args;
  if (args.includes('resume') || args.includes('review') || args.includes('fork')) return args;
  const json = args.includes('--json') ? args : ['exec', '--json', ...args.slice(1)];
  const prompt = codexStdin(file, json);
  if (!session.id || !prompt) return json;
  return [...prompt.args.slice(0, -1), 'resume', session.id, prompt.prompt];
}
