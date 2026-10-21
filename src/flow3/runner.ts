import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { addTask, acquireLock, attemptLogPath, atomicWriteJson, heartbeatPath, lockHeldBy, logEvent, recoverInterrupted, runPaths } from '../store.js';
import { commitAll, createTaskWorktree, ensureIntegrationWorktree, git, isGitRepo, removeWorktree, snapshotExcludes } from '../git-worktree.js';
import { depsMet, describeDeps, gateBlocks } from '../graph.js';
import { planAttempt } from '../harness-chain.js';
import { inferHarnessForCmd } from '../harnesses.js';
import { captureExecutionPolicy } from '../execution-policy.js';
import { checkCommand } from '../planning/compile.js';
import { recordPlanningAcceptance } from '../planning/runtime.js';
import { describeSettingsProblems, validateSettingsPatch, type DagEvent, type FailureKind, type Run, type Task } from '../types.js';
import type { ExecContext, ExecOutcome, Executor, RunnerOptions, RunSummary } from '../runner.js';
import type { WorkerSession } from '../agent-session.js';
import { PHASE_TIMEOUTS, type Candidate, type Checkpoint, type FlowSettings, type Phase } from './contracts.js';
import { chainWaves, checkGraph, overlaps, promptFor } from './graph.js';
import { checkScriptCommands, commandMentionsPath, protectedRepairPath, repairDecision } from './repair.js';

interface Worker {
  path: string;
  branch: string;
  prepared: boolean;
  busy: boolean;
  tainted: boolean;
  session: WorkerSession;
}
type Options = RunnerOptions & { executor: Executor };
const now = () => new Date().toISOString();
const tail = (text: string, max = 4000) => text.slice(-max);
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const definition = (task: Task) => hash(JSON.stringify({ node: task.node, spec: task.spec, cmd: task.cmd, deps: task.deps, chain: task.harnessChain }));
const failure = (message: string, kind: FailureKind = 'exit') => Object.assign(new Error(message), { kind });
const checkpointRepair = (task: Task) => !!(task.node?.repair_of || task.nodeState?.repairCheckpoint);

/** Ordinary Flow 3.0 runs. Factory controllers retain ownership of their own lifecycle. */
export class FlowRunner {
  isRunning = false;
  isStopping = false;
  result: RunSummary | null = null;
  private active = new Set<string>();
  private cancels = new Set<() => void>();
  private workers: Worker[] = [];
  private integration?: { path: string; branch: string };
  private integrationPrepared = false;
  private integrationTainted = false;
  private landing = Promise.resolve();
  private running?: Promise<void>;
  private advisory?: Promise<void>;
  private advisoryWorker?: Worker;
  private issues: string[] = [];
  private cancelAdvisory?: () => void;
  private repo: string;
  private settings: FlowSettings;
  private scope = new Set<string>();
  private budgetReached = false;
  private deadline = 0;
  private logBytes = new Map<string, number>();
  private recovery = { requeued: [] as string[], orphanPids: [] as number[] };

  constructor(readonly state: Run, private opts: Options, private ownedFiles: Set<string>) {
    this.repo = resolve(opts.cwd ?? (opts.file ? dirname(opts.file) : process.cwd()));
    this.settings = state.settings.flow3 ?? {};
  }
  get current(): string[] { return [...this.active]; }

  start(scope: Set<string> | null = null): Promise<void> {
    if (this.isRunning) return this.running!;
    this.isRunning = true; this.isStopping = false; this.budgetReached = false;
    this.workers = []; this.integrationPrepared = false; this.integrationTainted = false;
    this.settings = this.state.settings.flow3 ?? {};
    this.result = null;
    this.issues = [];
    this.scope = new Set(scope ?? Object.keys(this.state.tasks));
    this.running = this.run();
    return this.running;
  }
  async stop(): Promise<void> {
    this.isStopping = true;
    this.event('run-stop', null, 'Flow 3.0 stop requested');
    for (const cancel of [...this.cancels]) cancel();
    await this.running;
  }
  private event(type: DagEvent['type'], id: string | null, message: string): void {
    this.opts.onEvent?.(logEvent(this.state, type, id, message));
  }
  private save(): void {
    this.state.updatedAt = now();
    // Dispatch, verified candidates, and completion must be durable before proceeding.
    this.opts.persist?.(this.state);
  }
  private stopped(): boolean {
    if (this.deadline && Date.now() >= this.deadline) this.budgetReached = true;
    return this.isStopping || this.budgetReached;
  }
  private control(name: string, spec = ''): Task {
    const run = { ...this.state, tasks: {}, events: [], eventSeq: 0 };
    return addTask(run, { title: name, spec, cmd: null });
  }
  private async run(): Promise<void> {
    const file = this.opts.file ? resolve(this.opts.file) : undefined;
    let release: (() => void) | undefined;
    let owns = false;
    try {
      const problems = validateSettingsPatch(this.state.settings as unknown as Record<string, unknown>);
      if (problems.length) throw Error(describeSettingsProblems(problems));
      if (this.opts.quotaRecovery || this.opts.verificationRecovery) throw Error('Flow 3.0 resumes saved candidates directly; use dag retry for failed nodes');
      if (this.opts.contractGuard || this.opts.postcondition) throw Error('Move legacy per-node guards to Flow 3.0 verify or checkpoint commands');
      for (const id of this.scope) if (!this.state.tasks[id]) throw Error(`Unknown selected node ${id}`);
      if (file) {
        if ([...this.ownedFiles].some(owned => resolve(owned) === file)) throw Error(`Run file is locked: ${file}`);
        if (!lockHeldBy(file)) release = acquireLock(file, 'Flow 3.0 runner');
        this.ownedFiles.add(file); owns = true;
      }
      this.state.flowState ??= { version: 3, repairRound: 0, checkpoints: [], issues: [] };
      this.state.flowState.issues = [];
      this.adaptPlanningNodes();
      const graph = checkGraph(this.state);
      for (const warning of graph.warnings) this.event('note', null, warning);
      if (!graph.valid) throw Error(`Graph check failed: ${graph.errors.join('; ')}`);
      for (const edge of graph.addedEdges) this.event('edit', edge.consumer, `Added producer dependency ${edge.producer}`);
      for (const id of this.scope) if (!this.state.tasks[id].node) throw Error(`${id}: Flow 3.0 needs goal, touches, creates, relies_on and one verify command (dag edit --verify ...)`);
      this.recovery = recoverInterrupted(this.state);
      if (!isGitRepo(this.repo)) throw Error('Flow 3.0 requires a Git repository for its worker pool and integration branch');
      this.integration = ensureIntegrationWorktree(this.repo, this.state.id, undefined, file ? snapshotExcludes(file, this.repo) : undefined);
      this.warmCaches(this.integration.path);
      this.state.executionPolicy = captureExecutionPolicy(this.state);
      this.deadline = (this.opts.maxWallClockMs ?? this.state.settings.maxWallClockMs) > 0
        ? Date.now() + (this.opts.maxWallClockMs ?? this.state.settings.maxWallClockMs) : 0;
      this.event('run-start', null, `Flow 3.0; integration ${this.integration.branch}; ${this.scope.size} nodes`);
      this.save();
      // One advisory call runs alongside dispatch. Slow/failed review cannot gate startup.
      this.startAdvisory();
      for (;;) {
        await this.schedule();
        if (this.stopped()) break;
        const unfinished = [...this.scope].filter(id => this.state.tasks[id].status !== 'completed');
        // Missing producers are a scheduling outcome, not a product test failure.
        // A final checkpoint can only evaluate the complete selected graph.
        if (unfinished.length) {
          this.event('note', null, `Final checkpoint deferred: ${unfinished.length} required nodes are incomplete (${unfinished.join(', ')})`);
          break;
        }
        const final = await this.checkpoint('final', [...this.scope]);
        if (final.passed) break;
        if (!this.canRepair()) break;
        const errors = final.results.filter(r => !r.passed);
        if (!errors.length) break;
        if (errors.length && (!this.repairCommand() || !this.repairable(final))) break;
        this.state.flowState.repairRound++;
        if (errors.length) this.addFix(final);
        this.save();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.issues.push(message);
      if (owns || !file) {
        this.state.flowState ??= { version: 3, repairRound: 0, checkpoints: [], issues: [] };
        this.state.flowState.issues.push(message);
        this.event('note', null, `not starting: ${message}`);
      }
    } finally {
      this.cancelAdvisory?.();
      await this.advisory;
      if (this.advisoryWorker && !this.advisoryWorker.tainted) removeWorktree(this.repo, this.advisoryWorker.path);
      this.advisoryWorker = undefined;
      for (const worker of this.workers) if (!worker.tainted) removeWorktree(this.repo, worker.path);
      if (this.integration && !this.integrationTainted) removeWorktree(this.repo, this.integration.path);
      this.integration = undefined;
      const tasks = [...this.scope].map(id => this.state.tasks[id]).filter(Boolean);
      const flow = this.state.flowState;
      const last = flow?.checkpoints.filter(c => c.kind === 'final').at(-1);
      const passed = !!last?.passed && !this.issues.length && !flow?.issues.length && tasks.every(t => t.status === 'completed') && !this.stopped();
      this.result = {
        scope: [...this.scope], completed: tasks.filter(t => t.status === 'completed').map(t => t.id),
        failed: tasks.filter(t => t.status === 'failed').map(t => t.id),
        skipped: tasks.filter(t => t.status === 'skipped').map(t => t.id),
        unfinished: tasks.filter(t => !['completed', 'failed', 'skipped'].includes(t.status)).map(t => t.id),
        stopped: this.isStopping, budgetReached: this.budgetReached, interrupted: this.recovery, finalReview: null,
        flow3: { passed, repairRounds: flow?.repairRound ?? 0, issues: [...new Set([...this.issues, ...(flow?.issues ?? []),
          ...tasks.filter(t => t.status !== 'completed').map(t => `${t.id}: ${t.result ?? (t.deps.some(id => this.state.tasks[id]?.status !== 'completed') ? 'blocked by incomplete dependencies' : gateBlocks(t) ? 'awaiting approval' : t.status)}`),
          ...(last?.results.filter(r => !r.passed).map(r => `${r.command}: ${r.output}`) ?? [])])] },
      };
      this.isRunning = false;
      this.isStopping = false;
      if (owns || !file) this.event('run-end', null, `Flow 3.0 ${passed ? 'passed' : 'incomplete'}; ${this.result.completed.length} complete, ${this.result.failed.length} failed, ${this.result.unfinished.length} blocked/pending`);
      try { if (owns || !file) this.save(); }
      finally { release?.(); if (owns && file) this.ownedFiles.delete(file); }
    }
  }

  /** v2 source contracts remain available, but their expensive gates no longer own dispatch. */
  private adaptPlanningNodes(): void {
    for (const task of Object.values(this.state.tasks)) {
      const planned = this.state.planning?.manifest.tasks.find(t => t.id === task.id);
      if (!planned || !planned.checks.length) continue;
      const [fast] = planned.checks;
      const command = (c: typeof fast) => checkCommand(c, this.opts.file ? join(runPaths(this.opts.file).dir, 'flow-checks') : undefined);
      task.node ??= { goal: planned.objective, touches: (planned.files ?? []).filter(f => f.role !== 'frozen').map(f => f.path),
        creates: (planned.provides ?? []).map(p => p.id), relies_on: (planned.inputs ?? []).map(i => i.capability), verify: command(fast) };
      const rest = [...planned.checks, ...(planned.provides ?? []).map(p => p.check)].map(command).filter(c => c !== task.node!.verify);
      if (rest.length) {
        this.settings = { ...this.settings, additionalFinalChecks: [...new Set([...(this.settings.additionalFinalChecks ?? []), ...rest])] };
        this.state.settings.flow3 = this.settings;
      }
    }
  }

  private warmCaches(path: string): void {
    for (const cache of this.settings.cachePaths ?? ['node_modules', '.venv']) {
      const target = join(this.repo, cache), dest = join(path, cache);
      if (existsSync(target) && !existsSync(dest) && git(path, ['check-ignore', '--quiet', '--', `${cache}/`]).code === 0) {
        mkdirSync(dirname(dest), { recursive: true });
        try { symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir'); }
        catch (error) { this.event('note', null, `Cache ${cache} could not be shared: ${String(error)}`); }
      }
    }
  }
  private worker(): Worker {
    const idle = this.workers.find(w => !w.busy && !w.tainted);
    if (idle) { idle.busy = true; return idle; }
    const created = createTaskWorktree(this.repo, this.state.id, `worker-${randomUUID().slice(0, 8)}`, this.integration!.branch);
    const worker: Worker = { ...created, prepared: false, busy: true, tainted: false, session: {} };
    this.warmCaches(worker.path); this.workers.push(worker);
    return worker;
  }
  private reset(worker: Worker): void {
    const reset = git(worker.path, ['reset', '--hard', this.integration!.branch]);
    if (reset.code) throw failure(reset.stderr, 'worktree');
    const clean = git(worker.path, ['clean', '-fd', ...((this.settings.cachePaths ?? ['node_modules', '.venv']).flatMap(path => ['-e', path]))]);
    if (clean.code) throw failure(clean.stderr, 'worktree');
  }

  private async schedule(): Promise<void> {
    const concurrency = Math.min(64, Math.max(1, this.opts.concurrency ?? this.state.settings.concurrency));
    for (const wave of chainWaves(this.state, this.scope)) {
      if (this.stopped()) return;
      const previouslyDone = new Set(wave.flat().filter(id => this.state.tasks[id].status === 'completed'));
      const queue = [...wave], running = new Map<Promise<void>, string[]>();
      const touches = (chain: string[]) => chain.flatMap(id => this.state.tasks[id].node?.touches ?? []);
      while (queue.length || running.size) {
        if (!this.stopped()) for (let i = 0; i < queue.length && running.size < concurrency;) {
          const chain = queue[i];
          const pending = chain.find(id => ['pending', 'ready'].includes(this.state.tasks[id].status));
          if (!pending || !depsMet(this.state.tasks[pending], this.state.tasks) || gateBlocks(this.state.tasks[pending])) { queue.splice(i, 1); continue; }
          const conflict = [...running.values()].some(other => touches(chain).some(a => touches(other).some(b => overlaps(a, b))));
          if (conflict) { i++; continue; }
          queue.splice(i, 1);
          const promise = this.runChain(chain).finally(() => running.delete(promise));
          running.set(promise, chain);
        }
        if (!running.size) break;
        try { await Promise.race(running.keys()); }
        catch (error) {
          this.isStopping = true;
          for (const cancel of [...this.cancels]) cancel();
          await Promise.allSettled(running.keys());
          throw error;
        }
      }
      // All active workers finish before checking the shared integration branch.
      if (wave.flat().some(id => !previouslyDone.has(id) && this.state.tasks[id].status === 'completed') && !this.stopped()) {
        let check = await this.checkpoint('wave', wave.flat());
        while (!check.passed && this.canRepair() && this.repairCommand() && this.repairable(check) && !this.stopped()) {
          this.state.flowState!.repairRound++;
          const fix = this.addFix(check);
          await this.runChain([fix.id]);
          if (fix.status !== 'completed') break;
          check = await this.checkpoint('wave', wave.flat());
        }
      }
    }
  }
  private async runChain(chain: string[]): Promise<void> {
    const worker = this.worker();
    worker.session = {};
    try {
      this.reset(worker);
      for (const id of chain) {
        const task = this.state.tasks[id];
        if (task.status === 'completed') continue;
        if (this.stopped() || !['pending', 'ready'].includes(task.status) || !depsMet(task, this.state.tasks) || gateBlocks(task)) break;
        const done = await this.node(task, worker);
        if (!done) break;
        // Keep the same worktree, warm environment and harness session through a straight chain.
        this.reset(worker);
      }
    } finally { worker.busy = false; }
  }

  private async node(task: Task, worker: Worker): Promise<boolean> {
    this.active.add(task.id);
    const attemptLimit = Math.min(2, Math.max(1, task.maxAttempts));
    try {
      const saved = task.nodeState?.candidate;
      if (saved) {
        if (saved.definition !== definition(task)) throw failure('Saved verified candidate belongs to a changed node; edit/retry must clear its candidate explicitly', 'integration');
        task.status = 'running'; this.save();
        await this.land(task, saved);
        return this.complete(task);
      }
      let base = '';
      for (; task.attemptsInCycle < attemptLimit && !this.stopped();) {
        task.status = 'running'; task.attempts++; task.attemptsInCycle++;
        task.startedAt = now(); task.finishedAt = null; task.failureKind = null; task.result = null;
        task.nodeState = { ...task.nodeState, worker: worker.path };
        delete task.nodeState.decision;
        this.event('task-start', task.id, `Attempt ${task.attemptsInCycle}/${attemptLimit}; warm worker ${worker.path}`); this.save();
        try {
          if (!worker.prepared) {
            const prepare = this.opts.prepareCommand?.(task) ?? task.prepareCmd ?? this.state.settings.worktreePrepareCmd;
            if (prepare) await this.phase(task, 'setup', prepare, worker.path, worker);
            worker.prepared = true;
          }
          if (!base) { this.reset(worker); base = git(worker.path, ['rev-parse', 'HEAD']).stdout; }
          const selected = planAttempt(task.harnessChain ?? this.state.settings.harnessChain, task.attemptsInCycle);
          const preset = selected?.harness;
          const cmd = checkpointRepair(task) ? task.cmd : this.opts.workCommand?.(task) ?? preset?.cmd ?? task.cmd;
          if (!cmd) throw failure('Node has no work command or harness', 'manual');
          task.harness = selected?.candidate.harness ?? null;
          const workTask = { ...task, spec: promptFor(task, task.attemptsInCycle > 1),
            model: task.model ?? selected?.candidate.model ?? null,
            variant: task.variant ?? selected?.candidate.variant ?? null };
          const output = checkpointRepair(task)
            ? await this.guardedRepair(task, worker, cmd, workTask.spec)
            : await this.phase(workTask, 'work', cmd, worker.path, worker, task);
          (task.milestones ??= {}).implementedAt = now();
          await this.verifyNode(task, worker, cmd);
          task.milestones.checkedAt = now();
          commitAll(worker.path, `dag: ${task.id} attempt ${task.attempts}`, this.settings.cachePaths ?? ['node_modules', '.venv']);
          const commit = git(worker.path, ['rev-parse', 'HEAD']).stdout;
          const branch = `dag-node/${this.state.id}-${task.id}-${task.attempts}`;
          const pin = git(this.repo, ['branch', branch, commit]);
          if (pin.code) throw failure(`Cannot preserve verified candidate: ${pin.stderr}`, 'integration');
          task.branch = branch; task.commit = commit; task.result = tail(output.output);
          const candidate: Candidate = { commit, base, attempt: task.attempts, definition: definition(task) };
          task.nodeState.candidate = candidate; task.nodeState.session = worker.session.id;
          this.save(); // recover this verified source after a crash, without rerunning implementation
          await this.land(task, candidate);
          return this.complete(task);
        } catch (error) {
          if (task.nodeState?.candidate) throw error; // landing is never an implementation retry
          task.lastRejection = error instanceof Error ? error.message : String(error);
          task.failureKind = (error as { kind?: FailureKind }).kind ?? 'exit';
          if (this.isStopping) {
            // A stopped, unverified worker is the only copy of its in-progress edits.
            // Leave it registered for explicit recovery rather than removing it in run cleanup.
            worker.tainted = true;
            task.status = 'pending'; task.result = `Stopped; unverified source preserved at ${worker.path}`;
            return false;
          }
          try {
            const saved = commitAll(worker.path, `dag: failed ${task.id} attempt ${task.attempts}`, this.settings.cachePaths ?? ['node_modules', '.venv']);
            if (saved.commit) {
              const branch = `dag-failed/${this.state.id}-${task.id}-${task.attempts}`;
              git(this.repo, ['branch', branch, saved.commit]); task.branch = branch; task.commit = saved.commit;
            }
          } catch { /* Preserve the worktree if the executor could not be stopped. */ }
          if (task.nodeState?.decision || checkpointRepair(task) || worker.tainted || task.attemptsInCycle >= attemptLimit) throw error;
          const decision = repairDecision(this.state, { command: task.cmd ?? '', output: task.lastRejection,
            phase: task.phaseHistory?.at(-1)?.phase as Phase ?? 'work', kind: task.failureKind });
          task.nodeState!.decision = decision;
          if (decision.action !== 'repair') { this.event('note', task.id, `Automatic retry held: ${decision.reason}`); throw error; }
          this.event('task-retry', task.id, `Retry in saved workspace with actual failure: ${tail(task.lastRejection, 800)}`);
        }
      }
      throw failure('Node attempt or run budget exhausted', 'budget');
    } catch (error) {
      task.status = this.isStopping ? 'pending' : 'failed'; task.finishedAt = now(); task.pid = null;
      task.failureKind = (error as { kind?: FailureKind }).kind ?? 'exit';
      task.result = tail(error instanceof Error ? error.message : String(error)); task.lastRejection = task.result;
      this.event(this.isStopping ? 'task-killed' : 'task-fail', task.id, task.result);
      return false;
    } finally { this.active.delete(task.id); this.save(); }
  }
  private async verifyNode(task: Task, worker: Worker, workCommand: string): Promise<void> {
    for (;;) {
      try { await this.phase(task, 'verify', task.node!.verify, worker.path, worker); delete task.nodeState!.decision; return; }
      catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        const state = task.nodeState!;
        const decision = repairDecision(this.state, { command: task.node!.verify, output, phase: 'verify',
          kind: (error as { kind?: string }).kind, requires: task.node!.verify_requires });
        // A local check cannot be deferred past its own downstream consumer. Admission must wire its producers.
        if (decision.action === 'defer') { decision.action = 'hold'; decision.reason = 'Local verification requires an unfinished producer; declare verify_requires and repair the graph'; }
        if (state.repairFailures?.includes(decision.fingerprint)) {
          decision.action = 'hold'; decision.category = 'no-progress'; decision.reason = 'The same verifier failure remained after repair';
        }
        const repairLimit = this.settings.nodeRepairRounds ?? 1;
        if (decision.action === 'repair' && (state.repairAttempts ?? 0) >= repairLimit) {
          decision.action = 'hold'; decision.category = 'policy'; decision.reason = `Node repair budget exhausted: ${state.repairAttempts ?? 0}/${repairLimit}`;
        }
        state.decision = decision; this.save();
        if (this.stopped() || worker.tainted || checkpointRepair(task) || decision.action !== 'repair') {
          this.event('note', task.id, `Node repair held: ${decision.reason}; used ${state.repairAttempts ?? 0} repair rounds`);
          throw error;
        }
        state.repairAttempts = (state.repairAttempts ?? 0) + 1;
        (state.repairFailures ??= []).push(decision.fingerprint);
        this.event('task-repair', task.id, `In-place repair ${state.repairAttempts}: ${decision.reason}`); this.save();
        await this.guardedRepair(task, worker, this.settings.repairCommand ?? workCommand,
          `Repair only the concrete failure in the existing implementation. Keep all completed edits.\nNode: ${task.node!.goal}\nFailed check: ${task.node!.verify}\nActual output:\n${tail(output, 6000)}`);
      }
    }
  }
  private protectedPaths(): string[] {
    return [...new Set([...(this.settings.repairProtectedPaths ?? []),
      ...(this.state.planning?.manifest.tasks.flatMap(t => (t.files ?? []).filter(f => ['frozen', 'test'].includes(f.role)).map(f => f.path)) ?? [])])];
  }
  private async guardedRepair(task: Task, worker: Worker, command: string, instruction: string): Promise<ExecOutcome> {
    const before = snapshot(worker.path), head = git(worker.path, ['rev-parse', 'HEAD']).stdout;
    const packageFile = join(worker.path, 'package.json');
    const scripts = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')).scripts ?? {} : {};
    const checks = checkScriptCommands([task.node!.verify, ...this.commands('wave'), ...this.commands('final')], scripts);
    const protectedPaths = [...this.protectedPaths(), ...[...before.keys()].filter(path => /\.(?:[cm]?[jt]sx?|py|sh|ps1|bat|cmd|rb)$/i.test(path) && checks.some(command => commandMentionsPath(command, path)))];
    const spec = `${instruction}\nAllowed files: ${task.node!.touches.join(', ')}.\nPreserve acceptance tests, assertions, contracts and check configuration. Additional protected paths: ${protectedPaths.join(', ') || '(none)'}. Do not change Git history, dependencies, task scope or verification commands. Do not run broad acceptance suites. Return the repair for the runner to verify.`;
    try {
      const result = await this.phase({ ...task, spec }, 'repair', command, worker.path, worker, task);
      if (git(worker.path, ['rev-parse', 'HEAD']).stdout !== head) throw Error('Repair policy violation: agent changed Git history');
      const after = snapshot(worker.path), changed = [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file));
      for (const file of changed) {
        if (!task.node!.touches.some(allowed => overlaps(file, allowed))) throw Error(`Repair policy violation: outside allowed scope: ${file}`);
        if (protectedRepairPath(file) || protectedPaths.some(path => overlaps(file, path))) throw Error(`Repair policy violation: protected acceptance/configuration file ${file}`);
      }
      if (!changed.length) throw Error('Repair made no source changes; stop for diagnosis');
      return result;
    } catch (error) {
      const decision = repairDecision(this.state, { command, output: String(error), phase: 'repair', kind: (error as { kind?: string }).kind });
      task.nodeState!.decision = { ...decision, action: 'hold', ...(String(error).includes('no source changes') ? { category: 'no-progress' as const } : {}) };
      throw error;
    }
  }
  private complete(task: Task): true {
    task.status = 'completed'; task.finishedAt = now(); task.pid = null;
    task.failureKind = null; task.exitCode = 0;
    (task.milestones ??= {}).integratedAt = now();
    this.event('task-done', task.id, `Verified and integrated ${task.diffHead}`); this.save();
    return true;
  }

  private async phase(task: Task, phase: Phase, command: string, cwd: string, worker?: Worker, observed = task): Promise<ExecOutcome> {
    const started = Date.now(); let lastOutput = started, finished = false, settled = false;
    let kill: (() => void) | undefined, rejectPhase: (error: Error) => void = () => {};
    let killed = false;
    const killOnce = () => { if (!killed && kill) { killed = true; try { kill(); } catch { /* already exited */ } } };
    const requestedTimeout = phase === 'work' ? this.opts.timeoutFor?.(observed) ?? observed.timeoutMs ?? this.opts.timeoutMs ?? this.settings.phaseTimeouts?.work ?? this.state.settings.timeoutMs
      : this.settings.phaseTimeouts?.[phase] ?? PHASE_TIMEOUTS[phase];
    const timeout = requestedTimeout || PHASE_TIMEOUTS[phase];
    const idle = (observed.silenceMs ?? this.opts.silenceMs ?? this.settings.idleTimeoutMs ?? this.state.settings.silenceMs) || 180_000;
    const abort = (error: Error) => { if (!finished) { finished = true; killOnce(); rejectPhase(error); } };
    const cancel = () => abort(failure('Stopped', 'killed'));
    this.cancels.add(cancel);
    if (phase === 'advisory') this.cancelAdvisory = cancel;
    this.event('note', observed.id, `phase ${phase} start ${new Date(started).toISOString()} timeout=${timeout}ms idle=${idle}ms`);
    const aborted = new Promise<never>((_, reject) => { rejectPhase = reject; });
    const timer = setTimeout(() => abort(failure(`${phase} timed out after ${timeout}ms`, 'timeout')), timeout || PHASE_TIMEOUTS[phase]);
    const watchdog = setInterval(() => {
      if (this.opts.file && this.state.tasks[observed.id] && existsSync(heartbeatPath(this.opts.file, observed.id))) {
        try { const time = Date.parse(readFileSync(heartbeatPath(this.opts.file, observed.id), 'utf8').trim()); if (time > lastOutput && time <= Date.now()) lastOutput = time; } catch { /* malformed heartbeat is not liveness */ }
      }
      if (Date.now() - lastOutput >= idle) abort(failure(`${phase} stalled for ${idle}ms`, 'stalled'));
    }, Math.max(5, Math.min(1000, idle / 3)));
    const context: ExecContext = {
      cwd, executionProfile: 'lean', readOnly: phase === 'advisory', session: phase === 'work' ? worker?.session : undefined,
      env: { DAG_FILE: this.opts.file ? resolve(this.opts.file) : undefined, DAG_RUN: this.state.id, DAG_TASK: observed.id, DAG_PHASE: phase },
      deps: describeDeps(this.state, observed),
      onOutput: chunk => {
        if (finished) return;
        lastOutput = Date.now(); observed.lastOutputAt = now(); observed.lastOutput = tail(chunk, 2000);
        this.append(observed, phase, chunk);
      },
      registerKill: fn => { kill = fn; if (finished) killOnce(); },
      aborted: () => finished,
      setPid: pid => { if (!finished) { observed.pid = pid; this.save(); } },
    };
    let status = 'pass';
    const execution = Promise.resolve().then(() => this.opts.executor(task, context, command)).finally(() => { settled = true; });
    try {
      const outcome = await Promise.race([execution, aborted]);
      observed.exitCode = outcome.exitCode;
      if (outcome.exitCode !== 0) throw failure(`${phase} exit ${outcome.exitCode}: ${tail(outcome.output)}`);
      return outcome;
    } catch (error) {
      status = (error as Error).message; finished = true;
      if (!settled) killOnce();
      if (!settled) {
        let grace: NodeJS.Timeout | undefined;
        await Promise.race([execution.catch(() => {}), new Promise<void>(r => { grace = setTimeout(r, this.opts.stopGraceMs ?? 1000); })]);
        if (grace) clearTimeout(grace);
        if (!settled) {
          if (worker) worker.tainted = true;
          else if (phase !== 'advisory') this.integrationTainted = true;
          if (phase !== 'advisory') {
            this.state.flowState!.issues.push(`${phase}: executor did not stop; workspace preserved for inspection`);
            this.isStopping = true;
            for (const other of [...this.cancels]) if (other !== cancel) other();
          }
        }
      }
      throw error;
    } finally {
      finished = true; clearTimeout(timer); clearInterval(watchdog); this.cancels.delete(cancel); observed.pid = null;
      const ended = Date.now();
      (observed.phaseHistory ??= []).push({ attempt: observed.attempts, phase, startedAt: new Date(started).toISOString(), finishedAt: new Date(ended).toISOString(), durationMs: ended - started, outcome: status });
      this.event('note', observed.id, `phase ${phase} end ${new Date(ended).toISOString()} duration=${ended - started}ms ${tail(status, 800)}`);
      this.save();
    }
  }
  private append(task: Task, phase: Phase, chunk: string): void {
    if (!this.opts.file) return;
    const key = `${task.id}/${task.attempts}`;
    const bytes = this.logBytes.get(key) ?? 0;
    const limit = this.opts.logCapBytes ?? this.state.settings.logCapBytes;
    if (bytes >= limit) return;
    const file = attemptLogPath(this.opts.file, task.id, task.attempts);
    mkdirSync(dirname(file), { recursive: true });
    const data = Buffer.from(`[${phase}] ${chunk}`).subarray(0, limit - bytes);
    appendFileSync(file, data); this.logBytes.set(key, bytes + data.length);
  }

  private async land(task: Task, candidate: Candidate): Promise<void> {
    const queued = Date.now();
    const land = async () => {
      if (this.stopped()) throw failure('Stopped before landing', 'killed');
      const path = this.integration!.path;
      task.diffBase = git(path, ['rev-parse', 'HEAD']).stdout;
      // A crash after merge but before completion cannot cost another implementation attempt.
      if (git(path, ['merge-base', '--is-ancestor', candidate.commit, 'HEAD']).code !== 0) {
        const result = git(path, ['-c', 'user.name=DAG Orchestrator', '-c', 'user.email=dag@localhost', '-c', 'core.hooksPath=', 'merge', '--no-ff', '--no-commit', candidate.commit], undefined, this.settings.phaseTimeouts?.land ?? PHASE_TIMEOUTS.land);
        if (result.code) {
          const conflicts = git(path, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
          try {
            if (!conflicts.length) throw failure(`Merge failed: ${result.stderr || result.stdout}`, 'merge');
            const command = this.settings.conflictCommand ?? this.repairCommand();
            if (!command) throw failure(`Merge conflicts in ${conflicts.join(', ')}; configure flow3.conflictCommand. Verified source ${candidate.commit} is preserved.`, 'merge');
            const before = snapshot(path);
            const markers = new Map(conflicts.map(file => [file, readFileSync(join(path, file), 'utf8')]));
            const resolver = { ...task, spec: `Resolve only Git conflict marker blocks in ${conflicts.join(', ')}. Preserve every byte outside those blocks and every other file. Do not rerun node ${task.id}. Do not commit or run Git commands.` };
            await this.phase(resolver, 'resolve', command, path, undefined, task);
            if (git(path, ['rev-parse', 'HEAD']).stdout !== task.diffBase || git(path, ['rev-parse', 'MERGE_HEAD']).stdout !== candidate.commit) throw Error('Resolver changed Git history');
            assertMarkerOnly(path, before, markers);
            const staged = git(path, ['add', '--', ...conflicts]);
            if (staged.code) throw Error(staged.stderr);
          } catch (error) {
            git(path, ['merge', '--abort']);
            if (!this.integrationTainted) git(path, ['reset', '--hard', task.diffBase!]);
            throw failure(`Conflict resolution failed; verified source preserved: ${(error as Error).message}`, 'merge');
          }
        }
        try {
          const committed = git(path, ['-c', 'user.name=DAG Orchestrator', '-c', 'user.email=dag@localhost', '-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', `dag: integrate ${task.id}`], undefined, this.settings.phaseTimeouts?.land ?? PHASE_TIMEOUTS.land);
          if (committed.code) throw Error(committed.stderr || committed.stdout);
        }
        catch (error) { git(path, ['merge', '--abort']); throw failure(String(error), 'merge'); }
      }
      task.diffHead = git(path, ['rev-parse', 'HEAD']).stdout;
      this.save();
    };
    task.integrationQueuedAt = new Date(queued).toISOString(); this.save();
    const operation = this.landing.then(async () => {
      const started = Date.now(); let outcome = 'pass';
      delete task.integrationQueuedAt;
      this.event('note', task.id, `phase land start ${now()} queue=${started - queued}ms`);
      try { await land(); }
      catch (error) { outcome = String(error); throw error; }
      finally {
        (task.phaseHistory ??= []).push({ attempt: task.attempts, phase: 'land', startedAt: new Date(started).toISOString(), finishedAt: now(), durationMs: Date.now() - started, outcome });
        this.event('note', task.id, `phase land end ${now()} duration=${Date.now() - started}ms ${tail(outcome, 800)}`);
        this.save();
      }
    });
    this.landing = operation.then(() => {}, () => {});
    return operation;
  }

  private commands(kind: 'wave' | 'final'): string[] {
    const authored = kind === 'wave' ? this.settings.waveChecks : this.settings.finalChecks;
    const pkg = join(this.integration!.path, 'package.json');
    const scripts = existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {} : {};
    const detected = (kind === 'wave' ? ['build', 'typecheck'] : ['build', 'typecheck', 'test', 'verify:spec']).filter(name => scripts[name]).map(name => `npm run ${name}`);
    const commands = authored ?? detected;
    return kind === 'wave' ? commands : [...new Set([...this.commands('wave'), ...commands, ...(this.settings.additionalFinalChecks ?? []),
      ...[...this.scope].filter(id => this.state.tasks[id].status === 'completed').map(id => this.state.tasks[id].node!.verify)])];
  }
  private async checkpoint(kind: 'wave' | 'final', nodes: string[]): Promise<Checkpoint> {
    const path = this.integration!.path;
    const checkpoint: Checkpoint = { id: randomUUID(), kind, head: git(path, ['rev-parse', 'HEAD']).stdout, nodes,
      results: [], passed: true };
    const task = this.control(`${kind} checkpoint`);
    try {
      if (!this.integrationPrepared && this.state.settings.worktreePrepareCmd) {
        await this.phase(task, 'setup', this.state.settings.worktreePrepareCmd, path);
        this.integrationPrepared = true;
      }
      const commands = this.commands(kind);
      if (!commands.length) checkpoint.results.push({ command: `${kind}Checks`, passed: false, output: `No ${kind} checks configured or detected; configure flow3.${kind}Checks` });
      if (kind === 'final' && !this.commands('wave').length) checkpoint.results.push({ command: 'waveChecks', passed: false, output: 'Configure build/typecheck wave commands in flow3.waveChecks' });
      if (kind === 'final' && !(this.settings.finalChecks?.length ?? this.detectFinalChecks().length) && !this.settings.additionalFinalChecks?.length) checkpoint.results.push({ command: 'finalChecks', passed: false, output: 'Configure full integration/tests/spec checks in flow3.finalChecks' });
      for (const command of commands) {
        if (this.stopped()) break;
        const requires = this.settings.checkPrerequisites && Object.hasOwn(this.settings.checkPrerequisites, command) ? this.settings.checkPrerequisites[command] : [];
        if (requires.some(id => this.state.tasks[id]?.status !== 'completed')) {
          const decision = repairDecision(this.state, { command, output: '', phase: kind === 'wave' ? 'checkpoint' : 'integration', requires });
          checkpoint.results.push({ command, passed: false, output: decision.reason, decision });
          this.event('note', null, `Checkpoint check ${decision.action}: ${decision.reason}`);
          continue;
        }
        try {
          const result = await this.phase(task, kind === 'wave' ? 'checkpoint' : 'integration', command, path);
          checkpoint.results.push({ command, passed: true, output: tail(result.output) });
        } catch (error) {
          const output = tail((error as Error).message);
          const decision = repairDecision(this.state, { command, output, phase: kind === 'wave' ? 'checkpoint' : 'integration', kind: (error as { kind?: string }).kind, requires });
          checkpoint.results.push({ command, passed: false, output, decision });
          this.event('note', null, `Checkpoint repair ${decision.action}: ${decision.reason}`);
        }
      }
      // A checkpoint may generate ignored output, but may not silently alter accepted source.
      const dirty = git(path, ['status', '--porcelain', '--', '.', ...(this.settings.cachePaths ?? ['node_modules', '.venv']).map(cache => `:(exclude)${cache}`)]).stdout;
      if (dirty) {
        if (this.opts.file) atomicWriteJson(join(runPaths(this.opts.file).dir, 'flow3', `checkpoint-${checkpoint.id}.json`), {
          head: checkpoint.head, status: dirty, patch: git(path, ['diff', '--binary', 'HEAD']).stdout,
        });
        if (!this.integrationTainted) {
          git(path, ['reset', '--hard', checkpoint.head]);
          git(path, ['clean', '-fd', ...((this.settings.cachePaths ?? ['node_modules', '.venv']).flatMap(cache => ['-e', cache]))]);
        }
        throw Error(`Checkpoint modified tracked/untracked source; changes preserved in checkpoint diagnostics: ${dirty}`);
      }
    } catch (error) {
      const output = tail((error as Error).message);
      checkpoint.results.push({ command: 'checkpoint environment', passed: false, output,
        decision: repairDecision(this.state, { command: 'checkpoint environment', output, phase: 'setup' }) });
    }
    checkpoint.passed = checkpoint.results.length > 0 && checkpoint.results.every(r => r.passed) && !this.stopped();
    if (kind === 'final' && checkpoint.passed) for (const id of this.scope) {
      const node = this.state.tasks[id];
      if (node.status === 'completed') recordPlanningAcceptance(this.state, node, hash(JSON.stringify(checkpoint)));
    }
    this.state.flowState!.checkpoints.push(checkpoint);
    this.event('note', null, `${kind} checkpoint ${checkpoint.passed ? 'pass' : 'fail'} at ${checkpoint.head}`); this.save();
    return checkpoint;
  }
  private canRepair(): boolean { return this.state.flowState!.repairRound < (this.settings.repairRounds ?? 2); }
  private repairable(check: Checkpoint): boolean {
    const failed = check.results.filter(r => !r.passed);
    if (!failed.length || failed.some(r => r.decision?.action !== 'repair')) return false;
    if (failed.some(r => this.state.flowState!.repairFailures?.includes(r.decision!.fingerprint))) {
      this.event('note', null, 'Checkpoint repair held: the same failure remained after the previous repair');
      return false;
    }
    const touches = this.fixTouches(check);
    if (!touches.length || touches.length > 8) {
      this.event('note', null, 'Checkpoint repair held: no bounded file ownership could be identified (maximum 8 hints)');
      return false;
    }
    return true;
  }
  private fixTouches(check: Checkpoint): string[] {
    const candidates = [...new Set(check.nodes.filter(id => this.state.tasks[id]?.status === 'completed').flatMap(id => this.state.tasks[id].node?.touches ?? []))];
    const output = check.results.filter(r => !r.passed).map(r => r.output.replaceAll('\\', '/').toLowerCase()).join('\n');
    const mentioned = candidates.filter(path => output.includes(path.replaceAll('\\', '/').toLowerCase()));
    return (mentioned.length ? mentioned : candidates).filter(path => !protectedRepairPath(path) && !this.protectedPaths().some(p => overlaps(path, p)));
  }
  private detectFinalChecks(): string[] {
    const path = join(this.integration!.path, 'package.json');
    if (!existsSync(path)) return [];
    const scripts = JSON.parse(readFileSync(path, 'utf8')).scripts ?? {};
    return ['build', 'typecheck', 'test', 'verify:spec'].filter(name => scripts[name]);
  }
  private repairCommand(): string | undefined {
    if (this.settings.repairCommand) return this.settings.repairCommand;
    const selected = planAttempt(this.state.settings.harnessChain, 1)?.harness.cmd;
    return selected ?? Object.values(this.state.tasks).map(task => planAttempt(task.harnessChain, 1)?.harness.cmd ?? inferHarnessForCmd(task.cmd)?.cmd).find(Boolean) ?? undefined;
  }
  private addFix(check: Checkpoint): Task {
    const completed = [...this.scope].filter(id => this.state.tasks[id].status === 'completed');
    const errors = check.results.filter(r => !r.passed).map(r => `${r.command}\n${r.output}`).join('\n');
    const touches = this.fixTouches(check);
    const goal = `Fix actual ${check.kind} checkpoint errors; preserve completed behavior.\n${tail(errors, 6000)}`;
    const task = addTask(this.state, { title: `Repair ${check.kind} checkpoint (round ${this.state.flowState!.repairRound})`, spec: goal,
      cmd: this.repairCommand(), deps: completed,
      node: { goal, touches, creates: [], relies_on: [], verify: 'git diff --check', repair_of: check.id }, maxAttempts: 2 });
    task.nodeState = { repairCheckpoint: check.id };
    (this.state.flowState!.repairFailures ??= []).push(...check.results.filter(r => !r.passed).map(r => r.decision!.fingerprint));
    this.scope.add(task.id); this.event('task-repair', task.id, `Created from checkpoint ${check.id}`); this.save();
    return task;
  }
  private startAdvisory(): void {
    const command = this.settings.advisoryCommand ?? planAttempt(this.state.settings.harnessChain, 1)?.harness.cmd ??
      Object.values(this.state.tasks).map(task => planAttempt(task.harnessChain, 1)?.harness.cmd ?? inferHarnessForCmd(task.cmd)?.cmd).find(Boolean);
    if (!command || this.state.flowState!.advisory) return;
    this.state.flowState!.advisory = { status: 'started' }; this.save();
    const task = this.control('advisory plan review', 'Read-only advisory review. Identify oversized nodes, suspicious ordering or edges, and concrete proposed corrections. Do not edit files or run expensive checks. Execution is already starting.\n' + JSON.stringify([...this.scope].map(id => ({ id, deps: this.state.tasks[id].deps, ...this.state.tasks[id].node }))));
    try {
      const workspace = createTaskWorktree(this.repo, this.state.id, `advisory-${randomUUID().slice(0, 8)}`, this.integration!.branch);
      this.advisoryWorker = { ...workspace, prepared: true, busy: true, tainted: false, session: {} };
    } catch (error) {
      this.state.flowState!.advisory = { status: 'warning', output: String(error) };
      this.event('note', null, `Advisory workspace warning: ${String(error)}`); return;
    }
    this.advisory = this.phase(task, 'advisory', command, this.advisoryWorker.path, this.advisoryWorker).then(
      result => { this.state.flowState!.advisory = { status: 'finished', output: tail(result.output, 8000) }; this.event('note', null, `Advisory plan review: ${tail(result.output, 2000)}`); },
      error => { this.state.flowState!.advisory = { status: 'warning', output: String(error) }; this.event('note', null, `Advisory plan review warning: ${String(error)}`); },
    );
  }
}

/** Snapshot source identities only during conflict resolution, including new files. */
function snapshot(path: string): Map<string, string> {
  const names = git(path, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).stdout.split('\0').filter(Boolean);
  return new Map([...new Set(names)].map(name => {
    const file = join(path, name);
    return [name, existsSync(file) ? lstatSync(file).isSymbolicLink() ? hash(readlinkSync(file)) : hash(readFileSync(file)) : '(deleted)'];
  }));
}
function assertMarkerOnly(path: string, before: Map<string, string>, markers: Map<string, string>): void {
  const after = snapshot(path);
  for (const name of new Set([...before.keys(), ...after.keys()])) if (!markers.has(name) && before.get(name) !== after.get(name)) throw Error(`Resolver changed non-conflict file ${name}`);
  for (const [name, original] of markers) {
    const blocks = /^<<<<<<<[^\n]*\n[\s\S]*?^=======[^\n]*\n[\s\S]*?^>>>>>>>[^\n]*(?:\n|$)/gm;
    const segments: string[] = []; let cursor = 0, match: RegExpExecArray | null;
    while ((match = blocks.exec(original))) { segments.push(original.slice(cursor, match.index)); cursor = match.index + match[0].length; }
    segments.push(original.slice(cursor));
    if (segments.length < 2) throw Error(`Cannot resolve ${name}: no text conflict markers`);
    const escaped = segments.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const resolved = readFileSync(join(path, name), 'utf8');
    if (!new RegExp(`^${escaped.join('[\\s\\S]*?')}$`).test(resolved) || /^(?:<<<<<<<|=======|>>>>>>>)/m.test(resolved)) throw Error(`Resolver changed text outside marker blocks in ${name}`);
  }
}
