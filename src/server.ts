import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  newRun,
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
  findProject,
  projectId,
  removeProject,
  resolveRunFile,
  type ProjectEntry,
} from './registry.js';
import type { DepFailurePolicy, GatePolicy, Run, Task } from './types.js';
import { MAX_CONCURRENCY } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface ServeOptions {
  // Single-project focus for `dag serve`. Omit for hub mode (registry).
  file?: string;
  port?: number;
  autoResume?: boolean;
  killOrphansOnResume?: boolean;
  open?: boolean;
}

// One runtime per project. Locks are per run file, so projects never
// interfere: separate runners, separate scopes, separate event logs.
interface ProjectRuntime {
  entry: ProjectEntry;
  runner: DagRunner | null;
  releaseLock: (() => void) | null;
  jobStartedAt: string | null;
  activeScope: string[] | null;
  starting: boolean;
}

const runtimes = new Map<string, ProjectRuntime>();
let defaultId: string | null = null;
let listeningPort = 0;

function ensureRuntime(entry: ProjectEntry): ProjectRuntime {
  const id = projectId(entry.file);
  let rt = runtimes.get(id);
  if (!rt) {
    rt = {
      entry,
      runner: null,
      releaseLock: null,
      jobStartedAt: null,
      activeScope: null,
      starting: false,
    };
    runtimes.set(id, rt);
  } else {
    rt.entry = entry;
  }
  return rt;
}

function runtimeFor(id: string): ProjectRuntime | null {
  const existing = runtimes.get(id);
  if (existing) return existing;
  const entry = findProject(id);
  return entry ? ensureRuntime(entry) : null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function fileOf(rt: ProjectRuntime): string {
  return rt.entry.file;
}

function currentRun(file: string, rt: ProjectRuntime): Run {
  return rt.runner && (rt.runner.isRunning || rt.runner.isStopping)
    ? rt.runner.state
    : loadRun(file);
}

function jobView(rt: ProjectRuntime): Record<string, unknown> {
  const active = rt.runner?.isRunning || rt.runner?.isStopping;
  // A run started elsewhere (CLI, scheduler) holds the lock; the viewer must
  // say so instead of offering a Run button that will be refused.
  const foreign = active ? null : foreignLock(fileOf(rt));
  return {
    running: rt.runner?.isRunning ?? false,
    stopping: rt.runner?.isStopping ?? false,
    current: active ? (rt.runner?.current ?? []) : [],
    result: active ? null : (rt.runner?.result ?? null),
    startedAt: active ? rt.jobStartedAt : null,
    scope: active ? rt.activeScope : null,
    external: foreign
      ? { pid: foreign.pid, note: foreign.note, startedAt: foreign.startedAt }
      : null,
  };
}

// Cheap fingerprint of the definition so the viewer can skip refetches.
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

function projectView(rt: ProjectRuntime): Record<string, unknown> {
  const file = fileOf(rt);
  const base = {
    id: projectId(file),
    name: rt.entry.name,
    file,
    job: jobView(rt),
  };
  if (!existsSync(file)) return { ...base, missing: true, counts: {}, total: 0, objective: null };
  try {
    const run = currentRun(file, rt);
    const counts: Record<string, number> = {};
    for (const t of Object.values(run.tasks)) {
      const d = deriveStatus(run, t);
      counts[d] = (counts[d] ?? 0) + 1;
    }
    return {
      ...base,
      missing: false,
      runId: run.id,
      objective: run.objective,
      updatedAt: run.updatedAt,
      counts,
      total: Object.keys(run.tasks).length,
    };
  } catch (err) {
    return {
      ...base,
      missing: false,
      error: err instanceof Error ? err.message : String(err),
      counts: {},
      total: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Run lifecycle (per project)
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
  force?: boolean;
}

interface StartResult {
  started: boolean;
  scope?: string[];
  skippedManual?: string[];
  error?: string;
  code?: number;
}

async function startRun(rt: ProjectRuntime, opts: StartOptions): Promise<StartResult> {
  const file = fileOf(rt);
  if (rt.runner?.isRunning || rt.runner?.isStopping || rt.starting) {
    return { started: false, error: 'a run is already in progress', code: 409 };
  }
  if (!existsSync(file)) {
    return { started: false, error: `no run file at ${file}; create one first`, code: 400 };
  }
  rt.starting = true;
  let lock: (() => void) | null = null;
  try {
    try {
      lock = acquireLock(file, `serve run (${rt.entry.name})`, opts.force ?? false);
    } catch (err) {
      return { started: false, error: err instanceof Error ? err.message : String(err), code: 409 };
    }

    let run: Run;
    try {
      run = loadRun(file);
    } catch (err) {
      // A corrupt or missing run file must not leak the lock.
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
      run.settings.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, opts.concurrency));
    }
    if (opts.timeoutMs !== undefined) run.settings.timeoutMs = Math.max(0, opts.timeoutMs);
    if (opts.silenceMs !== undefined) run.settings.silenceMs = Math.max(0, opts.silenceMs);
    if (opts.maxAttempts !== undefined) {
      run.settings.maxAttempts = Math.max(1, opts.maxAttempts);
    }
    if (opts.onDepFailure !== undefined) run.settings.onDepFailure = opts.onDepFailure;
    if (opts.onGateBlocked !== undefined) run.settings.onGateBlocked = opts.onGateBlocked;
    if (opts.maxWallClockMs !== undefined) {
      run.settings.maxWallClockMs = Math.max(0, opts.maxWallClockMs);
    }
    if (opts.notifyCmd !== undefined) run.settings.notifyCmd = opts.notifyCmd;
    if (opts.model !== undefined) run.settings.model = opts.model;
    if (opts.variant !== undefined) run.settings.variant = opts.variant;
    if (opts.worktree !== undefined) run.settings.worktree = opts.worktree;
    saveRun(run, file);

    // Manual tasks (no cmd) are skipped, not failed.
    const candidates = opts.ids ?? Object.keys(run.tasks);
    const manual = candidates.filter(
      (id) =>
        !run.tasks[id].cmd &&
        (run.tasks[id].status === 'pending' || run.tasks[id].status === 'ready'),
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

    rt.runner = new DagRunner(run, {
      file,
      persist: (state) => saveRun(state, file),
    });
    rt.releaseLock = lock;
    rt.jobStartedAt = new Date().toISOString();
    rt.activeScope = scope;
    if (manual.length > 0) {
      logEvent(run, 'note', null, `skipped ${manual.length} manual task(s) without cmd: ${manual.join(', ')}`);
    }
    void rt.runner.start(new Set(scope)).finally(() => {
      rt.releaseLock?.();
      rt.releaseLock = null;
      saveRun(run, file);
    });
    return { started: true, scope, skippedManual: manual };
  } catch (err) {
    // Any unexpected failure before the runner takes ownership releases the lock.
    if (lock && !rt.releaseLock) lock();
    return { started: false, error: err instanceof Error ? err.message : String(err), code: 500 };
  } finally {
    rt.starting = false;
  }
}

async function autoResumeAll(killOrphansOnResume: boolean): Promise<void> {
  for (const rt of runtimes.values()) {
    const file = fileOf(rt);
    if (!existsSync(file)) continue;
    try {
      assertNoForeignLock(file);
    } catch (err) {
      console.log(`auto-resume: ${rt.entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    try {
      if (killOrphansOnResume) {
        const killed = await mutate(file, (run) => killOrphans(run));
        const n = killed.filter((k) => k.killed).length;
        if (n > 0) console.log(`auto-resume: ${rt.entry.name}: killed ${n} orphan(s)`);
      }
      const run = loadRun(file);
      const hasWork = getReady(run).length > 0;
      if (!hasWork) continue;
      const result = await startRun(rt, { ids: null });
      if (result.started) {
        console.log(`auto-resume: ${rt.entry.name}: running ${result.scope?.length ?? 0} task(s)`);
      } else if (result.error) {
        console.log(`auto-resume: ${rt.entry.name}: not started (${result.error})`);
      }
    } catch (err) {
      console.log(`auto-resume: ${rt.entry.name}: failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startServer(opts: ServeOptions): void {
  const basePort = opts.port ?? 8787;

  if (opts.file) {
    const entry = addProject(opts.file);
    defaultId = projectId(entry.file);
    ensureRuntime(entry);
  }

  const reportCrash = (kind: string, err: unknown): void => {
    console.error(`[lightweight-dag] ${kind}: ${err instanceof Error ? err.message : String(err)}`);
  };
  process.on('uncaughtException', (err) => reportCrash('uncaught exception', err));
  process.on('unhandledRejection', (err) => reportCrash('unhandled rejection', err));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      // ---- project registry ----
      if (path === '/api/projects' && req.method === 'GET') {
        const projects = [...runtimes.values()].map((rt) => projectView(rt));
        json(res, 200, { projects, defaultId, port: listeningPort });
        return;
      }

      if (path === '/api/models' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        const { models, error } = listAgentModels(force);
        json(res, 200, { models, error, source: 'opencode models' });
        return;
      }

      if (path === '/api/projects' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { dir?: string; name?: string };
        if (!body.dir) {
          json(res, 400, { error: 'dir is required' });
          return;
        }
        const target = resolveRunFile(body.dir);
        const entry = addProject(body.dir, body.name);
        if (!existsSync(target)) {
          const run = newRun(body.name ?? entry.name);
          saveRun(run, target);
        }
        const rt = ensureRuntime(entry);
        if (!defaultId) defaultId = projectId(entry.file);
        json(res, 200, { project: projectView(rt) });
        return;
      }

      const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
      if (projectMatch) {
        const id = projectMatch[1];
        const rest = projectMatch[2] ?? '';
        const rt = runtimeFor(id);
        if (!rt) {
          json(res, 404, { error: `unknown project ${id}` });
          return;
        }
        if (rest === '' && req.method === 'DELETE') {
          if (rt.runner?.isRunning) {
            json(res, 409, { error: 'stop the run before removing the project' });
            return;
          }
          removeProject(fileOf(rt));
          runtimes.delete(id);
          if (defaultId === id) defaultId = [...runtimes.keys()][0] ?? null;
          json(res, 200, { removed: true });
          return;
        }
        await handleProjectRoute(req, res, url, rt, rest);
        return;
      }

      // ---- legacy single-project routes ----
      const legacyRt = defaultId ? runtimes.get(defaultId) : null;
      if (!legacyRt) {
        if (path === '/' || path === '/index.html') {
          const html = await readFile(join(here, '..', 'viewer', 'index.html'), 'utf8');
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(html);
          return;
        }
        if (path.startsWith('/api/')) {
          json(res, 409, { error: 'no project registered yet; add one from the viewer' });
          return;
        }
      } else if (path.startsWith('/api/') && !path.startsWith('/api/projects')) {
        const rest = path.slice('/api'.length);
        const handled = await handleProjectRoute(req, res, url, legacyRt, rest);
        if (handled !== false) return;
      }

      if (path === '/vendor/vis-network.min.js' && req.method === 'GET') {
        const js = await readFile(join(here, '..', 'viewer', 'vendor', 'vis-network.min.js'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(js);
        return;
      }
      if ((path === '/' || path === '/index.html') && req.method === 'GET') {
        const html = await readFile(join(here, '..', 'viewer', 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html);
        return;
      }
      res.writeHead(404).end('not found');
    } catch (err) {
      res.writeHead(500).end(err instanceof Error ? err.message : String(err));
    }
  });

  // Shared per-project routes: `/api/projects/:id/<rest>`, and the same
  // handlers behind the legacy `/api/<rest>` for the default project.
  async function handleProjectRoute(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    url: URL,
    rt: ProjectRuntime,
    rest: string,
  ): Promise<boolean> {
    const file = fileOf(rt);

    if (rest === '/init' && req.method === 'POST') {
      if (existsSync(file)) {
        json(res, 200, { created: false });
        return true;
      }
      const body = JSON.parse((await readBody(req)) || '{}') as { objective?: string };
      saveRun(newRun(body.objective ?? rt.entry.name), file);
      json(res, 200, { created: true });
      return true;
    }

    if (rest === '/run' && req.method === 'GET') {
      if (!existsSync(file)) {
        json(res, 404, { error: `no run file at ${file}` });
        return true;
      }
      json(res, 200, {
        run: currentRun(file, rt),
        job: jobView(rt),
        meta: { file, port: listeningPort, id: projectId(file), name: rt.entry.name },
      });
      return true;
    }

    if (rest === '/summary' && req.method === 'GET') {
      if (!existsSync(file)) {
        json(res, 409, { error: `no run file at ${file}; init the project first`, missing: true });
        return true;
      }
      const run = currentRun(file, rt);
      const since = Number(url.searchParams.get('since') ?? -1);
      if (since === run.rev) {
        json(res, 200, { rev: run.rev, unchanged: true, file, job: jobView(rt) });
        return true;
      }
      json(res, 200, { ...summaryPayload(run), file, job: jobView(rt) });
      return true;
    }

    if (rest === '/definition' && req.method === 'GET') {
      if (!existsSync(file)) {
        json(res, 409, { error: 'no run file yet', missing: true });
        return true;
      }
      json(res, 200, definitionPayload(currentRun(file, rt)));
      return true;
    }

    if (rest === '/events' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const events = readEventTail(file).filter((e) => e.seq > since);
      json(res, 200, {
        events: events.slice(-500),
        latestSeq: events.length > 0 ? events[events.length - 1].seq : since,
      });
      return true;
    }

    if (rest === '/run/start' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as StartOptions;
      const result = await startRun(rt, body);
      json(res, result.started ? 200 : (result.code ?? 400), result);
      return true;
    }

    if (rest === '/run/stop' && req.method === 'POST') {
      if (!rt.runner?.isRunning) {
        json(res, 409, { error: 'no run in progress' });
        return true;
      }
      if (!rt.runner.isStopping) void rt.runner.stop();
      json(res, 200, { stopping: true });
      return true;
    }

    if (rest === '/retry' && req.method === 'POST') {
      if (rt.runner?.isRunning) {
        json(res, 409, { error: 'stop the run before retrying tasks' });
        return true;
      }
      const body = JSON.parse((await readBody(req)) || '{}') as {
        ids?: string[] | null;
        cascade?: boolean;
      };
      try {
        assertNoForeignLock(file);
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
      const touched = await mutate(file, (run) => {
        if (body.ids && body.ids.length > 0) {
          const out: string[] = [];
          for (const taskId of body.ids) out.push(...retryTask(run, taskId, body.cascade ?? false));
          return out;
        }
        return retryFailed(run, body.cascade ?? false);
      });
      json(res, 200, { retried: touched });
      return true;
    }

    if (rest === '/skip-blocked' && req.method === 'POST') {
      if (rt.runner?.isRunning) {
        json(res, 409, { error: 'stop the run before skipping tasks' });
        return true;
      }
      try {
        assertNoForeignLock(file);
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
      const skipped = await mutate(file, (run) => [...skipBlocked(run), ...skipGated(run)]);
      json(res, 200, { skipped });
      return true;
    }

    if (rest === '/kill-orphans' && req.method === 'POST') {
      if (rt.runner?.isRunning) {
        json(res, 409, { error: 'stop the run before killing orphans' });
        return true;
      }
      try {
        assertNoForeignLock(file);
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
      const killed = await mutate(file, (run) => killOrphans(run));
      json(res, 200, { killed });
      return true;
    }

    const logMatch = rest.match(/^\/logs\/([^/]+)$/);
    if (logMatch && req.method === 'GET') {
      const taskId = logMatch[1];
      const attempts = attemptLogFiles(file, taskId);
      if (attempts.length === 0) {
        json(res, 404, { error: `no attempt logs for ${taskId}` });
        return true;
      }
      const requested = url.searchParams.get('attempt');
      const attempt = requested ? Number(requested) : attempts[attempts.length - 1];
      json(res, 200, { attempts, attempt, content: readAttemptLog(file, taskId, attempt) });
      return true;
    }

    const taskMatch = rest.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch && req.method === 'GET') {
      if (!existsSync(file)) {
        json(res, 404, { error: 'no run file yet' });
        return true;
      }
      const run = currentRun(file, rt);
      const task = run.tasks[taskMatch[1]];
      if (!task) {
        json(res, 404, { error: `unknown task ${taskMatch[1]}` });
        return true;
      }
      json(res, 200, { task, display: deriveStatus(run, task) });
      return true;
    }

    if (taskMatch && req.method === 'POST') {
      const taskId = taskMatch[1];
      const active = rt.runner?.isRunning === true;
      if (active && rt.runner?.state.tasks[taskId]?.status === 'running') {
        json(res, 409, { error: `task ${taskId} is running; stop the run first` });
        return true;
      }
      const body = JSON.parse((await readBody(req)) || '{}') as {
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
        assertNoForeignLock(file);
        json(res, 200, await mutate(file, apply));
      }
      return true;
    }

    return false;
  }

  let port = basePort;
  let attempts = 0;
  server.on('listening', () => {
    listeningPort = (server.address() as { port: number } | null)?.port ?? port;
    console.log(`lightweight-dag: http://localhost:${listeningPort}`);
    for (const rt of runtimes.values()) console.log(`project: ${rt.entry.name} → ${rt.entry.file}`);
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
  // Bind loopback only: this is a local tool, not a network service.
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
}
