// Review-oriented commands: `layers` (dependency waves), `chain-review`
// (review tasks that themselves review other tasks), the integration/reviewer
// scaffolds, and the harness/model presets that supply agent commands.
import { existsSync } from 'node:fs';
import {
  addTask,
  buildIntegrationSpec,
  editTask,
  loadRun,
  saveRun,
} from '../store.js';
import { computeDepths, topoSort, transitiveDepIds } from '../graph.js';
import { HARNESSES, findHarness } from '../harnesses.js';
import { listAgentModels } from '../agent-models.js';
import { resolveCommand } from '../command-resolution.js';
import { parseWhen } from '../review-policy.js';
import {
  countFlag,
  emit,
  flag,
  guard,
  has,
  parseList,
  retriesToMaxAttempts,
  secondsToMs,
} from '../cli-args.js';
import type { Task } from '../types.js';

// `layers` groups tasks into dependency waves (depth 0 has no deps, etc.), so
// callers can pick a wave to review or to run in parallel.
export function layersCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  const run = loadRun(file);
  const depths = computeDepths(run);
  const waves = new Map<number, Task[]>();
  for (const task of Object.values(run.tasks)) {
    const d = depths.get(task.id) ?? 0;
    const list = waves.get(d) ?? [];
    list.push(task);
    waves.set(d, list);
  }
  const rows = [...waves.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, list]) => ({
      wave: depth,
      tasks: list.length,
      ids: list.map((t) => t.id),
      titles: list.map((t) => t.title),
    }));
  emit(argv, { waves: rows }, () =>
    rows
      .map((r) => `wave ${r.wave}: ${r.tasks} task(s) — ${r.titles.slice(0, 4).join(' | ')}${r.titles.length > 4 ? ' | …' : ''}`)
      .join('\n'),
  );
}

// `chain-review` creates one review task per chunk of finished tasks. The
// review task depends on (and covers) its subjects, so it runs after them, and
// its own VERDICT decides. The spec is a template rendered at run time from
// `{coverage*}`, which is what lets a reviewer see the per-task diffs.
export function chainReviewCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const depths = computeDepths(run);
  const all = Object.values(run.tasks);

  // Which tasks are covered: an explicit list, one wave, or everything.
  let covered: Task[];
  const of = parseList(flag(argv, 'of'));
  const wave = countFlag(argv, 'wave', 0);
  const from = flag(argv, 'from');
  const depth = countFlag(argv, 'depth', 1) ?? 1;
  if (of.length > 0) {
    const unknown = of.filter((id) => !run.tasks[id]);
    if (unknown.length > 0) throw new Error(`unknown task(s): ${unknown.join(', ')}`);
    covered = of.map((id) => run.tasks[id]);
  } else if (wave !== undefined) {
    covered = all.filter((t) => (depths.get(t.id) ?? 0) === wave);
    if (covered.length === 0) throw new Error(`no tasks in wave ${wave}; try: dag layers`);
  } else if (from !== undefined) {
    if (!run.tasks[from]) throw new Error(`unknown task ${from}`);
    const subtree = new Set([from, ...transitiveDepIds(run, from)]);
    // Cover the dependency cone of the anchor, in topological order.
    covered = topoSort(run).filter((t) => subtree.has(t.id));
    if (depth > 1) covered = covered.filter((t) => (depths.get(t.id) ?? 0) <= (depths.get(from) ?? 0));
  } else if (has(argv, 'all')) {
    covered = topoSort(run);
  } else {
    throw new Error('choose what to review: --of a,b | --wave N | --from <id> | --all');
  }
  const done = covered.filter((t) => t.status === 'completed' && !t.covers);
  if (done.length === 0) {
    throw new Error('nothing to review: none of the selected tasks completed (chain tasks are not reviewed twice)');
  }
  // 500 tasks is not one reviewer's job: chunk by --batch (default keeps one
  // task per chunk for an explicit --of, and 25 otherwise).
  const batch = countFlag(argv, 'batch', 1) ?? (of.length > 0 ? done.length : 25);
  const chunks: Task[][] = [];
  for (let i = 0; i < done.length; i += batch) chunks.push(done.slice(i, i + batch));

  const reviewCommand =
    flag(argv, 'cmd') ??
    (run.settings.harnessChain?.length
      ? findHarness(run.settings.harnessChain[run.settings.harnessChain.length - 1].harness)?.cmd
      : undefined) ??
    findHarness('opencode')?.cmd;
  if (!reviewCommand) throw new Error('no command for the reviewer; pass --cmd');

  const created: string[] = [];
  for (const chunk of chunks) {
    const titleBase = flag(argv, 'title') ?? 'chain review';
    const title =
      chunks.length === 1
        ? `${titleBase}: ${chunk.length} task(s)`
        : `${titleBase}: ${chunk.length} task(s) [${created.length + 1}/${chunks.length}]`;
    const spec = [
      'Review the combined work of the tasks listed at the end of this prompt.',
      'This is a review, not an implementation: do not modify files.',
      '',
      'Facts about the covered work:',
      '- covered tasks:',
      '{coverage}',
      '- one diff per task, plus a manifest, live in: {coverageDir}',
      '  (the manifest is {coverageManifest}; each entry names its task, spec, result and diff file)',
      '- changed files across the chain:',
      '{coverageFiles}',
      '- change summary:',
      '{coverageStat}',
      '',
      'Do this:',
      '1. Read the manifest, then the per-task diffs. For each task, check the code actually satisfies its spec - not just that the task ran.',
      '2. Look for what per-task reviews cannot see: tasks contradicting each other, a later task undoing an earlier one, changes that only work in isolation, gaps between tasks, broken integration.',
      '3. Verify with the repository own checks where cheap (build, tests, lint), and say what you ran.',
      '4. Report concrete findings with file:line and the task that caused them.',
      '',
      'End with exactly one line: VERDICT: PASS or VERDICT: FAIL: <reason>',
    ].join('\n');
    const task = addTask(run, {
      title,
      spec,
      cmd: reviewCommand,
      deps: chunk.map((t) => t.id),
      covers: chunk.map((t) => t.id),
    });
    created.push(task.id);
  }
  saveRun(run, file);
  emit(
    argv,
    { created, covered: done.map((t) => t.id), chunks: chunks.map((c) => c.length) },
    () =>
      `created ${created.length} chain review task(s) over ${done.length} task(s): ${created.join(', ')}`,
  );
}

// `review` either scaffolds an integration node over several deps (whose
// failure repairs its upstream), or attaches a reviewer postcondition to an
// existing task with --id.
export function reviewCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const attachTo = flag(argv, 'id');
  if (attachTo && !argv.includes('--of')) {
    const reviewCmd = flag(argv, 'review-cmd');
    if (!reviewCmd) throw new Error('--review-cmd is required when reviewing an existing task');
    const rounds = flag(argv, 'review-rounds');
    const task = editTask(run, attachTo, {
      reviewCmd,
      reviewRounds: rounds !== undefined ? countFlag(argv, 'review-rounds', 0) ?? 1 : 1,
    });
    saveRun(run, file);
    emit(argv, task, () => `${task.id} reviewCmd set (rounds ${task.reviewRounds})`);
    return;
  }
  const deps = parseList(flag(argv, 'of'));
  if (deps.length === 0) throw new Error('--of id1,id2 is required (or --id to review one task)');
  for (const d of deps) {
    if (!run.tasks[d]) throw new Error(`unknown dep ${d}`);
  }
  const checkCmd = flag(argv, 'cmd');
  if (!checkCmd) throw new Error('--cmd is required: the command that checks the pieces mesh');
  const title =
    flag(argv, 'title') ??
    `integration: ${deps.map((id) => run.tasks[id].title).join(' + ')}`;
  const spec = flag(argv, 'spec') ?? buildIntegrationSpec(run, deps, checkCmd);
  const repairRounds = flag(argv, 'repair-rounds');
  const task = addTask(run, {
    title,
    spec,
    deps,
    cmd: checkCmd,
    maxAttempts: retriesToMaxAttempts(flag(argv, 'retries')),
    timeoutMs: secondsToMs(flag(argv, 'timeout')) ?? null,
    silenceMs: secondsToMs(flag(argv, 'silence')) ?? null,
    reviewCmd: argv.includes('--review-cmd') ? (flag(argv, 'review-cmd') ?? null) : null,
    reviewRounds: countFlag(argv, 'review-rounds', 0) ?? 0,
    repairRounds: repairRounds !== undefined ? countFlag(argv, 'repair-rounds', 0) ?? 1 : 1,
  });
  saveRun(run, file);
  emit(
    argv,
    task,
    () =>
      `${task.id}\n${task.title}\ndeps=[${deps.join(',')}] repairRounds=${task.repairRounds}\n\n${task.spec}`,
  );
}

// `reviewer` manages the reviewers attached to a task: each emits its own
// verdict and the task passes only when every applicable one passes.
export function reviewerCmd(argv: string[]): void {
  const file = flag(argv, 'file') ?? 'dag.run.json';
  guard(file, argv);
  const run = loadRun(file);
  const id = flag(argv, 'id');
  const sub = argv[0] ?? 'list';
  if (sub === 'list') {
    if (!id) throw new Error('usage: dag reviewer list --id <task>');
    const task = run.tasks[id];
    if (!task) throw new Error(`unknown task ${id}`);
    const list = [...(task.reviewers ?? [])];
    if (task.reviewCmd) list.push({ name: 'review', cmd: task.reviewCmd, when: 'always' });
    emit(argv, list, () =>
      list.length === 0
        ? 'no reviewers'
        : list
            .map((r) => `${r.name.padEnd(12)} when=${r.when ?? 'always'} verdict=${r.verdict ?? 'default'}\n  ${r.cmd}`)
            .join('\n'),
    );
    return;
  }
  if (sub === 'rm' || sub === 'remove') {
    if (!id) throw new Error('usage: dag reviewer rm --id <task> --name <reviewer>');
    const name = flag(argv, 'name');
    if (!name) throw new Error('--name is required');
    const task = run.tasks[id];
    if (!task) throw new Error(`unknown task ${id}`);
    const before = (task.reviewers ?? []).length;
    const legacyCleared = name === 'review' && Boolean(task.reviewCmd);
    task.reviewers = (task.reviewers ?? []).filter((r) => r.name !== name);
    if (legacyCleared) task.reviewCmd = null;
    const removed = before - (task.reviewers ?? []).length;
    if (removed === 0 && !legacyCleared) {
      throw new Error(`no reviewer named "${name}" on ${id}`);
    }
    saveRun(run, file);
    emit(argv, { removed }, () => `removed reviewer "${name}" from ${id}`);
    return;
  }
  if (sub === 'add' || sub === 'set') {
    if (!id) throw new Error('usage: dag reviewer add --id <task> --name N --cmd "..." [--when W] [--verdict v]');
    const name = flag(argv, 'name');
    const cmdText = flag(argv, 'cmd');
    if (!name || !cmdText) throw new Error('--name and --cmd are required');
    const when = flag(argv, 'when') ?? 'always';
    const invalid = parseWhen(when).invalid;
    if (invalid) throw new Error(`unknown --when clause "${invalid}"`);
    const verdict = flag(argv, 'verdict');
    if (verdict !== undefined && verdict !== 'marker' && verdict !== 'exit-code') {
      throw new Error(`--verdict must be marker|exit-code (got ${verdict})`);
    }
    const task = run.tasks[id];
    if (!task) throw new Error(`unknown task ${id}`);
    const list = (task.reviewers ?? []).filter((r) => r.name !== name);
    list.push({
      name,
      cmd: cmdText,
      when,
      ...(verdict ? { verdict: verdict as 'marker' | 'exit-code' } : {}),
      ...(flag(argv, 'why') ? { why: flag(argv, 'why') } : {}),
    });
    task.reviewers = list;
    saveRun(run, file);
    emit(argv, task.reviewers, () => `${id}: ${list.length} reviewer(s), added "${name}" (${when})`);
    return;
  }
  throw new Error('usage: dag reviewer add|rm|list --id <task> [--name N] [--cmd C] [--when W] [--verdict v]');
}

// `harness` lists or shows the agent-CLI presets a task can be pointed at.
export function harnessCmd(argv: string[]): void {
  const sub = argv[0] ?? 'list';
  if (sub === 'show') {
    const name = flag(argv, 'name') ?? argv[1];
    const harness = name ? findHarness(name) : undefined;
    if (!harness) throw new Error(`unknown harness ${name ?? ''}; try: dag harness list`);
    emit(argv, harness, () => JSON.stringify(harness, null, 2));
    return;
  }
  const rows = HARNESSES.map((h) => ({
    name: h.name,
    label: h.label,
    detected: h.binary ? existsSync(resolveCommand(h.binary).file) : true,
    verified: h.verified,
    cmd: h.cmd,
    notes: h.notes ?? '',
  }));
  emit(argv, rows, () =>
    rows
      .map(
        (r) =>
          `${r.detected ? '[x]' : '[ ]'} ${r.name.padEnd(14)} ${r.label.padEnd(18)} ${r.verified ? 'verified' : 'unverified'}` +
          (r.cmd ? `\n    ${r.cmd}` : '') +
          (r.notes ? `\n    ${r.notes}` : ''),
      )
      .join('\n'),
  );
}

// `models` lists the models an agent CLI offers.
export async function modelsCmd(argv: string[]): Promise<void> {
  const harnessName = flag(argv, 'harness') ?? 'opencode';
  const harness = findHarness(harnessName);
  if (harness && !harness.modelListCmd) {
    emit(argv, { models: [], error: `${harnessName} has no model list command; set --model free-text` }, () =>
      `${harnessName} has no model list command; set --model free-text`,
    );
    return;
  }
  const { models, error } = await listAgentModels(flag(argv, 'refresh') === '1');
  emit(argv, { models, error }, () =>
    error
      ? `could not list models: ${error}`
      : models.length === 0
        ? 'no models reported by opencode'
        : models.join('\n'),
  );
}
