import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countFlag, fileOf, flag, flagRequired, has } from '../cli-args.js';
import { loadRun, readEventLog, runPaths } from '../store.js';

/** Explicit, read-only diagnostic. Does not requeue, rewrite requirements or approve work. */
export async function diagnoseCmd(argv: string[]): Promise<void> {
  const file = resolve(fileOf(argv)), run = loadRun(file), id = flagRequired(argv, 'id');
  const task = run.tasks[id];
  if (!task) throw new Error(`Unknown task ${id}`);
  const timeoutSeconds = countFlag(argv, 'timeout', 1) ?? 300;
  if (timeoutSeconds > 300) throw new Error('Diagnostic timeout cannot exceed 300 seconds');
  const scope = { title: task.title, instructions: task.spec, deps: task.deps,
    command: task.cmd, reviewers: task.reviewers, reviewCommand: task.reviewCmd };
  // The contract fingerprint excludes mutable runtime outcomes and rejection text.
  const contractRevision = createHash('sha256').update(JSON.stringify({ title: task.title, spec: task.spec,
    deps: task.deps, cmd: task.cmd, reviewers: task.reviewers, reviewCmd: task.reviewCmd })).digest('hex');
  const packet = { controllerRoot: dirname(file), cwd: resolve(flag(argv, 'cwd') ?? dirname(file)),
    recordRoot: join(runPaths(file).dir, 'diagnostics'), runId: run.id, taskId: id,
    unit: scope, contractRevision, events: readEventLog(file, 0), dryRun: has(argv, 'dry-run'),
    policy: { diagnostics: { enabled: true, afterRejections: countFlag(argv, 'after', 1) ?? 3,
      model: flag(argv, 'model') ?? 'gpt-6-luna', reasoning: flag(argv, 'reasoning') ?? 'xhigh', timeoutMs: timeoutSeconds * 1000 } } };
  const script = fileURLToPath(new URL('../../scripts/diagnostics/cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(packet));
  const code = await new Promise<number | null>((accept, reject) => {
    child.once('error', reject); child.once('close', accept);
  });
  if (code !== 0) process.exitCode = code ?? 1;
}
