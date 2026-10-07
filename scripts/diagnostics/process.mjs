import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/** One bounded command; streamed output is evidence, never a success verdict. */
export function runRecoveryProcess(binary, args, { cwd, timeoutMs, input = null, logPath, env = process.env } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw new Error('Recovery command timeout must be 1..900000ms');
  return new Promise((resolve, reject) => {
    const childEnv = { ...env }; delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(binary, args, { cwd, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio:'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
      // Do not wait indefinitely for inherited pipes after a dead child.
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref();
      if(logPath)writeFileSync(logPath,output);
      reject(new Error(`Recovery command timeout after ${timeoutMs}ms: ${binary}`));
    }, timeoutMs);
    const collect = bytes => { output += bytes.toString(); if(output.length > 32*1024*1024)output=output.slice(-32*1024*1024);process.stderr.write(bytes); };
    child.stdout.on('data', collect); child.stderr.on('data', collect); child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); if(logPath)writeFileSync(logPath,output);
      if(timedOut)reject(new Error(`Recovery command timeout after ${timeoutMs}ms: ${binary}`));
      else if(code!==0)reject(new Error(`Recovery command exited ${code}: ${output.slice(-3000)}`));
      else resolve(output);
    });
    child.stdin.end(input);
  });
}
