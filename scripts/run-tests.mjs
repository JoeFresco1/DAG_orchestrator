// Enumerate explicitly so Windows and Node 20 run the same complete suite.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

function tests(directory, suffix) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tests(path, suffix) : entry.name.endsWith(suffix) ? [path] : [];
  });
}
// TypeScript leaves old emitted files behind when a source test is removed.
// Derive the suite from current source so those stale artifacts cannot execute.
const compiled = tests('src', '.test.ts').sort().map(source =>
  join('dist', relative('src', source).replace(/\.ts$/, '.js')));
const missing = compiled.filter(path => !existsSync(path));
if (missing.length > 0) {
  throw new Error(`Missing compiled tests; rebuild before testing: ${missing.join(', ')}`);
}
if (compiled.length === 0) throw new Error('No source tests found');
const result = spawnSync(process.execPath, ['--test', ...compiled], { stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
