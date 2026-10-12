// Invoked by the ordinary runner. Keeps argv exact, including literal task tokens.
import { spawn } from 'node:child_process';
import { resolveCommand } from '../command-resolution.js';
import { validatePlanningCheck } from './contracts.js';
import { killTree } from '../runner.js';

try {
  const check: unknown = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
  validatePlanningCheck(check);
  const target = resolveCommand(check.program);
  const child = spawn(target.file, [...target.args, ...check.args], { stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
  const timer = setTimeout(() => { killTree(child); process.exitCode = 1; }, check.timeoutMs);
  child.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
  child.on('close', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} catch (error) { console.error(String(error)); process.exitCode = 1; }
