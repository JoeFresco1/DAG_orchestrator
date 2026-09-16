// The viewer needs vis-network at runtime; copy it from the dependency at
// build time instead of committing a 435KB minified blob.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = join(here, '..');
const target = join(root, 'viewer', 'vendor', 'vis-network.min.js');

let source;
try {
  source = join(dirname(require.resolve('vis-network/package.json')), 'dist', 'vis-network.min.js');
} catch {
  console.error('viewer/vendor: install dependencies first (pnpm install)');
  process.exit(1);
}
if (!existsSync(source)) {
  console.error(`viewer/vendor: missing ${source}`);
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log('viewer/vendor/vis-network.min.js ready');
