import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git-worktree.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Snapshot tracked and untracked source for verification and repair guards. */
export function snapshot(path: string): Map<string, string> {
  const names = git(path, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).stdout.split('\0').filter(Boolean);
  const entries: [string, string][] = [];
  for (const name of new Set(names)) {
    const file = join(path, name);
    if (!existsSync(file)) {
      entries.push([name, '(deleted)']);
      continue;
    }
    const contents = lstatSync(file).isSymbolicLink() ? readlinkSync(file) : readFileSync(file);
    entries.push([name, hash(contents)]);
  }
  return new Map(entries);
}
export function assertMarkerOnly(path: string, before: Map<string, string>, markers: Map<string, string>): void {
  const after = snapshot(path);
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (!markers.has(name) && before.get(name) !== after.get(name)) {
      throw Error(`Resolver changed non-conflict file ${name}`);
    }
  }
  for (const [name, original] of markers) {
    const blocks = /^<<<<<<<[^\n]*\n[\s\S]*?^=======[^\n]*\n[\s\S]*?^>>>>>>>[^\n]*(?:\n|$)/gm;
    const segments: string[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = blocks.exec(original))) {
      segments.push(original.slice(cursor, match.index));
      cursor = match.index + match[0].length;
    }
    segments.push(original.slice(cursor));
    if (segments.length < 2) throw Error(`Cannot resolve ${name}: no text conflict markers`);
    const escaped = segments.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const resolved = readFileSync(join(path, name), 'utf8');
    if (!new RegExp(`^${escaped.join('[\\s\\S]*?')}$`).test(resolved) || /^(?:<<<<<<<|=======|>>>>>>>)/m.test(resolved)) {
      throw Error(`Resolver changed text outside marker blocks in ${name}`);
    }
  }
}
