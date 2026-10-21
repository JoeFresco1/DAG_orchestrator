// Invoked by the ordinary runner. Keeps argv exact, including literal task tokens.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveCommand } from '../command-resolution.js';
import { digest, validatePlanningCheck } from './contracts.js';
import { killTree } from '../runner.js';
import { codexStdin } from '../codex-transport.js';
import { selectedTestEvidence } from './check-evidence.js';

try {
  // Legacy persisted commands may still use base64; new commands use durable JSON files.
  const check: unknown = JSON.parse(process.argv[2] === '--file'
    ? readFileSync(process.argv[3], 'utf8')
    : Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
  validatePlanningCheck(check);
  if (process.argv[2] === '--file' && basename(process.argv[3]) !== `${digest(check)}.json`) {
    throw Error('Check payload identity changed');
  }
  const target = resolveCommand(check.program);
  const transport = codexStdin(check.program, check.args);
  let output = '', overflow = false;
  const child = spawn(target.file, [...target.args, ...(transport?.args ?? check.args)], {
    stdio: [transport ? 'pipe' : 'inherit', check.kind === 'test' ? 'pipe' : 'inherit', check.kind === 'test' ? 'pipe' : 'inherit'], windowsHide: true, detached: process.platform !== 'win32',
  });
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) stream?.on('data', chunk => {
    destination.write(chunk);
    if (output.length + chunk.length > 16_000_000) overflow = true;
    else output += chunk.toString();
  });
  if (transport) {
    child.stdin!.on('error', error => {
      // A rejected command may exit before consuming its prompt.
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') { console.error(error.message); process.exitCode = 1; }
    });
    child.stdin!.end(transport.prompt, 'utf8');
  }
  const timer = setTimeout(() => { killTree(child); process.exitCode = 1; }, check.timeoutMs);
  child.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
  child.on('close', code => {
    clearTimeout(timer); process.exitCode = process.exitCode || code || (code === 0 ? 0 : 1);
    if (process.exitCode !== 0) return;
    try {
      if (overflow) throw Error('Selected test summary output exceeded capture limit');
      const evidence = selectedTestEvidence(check, output);
      if (evidence) console.log(`DAG_CHECK_EVIDENCE: ${JSON.stringify(evidence)}`);
    } catch (error) { console.error(String(error)); process.exitCode = 1; }
  });
} catch (error) { console.error(String(error)); process.exitCode = 1; }
