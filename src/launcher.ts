import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addProject, claimedPorts, loadRegistry, projectId, setProjectPort, type ProjectEntry } from './registry.js';
import { atomicWriteJson } from './store.js';

// One server per run file, tracked here so `dag servers` can list and stop them.
export interface ServerRecord {
  file: string;
  name: string;
  port: number;
  pid: number;
  startedAt: string;
}

export interface ServersFile {
  version: 1;
  servers: ServerRecord[];
}

export function serversPath(): string {
  return process.env.DAG_SERVERS ?? join(homedir(), '.lightweight-dag', 'servers.json');
}

export function loadServers(): ServersFile {
  const path = serversPath();
  if (!existsSync(path)) return { version: 1, servers: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ServersFile;
    return { version: 1, servers: Array.isArray(raw.servers) ? raw.servers : [] };
  } catch {
    return { version: 1, servers: [] };
  }
}

export function saveServers(servers: ServersFile): void {
  atomicWriteJson(serversPath(), servers);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function pruneServers(): ServerRecord[] {
  const file = loadServers();
  const alive = file.servers.filter((s) => isAlive(s.pid));
  if (alive.length !== file.servers.length) {
    saveServers({ version: 1, servers: alive });
  }
  return alive;
}

export function serverFor(file: string): ServerRecord | null {
  return pruneServers().find((s) => s.file === file) ?? null;
}

// A port is free if we can bind it right now. Small race with other
// processes, but the server auto-bumps if it loses.
export function portAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createConnection({ port, host });
    server.on('connect', () => {
      server.destroy();
      resolve(false);
    });
    server.on('error', () => {
      server.destroy();
      resolve(true);
    });
  });
}

export async function pickPort(file: string, preferred = 8787): Promise<number> {
  const claimed = claimedPorts(file);
  for (let port = preferred; port < preferred + 200; port++) {
    if (claimed.has(port)) continue;
    if (await portAvailable(port)) return port;
  }
  throw new Error(`no free port in ${preferred}..${preferred + 199}`);
}

export function cliPath(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = here.endsWith('.ts') ? '.ts' : '.js';
  return join(dirname(here), `cli${ext}`);
}

export interface LaunchOptions {
  open?: boolean;
  autoResume?: boolean;
  killOrphans?: boolean;
  extraArgs?: string[];
}

export interface LaunchResult {
  entry: ProjectEntry;
  port: number;
  pid: number;
  url: string;
  alreadyRunning: boolean;
}

export async function launchProject(entry: ProjectEntry, opts: LaunchOptions = {}): Promise<LaunchResult> {
  const running = serverFor(entry.file);
  if (running) {
    return {
      entry,
      port: running.port,
      pid: running.pid,
      url: `http://localhost:${running.port}`,
      alreadyRunning: true,
    };
  }

  const port = await pickPort(entry.file, entry.port ?? 8787);
  setProjectPort(entry.file, port);

  const logDir = join(homedir(), '.lightweight-dag', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `server-${projectId(entry.file)}.log`);
  const fd = openSync(logFile, 'a');

  const args = [cliPath(), 'serve', '--file', entry.file, '--port', String(port)];
  if (opts.autoResume) args.push('--auto-resume');
  if (opts.killOrphans) args.push('--kill-orphans');
  if (opts.extraArgs) args.push(...opts.extraArgs);

  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  closeSync(fd);

  // The server may have bumped the port if it lost a race; trust its log
  // line over our guess so the printed URL is always reachable.
  const actualPort = await confirmPort(logFile, port);

  const servers = loadServers();
  servers.servers = servers.servers.filter((s) => s.file !== entry.file);
  servers.servers.push({
    file: entry.file,
    name: entry.name,
    port: actualPort,
    pid: child.pid ?? 0,
    startedAt: new Date().toISOString(),
  });
  saveServers(servers);

  const url = `http://localhost:${actualPort}`;
  if (opts.open) openBrowser(url);
  return { entry, port: actualPort, pid: child.pid ?? 0, url, alreadyRunning: false };
}

async function confirmPort(logFile: string, fallback: number): Promise<number> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const text = readFileSync(logFile, 'utf8');
      const m = [...text.matchAll(/http:\/\/localhost:(\d+)/g)].pop();
      if (m) return Number(m[1]);
    } catch {
      // log not written yet
    }
  }
  return fallback;
}

export function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
      return;
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // opening a browser is best effort
  }
}

export function stopServer(file: string): { stopped: boolean; pid: number | null } {
  const running = serverFor(file);
  if (!running) return { stopped: false, pid: null };
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(running.pid), '/T', '/F'], { windowsHide: true });
  }
  try {
    process.kill(running.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  // Only forget the record once the process is actually gone; otherwise a
  // surviving server would be invisible to `dag servers`.
  const deadline = Date.now() + 3000;
  let alive = isAlive(running.pid);
  while (alive && Date.now() < deadline) {
    sleepSync(100);
    alive = isAlive(running.pid);
  }
  if (alive) return { stopped: false, pid: running.pid };
  const servers = loadServers();
  servers.servers = servers.servers.filter((s) => s.file !== file);
  saveServers(servers);
  return { stopped: true, pid: running.pid };
}

export function projectEntriesFromArgs(dirs: string[], all: boolean): ProjectEntry[] {
  if (all) return loadRegistry().projects;
  const entries: ProjectEntry[] = [];
  for (const dir of dirs) entries.push(addProject(dir));
  return entries;
}
