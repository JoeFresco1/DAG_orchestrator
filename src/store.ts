import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertNoCycle, isTerminal, topoSort, transitiveBlocked } from './graph.js';
import type { Reviewer } from './review-policy.js';
import type { HarnessCandidate } from './harness-chain.js';
import {
  DEFAULT_SETTINGS,
  DEFINITION_FIELDS,
  DYNAMIC_FIELDS,
  EVENT_LOG_ROTATE_BYTES,
  EVENT_RING_LIMIT,
  STORAGE_VERSION,
  type DagEvent,
  type EventType,
  type Run,
  type RunSettings,
  type Task,
  type TaskStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Layout. One run file plus a sidecar directory:
//   dag.run.json           definition (objective, settings, task specs)
//   dag.run.d/state.json   dynamic state (statuses, counters, rev, eventSeq)
//   dag.run.d/events.jsonl append-only full history
//   dag.run.d/logs/        per-attempt stdout/stderr
//   dag.run.json.lock      held while a run is active
// ---------------------------------------------------------------------------

export interface RunPaths {
  file: string;
  dir: string;
  state: string;
  events: string;
  logs: string;
  lock: string;
}

export function runPaths(file: string): RunPaths {
  const abs = resolve(file);
  const base = abs.endsWith('.json') ? abs.slice(0, -5) : abs;
  const dir = `${base}.d`;
  return {
    file: abs,
    dir,
    state: join(dir, 'state.json'),
    events: join(dir, 'events.jsonl'),
    logs: join(dir, 'logs'),
    lock: `${abs}.lock`,
  };
}

// ---------------------------------------------------------------------------
// Atomic write: tmp + fsync + rename, previous revision kept as .bak.
// ---------------------------------------------------------------------------

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existsSync(path)) {
    try {
      renameSync(path, `${path}.bak`);
    } catch {
      // best effort; the rename below still overwrites
    }
  }
  renameSync(tmp, path);
}

function readJsonWithBackup<T>(path: string): T | null {
  for (const candidate of [path, `${path}.bak`]) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, 'utf8')) as T;
    } catch {
      // try the backup
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

const pathByRun = new WeakMap<Run, RunPaths>();
const appendedSeqByRun = new WeakMap<Run, number>();
const eventLogSizes = new Map<string, number>();

// Global state files (registry, servers, schedule) get the same crash-safe
// write as run files: concurrent `dag` processes can't leave them corrupt.
export function atomicWriteJson(path: string, value: unknown): void {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function appendEventLine(paths: RunPaths, ev: DagEvent): void {
  mkdirSync(paths.dir, { recursive: true });
  let size = eventLogSizes.get(paths.events);
  if (size === undefined) {
    size = existsSync(paths.events) ? statSync(paths.events).size : 0;
  }
  if (size > EVENT_LOG_ROTATE_BYTES) {
    try {
      renameSync(paths.events, `${paths.events}.1`);
    } catch {
      // rotation is best effort
    }
    size = 0;
  }
  const line = `${JSON.stringify(ev)}\n`;
  appendFileSync(paths.events, line, 'utf8');
  eventLogSizes.set(paths.events, size + Buffer.byteLength(line));
}

export function logEvent(
  run: Run,
  type: EventType,
  taskId: string | null,
  message: string,
): DagEvent {
  const ev: DagEvent = {
    seq: ++run.eventSeq,
    ts: new Date().toISOString(),
    type,
    taskId,
    message,
  };
  run.events.push(ev);
  if (run.events.length > EVENT_RING_LIMIT) {
    run.events.splice(0, run.events.length - EVENT_RING_LIMIT);
  }
  const paths = pathByRun.get(run);
  if (paths) {
    try {
      appendEventLine(paths, ev);
      appendedSeqByRun.set(run, ev.seq);
    } catch {
      // logging must never break a run
    }
  }
  return ev;
}

// Events logged before the run had a known path still need to reach the log.
function flushPendingEvents(run: Run, paths: RunPaths): void {
  const last = appendedSeqByRun.get(run) ?? 0;
  let newest = last;
  for (const ev of run.events) {
    if (ev.seq <= last) continue;
    appendEventLine(paths, ev);
    newest = Math.max(newest, ev.seq);
  }
  appendedSeqByRun.set(run, newest);
  if (!existsSync(paths.events)) writeFileSync(paths.events, '', { flag: 'a' });
}

// Reads the last maxBytes of events.jsonl and parses complete lines.
export function readEventTail(file: string, maxBytes = 256 * 1024): DagEvent[] {
  const paths = runPaths(file);
  if (!existsSync(paths.events)) return [];
  const size = statSync(paths.events).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = openSync(paths.events, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    text = buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  const events: DagEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as DagEvent);
    } catch {
      // partial line from a crash or rotation; skip
    }
  }
  return events;
}

export function readEventLog(file: string, limit: number): DagEvent[] {
  const events = readEventTail(file, 8 * 1024 * 1024);
  return events.slice(-limit);
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  note: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(file: string): LockInfo | null {
  const paths = runPaths(file);
  if (!existsSync(paths.lock)) return null;
  try {
    return JSON.parse(readFileSync(paths.lock, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

// A lock held by another live process on this host; stale locks are ignored.
export function foreignLock(file: string): LockInfo | null {
  const cur = readLock(file);
  if (!cur) return null;
  if (cur.pid === process.pid) return null;
  if (cur.host === hostname() && !isProcessAlive(cur.pid)) return null;
  return cur;
}

// A lock is per run file, not global: one runner owns one file, and that
// runner runs many workers in parallel. Different projects = different files
// = independent runners.
function lockedMessage(cur: LockInfo): string {
  return (
    `run file is locked by pid ${cur.pid} (${cur.note}, since ${cur.startedAt}) — a run is in progress. ` +
    'Parallel workers live inside a run: raise --concurrency (up to 64). ' +
    'Independent graphs need their own run file (dag launch --all). --force overrides.'
  );
}

// True when this very process already holds the lock (re-entrant acquisition).
export function lockHeldBy(file: string): boolean {
  return readLock(file)?.pid === process.pid;
}

export function assertNoForeignLock(file: string, force = false): void {
  if (force) return;
  const cur = foreignLock(file);
  if (cur) throw new Error(lockedMessage(cur));
}

// Synchronous sleep for the lock loop: acquireLock is called from sync code,
// and the wait only happens while another process is mid-write.
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function acquireLock(file: string, note: string, force = false): () => void {
  const paths = runPaths(file);
  mkdirSync(dirname(paths.lock), { recursive: true });
  const mine: LockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    note,
  };
  let held = false;
  // A lock file exists but reads as nothing: another process may be between
  // creating it and filling it in. Wait before treating it as garbage — but
  // not forever, because an empty lock left by a crash must still be stealable.
  let emptySince: number | null = null;
  for (let attempt = 0; attempt < 60 && !held; attempt++) {
    try {
      writeFileSync(paths.lock, `${JSON.stringify(mine, null, 2)}\n`, { flag: 'wx' });
      held = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const cur = readLock(file);
    if (!cur) {
      if (emptySince === null) emptySince = Date.now();
      if (Date.now() - emptySince < 1000) {
        syncSleep(25);
        continue;
      }
      rmSync(paths.lock, { force: true });
      continue;
    }
    emptySince = null;
    if (cur.pid === process.pid) {
      writeFileSync(paths.lock, `${JSON.stringify(mine, null, 2)}\n`);
      held = true;
      break;
    }
    const stale = cur.host === hostname() && !isProcessAlive(cur.pid);
    if (!stale && !force) {
      throw new Error(lockedMessage(cur));
    }
    rmSync(paths.lock, { force: true });
  }
  if (!held) {
    // Never return a release function for a lock we do not hold: callers treat
    // this return value as ownership.
    throw new Error(`could not acquire the run lock at ${paths.lock} (contended)`);
  }
  return () => {
    const cur = readLock(file);
    if (cur?.pid === process.pid) rmSync(paths.lock, { force: true });
  };
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function definitionOf(run: Run): Record<string, unknown> {
  const tasks: Record<string, unknown> = {};
  for (const task of Object.values(run.tasks)) {
    const def: Record<string, unknown> = {};
    for (const field of DEFINITION_FIELDS) def[field] = task[field];
    tasks[task.id] = def;
  }
  return {
    storageVersion: STORAGE_VERSION,
    id: run.id,
    objective: run.objective,
    createdAt: run.createdAt,
    settings: run.settings,
    tasks,
  };
}

function stateOf(run: Run): Record<string, unknown> {
  const tasks: Record<string, unknown> = {};
  for (const task of Object.values(run.tasks)) {
    const dyn: Record<string, unknown> = {};
    for (const field of DYNAMIC_FIELDS) dyn[field] = task[field];
    tasks[task.id] = dyn;
  }
  return {
    storageVersion: STORAGE_VERSION,
    updatedAt: run.updatedAt,
    rev: run.rev,
    eventSeq: run.eventSeq,
    tasks,
  };
}

const lastDefinitionJson = new Map<string, string>();
const lastStateJson = new Map<string, string>();

// State without the fields that change on every write, for "did anything
// actually change" comparisons.
function stateContent(run: Run): string {
  const state = stateOf(run);
  delete state.updatedAt;
  delete state.rev;
  return JSON.stringify(state);
}

export function newRun(objective: string): Run {
  const now = new Date().toISOString();
  return {
    storageVersion: STORAGE_VERSION,
    id: `run_${randomUUID().slice(0, 8)}`,
    objective,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    eventSeq: 0,
    settings: { ...DEFAULT_SETTINGS },
    tasks: {},
    events: [],
  };
}

interface StoredDefinition {
  storageVersion?: number;
  id: string;
  objective: string;
  createdAt: string;
  settings?: Partial<RunSettings>;
  tasks: Record<string, Partial<Task>>;
  // legacy fields
  updatedAt?: string;
  rev?: number;
  eventSeq?: number;
  events?: DagEvent[];
}

interface StoredState {
  updatedAt?: string;
  rev?: number;
  eventSeq?: number;
  tasks?: Record<string, Partial<Task>>;
}

function normalizeTask(raw: Partial<Task>, run: Run, index: number): Task {
  const now = run.createdAt;
  return {
    id: raw.id ?? `task_${randomUUID().slice(0, 8)}`,
    title: raw.title ?? '(untitled)',
    spec: raw.spec ?? '',
    deps: [...new Set(raw.deps ?? [])],
    status: raw.status ?? 'pending',
    cmd: raw.cmd ?? null,
    gate: raw.gate ?? null,
    result: raw.result ?? null,
    createdAt: raw.createdAt ?? now,
    seq: raw.seq ?? index + 1,
    attempts: raw.attempts ?? 0,
    maxAttempts: raw.maxAttempts ?? run.settings.maxAttempts,
    timeoutMs: raw.timeoutMs ?? null,
    silenceMs: raw.silenceMs ?? null,
    startedAt: raw.startedAt ?? null,
    finishedAt: raw.finishedAt ?? null,
    exitCode: raw.exitCode ?? null,
    failureKind: raw.failureKind ?? null,
    lastOutputAt: raw.lastOutputAt ?? null,
    lastOutput: raw.lastOutput ?? null,
    pid: raw.pid ?? null,
    reviewCmd: raw.reviewCmd ?? null,
    reviewRounds: raw.reviewRounds ?? 0,
    reviews: raw.reviews ?? 0,
    reviewResult: raw.reviewResult ?? null,
    reviewExitCode: raw.reviewExitCode ?? null,
    repairRounds: raw.repairRounds ?? 0,
    repairs: raw.repairs ?? 0,
    branch: raw.branch ?? null,
    commit: raw.commit ?? null,
    mergeRetries: raw.mergeRetries ?? 0,
    planCmd: raw.planCmd ?? null,
    plan: raw.plan ?? null,
    prepareCmd: raw.prepareCmd ?? null,
    harnessChain: raw.harnessChain ?? null,
    covers: raw.covers && raw.covers.length > 0 ? [...new Set(raw.covers)] : null,
    harness: raw.harness ?? null,
    diffBase: raw.diffBase ?? null,
    diffHead: raw.diffHead ?? null,
    finalReview: raw.finalReview ?? null,
    coverage: raw.coverage ?? null,
    reviewers: Array.isArray(raw.reviewers) ? raw.reviewers : [],
    reviewerVerdicts: raw.reviewerVerdicts ?? {},
    lastRejection: raw.lastRejection ?? null,
    model: raw.model ?? null,
    variant: raw.variant ?? null,
  };
}

export function loadRun(file: string): Run {
  const paths = runPaths(file);
  const def = readJsonWithBackup<StoredDefinition>(paths.file);
  if (!def) throw new Error(`cannot read run file: ${paths.file}`);

  const run = newRun(def.objective ?? 'untitled dag');
  run.id = def.id ?? run.id;
  run.createdAt = def.createdAt ?? run.createdAt;
  run.settings = { ...DEFAULT_SETTINGS, ...(def.settings ?? {}) };

  const state = readJsonWithBackup<StoredState>(paths.state);
  const legacy = !state && (def.storageVersion ?? 1) < STORAGE_VERSION;
  const dynamic = state?.tasks ?? {};
  run.updatedAt = state?.updatedAt ?? def.updatedAt ?? run.createdAt;
  run.rev = state?.rev ?? def.rev ?? 0;
  run.eventSeq = state?.eventSeq ?? def.eventSeq ?? 0;

  let index = 0;
  for (const [id, raw] of Object.entries(def.tasks ?? {})) {
    // Static fields come from the definition; dynamic state overlays them.
    const merged = { ...raw, ...(dynamic[id] ?? {}), id };
    const task = normalizeTask(merged, run, index++);
    run.tasks[task.id] = task;
  }

  // Legacy single-file runs carried events; move them to the jsonl log. Do it
  // once, by writing the state that marks the run as migrated — otherwise every
  // read-only load (list, show, viewer polls) appends another copy.
  if (legacy && Array.isArray(def.events) && def.events.length > 0) {
    pathByRun.set(run, paths);
    for (const ev of def.events) {
      run.events.push(ev);
      if (!ev.seq) ev.seq = ++run.eventSeq;
      else run.eventSeq = Math.max(run.eventSeq, ev.seq);
    }
    try {
      for (const ev of run.events) appendEventLine(paths, ev);
      appendedSeqByRun.set(run, run.eventSeq);
      mkdirSync(paths.dir, { recursive: true });
      atomicWrite(paths.state, `${JSON.stringify(stateOf(run), null, 2)}\n`);
    } catch {
      // best effort
    }
  } else if (legacy) {
    // Nothing to migrate but the version marker: record it so the next load is
    // not treated as legacy again.
    try {
      mkdirSync(paths.dir, { recursive: true });
      atomicWrite(paths.state, `${JSON.stringify(stateOf(run), null, 2)}\n`);
    } catch {
      // best effort
    }
  }

  // Recover the event cursor if state was lost after events were written.
  try {
    const tail = readEventTail(file, 64 * 1024);
    const lastSeq = tail.length > 0 ? tail[tail.length - 1].seq : 0;
    if (lastSeq > run.eventSeq) run.eventSeq = lastSeq;
  } catch {
    // tail is optional
  }
  appendedSeqByRun.set(run, run.eventSeq);

  pathByRun.set(run, paths);
  // Store the same serialization saveRun compares against, or every save
  // rewrites the definition (and rotates its .bak) even for state-only changes.
  lastDefinitionJson.set(paths.file, JSON.stringify(definitionOf(run), null, 2));
  lastStateJson.set(paths.file, stateContent(run));
  return run;
}

export function saveRun(run: Run, file: string): void {
  const paths = runPaths(file);
  pathByRun.set(run, paths);
  try {
    mkdirSync(paths.dir, { recursive: true });
    flushPendingEvents(run, paths);
  } catch {
    // the state write below is the critical part
  }
  const defJson = JSON.stringify(definitionOf(run), null, 2);
  const stateJson = stateContent(run);
  const defChanged = lastDefinitionJson.get(paths.file) !== defJson;
  const stateChanged = lastStateJson.get(paths.file) !== stateJson;
  // A command that changed nothing must not bump rev or rewrite files: the
  // viewer polls rev, and a no-op write rotates the definition's .bak.
  if (!defChanged && !stateChanged) return;
  run.updatedAt = new Date().toISOString();
  run.rev += 1;
  if (defChanged) {
    atomicWrite(paths.file, `${defJson}\n`);
    lastDefinitionJson.set(paths.file, defJson);
  }
  const nextState = `${JSON.stringify(stateOf(run), null, 2)}\n`;
  atomicWrite(paths.state, nextState);
  lastStateJson.set(paths.file, stateContent(run));
}

// Serialized read-modify-write per file: concurrent editors cannot clobber
// each other's whole-file writes.
const writeChains = new Map<string, Promise<unknown>>();

// In-process callers (the viewer's HTTP routes) check for a foreign lock and
// then read-modify-write: without holding the lock across both, a CLI command
// that writes in between has its revision clobbered.
export function mutate<T>(file: string, fn: (run: Run) => T, lockLabel?: string): Promise<T> {
  const key = resolve(file);
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(() => {
    const release = lockLabel ? acquireLock(key, lockLabel, false) : null;
    try {
      const run = loadRun(key);
      const result = fn(run);
      saveRun(run, key);
      return result;
    } finally {
      release?.();
    }
  });
  writeChains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export function touch(run: Run): void {
  run.updatedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Task operations
// ---------------------------------------------------------------------------

export interface AddTaskInput {
  title: string;
  spec: string;
  deps?: string[];
  cmd?: string | null;
  maxAttempts?: number;
  timeoutMs?: number | null;
  silenceMs?: number | null;
  reviewCmd?: string | null;
  reviewRounds?: number;
  repairRounds?: number;
  planCmd?: string | null;
  model?: string | null;
  variant?: string | null;
  reviewers?: Reviewer[];
  prepareCmd?: string | null;
  harnessChain?: HarnessCandidate[] | null;
  covers?: string[] | null;
}

export function addTask(run: Run, input: AddTaskInput): Task {
  // Dedupe: a repeated dep is always a mistake and would double-count edges.
  const deps = [...new Set(input.deps ?? [])];
  for (const d of deps) {
    if (!run.tasks[d]) throw new Error(`unknown dep ${d}`);
  }
  const id = `task_${randomUUID().slice(0, 8)}`;
  const seq = Object.values(run.tasks).reduce((m, t) => Math.max(m, t.seq ?? 0), 0) + 1;
  const task: Task = {
    id,
    title: input.title,
    spec: input.spec,
    deps: [...deps],
    status: 'pending',
    cmd: input.cmd ?? null,
    gate: null,
    result: null,
    createdAt: new Date().toISOString(),
    seq,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? run.settings.maxAttempts,
    timeoutMs: input.timeoutMs ?? null,
    silenceMs: input.silenceMs ?? null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    failureKind: null,
    lastOutputAt: null,
    lastOutput: null,
    pid: null,
    reviewCmd: input.reviewCmd ?? null,
    reviewRounds: input.reviewRounds ?? 0,
    reviews: 0,
    reviewResult: null,
    reviewExitCode: null,
    repairRounds: input.repairRounds ?? 0,
    repairs: 0,
    branch: null,
    commit: null,
    mergeRetries: 0,
    planCmd: input.planCmd ?? null,
    plan: null,
    prepareCmd: input.prepareCmd ?? null,
    harnessChain: input.harnessChain ?? null,
    covers: input.covers && input.covers.length > 0 ? [...new Set(input.covers)] : null,
    harness: null,
    diffBase: null,
    diffHead: null,
    finalReview: null,
    coverage: null,
    reviewers: input.reviewers ?? [],
    reviewerVerdicts: {},
    lastRejection: null,
    model: input.model ?? null,
    variant: input.variant ?? null,
  };
  run.tasks[id] = task;
  assertNoCycle(run);
  logEvent(run, 'edit', id, `added: ${input.title}`);
  touch(run);
  return task;
}

export interface EditTaskInput {
  title?: string;
  spec?: string;
  deps?: string[];
  cmd?: string | null;
  status?: TaskStatus;
  result?: string | null;
  maxAttempts?: number;
  timeoutMs?: number | null;
  silenceMs?: number | null;
  reviewCmd?: string | null;
  reviewRounds?: number;
  repairRounds?: number;
  planCmd?: string | null;
  model?: string | null;
  variant?: string | null;
  reviewers?: Reviewer[];
  prepareCmd?: string | null;
  harnessChain?: HarnessCandidate[] | null;
}

export function editTask(run: Run, id: string, patch: EditTaskInput): Task {
  const task = run.tasks[id];
  if (!task) throw new Error(`unknown task ${id}`);
  const prev = { ...task, deps: [...task.deps] };
  if (patch.title !== undefined) task.title = patch.title;
  if (patch.spec !== undefined) task.spec = patch.spec;
  if (patch.cmd !== undefined) task.cmd = patch.cmd;
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.result !== undefined) task.result = patch.result;
  if (patch.maxAttempts !== undefined) task.maxAttempts = Math.max(1, patch.maxAttempts);
  if (patch.timeoutMs !== undefined) task.timeoutMs = patch.timeoutMs;
  if (patch.silenceMs !== undefined) task.silenceMs = patch.silenceMs;
  if (patch.reviewCmd !== undefined) task.reviewCmd = patch.reviewCmd;
  if (patch.planCmd !== undefined) task.planCmd = patch.planCmd;
  if (patch.model !== undefined) task.model = patch.model;
  if (patch.variant !== undefined) task.variant = patch.variant;
  if (patch.reviewers !== undefined) task.reviewers = patch.reviewers;
  if (patch.prepareCmd !== undefined) task.prepareCmd = patch.prepareCmd;
  if (patch.harnessChain !== undefined) task.harnessChain = patch.harnessChain;
  if (patch.reviewRounds !== undefined) task.reviewRounds = Math.max(0, patch.reviewRounds);
  if (patch.repairRounds !== undefined) task.repairRounds = Math.max(0, patch.repairRounds);
  if (patch.deps !== undefined) {
    for (const d of patch.deps) {
      if (d === id) throw new Error('task cannot depend on itself');
      if (!run.tasks[d]) throw new Error(`unknown dep ${d}`);
    }
    task.deps = [...patch.deps];
  }
  try {
    assertNoCycle(run);
  } catch (err) {
    run.tasks[id] = prev;
    throw err;
  }
  logEvent(run, 'edit', id, 'edited');
  touch(run);
  return task;
}

export function removeTask(run: Run, id: string): void {
  if (!run.tasks[id]) throw new Error(`unknown task ${id}`);
  delete run.tasks[id];
  for (const t of Object.values(run.tasks)) {
    t.deps = t.deps.filter((d) => d !== id);
  }
  logEvent(run, 'edit', id, 'removed');
  touch(run);
}

export function retryTask(run: Run, id: string, cascade = false): string[] {
  const task = run.tasks[id];
  if (!task) throw new Error(`unknown task ${id}`);
  if (task.status === 'running') throw new Error(`task ${id} is running; stop the run first`);
  const touched: string[] = [];
  const requeue = (t: Task): void => {
    t.status = 'pending';
    t.result = null;
    t.failureKind = null;
    t.exitCode = null;
    t.startedAt = null;
    t.finishedAt = null;
    t.lastOutputAt = null;
    t.lastOutput = null;
    t.pid = null;
    // A manual retry is a fresh start: review and repair budgets reset, or a
    // task that exhausted its rounds could never run again.
    t.plan = null;
    t.reviewerVerdicts = {};
    t.lastRejection = null;
    t.reviews = 0;
    t.reviewResult = null;
    t.reviewExitCode = null;
    t.repairs = 0;
    touched.push(t.id);
  };
  requeue(task);
  if (cascade) {
    for (const other of Object.values(run.tasks)) {
      if (other.id === id) continue;
      if (other.status !== 'failed' && other.status !== 'skipped') continue;
      if (isDescendant(run, other.id, id, new Set())) requeue(other);
    }
  }
  logEvent(run, 'edit', id, cascade ? `retry (cascade): ${touched.join(', ')}` : 'retry');
  touch(run);
  return touched;
}

function isDescendant(run: Run, candidate: string, ancestor: string, seen: Set<string>): boolean {
  if (seen.has(candidate)) return false;
  seen.add(candidate);
  const t = run.tasks[candidate];
  if (!t) return false;
  return t.deps.some((d) => d === ancestor || isDescendant(run, d, ancestor, seen));
}

export function retryFailed(run: Run, cascade = false): string[] {
  const failed = Object.values(run.tasks)
    .filter((t) => t.status === 'failed' || t.status === 'skipped')
    .map((t) => t.id);
  const touched = new Set<string>();
  for (const id of failed) {
    for (const t of retryTask(run, id, cascade)) touched.add(t);
  }
  touch(run);
  return [...touched];
}

// ---------------------------------------------------------------------------
// Recovery and failure policy
// ---------------------------------------------------------------------------

export interface RecoveryResult {
  requeued: string[];
  orphanPids: number[];
}

// Anything still 'running' after a restart cannot be running: our process
// never started it. Requeue and report pids for orphan cleanup.
export function recoverInterrupted(run: Run): RecoveryResult {
  const requeued: string[] = [];
  const orphanPids: number[] = [];
  for (const task of Object.values(run.tasks)) {
    if (task.status !== 'running') continue;
    if (task.pid) orphanPids.push(task.pid);
    task.pid = null;
    task.status = 'pending';
    task.failureKind = 'interrupted';
    task.result = 'interrupted (process died); requeued';
    task.finishedAt = new Date().toISOString();
    requeued.push(task.id);
    logEvent(run, 'task-interrupted', task.id, `was running at startup; requeued`);
  }
  if (requeued.length > 0) touch(run);
  return { requeued, orphanPids };
}

// Every recorded pid is from a process this run no longer owns: a live runner
// holds the file lock, so a caller that got past `guard` owns the file and any
// 'running' task is a leftover from a crashed process.
export function orphanedPids(run: Run): number[] {
  return Object.values(run.tasks)
    .filter((t) => t.pid !== null)
    .map((t) => t.pid as number);
}

export function killPid(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      return out.status === 0;
    }
    // The agent runs detached in its own process group, so kill the group:
    // killing the direct pid leaves its children (npm -> node -> agents) alive.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

export function killOrphans(run: Run): { pid: number; killed: boolean }[] {
  const out: { pid: number; killed: boolean }[] = [];
  for (const task of Object.values(run.tasks)) {
    if (task.pid === null) continue;
    const pid = task.pid;
    const killed = killPid(pid);
    // Forget the pid: on Windows they are recycled quickly, and a stale entry
    // would let a later kill-orphans tree-kill an unrelated process.
    task.pid = null;
    out.push({ pid, killed });
    logEvent(run, 'note', task.id, `orphan pid ${pid}: ${killed ? 'killed' : 'not found'}`);
  }
  touch(run);
  return out;
}

// Mark every transitively blocked pending task as skipped so the run can
// converge without a human. One pass in topo order cascades correctly.
// `only` restricts the policy to a run's scope; without it, unrelated tasks
// in the file would be mutated by a scoped run.
export function skipBlocked(run: Run, reason = 'dependency failed', only?: Set<string>): string[] {
  const skipped: string[] = [];
  const memo = new Map<string, boolean>();
  for (const task of topoSort(run)) {
    if (task.status !== 'pending' && task.status !== 'ready') continue;
    if (only && !only.has(task.id)) continue;
    if (!transitiveBlocked(run, task.id, memo)) continue;
    task.status = 'skipped';
    task.result = `skipped: ${reason}`;
    task.failureKind = null;
    task.finishedAt = new Date().toISOString();
    skipped.push(task.id);
    logEvent(run, 'task-skip', task.id, task.result);
  }
  if (skipped.length > 0) touch(run);
  return skipped;
}

export function skipGated(run: Run, only?: Set<string>): string[] {
  const skipped: string[] = [];
  for (const task of topoSort(run)) {
    if (task.status !== 'pending' && task.status !== 'ready') continue;
    if (only && !only.has(task.id)) continue;
    if (!task.gate || task.gate.approved === true) continue;
    const depsDone = task.deps.every((d) => run.tasks[d]?.status === 'completed');
    if (!depsDone) continue;
    task.status = 'skipped';
    task.result = 'skipped: gate not approved';
    task.finishedAt = new Date().toISOString();
    skipped.push(task.id);
    logEvent(run, 'task-skip', task.id, task.result);
  }
  if (skipped.length > 0) touch(run);
  return skipped;
}

// Scaffolds the spec for an integration node: the reviewer agent needs to
// know which upstream tasks to inspect and what "meshes" means.
export function buildIntegrationSpec(run: Run, depIds: string[], cmd: string): string {
  const oneLine = (s: string, n: number): string =>
    s.replace(/\s+/g, ' ').length > n ? `${s.replace(/\s+/g, ' ').slice(0, n)}…` : s.replace(/\s+/g, ' ');
  const lines = [
    'Verify that the outputs of the upstream tasks mesh and are internally consistent.',
    '',
    'Upstream tasks:',
  ];
  for (const id of depIds) {
    const t = run.tasks[id];
    if (!t) continue;
    lines.push(`- ${id} "${t.title}" — status ${t.status}`);
    if (t.result) lines.push(`  result: ${oneLine(t.result, 300)}`);
  }
  lines.push(
    '',
    'Inputs: the artifacts those tasks produced. Inspect any of them with `dag show --id <task>`.',
    `Acceptance: \`${cmd}\` exits 0 and the upstream deliverables are consistent with each other.`,
    'If anything does not mesh, exit non-zero with a concise explanation of what is wrong.',
  );
  return lines.join('\n');
}

export interface TaskPatch {
  cmd?: string | null;
  reviewCmd?: string | null;
  planCmd?: string | null;
  model?: string | null;
  variant?: string | null;
  reviewers?: Reviewer[];
  prepareCmd?: string | null;
  harnessChain?: HarnessCandidate[] | null;
  covers?: string[] | null;
  reviewRounds?: number;
  repairRounds?: number;
  maxAttempts?: number;
  timeoutMs?: number | null;
  silenceMs?: number | null;
}

export interface TaskSelector {
  all?: boolean;
  only?: string[];
  match?: string;
}

// Bulk edit: point many tasks at the same harness, policy, or budgets at
// once. Skips running tasks; `reviewCmd: null` clears the reviewer.
export function setTasks(run: Run, patch: TaskPatch, selector: TaskSelector): string[] {
  const only = selector.only && selector.only.length > 0 ? new Set(selector.only) : null;
  const re = selector.match ? new RegExp(selector.match, 'i') : null;
  if (!selector.all && !only && !re) {
    throw new Error('select tasks with --all, --only, or --match');
  }
  const changed: string[] = [];
  for (const task of Object.values(run.tasks)) {
    if (task.status === 'running') continue;
    const selected =
      selector.all === true ||
      (only ? only.has(task.id) : false) ||
      (re ? re.test(task.title) || re.test(task.id) : false);
    if (!selected) continue;

    const before = JSON.stringify([
      task.cmd,
      task.reviewCmd,
      task.planCmd,
      task.model,
      task.variant,
      task.reviewRounds,
      task.repairRounds,
      task.maxAttempts,
      task.timeoutMs,
      task.silenceMs,
      task.harnessChain,
      task.covers,
    ]);
    if (patch.cmd !== undefined) task.cmd = patch.cmd;
    if (patch.reviewCmd !== undefined) task.reviewCmd = patch.reviewCmd;
    if (patch.planCmd !== undefined) task.planCmd = patch.planCmd;
    if (patch.model !== undefined) task.model = patch.model;
    if (patch.variant !== undefined) task.variant = patch.variant;
    if (patch.reviewers !== undefined) task.reviewers = patch.reviewers;
    if (patch.prepareCmd !== undefined) task.prepareCmd = patch.prepareCmd;
    if (patch.harnessChain !== undefined) task.harnessChain = patch.harnessChain;
    if (patch.covers !== undefined) task.covers = patch.covers;
    if (patch.reviewRounds !== undefined) task.reviewRounds = Math.max(0, patch.reviewRounds);
    if (patch.repairRounds !== undefined) task.repairRounds = Math.max(0, patch.repairRounds);
    if (patch.maxAttempts !== undefined) task.maxAttempts = Math.max(1, patch.maxAttempts);
    if (patch.timeoutMs !== undefined) task.timeoutMs = patch.timeoutMs;
    if (patch.silenceMs !== undefined) task.silenceMs = patch.silenceMs;

    const after = JSON.stringify([
      task.cmd,
      task.reviewCmd,
      task.planCmd,
      task.model,
      task.variant,
      task.reviewRounds,
      task.repairRounds,
      task.maxAttempts,
      task.timeoutMs,
      task.silenceMs,
      task.harnessChain,
      task.covers,
    ]);
    if (before === after) continue;
    changed.push(task.id);
    logEvent(run, 'edit', task.id, `set: ${Object.keys(patch).join(', ')}`);
  }
  if (changed.length > 0) touch(run);
  return changed;
}

// Point many tasks at the same harness at once: `--all`, `--only a,b`, or a
// title/id regex. Skips tasks that are currently running.
export function setTaskCommand(
  run: Run,
  cmd: string | null,
  selector: { all?: boolean; only?: string[]; match?: string },
): string[] {
  return setTasks(run, { cmd }, selector);
}

export function setSettings(run: Run, patch: Partial<RunSettings>): RunSettings {
  run.settings = { ...run.settings, ...patch };
  logEvent(run, 'edit', null, `settings: ${JSON.stringify(patch)}`);
  touch(run);
  return run.settings;
}

export function setGate(
  run: Run,
  id: string,
  question: string,
  options: string[] = ['approved', 'rejected'],
): Task {
  const task = run.tasks[id];
  if (!task) throw new Error(`unknown task ${id}`);
  task.gate = { question, options, approved: null };
  if (task.status === 'pending') task.status = 'ready';
  logEvent(run, 'edit', id, `gate: ${question}`);
  touch(run);
  return task;
}

export function resolveGate(run: Run, id: string, approved: boolean): Task {
  const task = run.tasks[id];
  if (!task?.gate) throw new Error(`task ${id} has no gate`);
  task.gate.approved = approved;
  logEvent(run, 'edit', id, `gate ${approved ? 'approved' : 'rejected'}`);
  touch(run);
  return task;
}

// ---------------------------------------------------------------------------
// Per-attempt logs
// ---------------------------------------------------------------------------

// Task ids reach these helpers from HTTP routes and hand-edited run files, so
// they are not trusted as path segments.
function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw Object.assign(new Error(`unsafe task id: ${JSON.stringify(id)}`), { code: 400 });
  }
  return id;
}

export function attemptLogPath(file: string, taskId: string, attempt: number): string {
  return join(runPaths(file).logs, `${safeId(taskId)}.${attempt}.log`);
}

// Heartbeat marker for workers that write files instead of streaming output
// (an agent that goes quiet on stdout but is still making progress).
export function heartbeatPath(file: string, taskId: string): string {
  return join(runPaths(file).dir, 'heartbeats', safeId(taskId));
}

export function recordHeartbeat(file: string, taskId: string): void {
  const path = heartbeatPath(file, taskId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${new Date().toISOString()}\n`, 'utf8');
}
export function attemptLogFiles(file: string, taskId: string): number[] {
  const paths = runPaths(file);
  if (!existsSync(paths.logs)) return [];
  const attempts: number[] = [];
  // The id reaches here from HTTP routes and run files: treat it as a literal,
  // not as a pattern.
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}\\.(\\d+)\\.log$`);
  for (const name of readdirSync(paths.logs)) {
    const m = name.match(re);
    if (m) attempts.push(Number(m[1]));
  }
  return attempts.sort((a, b) => a - b);
}

export function readAttemptLog(
  file: string,
  taskId: string,
  attempt: number,
  maxBytes = 200 * 1024,
): string | null {
  const path = attemptLogPath(file, taskId, attempt);
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const body = buf.toString('utf8');
    return start > 0 ? `… [showing last ${maxBytes} bytes]\n${body}` : body;
  } finally {
    closeSync(fd);
  }
}

export { isTerminal };
