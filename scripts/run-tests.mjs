// Enumerate explicitly so Windows and Node 20 run the same complete suite.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function tests(directory, suffix) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tests(path, suffix) : entry.name.endsWith(suffix) ? [path] : [];
  });
}
const result = spawnSync(process.execPath, ['--test', ...tests('dist', '.test.js')], { stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
