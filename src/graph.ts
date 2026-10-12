// Dependency-graph queries over a run: readiness, transitive blocking, depth
// and topological order, cycle detection, and the upstream-evidence text used
// by the {deps} / {depsAll} / {depsFile} tokens. Pure functions, no I/O.

import type {
  DagConvergence,
  DisplayStatus,
  Run,
  Task,
  TaskStatus,
  TerminalStatus,
} from './types.js';

/** All tasks in the run; the store is keyed by id, order is insertion order. */
export function taskList(run: Run): Task[] {
  return Object.values(run.tasks);
}

/** Terminal statuses never change again, so downstream work can be judged. */
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

/** Direct dependencies only; a missing dep is simply not completed. */
export function depsMet(task: Task, tasks: Record<string, Task>): boolean {
  return task.deps.every((d) => tasks[d]?.status === 'completed');
}

/** `approved !== true` means null/false/unapproved all count as closed. */
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

/** Non-terminal tasks that can never run because an ancestor failed/skipped. */
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
  // Fixed-point expansion: each pass can discover new dependents of the ones
  // just added, so keep going until a full pass changes nothing.
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
  // Collapse whitespace and cap length: dependency output can be huge, and
  // these strings are inlined into prompts.
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
    // A deps-met, ungated task is ready to launch, not stuck. Root tasks have
    // an empty dependency list and previously produced "waiting on: ".
    if (depsMet(t, run.tasks)) continue;
    const waiting = t.deps.filter((d) => run.tasks[d].status !== 'completed');
    out.push({
      id: t.id,
      reason: `waiting on: ${waiting.map((d) => `${d} (${run.tasks[d].status})`).join(', ')}`,
    });
  }
  return out;
}

/** Run-level state for the UI: empty, all-done, or still active. */
export function evaluateConvergence(run: Run): DagConvergence {
  const all = taskList(run);
  if (all.length === 0) return 'empty';
  if (all.every((t) => isTerminal(t.status))) return 'all-done';
  return 'active';
}

// Depth for layered rendering: longest chain from a root.
export function computeDepths(run: Run): Map<string, number> {
  const depths = new Map<string, number>();
  // `trail` is the current recursion path; seeing an id twice is a back edge,
  // i.e. a cycle. Memoized depths make this linear in the shared prefixes.
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

/** Throw if the graph has a cycle; delegates to the depth computation. */
export function assertNoCycle(run: Run): void {
  computeDepths(run); // throws on cycle
}

// ---------------------------------------------------------------------------
// Shape analysis: the guardrail against near-linear DAGs.
//
// A common failure mode is chaining every task onto its predecessor
// (A -> B -> C -> D ...) when a mid-tier task only actually needs one
// upstream output (e.g. the root contracts). One stalled task then blocks
// everything and independent work never runs in parallel. These helpers back
// `dag lint` and the minimal-deps guidance: depend only on tasks whose
// outputs you directly consume, and let `lint` prove the graph fans out.
// ---------------------------------------------------------------------------

/** All transitive deps of one task, as a set (direct + indirect). */
export function transitiveDepSet(run: Run, id: string): Set<string> {
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
  return seen;
}

export interface RedundantDep {
  id: string;
  dep: string;
  via: string;
}

/**
 * Direct deps that are already reachable through another direct dep.
 * `B.deps = [A, C]` with `C.deps = [A]` makes `A` redundant on B: dropping it
 * changes nothing about ordering, but unblocks B from A's stall only in the
 * sense that B still waits on C which waits on A — the fix is to question
 * whether the `C` edge is needed at all, not to silently drop `A`.
 * Callers should surface these as "justify or remove" warnings.
 */
export function findRedundantDeps(run: Run, onlyId?: string): RedundantDep[] {
  const out: RedundantDep[] = [];
  const tasks = onlyId ? [run.tasks[onlyId]].filter(Boolean) : taskList(run);
  for (const task of tasks) {
    if (task.deps.length < 2) continue;
    for (const dep of task.deps) {
      const others = task.deps.filter((d) => d !== dep);
      // dep is redundant when every other path already covers it.
      const coveredBy = others.find((o) => {
        if (o === dep) return false;
        return transitiveDepSet(run, o).has(dep);
      });
      if (coveredBy) out.push({ id: task.id, dep, via: coveredBy });
    }
  }
  return out;
}

/** One longest root-to-leaf path (ids, root first). Empty when no tasks. */
export function longestChain(run: Run): string[] {
  const depths = computeDepths(run);
  let deepest: Task | null = null;
  for (const t of taskList(run)) {
    if (!deepest || (depths.get(t.id) ?? 0) > (depths.get(deepest.id) ?? 0)) deepest = t;
  }
  if (!deepest) return [];
  const chain: string[] = [deepest.id];
  let cur = deepest;
  while (cur.deps.length > 0) {
    let best = cur.deps[0];
    for (const d of cur.deps.slice(1)) {
      if ((depths.get(d) ?? 0) > (depths.get(best) ?? 0)) best = d;
    }
    chain.unshift(best);
    const next = run.tasks[best];
    if (!next) break;
    cur = next;
  }
  return chain;
}

export interface ShapeWarning {
  kind: 'long-chain' | 'redundant-dep' | 'narrow' | 'blast-radius';
  message: string;
}

export interface ShapeAnalysis {
  tasks: number;
  /** Edges in the longest chain (0 for empty/singleton). */
  depth: number;
  chain: string[];
  /** Largest wave size (parallelism ceiling at one depth). */
  maxWidth: number;
  /** Redundant direct edges that add blocking without adding order. */
  redundant: RedundantDep[];
  /** Per-task transitive dependent count, descending. */
  blastRadius: { id: string; downstream: number }[];
  warnings: ShapeWarning[];
}

// Thresholds for `dag lint`. Depth counts edges, so depth 5 == 6 tasks deep.
const LONG_CHAIN_EDGES = 5;
const BLAST_RADIUS_FRACTION = 0.5;

/** Full shape report: depth, width, redundant edges, blast radius, warnings. */
export function analyzeShape(run: Run): ShapeAnalysis {
  const tasks = taskList(run);
  const chain = longestChain(run);
  const depth = Math.max(0, chain.length - 1);
  const depths = computeDepths(run);
  const widthByWave = new Map<number, number>();
  for (const t of tasks) {
    const d = depths.get(t.id) ?? 0;
    widthByWave.set(d, (widthByWave.get(d) ?? 0) + 1);
  }
  const maxWidth = widthByWave.size === 0 ? 0 : Math.max(...widthByWave.values());
  const redundant = findRedundantDeps(run);
  const blastRadius = tasks
    .map((t) => ({ id: t.id, downstream: transitiveDependentIds(run, t.id).length }))
    .sort((a, b) => b.downstream - a.downstream);
  const warnings: ShapeWarning[] = [];
  if (depth >= LONG_CHAIN_EDGES) {
    warnings.push({
      kind: 'long-chain',
      message: `chain of ${chain.length} tasks (${chain.slice(0, 4).join(' -> ')}${chain.length > 4 ? ' -> …' : ''}): one stalled task blocks everything below it. Split independent work off the chain so mid-tier tasks depend only on what they directly consume.`,
    });
  }
  for (const r of redundant) {
    warnings.push({
      kind: 'redundant-dep',
      message: `${r.id} depends on ${r.dep} and ${r.via}, but ${r.dep} is already reachable via ${r.via}. Keep only the dep whose output this task directly consumes.`,
    });
  }
  if (tasks.length >= 4 && maxWidth <= 1) {
    warnings.push({
      kind: 'narrow',
      message: `${tasks.length} tasks run at most 1 wide: the graph is fully serial. Fan independent tasks out from their true prerequisite instead of chaining them.`,
    });
  }
  // Roots inevitably block their fan-out, so the blast-radius warning looks
  // past them: a *mid-chain* task stalling half the run means its downstream
  // deps are over-claimed and should be re-checked.
  const topNonRoot = blastRadius.find((b) => (depths.get(b.id) ?? 0) >= 1);
  if (topNonRoot && tasks.length >= 4 && topNonRoot.downstream >= Math.ceil(tasks.length * BLAST_RADIUS_FRACTION)) {
    warnings.push({
      kind: 'blast-radius',
      message: `${topNonRoot.id} blocks ${topNonRoot.downstream} of ${tasks.length} tasks when it stalls. Check that every downstream task truly needs it, directly — not just transitively through the chain.`,
    });
  }
  return { tasks: tasks.length, depth, chain, maxWidth, redundant, blastRadius, warnings };
}

// Deterministic launch order: depth, then creation sequence.
export function topoSort(run: Run): Task[] {
  const depths = computeDepths(run);
  return taskList(run).sort(
    (a, b) => (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0) || a.seq - b.seq,
  );
}

/** Human-readable status block for `dag status`: counts, ready, and why stuck. */
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
