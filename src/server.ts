import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLock,
  assertNoForeignLock,
  attemptLogFiles,
  foreignLock,
  killOrphans,
  loadRun,
  logEvent,
  mutate,
  readAttemptLog,
  readEventTail,
  retryFailed,
  retryTask,
  saveRun,
  skipBlocked,
  skipGated,
} from './store.js';
import { DagRunner } from './runner.js';
import { deriveStatus, getReady } from './graph.js';
import { openBrowser } from './launcher.js';
import { listAgentModels } from './agent-models.js';
import {
  addProject,
  cleanPath,
  loadRegistry,
  projectId,
  removeProject,
  type ProjectEntry,
} from './registry.js';
import {
  activeRunFile,
  archiveRun,
  findRun,
  listRuns,
  projectOf,
  startNewRun,
} from './runs.js';
import {
  describeSettingsProblems,
  validateSettingsPatch,
  type DepFailurePolicy,
  type GatePolicy,
  type Run,
  type Task,
} from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface ServeOptions {
  // Single-run focus for `dag serve --file`. Omit for hub mode.
  file?: string;
  port?: number;
  autoResume?: boolean;
  killOrphansOnResume?: boolean;
  open?: boolean;
}

// One runtime per RUN, not per project: two runs in one repository are two
// independent runners with their own locks and integration branches.
interface RunRuntime {
  runId: string;
  projectDir: string;
  file: string;
  archived: boolean;
  runner: DagRunner | null;
  releaseLock: (() => void) | null;
  jobStartedAt: string | null;
  activeScope: string[] | null;
  starting: boolean;
}

const runtimes = new Map<string, RunRuntime>();
let defaultRunId: string | null = null;
let listeningPort = 0;
let singleRunMode = false;

function projectDirs(): string[] {
  // One project, one directory: two entries can point at the same folder (a
  // run file and its archived sibling), which must not look like two projects.
  const dirs = loadRegistry().projects.map((p) => projectOf(p.file));
  return [...new Map(dirs.map((d) => [resolve(d).toLowerCase(), d])).values()];
}

function runtimeFor(runId: string): RunRuntime | null {
  const existing = runtimes.get(runId);
  if (existing) {
    // The file behind a runtime can move (archived by a CLI in another
    // process) or be replaced (a new run): re-resolve instead of answering
    // from a cache that points at a file nobody has any more.
    if (existsSync(existing.file)) return existing;
    runtimes.delete(runId);
  }
  const matches: { dir: string; found: NonNullable<ReturnType<typeof findRun>> }[] = [];
  for (const dir of projectDirs()) {
    const found = findRun(dir, runId);
    if (found) matches.push({ dir, found });
  }
  if (matches.length === 0) return null;
  // Prefer a live run over archived history; run ids are only unique per
  // project, so copied repos can share one.
  const active = matches.filter((m) => !m.found.archived);
  if (active.length > 1) return null; // ambiguous: the caller reports 409
  const pick = active[0] ?? matches[0];
  const rt: RunRuntime = {
    runId,
    projectDir: pick.dir,
    file: pick.found.file,
    archived: pick.found.archived,
    runner: null,
    releaseLock: null,
    jobStartedAt: null,
    activeScope: null,
    starting: false,
  };
  runtimes.set(runId, rt);
  return rt;
}

// True when a run id resolves to more than one active run across projects.
function ambiguousRunId(runId: string): string[] {
  const dirs: string[] = [];
  for (const dir of projectDirs()) {
    const found = findRun(dir, runId);
    if (found && !found.archived) dirs.push(dir);
  }
  return dirs;
}

// A runtime's cached file can go stale: `dag new-run` (or the HTTP route)
// archives the run and creates a new one at the same path.
function dropRuntime(runId: string): void {
  runtimes.delete(runId);
}

function projectPayload(entry: ProjectEntry): Record<string, unknown> {
  const dir = projectOf(entry.file);
  const runs = listRuns(dir).map((row) => ({
    ...row,
    job: runtimes.get(row.runId) ? jobView(runtimes.get(row.runId) as RunRuntime) : null,
  }));
  const active = runs.find((r) => !r.archived) ?? null;
  const running = runs.filter((r) => r.job?.running).length;
  return {
    id: projectId(entry.file),
    name: entry.name,
    dir,
    file: entry.file,
    exists: existsSync(entry.file),
    addedAt: entry.addedAt,
    activeRunId: active?.runId ?? null,
    running,
    totalRuns: runs.length,
    counts: active?.counts ?? {},
    status: active?.status ?? 'empty',
    runs,
  };
}

function projectName(dir: string): string {
  const entry = loadRegistry().projects.find((p) => projectOf(p.file) === resolve(dir));
  return entry?.name ?? basename(dir);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c;
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

const MAX_BODY_BYTES = 1024 * 1024;

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Malformed JSON is the caller's fault, not a server error.
function parseBody(req: import('node:http').IncomingMessage, raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  const type = String(req.headers['content-type'] ?? '');
  if (!type.includes('application/json')) {
    throw Object.assign(new Error('content-type must be application/json'), { code: 415 });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw Object.assign(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`), {
      code: 400,
    });
  }
}

// Browsers can reach localhost from any page, and the server can spawn
// processes (notifyCmd, worktreePrepareCmd). Only accept mutations from our own
// origin: this blocks CSRF and DNS-rebinding without a token.
function checkOrigin(req: import('node:http').IncomingMessage, port: number): string | null {
  const host = String(req.headers.host ?? '');
  const hostOk =
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ||
    host === `localhost:${port}` ||
    host === `127.0.0.1:${port}`;
  if (!hostOk) return `host not allowed: ${host}`;
  const origin = req.headers.origin;
  if (origin) {
    const ok =
      origin === `http://localhost:${port}` ||
      origin === `http://127.0.0.1:${port}` ||
      origin === `http://[::1]:${port}`;
    if (!ok) return `origin not allowed: ${origin}`;
  }
  return null;
}

function activeRuntimeForFile(file: string): RunRuntime | null {
  const target = resolve(file);
  for (const rt of runtimes.values()) {
    if (resolve(rt.file) !== target) continue;
    if (rt.runner?.isRunning || rt.runner?.isStopping || rt.starting) return rt;
  }
  return null;
}

function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function jobView(rt: RunRuntime): Record<string, unknown> {
  const active = rt.runner?.isRunning || rt.runner?.isStopping;
  const foreign = active ? null : foreignLock(rt.file);
  return {
    running: rt.runner?.isRunning ?? false,
    stopping: rt.runner?.isStopping ?? false,
    current: active ? (rt.runner?.current ?? []) : [],
    result: active ? null : (rt.runner?.result ?? null),
    startedAt: active ? rt.jobStartedAt : null,
    scope: active ? rt.activeScope : null,
    external: foreign ? { pid: foreign.pid, note: foreign.note, startedAt: foreign.startedAt } : null,
  };
}

function defHash(run: Run): number {
  let h = 2166136261;
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  };
  for (const t of Object.values(run.tasks)) {
    feed(t.id);
    feed(t.title);
    feed(t.deps.join(','));
  }
  return h >>> 0;
}

function definitionPayload(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    objective: run.objective,
    createdAt: run.createdAt,
    settings: run.settings,
    tasks: Object.values(run.tasks).map((t) => ({
      id: t.id,
      title: t.title,
      deps: t.deps,
      seq: t.seq,
      model: t.model,
      variant: t.variant,
    })),
  };
}

function summaryPayload(run: Run): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const tasks = Object.values(run.tasks).map((t) => {
    const display = deriveStatus(run, t);
    counts[display] = (counts[display] ?? 0) + 1;
    return {
      id: t.id,
      status: t.status,
      display,
      attempts: t.attempts,
      maxAttempts: t.maxAttempts,
      failureKind: t.failureKind,
      exitCode: t.exitCode,
      lastOutputAt: t.lastOutputAt,
      pid: t.pid,
      model: t.model,
      variant: t.variant,
      reviews: t.reviews,
      reviewRounds: t.reviewRounds,
      repairs: t.repairs,
      repairRounds: t.repairRounds,
    };
  });
  return {
    rev: run.rev,
    defRev: defHash(run),
    runId: run.id,
    objective: run.objective,
    updatedAt: run.updatedAt,
    counts,
    total: tasks.length,
    tasks,
  };
}

function currentRun(rt: RunRuntime): Run {
  return rt.runner && (rt.runner.isRunning || rt.runner.isStopping) ? rt.runner.state : loadRun(rt.file);
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

interface StartOptions {
  ids?: string[] | null;
  concurrency?: number;
  timeoutMs?: number;
  silenceMs?: number;
  maxAttempts?: number;
  onDepFailure?: DepFailurePolicy;
  onGateBlocked?: GatePolicy;
  maxWallClockMs?: number;
  notifyCmd?: string;
  model?: string;
  variant?: string;
  worktree?: 'none' | 'task';
  worktreePrepareCmd?: string;
  force?: boolean;
}

interface StartResult {
  started: boolean;
  scope?: string[];
  skippedManual?: string[];
  error?: string;
  code?: number;
}

async function startRun(rt: RunRuntime, opts: StartOptions): Promise<StartResult> {
  if (rt.archived) {
    return { started: false, error: 'this run is archived (history) and cannot be started', code: 409 };
  }
  if (rt.runner?.isRunning || rt.runner?.isStopping || rt.starting) {
    return { started: false, error: 'this run is already in progress', code: 409 };
  }
  // Another runtime (a stale runId alias) may already be driving this same
  // file: acquiring the lock below would overwrite the live runner's lock and
  // leave the file unprotected.
  const busy = activeRuntimeForFile(rt.file);
  if (busy && busy !== rt) {
    return { started: false, error: `run ${busy.runId} is already in progress on this file`, code: 409 };
  }
  rt.starting = true;
  let lock: (() => void) | null = null;
  try {
    try {
      lock = acquireLock(rt.file, `serve run (${rt.runId})`, opts.force ?? false);
    } catch (err) {
      return { started: false, error: err instanceof Error ? err.message : String(err), code: 409 };
    }
    let run: Run;
    try {
      run = loadRun(rt.file);
    } catch (err) {
      lock();
      return { started: false, error: err instanceof Error ? err.message : String(err), code: 400 };
    }
    if (opts.ids != null) {
      const unknown = opts.ids.filter((id) => !run.tasks[id]);
      if (unknown.length > 0) {
        lock();
        return { started: false, error: `unknown tasks: ${unknown.join(', ')}`, code: 400 };
      }
    }
    if (opts.concurrency !== undefined) {
      run.settings.concurrency = Math.min(64, Math.max(1, opts.concurrency));
    }
    if (opts.timeoutMs !== undefined) run.settings.timeoutMs = Math.max(0, opts.timeoutMs);
    if (opts.silenceMs !== undefined) run.settings.silenceMs = Math.max(0, opts.silenceMs);
    if (opts.maxAttempts !== undefined) run.settings.maxAttempts = Math.max(1, opts.maxAttempts);
    if (opts.onDepFailure !== undefined) run.settings.onDepFailure = opts.onDepFailure;
    if (opts.onGateBlocked !== undefined) run.settings.onGateBlocked = opts.onGateBlocked;
    if (opts.maxWallClockMs !== undefined) run.settings.maxWallClockMs = Math.max(0, opts.maxWallClockMs);
    if (opts.notifyCmd !== undefined) run.settings.notifyCmd = opts.notifyCmd;
    if (opts.model !== undefined) run.settings.model = opts.model;
    if (opts.variant !== undefined) run.settings.variant = opts.variant;
    if (opts.worktree !== undefined) run.settings.worktree = opts.worktree;
    if (opts.worktreePrepareCmd !== undefined) {
      run.settings.worktreePrepareCmd = opts.worktreePrepareCmd;
    }
    saveRun(run, rt.file);

    const candidates = opts.ids ?? Object.keys(run.tasks);
    const manual = candidates.filter(
      (id) => !run.tasks[id].cmd && (run.tasks[id].status === 'pending' || run.tasks[id].status === 'ready'),
    );
    const scope = candidates.filter((id) => run.tasks[id].cmd);
    if (scope.length === 0) {
      lock();
      return {
        started: false,
        error:
          manual.length > 0
            ? `nothing to run: all selected tasks are manual (no cmd): ${manual.join(', ')}`
            : 'nothing to run: nothing selected',
        code: 400,
      };
    }

    rt.runner = new DagRunner(run, { file: rt.file, persist: (state) => saveRun(state, rt.file) });
    rt.releaseLock = lock;
    rt.jobStartedAt = new Date().toISOString();
    rt.activeScope = scope;
    if (manual.length > 0) {
      logEvent(run, 'note', null, `skipped ${manual.length} manual task(s) without cmd: ${manual.join(', ')}`);
    }
    // A runner that cannot even set up (no git repo for isolation, bad graph)
    // refuses synchronously and finishes instantly. Report that instead of
    // claiming the run started and leaving the UI looking idle.
    const eventsBefore = run.events.length;
    void rt.runner.start(new Set(scope)).finally(() => {
      rt.releaseLock?.();
      rt.releaseLock = null;
      saveRun(run, rt.file);
    });
    await sleepMs(60);
    if (!rt.runner.isRunning && rt.runner.result) {
      const refusal = run.events
        .slice(eventsBefore)
        .reverse()
        .find((e) => e.type === 'note' && e.message.startsWith('not starting:'));
      if (refusal) {
        rt.runner = null;
        rt.activeScope = null;
        return { started: false, error: refusal.message.replace(/^not starting:\s*/, ''), code: 409 };
      }
    }
    return { started: true, scope, skippedManual: manual };
  } catch (err) {
    if (lock && !rt.releaseLock) lock();
    return { started: false, error: err instanceof Error ? err.message : String(err), code: 500 };
  } finally {
    rt.starting = false;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startServer(opts: ServeOptions): void {
  const basePort = opts.port ?? 8787;
  singleRunMode = Boolean(opts.file);

  if (opts.file) {
    const entry = addProject(opts.file);
    const dir = projectOf(entry.file);
    const active = activeRunFile(dir);
    if (existsSync(active)) {
      try {
        defaultRunId = loadRun(active).id;
      } catch {
        defaultRunId = null;
      }
    }
    if (defaultRunId) runtimeFor(defaultRunId);
  }

  const processStartedAt = Date.now();
  const runnerFile = fileURLToPath(new URL('./runner.js', import.meta.url));
  const staleBuild = (): boolean => {
    try {
      return statSync(runnerFile).mtimeMs > processStartedAt;
    } catch {
      return false;
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const originError = checkOrigin(req, listeningPort);
      if (originError) {
        json(res, 403, { error: originError });
        return;
      }

      // ---- projects: the hub's top level ----
      if ((path === '/api/projects' || path === '/api/runs') && req.method === 'GET') {
        const registry = loadRegistry();
        const projects = registry.projects.map((entry: ProjectEntry) => projectPayload(entry));
        json(res, 200, { projects, singleRunMode, defaultRunId, port: listeningPort });
        return;
      }

      // ---- one project: its runs and the active run's settings ----
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        const id = projectMatch[1];
        const registry = loadRegistry();
        const entry = registry.projects.find((p) => projectId(p.file) === id);
        if (!entry) {
          json(res, 404, { error: `unknown project ${id}` });
          return;
        }
        if (req.method === 'GET') {
          const payload = projectPayload(entry);
          let settings: unknown = null;
          const activeFile = activeRunFile(projectOf(entry.file));
          if (existsSync(activeFile)) {
            try {
              settings = loadRun(activeFile).settings;
            } catch {
              settings = null;
            }
          }
          json(res, 200, { project: payload, settings });
          return;
        }
        if (req.method === 'PATCH') {
          const body = parseBody(req, await readBody(req)) as { name?: string };
          const name = body.name?.trim();
          if (!name) {
            json(res, 400, { error: 'name is required' });
            return;
          }
          addProject(entry.file, name);
          json(res, 200, { project: projectPayload({ ...entry, name }) });
          return;
        }
        if (req.method === 'DELETE') {
          const removed = removeProject(id);
          json(res, removed ? 200 : 404, removed ? { removed: id } : { error: `unknown project ${id}` });
          return;
        }
        json(res, 405, { error: `${req.method} not allowed` });
        return;
      }

      // ---- folder browser for the add-project flow ----
      if (path === '/api/fs' && req.method === 'GET') {
        const wanted = cleanPath(url.searchParams.get('dir') ?? '');
        const dir = wanted ? resolve(wanted) : homedir();
        let entries: { name: string; path: string; hasRun: boolean }[] = [];
        try {
          entries = readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => ({
              name: e.name,
              path: join(dir, e.name),
              hasRun: existsSync(join(dir, e.name, 'dag.run.json')),
            }))
            .sort((a, b) => Number(b.hasRun) - Number(a.hasRun) || a.name.localeCompare(b.name));
        } catch (err) {
          json(res, 400, {
            error: `cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        const parent = dirname(dir);
        json(res, 200, {
          dir,
          parent: parent === dir ? null : parent,
          isProject: existsSync(join(dir, 'dag.run.json')),
          dirs: entries,
        });
        return;
      }

      if (path === '/api/context' && req.method === 'GET') {
        json(res, 200, {
          singleRunMode,
          defaultRunId,
          runIds: [...runtimes.keys()],
          port: listeningPort,
          staleBuild: staleBuild(),
        });
        return;
      }

      if (path === '/api/models' && req.method === 'GET') {
        const { models, error } = await listAgentModels(url.searchParams.get('refresh') === '1');
        json(res, 200, { models, error, source: 'opencode models' });
        return;
      }

      // ---- register a project (and give it a first run if it has none) ----
      if (path === '/api/projects' && req.method === 'POST') {
        const body = parseBody(req, await readBody(req)) as { dir?: string; name?: string };
        if (!body.dir) {
          json(res, 400, { error: 'dir is required' });
          return;
        }
        const entry = addProject(body.dir, body.name);
        const dir = projectOf(entry.file);
        if (!existsSync(activeRunFile(dir))) {
          startNewRun(dir, entry.name);
        }
        json(res, 200, {
          project: { projectId: projectId(entry.file), name: entry.name, dir },
          runs: listRuns(dir),
        });
        return;
      }

      // ---- archive the active run and start a fresh one ----
      if (path === '/api/runs/new' && req.method === 'POST') {
        const body = parseBody(req, await readBody(req)) as { dir?: string; objective?: string };
        if (!body.dir) {
          json(res, 400, { error: 'dir is required' });
          return;
        }
        const entry = addProject(body.dir);
        const dir = projectOf(entry.file);
        const active = activeRunFile(dir);
        if (existsSync(active)) {
          // Archiving replaces the run file: doing that under a live runner
          // (this process's or another's) destroys both runs.
          const busy = activeRuntimeForFile(active);
          if (busy) {
            json(res, 409, { error: `run ${busy.runId} is in progress; stop it before starting a new one` });
            return;
          }
          try {
            assertNoForeignLock(active);
          } catch (err) {
            json(res, 409, { error: err instanceof Error ? err.message : String(err) });
            return;
          }
        }
        const { run, archivedTo } = startNewRun(dir, body.objective ?? entry.name);
        // The archived run's cached runtime now points at the new file.
        for (const [id, rt] of runtimes) {
          if (resolve(rt.file) === resolve(active)) dropRuntime(id);
        }
        runtimeFor(run.id);
        json(res, 200, { runId: run.id, archivedTo, project: { name: entry.name, dir } });
        return;
      }

      // ---- per-run routes: /api/runs/:runId/<rest> ----
      const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/.*)?$/);
      if (runMatch) {
        const runId = runMatch[1];
        const rest = runMatch[2] ?? '';
        const rt = runtimeFor(runId);
        if (!rt) {
          const dirs = ambiguousRunId(runId);
          if (dirs.length > 1) {
            json(res, 409, {
              error: `run id ${runId} exists in ${dirs.length} projects (${dirs.join(', ')}); ids are only unique per project`,
            });
            return;
          }
          json(res, 404, { error: `unknown run ${runId}` });
          return;
        }
        await handleRunRoute(req, res, url, rt, rest);
        return;
      }

      // ---- pages ----
      // Pages are read from disk per request, but the routes were frozen when
      // this process started. If the code on disk is newer, this process would
      // serve a page whose API it does not implement (the page then hangs on
      // "loading…"), so say so instead.
      const page = async (name: string): Promise<void> => {
        if (staleBuild()) {
          res.writeHead(503, { 'content-type': 'text/html' });
          res.end(
            `<!doctype html><meta charset="utf-8"><title>DAG Orchestrator — restart needed</title>` +
              `<body style="background:#04070d;color:#d7f5ff;font:14px ui-monospace,Consolas,monospace;padding:40px">` +
              `<h1 style="color:#ffc400;font-size:16px;letter-spacing:.1em">THE HUB IS RUNNING OLDER CODE</h1>` +
              `<p>This process started before the code on disk changed, so it cannot serve the viewer.</p>` +
              `<p>Stop it and start it again:</p>` +
              `<pre style="background:#0b1220;border:1px solid #1e2a3f;padding:12px">dag serve</pre>` +
              `<p style="color:#6f9db4">(Single-run mode: <code>dag serve --file &lt;run file&gt;</code>)</p>` +
              `</body>`,
          );
          return;
        }
        const html = await readFile(join(here, '..', 'viewer', name), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html);
      };

      if (path === '/' && req.method === 'GET') {
        if (singleRunMode && defaultRunId) {
          res.writeHead(302, { location: `/r/${defaultRunId}` });
          res.end();
          return;
        }
        await page('index.html');
        return;
      }
      if (path.match(/^\/p\/[^/]+\/?$/) && req.method === 'GET') {
        await page('project.html');
        return;
      }
      const pageMatch = path.match(/^\/r\/([^/]+)\/?$/);
      if (pageMatch && req.method === 'GET') {
        await page('run.html');
        return;
      }
      if (path === '/vendor/vis-network.min.js' && req.method === 'GET') {
        const js = await readFile(join(here, '..', 'viewer', 'vendor', 'vis-network.min.js'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(js);
        return;
      }
      res.writeHead(404).end('not found');
    } catch (err) {
      const code = (err as { code?: number }).code ?? 500;
      if (code >= 500) {
        res.writeHead(500).end(err instanceof Error ? err.message : String(err));
        return;
      }
      json(res, code, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  async function handleRunRoute(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    url: URL,
    rt: RunRuntime,
    rest: string,
  ): Promise<void> {
    const file = rt.file;

    if (rest === '/run' && req.method === 'GET') {
      if (!existsSync(file)) {
        json(res, 404, { error: `no run file at ${file}` });
        return;
      }
      json(res, 200, {
        run: currentRun(rt),
        job: jobView(rt),
        meta: {
          file,
          port: listeningPort,
          runId: rt.runId,
          name: projectName(rt.projectDir),
          projectId: projectId(join(rt.projectDir, 'dag.run.json')),
          projectDir: rt.projectDir,
          archived: rt.archived,
        },
      });
      return;
    }

    if (rest === '/summary' && req.method === 'GET') {
      if (!existsSync(file)) {
        json(res, 409, { error: `no run file at ${file}`, missing: true });
        return;
      }
      const run = currentRun(rt);
      const since = Number(url.searchParams.get('since') ?? -1);
      if (since === run.rev) {
        json(res, 200, {
          rev: run.rev,
          unchanged: true,
          file,
          name: projectName(rt.projectDir),
          projectId: projectId(join(rt.projectDir, 'dag.run.json')),
          archived: rt.archived,
          job: jobView(rt),
          staleBuild: staleBuild(),
        });
        return;
      }
      json(res, 200, {
        ...summaryPayload(run),
        file,
        name: projectName(rt.projectDir),
        projectId: projectId(join(rt.projectDir, 'dag.run.json')),
        archived: rt.archived,
        job: jobView(rt),
        staleBuild: staleBuild(),
      });
      return;
    }

    if (rest === '/definition' && req.method === 'GET') {
      if (!existsSync(file)) {
        json(res, 409, { error: 'no run file', missing: true });
        return;
      }
      json(res, 200, definitionPayload(currentRun(rt)));
      return;
    }

    if (rest === '/events' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const events = readEventTail(file).filter((e) => e.seq > since);
      json(res, 200, {
        events: events.slice(-500),
        latestSeq: events.length > 0 ? events[events.length - 1].seq : since,
      });
      return;
    }

    if (rest === '/run/start' && req.method === 'POST') {
      const body = parseBody(req, await readBody(req)) as unknown as StartOptions;
      const result = await startRun(rt, body);
      json(res, result.started ? 200 : (result.code ?? 400), result);
      return;
    }

    if (rest === '/run/stop' && req.method === 'POST') {
      if (!rt.runner?.isRunning) {
        json(res, 409, { error: 'no run in progress' });
        return;
      }
      if (!rt.runner.isStopping) void rt.runner.stop();
      json(res, 200, { stopping: true });
      return;
    }

    if (rest === '/archive' && req.method === 'POST') {
      if (rt.runner?.isRunning) {
        json(res, 409, { error: 'stop the run before archiving it' });
        return;
      }
      const target = archiveRun(rt.projectDir, rt.file);
      if (!target) {
        json(res, 400, { error: 'nothing to archive' });
        return;
      }
      runtimes.delete(rt.runId);
      json(res, 200, { archivedTo: target });
      return;
    }

    const guardArchived = (): boolean => {
      if (!rt.archived) return false;
      json(res, 409, { error: 'archived runs are read-only history' });
      return true;
    };

    if (rest === '/retry' && req.method === 'POST') {
      if (guardArchived()) return;
      if (rt.runner?.isRunning) {
        json(res, 409, { error: 'stop the run before retrying tasks' });
        return;
      }
      const body = parseBody(req, await readBody(req)) as {
        ids?: string[] | null;
        cascade?: boolean;
      };
      try {
        assertNoForeignLock(file);
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const touched = await mutate(
        file,
        (run) => {
          if (body.ids && body.ids.length > 0) {
            const out: string[] = [];
            for (const taskId of body.ids) out.push(...retryTask(run, taskId, body.cascade ?? false));
            return out;
          }
          return retryFailed(run, body.cascade ?? false);
        },
        'viewer retry',
      );
      json(res, 200, { retried: touched });
      return;
    }

    if (rest === '/skip-blocked' && req.method === 'POST') {
      if (guardArchived()) return;
      if (rt.runner?.isRunning) {
        json(res, 409, { error: 'stop the run before skipping tasks' });
        return;
      }
      try {
        assertNoForeignLock(file);
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const skipped = await mutate(
        file,
        (run) => [...skipBlocked(run), ...skipGated(run)],
        'viewer skip',
      );
      json(res, 200, { skipped });
      return;
    }

    if (rest === '/kill-orphans' && req.method === 'POST') {
      if (guardArchived()) return;
      if (rt.runner?.isRunning) {
        json(res, 409, { error: 'stop the run before killing orphans' });
        return;
      }
      try {
        assertNoForeignLock(file);
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const killed = await mutate(file, (run) => killOrphans(run), 'viewer kill-orphans');
      json(res, 200, { killed });
      return;
    }

    const logMatch = rest.match(/^\/logs\/([^/]+)$/);
    if (logMatch && req.method === 'GET') {
      const taskId = logMatch[1];
      const attempts = attemptLogFiles(file, taskId);
      if (attempts.length === 0) {
        json(res, 404, { error: `no attempt logs for ${taskId}` });
        return;
      }
      const requested = url.searchParams.get('attempt');
      const attempt = requested ? Number(requested) : attempts[attempts.length - 1];
      json(res, 200, { attempts, attempt, content: readAttemptLog(file, taskId, attempt) });
      return;
    }

    // Project-scoped settings live on the run file, so the project page edits
    // them here rather than shipping a second settings store.
    if (rest === '/settings' && req.method === 'PATCH') {
      if (guardArchived()) return;
      const body = parseBody(req, await readBody(req)) as Record<string, unknown>;
      const allowed = new Set([
        'concurrency',
        'model',
        'variant',
        'worktree',
        'worktreePrepareCmd',
        'finalReview',
        'finalReviewRounds',
        'finalReviewCmd',
        'failOnNonZeroExit',
        'notifyCmd',
        'maxAttempts',
        'timeoutMs',
        'silenceMs',
        'silenceAction',
        'onDepFailure',
        'onGateBlocked',
        'maxWallClockMs',
      ]);
      const unknown = Object.keys(body).filter((k) => !allowed.has(k));
      if (unknown.length > 0) {
        json(res, 400, { error: `cannot set: ${unknown.join(', ')}` });
        return;
      }
      // Keys are not values: "banana" for a concurrency and "typo" for an
      // isolation mode used to be accepted and persisted.
      const problems = validateSettingsPatch(body);
      if (problems.length > 0) {
        json(res, 400, { error: describeSettingsProblems(problems), problems });
        return;
      }
      if (rt.runner?.isRunning) {
        json(res, 409, { error: 'stop the run before changing its settings' });
        return;
      }
      try {
        assertNoForeignLock(file);
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const settings = await mutate(
        file,
        (run) => {
          Object.assign(run.settings, body);
          return run.settings;
        },
        'viewer settings',
      );
      json(res, 200, { settings });
      return;
    }

    const taskMatch = rest.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch && req.method === 'GET') {
      const run = currentRun(rt);
      const task = run.tasks[taskMatch[1]];
      if (!task) {
        json(res, 404, { error: `unknown task ${taskMatch[1]}` });
        return;
      }
      json(res, 200, { task, display: deriveStatus(run, task) });
      return;
    }

    if (taskMatch && req.method === 'POST') {
      if (guardArchived()) return;
      const taskId = taskMatch[1];
      const active = rt.runner?.isRunning === true;
      if (active && rt.runner?.state.tasks[taskId]?.status === 'running') {
        json(res, 409, { error: `task ${taskId} is running; stop the run first` });
        return;
      }
      const body = parseBody(req, await readBody(req)) as {
        status?: Task['status'];
        result?: string | null;
        approved?: boolean | null;
        model?: string | null;
        variant?: string | null;
      };
      const apply = (run: Run): unknown => {
        const task = run.tasks[taskId];
        if (!task) throw new Error(`unknown task ${taskId}`);
        if (body.status) task.status = body.status;
        if (body.result !== undefined) task.result = body.result;
        if (body.approved !== undefined && task.gate) task.gate.approved = body.approved;
        if (body.model !== undefined) task.model = body.model;
        if (body.variant !== undefined) task.variant = body.variant;
        logEvent(run, 'edit', taskId, 'updated from viewer');
        return { id: taskId, status: task.status, display: deriveStatus(run, task) };
      };
      if (active && rt.runner) {
        json(res, 200, apply(rt.runner.state));
        saveRun(rt.runner.state, file);
      } else {
        try {
          assertNoForeignLock(file);
        } catch (err) {
          json(res, 409, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        json(res, 200, await mutate(file, apply, 'viewer edit'));
      }
      return;
    }

    json(res, 404, { error: `unknown route ${rest}` });
  }

  let port = basePort;
  let attempts = 0;
  server.on('listening', () => {
    listeningPort = (server.address() as { port: number } | null)?.port ?? port;
    console.log(`DAG Orchestrator: http://localhost:${listeningPort}`);
    if (singleRunMode) {
      console.log(`run: ${defaultRunId ?? '(none)'} → ${opts.file}`);
    } else {
      const projects = loadRegistry().projects;
      console.log(
        projects.length === 0
          ? 'no projects registered yet; add one from the index page'
          : `projects: ${projects.map((p) => p.name).join(', ')}`,
      );
    }
    if (opts.open) openBrowser(`http://localhost:${listeningPort}`);
    if (opts.autoResume) void autoResumeAll(opts.killOrphansOnResume ?? false);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attempts < 10) {
      console.log(`port ${port} busy, trying ${port + 1}...`);
      port += 1;
      attempts += 1;
      server.listen(port, '127.0.0.1');
      return;
    }
    console.error(`failed to start server on port ${port}: ${err.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1');

  const shutdown = (): void => {
    void (async () => {
      for (const rt of runtimes.values()) {
        try {
          if (rt.runner?.isRunning) await rt.runner.stop();
        } finally {
          rt.releaseLock?.();
        }
      }
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  async function autoResumeAll(killOrphansOnResume: boolean): Promise<void> {
    for (const dir of projectDirs()) {
      const active = activeRunFile(dir);
      if (!existsSync(active)) continue;
      const row = listRuns(dir).find((r) => !r.archived);
      if (!row) continue;
      const rt = runtimeFor(row.runId);
      if (!rt) continue;
      try {
        assertNoForeignLock(rt.file);
      } catch (err) {
        console.log(`auto-resume: ${projectName(dir)}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (killOrphansOnResume) {
        const killed = await mutate(rt.file, (run) => killOrphans(run), 'serve auto-resume');
        const n = killed.filter((k) => k.killed).length;
        if (n > 0) console.log(`auto-resume: ${projectName(dir)}: killed ${n} orphan(s)`);
      }
      const run = loadRun(rt.file);
      if (getReady(run).length === 0) continue;
      const result = await startRun(rt, { ids: null });
      console.log(
        result.started
          ? `auto-resume: ${projectName(dir)}: running ${result.scope?.length ?? 0} task(s)`
          : `auto-resume: ${projectName(dir)}: not started (${result.error})`,
      );
    }
  }
}

export function stopServer(): void {
  void (async () => {
    for (const rt of runtimes.values()) await rt.runner?.stop();
  })();
}
