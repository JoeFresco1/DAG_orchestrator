import type {
  DagConvergence,
  DisplayStatus,
  Run,
  Task,
  TaskStatus,
  TerminalStatus,
} from './types.js';

export function taskList(run: Run): Task[] {
  return Object.values(run.tasks);
}

export function isTerminal(status: TaskStatus): status is TerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'skipped';
}

// A dep that is failed, skipped, or missing can never complete.
export function depUnusable(task: Task, tasks: Record<string, Task>): boolean {
  return task.deps.some((d) => {
    const dep = tasks[d];
    return !dep || dep.status === 'failed' || dep.status === 'skipped';
  });
}

export function depsMet(task: Task, tasks: Record<string, Task>): boolean {
  return task.deps.every((d) => tasks[d]?.status === 'completed');
}

export function gateBlocks(task: Task): boolean {
  return task.gate !== null && task.gate.approved !== true;
}

// Ready = pending/ready, deps all completed, gate approved (or none).
export function getReady(run: Run): Task[] {
  return taskList(run).filter(
    (t) =>
      (t.status === 'pending' || t.status === 'ready') &&
      !depUnusable(t, run.tasks) &&
      depsMet(t, run.tasks) &&
      !gateBlocks(t),
  );
}

// Blocked is transitive: a failed/skipped/missing dep blocks everything
// downstream, not just the immediate dependent. Cycle-guarded memo.
export function transitiveBlocked(
  run: Run,
  id: string,
  memo: Map<string, boolean> = new Map(),
): boolean {
  const cached = memo.get(id);
  if (cached !== undefined) return cached;
  const task = run.tasks[id];
  if (!task) {
    memo.set(id, true);
    return true;
  }
  memo.set(id, false); // cycle guard; real cycles are rejected at edit time
  let blocked = false;
  for (const d of task.deps) {
    const dep = run.tasks[d];
    if (!dep || dep.status === 'failed' || dep.status === 'skipped' || transitiveBlocked(run, d, memo)) {
      blocked = true;
      break;
    }
  }
  memo.set(id, blocked);
  return blocked;
}

export function getBlocked(run: Run): Task[] {
  const memo = new Map<string, boolean>();
  return taskList(run)
    .filter((t) => t.status === 'pending' || t.status === 'ready')
    .filter((t) => transitiveBlocked(run, t.id, memo));
}

// What the viewer paints: real status, else blocked, else gated.
export function deriveStatus(run: Run, task: Task): DisplayStatus {
  if (task.status === 'running' || isTerminal(task.status)) return task.status;
  if (transitiveBlocked(run, task.id)) return 'blocked';
  if (gateBlocks(task) && depsMet(task, run.tasks)) return 'gated';
  return task.status;
}

// Every task reachable through dependencies, nearest first.
export function transitiveDepIds(run: Run, id: string): string[] {
  const seen = new Set<string>();
  const visit = (taskId: string): void => {
    const task = run.tasks[taskId];
    if (!task) return;
    for (const dep of task.deps) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      visit(dep);
    }
  };
  visit(id);
  const depths = computeDepths(run);
  return [...seen].sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0));
}

// Every task that (transitively) depends on this one, shallowest first:
// the other direction of transitiveDepIds. Used to invalidate work whose
// inputs changed when an upstream task is repaired or retried.
export function transitiveDependentIds(run: Run, id: string): string[] {
  const seen = new Set<string>([id]);
  for (let pass = 0; pass < Object.keys(run.tasks).length; pass += 1) {
    let grew = false;
    for (const task of Object.values(run.tasks)) {
      if (seen.has(task.id)) continue;
      if (task.deps.some((d) => seen.has(d))) {
        seen.add(task.id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  seen.delete(id);
  const depths = computeDepths(run);
  return [...seen].sort((a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0));
}

// Evidence from upstream tasks, for `{deps}` / `{depsAll}` / `{depsFile}`.
// This is what makes an integration check grade claims against the graph
// instead of vibes: the reviewer sees what each dependency actually produced.
export function describeDeps(
  run: Run,
  task: Task,
  opts: { transitive?: boolean; perDep?: number; limit?: number } = {},
): string {
  const perDep = opts.perDep ?? 1200;
  const limit = opts.limit ?? 20000;
  const oneLine = (s: string, n: number): string => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > n ? `${flat.slice(0, n)}…` : flat;
  };
  const ids = opts.transitive ? transitiveDepIds(run, task.id) : [...task.deps];
  // Never start the text with "-": a token that becomes an argv element
  // beginning with a dash is parsed as a CLI flag by the child program.
  const lines: string[] = [`Upstream tasks (${opts.transitive ? 'all' : 'direct'}):`];
  for (const id of ids) {
    const dep = run.tasks[id];
    if (!dep) {
      lines.push(`- ${id}: (missing)`);
      continue;
    }
    const head = `- ${dep.id} "${dep.title}" [${deriveStatus(run, dep)}] attempts ${dep.attempts}/${dep.maxAttempts}`;
    if (!opts.transitive) {
      lines.push(head);
      if (dep.result) lines.push(`  result: ${oneLine(dep.result, perDep)}`);
      if (dep.reviewResult) lines.push(`  review: ${oneLine(dep.reviewResult, 400)}`);
      if (dep.failureKind) lines.push(`  failure: ${dep.failureKind}`);
      if (dep.branch) lines.push(`  branch: ${dep.branch}${dep.commit ? ` @ ${dep.commit.slice(0, 8)}` : ''}`);
    } else {
      lines.push(`${head}${dep.result ? ` — ${oneLine(dep.result, 160)}` : ''}`);
    }
  }
  lines.push('', 'Full transcripts: `dag show --id <task>`');
  const text = lines.join('\n');
  return text.length > limit ? `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]` : text;
}

export interface StuckReason {
  id: string;
  reason: string;
}

// Why a non-terminal task cannot launch right now.
export function describeStuck(run: Run): StuckReason[] {
  const out: StuckReason[] = [];
  for (const t of taskList(run)) {
    if (t.status === 'running' || isTerminal(t.status)) continue;
    const missing = t.deps.filter((d) => !run.tasks[d]);
    if (missing.length > 0) {
      out.push({ id: t.id, reason: `missing dep(s): ${missing.join(', ')}` });
      continue;
    }
    const bad = t.deps.filter((d) => {
      const s = run.tasks[d].status;
      return s === 'failed' || s === 'skipped';
    });
    if (bad.length > 0 || transitiveBlocked(run, t.id)) {
      out.push({
        id: t.id,
        reason: `blocked by failed/skipped dep(s): ${bad.length > 0 ? bad.join(', ') : t.deps.join(', ')}`,
      });
      continue;
    }
    if (gateBlocks(t) && depsMet(t, run.tasks)) {
      out.push({ id: t.id, reason: `awaiting approval: ${t.gate?.question ?? ''}` });
      continue;
    }
    const waiting = t.deps.filter((d) => run.tasks[d].status !== 'completed');
    out.push({
      id: t.id,
      reason: `waiting on: ${waiting.map((d) => `${d} (${run.tasks[d].status})`).join(', ')}`,
    });
  }
  return out;
}

export function evaluateConvergence(run: Run): DagConvergence {
  const all = taskList(run);
  if (all.length === 0) return 'empty';
  if (all.every((t) => isTerminal(t.status))) return 'all-done';
  return 'active';
}

// Depth for layered rendering: longest chain from a root.
export function computeDepths(run: Run): Map<string, number> {
  const depths = new Map<string, number>();
  const visit = (id: string, trail: string[]): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (trail.includes(id)) throw new Error(`cycle detected at ${id}`);
    const t = run.tasks[id];
    if (!t || t.deps.length === 0) {
      depths.set(id, 0);
      return 0;
    }
    const d = 1 + Math.max(...t.deps.map((p) => visit(p, [...trail, id])));
    depths.set(id, d);
    return d;
  };
  for (const id of Object.keys(run.tasks)) visit(id, []);
  return depths;
}

export function assertNoCycle(run: Run): void {
  computeDepths(run); // throws on cycle
}

// Deterministic launch order: depth, then creation sequence.
export function topoSort(run: Run): Task[] {
  const depths = computeDepths(run);
  return taskList(run).sort(
    (a, b) => (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0) || a.seq - b.seq,
  );
}

export function summarize(run: Run): string {
  const counts = new Map<TaskStatus, number>();
  for (const t of taskList(run)) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const ready = getReady(run).map((t) => t.id);
  const blocked = getBlocked(run).map((t) => t.id);
  const stuck = describeStuck(run);
  return [
    `run ${run.id}: ${taskList(run).length} tasks (rev ${run.rev})`,
    ...[...counts.entries()].map(([s, n]) => `  ${s}: ${n}`),
    `  runnable now: ${ready.length > 0 ? `${ready.length} task(s)` : '(none)'}`,
    ...(blocked.length > 0 ? [`  blocked: ${blocked.length} task(s)`] : []),
    ...(ready.length === 0 && stuck.length > 0
      ? [
          '  why stuck:',
          ...stuck.slice(0, 10).map((s) => `    ${s.id}: ${s.reason}`),
          ...(stuck.length > 10 ? [`    … ${stuck.length - 10} more`] : []),
        ]
      : []),
  ].join('\n');
}
