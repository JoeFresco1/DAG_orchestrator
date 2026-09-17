import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { atomicWriteJson } from './store.js';

// One hub serves many projects. The registry is the hub's memory of them,
// stored per-user so `dag hub` works from any directory.
export interface ProjectEntry {
  file: string;
  name: string;
  addedAt: string;
  // Stable viewer port so each project keeps a bookmarked browser tab.
  port?: number;
}

export interface Registry {
  version: 1;
  projects: ProjectEntry[];
}

// Kept at ~/.lightweight-dag for continuity with existing installs; the
// name is historical, the contents are the project registry.
export function registryPath(): string {
  return process.env.DAG_REGISTRY ?? join(homedir(), '.lightweight-dag', 'projects.json');
}

export function loadRegistry(): Registry {
  const path = registryPath();
  if (!existsSync(path)) return { version: 1, projects: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Registry;
    const projects = Array.isArray(raw.projects) ? raw.projects : [];
    // Heal registries written before paths were compared like paths.
    const seen: ProjectEntry[] = [];
    for (const entry of projects) {
      if (!seen.some((p) => samePath(p.file, entry.file))) seen.push(entry);
    }
    return { version: 1, projects: seen };
  } catch {
    return { version: 1, projects: [] };
  }
}

export function saveRegistry(registry: Registry): void {
  atomicWriteJson(registryPath(), registry);
}

export function projectId(file: string): string {
  const abs = resolve(file);
  return `proj_${createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 8)}`;
}

export function defaultProjectName(file: string): string {
  const dir = dirname(resolve(file));
  const folder = basename(dir);
  const fileBase = basename(file).replace(/\.json$/, '');
  // `dag.run` is the convention, so the folder name is the better label.
  return fileBase === 'dag.run' || fileBase === 'dag' ? folder : `${folder}/${fileBase}`;
}

export function resolveRunFile(target: string): string {
  const abs = resolve(target);
  if (abs.endsWith('.json')) return abs;
  return join(abs, 'dag.run.json');
}

// The same run file reaches the registry as "C:/x/dag.run.json",
// "C:\x\dag.run.json" or with different casing; comparing raw strings made
// each spelling a separate project (and a duplicate directory in the hub).
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const [x, y] = [norm(a), norm(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function addProject(target: string, name?: string): ProjectEntry {
  const file = resolveRunFile(target);
  const registry = loadRegistry();
  const existing = registry.projects.find((p) => samePath(p.file, file));
  if (existing) {
    if (name) existing.name = name;
    saveRegistry(registry);
    return existing;
  }
  const entry: ProjectEntry = {
    file,
    name: name ?? defaultProjectName(file),
    addedAt: new Date().toISOString(),
  };
  registry.projects.push(entry);
  saveRegistry(registry);
  return entry;
}

export function removeProject(idOrPath: string): boolean {
  const registry = loadRegistry();
  const before = registry.projects.length;
  registry.projects = registry.projects.filter(
    (p) => projectId(p.file) !== idOrPath && !samePath(p.file, idOrPath) && p.name !== idOrPath,
  );
  if (registry.projects.length === before) return false;
  saveRegistry(registry);
  return true;
}

export function findProject(idOrPath: string): ProjectEntry | null {
  const registry = loadRegistry();
  const abs = resolve(idOrPath);
  return (
    registry.projects.find(
      (p) => projectId(p.file) === idOrPath || samePath(p.file, abs) || p.name === idOrPath,
    ) ?? null
  );
}

export function setProjectPort(file: string, port: number): ProjectEntry | null {
  const registry = loadRegistry();
  const entry = registry.projects.find((p) => samePath(p.file, file));
  if (!entry) return null;
  entry.port = port;
  saveRegistry(registry);
  return entry;
}

// Highest port already claimed by another project, so new launches don't collide.
export function claimedPorts(exceptFile?: string): Set<number> {
  const out = new Set<number>();
  for (const p of loadRegistry().projects) {
    if (exceptFile && p.file === resolve(exceptFile)) continue;
    if (p.port) out.add(p.port);
  }
  return out;
}
