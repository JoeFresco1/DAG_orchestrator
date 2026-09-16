import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
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
  loadRegistry,
  projectId,
  type ProjectEntry,
} from './registry.js';
import { activeRunFile, archiveRun, findRun, listRuns, projectOf, startNewRun } from './runs.js';
import type { DepFailurePolicy, GatePolicy, Run, Task } from './types.js';

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
  return loadRegistry().projects.map((p) => p.file).map((f) => projectOf(f));
}

function runtimeFor(runId: string): RunRuntime | null {
  const existing = runtimes.get(runId);
  if (existing) return existing;
  for (const dir of projectDirs()) {
    const found = findRun(dir, runId);
    if (!found) continue;
    const rt: RunRuntime = {
      runId,
      projectDir: dir,
      file: found.file,
      archived: found.archived,
      runner: null,
      releaseLock: null,
      jobStartedAt: null,
      activeScope: null,
      starting: false,
    };
    runtimes.set(runId, rt);
    return rt;
  }
  return null;
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
    void rt.runner.start(new Set(scope)).finally(() => {
      rt.releaseLock?.();
      rt.releaseLock = null;
      saveRun(run, rt.file);
    });
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

      // ---- index: projects and their runs ----
      if (path === '/api/runs' && req.method === 'GET') {
        const registry = loadRegistry();
        const projects = registry.projects.map((entry: ProjectEntry) => {
          const dir = projectOf(entry.file);
          return {
            projectId: projectId(entry.file),
            name: entry.name,
            dir,
            runs: listRuns(dir).map((row) => ({
              ...row,
              job: runtimes.get(row.runId) ? jobView(runtimes.get(row.runId) as RunRuntime) : null,
            })),
          };
        });
        json(res, 200, { projects, singleRunMode, defaultRunId, port: listeningPort });
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
        const { models, error } = listAgentModels(url.searchParams.get('refresh') === '1');
        json(res, 200, { models, error, source: 'opencode models' });
        return;
      }

      // ---- register a project (and give it a first run if it has none) ----
      if (path === '/api/projects' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as { dir?: string; name?: string };
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
        const body = JSON.parse((await readBody(req)) || '{}') as { dir?: string; objective?: string };
        if (!body.dir) {
          json(res, 400, { error: 'dir is required' });
          return;
        }
        const entry = addProject(body.dir);
        const dir = projectOf(entry.file);
        const active = activeRunFile(dir);
        if (existsSync(active)) {
          try {
            assertNoForeignLock(active);
          } catch (err) {
            json(res, 409, { error: err instanceof Error ? err.message : String(err) });
            return;
          }
        }
        const { run, archivedTo } = startNewRun(dir, body.objective ?? entry.name);
        const rt = runtimeFor(run.id);
        json(res, 200, { runId: run.id, archivedTo, project: { name: entry.name, dir } });
        void rt;
        return;
      }

      // ---- per-run routes: /api/runs/:runId/<rest> ----
      const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/.*)?$/);
      if (runMatch) {
        const runId = runMatch[1];
        const rest = runMatch[2] ?? '';
        const rt = runtimeFor(runId);
        if (!rt) {
          json(res, 404, { error: `unknown run ${runId}` });
          return;
        }
        await handleRunRoute(req, res, url, rt, rest);
        return;
      }

      // ---- pages ----
      if (path === '/' && req.method === 'GET') {
        if (singleRunMode && defaultRunId) {
          res.writeHead(302, { location: `/r/${defaultRunId}` });
          res.end();
          return;
        }
        const html = await readFile(join(here, '..', 'viewer', 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html);
        return;
      }
      const pageMatch = path.match(/^\/r\/([^/]+)\/?$/);
      if (pageMatch && req.method === 'GET') {
        const html = await readFile(join(here, '..', 'viewer', 'run.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html);
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
      res.writeHead(500).end(err instanceof Error ? err.message : String(err));
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
      const body = JSON.parse((await readBody(req)) || '{}') as StartOptions;
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
      const body = JSON.parse((await readBody(req)) || '{}') as {
        ids?: string[] | null;
        cascade?: boolean;
      };
      try {
        assertNoForeignLock(file);
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        return;
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
      const skipped = await mutate(file, (run) => [...skipBlocked(run), ...skipGated(run)]);
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
      const killed = await mutate(file, (run) => killOrphans(run));
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
        const killed = await mutate(rt.file, (run) => killOrphans(run));
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
