import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path';

// Windows npm/pnpm install CLIs as `.cmd`/`.ps1` shims, not executables.
// Node's shell-less spawn (which this runner insists on) cannot execute them:
// CreateProcess only appends `.exe`. So we resolve the shim to the real target
// and spawn that with the same argv. Unix is a no-op.
export interface ResolvedCommand {
  file: string;
  args: string[];
}

// Resolution hits the filesystem and reads shim files; cache per name so a
// long-lived server does not repeat that work on every spawn.
const cache = new Map<string, ResolvedCommand>();

/** Candidate paths for `name` in PATH order, .exe before the npm shims. */
function pathCandidates(name: string): string[] {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const out: string[] = [];
  for (const dir of dirs) {
    // Windows order: a real .exe wins, then the npm .cmd shim. The
    // extension-less file npm also writes is a POSIX shell script.
    out.push(join(dir, `${name}.exe`), join(dir, `${name}.cmd`), join(dir, `${name}.bat`), join(dir, name));
  }
  out.push(`${name}.exe`, name);
  return out;
}

// `%~dp0` / `%dp0%` expand to the shim's own directory, trailing separator and all.
function expandDp0(target: string, shimDir: string): string {
  const stripped = target.replace(/^~?%?dp0%?[\\/]*/i, '');
  const resolved = stripped.match(/^([a-zA-Z]:[\\/])/) ? stripped : join(shimDir, stripped);
  const cleaned = resolved.split(/[\\/]+/).join(sep);
  return isAbsolute(cleaned) ? cleaned : join(shimDir, cleaned);
}

/**
 * Read a .cmd/.bat shim and extract the real executable or JS entry point it
 * forwards to. Returns null when the shim is unreadable or unrecognized.
 */
function resolveShim(shimPath: string): ResolvedCommand | null {
  let text: string;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const shimDir = dirname(shimPath);
  // npm/pnpm shims quote the real target: "…\node_modules\pkg\bin\x.exe" %*
  const exe = text.match(/"([^"]+\.exe)"/i);
  if (exe) {
    const target = expandDp0(exe[1], shimDir);
    if (existsSync(target)) return { file: target, args: [] };
  }
  const js = text.match(/"([^"]+\.(?:js|mjs|cjs))"/i);
  if (js) {
    const target = expandDp0(js[1], shimDir);
    if (existsSync(target)) return { file: process.execPath, args: [target] };
  }
  return null;
}

/**
 * Map a command name to a file + argv a shell-less spawn can execute. On Unix
 * this is a no-op; on Windows it follows npm/pnpm .cmd shims to their target.
 */
export function resolveCommand(file: string): ResolvedCommand {
  if (process.platform !== 'win32') return { file, args: [] };
  const cached = cache.get(file);
  if (cached) return cached;

  // Default to the bare name: if nothing on PATH matches, let spawn report the
  // ENOENT rather than inventing a path.
  let resolved: ResolvedCommand = { file, args: [] };
  const candidate = pathCandidates(file).find((c) => existsSync(c));
  if (candidate) {
    const lower = candidate.toLowerCase();
    if (lower.endsWith('.exe')) {
      resolved = { file: candidate, args: [] };
    } else if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      // Unparseable shim: keep the shim path rather than dropping the command,
      // so the failure names the file the user meant.
      resolved = resolveShim(candidate) ?? { file: candidate, args: [] };
    } else {
      resolved = { file: candidate, args: [] };
    }
  }
  cache.set(file, resolved);
  return resolved;
}
