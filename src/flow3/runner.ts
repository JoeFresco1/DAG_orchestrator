import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { addTask, acquireLock, attemptLogPath, atomicWriteJson, heartbeatPath, lockHeldBy, logEvent, recoverInterrupted, runPaths } from '../store.js';
import { commitAll, createTaskWorktree, ensureIntegrationWorktree, git, isGitRepo, removeWorktree, snapshotExcludes } from '../git-worktree.js';
import { depsMet, describeDeps, gateBlocks, transitiveDepSet } from '../graph.js';
import { planAttempt } from '../harness-chain.js';
import { findHarness, inferHarnessForCmd } from '../harnesses.js';
import { captureExecutionPolicy } from '../execution-policy.js';
import { checkCommand } from '../planning/compile.js';
import { recordPlanningAcceptance } from '../planning/runtime.js';
import { describeSettingsProblems, validateSettingsPatch, type DagEvent, type FailureKind, type Run, type Task } from '../types.js';
import { parseVerdict, stripAnsi, type ExecContext, type ExecOutcome, type Executor, type RunnerOptions, type RunSummary } from '../runner.js';
import type { WorkerSession } from '../agent-session.js';
import { PHASE_TIMEOUTS, type Candidate, type Checkpoint, type FlowSettings, type Phase, type RepairContext, type RepairIntent } from './contracts.js';
import { acceptanceIdentity, completionScope, evidenceFailure, evidenceArtifacts } from './lifecycle.js';
import { codexQuota, quotaSignal, QuotaUnavailable, type QuotaProbe, type QuotaReading } from './quota.js';
import { repairBrief } from './progress.js';
import { chainWaves, checkGraph, overlaps, promptFor } from './graph.js';
import { checkScriptCommands, commandMentionsPath, protectedRepairPath, repairDecision, transientProviderFailure } from './repair.js';

interface Worker {
  path: string;
  branch: string;
  prepared: boolean;
  busy: boolean;
  tainted: boolean;
  session: WorkerSession;
}
type CheckOutcome = ExecOutcome & { evidenceRef?: string; artifacts?: Record<string, string> };
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
  private finalCheckpointId?: string;
  private explicitSelection = false;
  private schedulingChanged = false;
  private wakeQuota?: () => void;
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
    this.result = null; this.finalCheckpointId = undefined;
    this.issues = [];
    this.explicitSelection = scope !== null;
    const saved = this.state.flowState?.completion;
    this.scope = new Set(scope ?? (saved?.mode === 'scoped' ? [...saved.required, ...saved.optional.filter(id => !saved.excluded.includes(id))] : this.settings.completion?.mode === 'scoped' ? [...this.settings.completion.required, ...this.settings.completion.optional] : Object.keys(this.state.tasks)));
    this.running = this.run();
    return this.running;
  }
  async stop(userRequested = true): Promise<void> {
    this.isStopping = true;
    if (this.state.flowState && userRequested) { this.finishQuotaClock(); this.state.flowState.userStopped = true; this.save(); }
    this.wakeQuota?.();
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
      delete this.state.flowState.userStopped;
      if (this.state.flowState.quotaWait?.manual) delete this.state.flowState.quotaWait;
      this.state.flowState.issues = [];
      this.state.flowState.implementationComplete = false;
      this.state.flowState.acceptanceStatus = 'pending';
      this.state.flowState.productComplete = false;
      const previousReview = this.state.flowState.review;
      if (previousReview?.status === 'pending' && previousReview.output) (this.state.flowState.reviewHistory ??= []).push({ ...previousReview, status: 'error', output: previousReview.output + '\nInterrupted before a conclusive review result' });
      this.state.flowState.review = { identity: '', status: this.state.settings.finalReview === 'off' ? 'off' : 'pending' };
      for (const check of this.state.flowState.checkpoints) if (check.outcome === 'running') {
        check.outcome = 'interrupted'; check.passed = false;
        check.results.push({ command: 'checkpoint interruption', passed: false, outcome: 'interrupted', output: 'Previous check execution ended without a conclusive checkpoint result' });
      }
      this.adaptPlanningNodes();
      this.state.flowState.completion = completionScope(this.state, this.scope, this.explicitSelection);
      // A persisted required producer participates in the same scheduler, even after a scoped resume.
      for (const id of this.state.flowState.completion.required) this.scope.add(id);
      this.resumeRepairIntents();
      const graph = checkGraph(this.state);
      for (const warning of graph.warnings) this.event('note', null, warning);
      if (!graph.valid) throw Error(`Graph check failed: ${graph.errors.join('; ')}`);
      for (const edge of graph.addedEdges) this.event('edit', edge.consumer, `Added producer dependency ${edge.producer}`);
      // Admission can add edges after completionScope was calculated.
      this.reopenProducers(this.required());
      for (const id of this.scope) if (!this.state.tasks[id].node) throw Error(`${id}: Flow 3.0 needs goal, touches, creates, relies_on and one verify command (dag edit --verify ...)`);
      this.recovery = recoverInterrupted(this.state);
      if (!isGitRepo(this.repo)) throw Error('Flow 3.0 requires a Git repository for its worker pool and integration branch');
      this.integration = ensureIntegrationWorktree(this.repo, this.state.id, undefined, file ? snapshotExcludes(file, this.repo) : undefined);
      this.warmCaches(this.integration.path);
      this.state.flowState.integrationBase ??= git(this.integration.path, ['rev-parse', 'HEAD']).stdout;
      for (const task of this.correctedTasks()) this.assertVerificationCorrection(task, this.integration.path);
      this.reopenProducers(this.correctedTasks().flatMap(t => t.nodeState!.verificationCorrection!.requires));
      this.state.executionPolicy = captureExecutionPolicy(this.state);
      const wall = this.opts.maxWallClockMs ?? this.state.settings.maxWallClockMs;
      if (!this.state.flowState.deadlineAt && wall > 0) this.state.flowState.deadlineAt = Date.now() + wall;
      this.state.flowState.deadlineAt ??= 0;
      this.deadline = this.state.flowState.deadlineAt;
      this.event('run-start', null, `Flow 3.0; integration ${this.integration.branch}; ${this.scope.size} nodes`);
      this.save();
      // One advisory call runs alongside dispatch. Slow/failed review cannot gate startup.
      if (!this.state.flowState.quotaWait) this.startAdvisory();
      for (;;) {
        if (this.state.flowState.quotaWait && !await this.awaitQuota()) break;
        this.schedulingChanged = false;
        await this.schedule();
        if (this.state.flowState.quotaWait && !this.isStopping) continue;
        if (this.stopped()) break;
        // Local and wave diagnoses may enlarge scope while a wave snapshot runs.
        if (this.schedulingChanged) continue;
        const unfinished = [...new Set([...this.required(), ...[...this.scope].filter(id => checkpointRepair(this.state.tasks[id]))])].filter(id => this.state.tasks[id]?.status !== 'completed');
        this.state.flowState.implementationComplete = !unfinished.length;
        // Missing producers are a scheduling outcome, not a product test failure.
        // A final checkpoint can only evaluate the complete selected graph.
        if (unfinished.length) {
          this.event('note', null, `Final checkpoint deferred: ${unfinished.length} required nodes are incomplete (${unfinished.join(', ')})`);
          break;
        }
        const final = await this.checkpoint('final', [...this.scope]);
        const producers = final.results.flatMap(r => r.decision?.action === 'defer' ? r.decision.requires ?? [] : []);
        if (this.reopenProducers(producers)) continue;
        if (final.passed) { await this.finalReview(final); break; }
        if (!this.canRepair()) break;
        const errors = final.results.filter(r => !r.passed);
        if (!errors.length) break;
        if (errors.length && (!this.repairCommand() || !this.repairable(final))) break;
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
      const last = flow?.checkpoints.find(c => c.id === this.finalCheckpointId);
      const implementationComplete = this.required().every(id => this.state.tasks[id]?.status === 'completed') && tasks.filter(checkpointRepair).every(t => t.status === 'completed');
      const accepted = !!last?.passed && implementationComplete && !this.issues.length && !flow?.issues.length && !this.stopped();
      const reviewStatus = this.state.settings.finalReview === 'off' ? 'off' : last?.identity?.digest && flow?.review?.identity === last.identity.digest ? flow.review.status : 'pending';
      const passed = accepted && (reviewStatus === 'off' || reviewStatus === 'pass');
      if (flow && (owns || !file)) {
        flow.implementationComplete = implementationComplete;
        flow.acceptanceStatus = accepted ? 'passed' : last ? 'failed' : 'pending';
        flow.productComplete = passed && flow.completion?.mode === 'whole-product';
        flow.mergeStatus = 'integration-only';
      }
      this.result = {
        scope: [...this.scope], completed: tasks.filter(t => t.status === 'completed').map(t => t.id),
        failed: tasks.filter(t => t.status === 'failed').map(t => t.id),
        skipped: tasks.filter(t => t.status === 'skipped').map(t => t.id),
        unfinished: tasks.filter(t => !['completed', 'failed', 'skipped'].includes(t.status)).map(t => t.id),
        stopped: this.isStopping, budgetReached: this.budgetReached, interrupted: this.recovery, finalReview: flow?.review && reviewStatus !== 'off' && reviewStatus !== 'pending' ? {
          mode: this.state.settings.finalReview, verdict: reviewStatus, reason: flow.review.output ?? '',
          reviewed: this.state.settings.finalReview === 'per-task' ? (flow.review.results ?? []).map(r => r.task) : flow.review.results?.length ? tasks.filter(t => t.status === 'completed').map(t => t.id) : [], failed: this.state.settings.finalReview === 'per-task' ? (flow.review.results ?? []).filter(r => r.verdict !== 'pass').map(r => r.task) : flow.review.status === 'pass' ? [] : flow.review.results?.length ? tasks.map(t => t.id) : [], requeued: [] } : null,
        flow3: { passed, implementationComplete, acceptanceStatus: flow?.acceptanceStatus ?? 'pending', reviewStatus, mergeStatus: 'integration-only', productComplete: flow?.productComplete ?? false, completion: flow?.completion, repairRounds: flow?.repairRound ?? 0, issues: [...new Set([...this.issues, ...(flow?.issues ?? []),
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

  /** This intent is durable before git changes HEAD. update-ref can be repeated after a crash. */
  private pinInterruptedWork(task: Task): void {
    const state = task.nodeState!, saved = state.quotaCapture!;
    const ref = 'refs/dag/quota/' + this.state.id + '/' + task.id;
    if (saved.attempt !== task.attempts || saved.definition !== definition(task) || this.recovery.orphanPids.length ||
      saved.path !== state.worker || !existsSync(saved.path)) throw failure('Cannot identify interrupted worktree; source preserved', 'worktree');
    const current = git(saved.path, ['rev-parse', 'HEAD']).stdout;
    if (current !== saved.head && (git(saved.path, ['rev-parse', 'HEAD^']).stdout !== saved.head ||
      git(saved.path, ['log', '-1', '--format=%s']).stdout !== 'dag: interrupted implementation')) throw failure('Interrupted worktree changed; source preserved', 'worktree');
    const snapshot = commitAll(saved.path, 'dag: interrupted implementation', this.settings.cachePaths ?? ['node_modules', '.venv']);
    const commit = snapshot.commit ?? current;
    const pin = git(this.repo, ['update-ref', ref, commit]);
    if (pin.code) throw failure(pin.stderr, 'worktree');
    state.quotaWork = { commit, definition: saved.definition, attempt: saved.attempt, remainingMs: saved.remainingMs, session: saved.session };
    delete state.quotaCapture; this.save();
  }
  private finishQuotaClock(): void {
    const flow = this.state.flowState, wait = flow?.quotaWait;
    if (!flow || wait?.since === undefined) return;
    if (flow.deadlineAt) this.deadline = flow.deadlineAt += Math.max(0, Date.now() - wait.since);
    delete wait.since;
  }
  private provider(task: Task, cmd: string): string {
    return this.opts.quotaProbe ? 'adapter' : (task.harness === 'codex' || inferHarnessForCmd(cmd)?.name === 'codex' ? 'codex' : 'unsupported');
  }
  private probe(provider: string) { return this.opts.quotaProbe ?? (provider === 'codex' ? codexQuota : undefined); }
  private requestQuotaWait(provider: string, reason: string, reading?: QuotaReading, confirmed = true): void {
    const wait = this.state.flowState!.quotaWait ??= { provider, reason, reading, confirmed };
    if (confirmed) wait.confirmed = true;
    if (provider !== wait.provider && !wait.pendingProviders?.includes(provider)) (wait.pendingProviders ??= []).push(provider);
  }
  private readQuota(probe: QuotaProbe): Promise<QuotaReading> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.cancels.delete(cancel); };
      const cancel = () => { cleanup(); reject(Error('Quota read interrupted')); };
      const timer = setTimeout(cancel, 15000);
      this.cancels.add(cancel);
      Promise.resolve().then(probe).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  private fresh(r: QuotaReading, requested: number) {
    return Number.isFinite(r.remainingPercent) && r.remainingPercent >= 0 && r.remainingPercent <= 100 && r.observedAt >= requested && r.observedAt <= Date.now();
  }
  private async awaitQuota(): Promise<boolean> {
    const flow = this.state.flowState!, w = flow.quotaWait!, probe = this.probe(w.provider);
    if (this.isStopping || this.budgetReached) return false;
    if (!probe) { this.finishQuotaClock(); w.manual = true; w.reason = 'No quota probe for this harness. Confirm availability and explicitly start the saved run.'; this.save(); return false; }
    if (w.since === undefined && this.stopped()) return false;
    if (w.confirmed !== false) w.since ??= Date.now();
    this.save();
    while (!this.isStopping) {
      if (w.since === undefined && this.stopped()) return false;
      const requested = Date.now();
      try {
        const r = await this.readQuota(probe); if (this.isStopping) return false;
        if (!this.fresh(r, requested)) throw Error('Stale reading');
        w.reading = r;
        if (r.remainingPercent > (this.settings.quotaReservePercent ?? 0)) {
          const next = w.pendingProviders?.shift();
          if (next) {
            w.provider = next; delete w.reading; delete w.nextProbeAt; this.save();
            return this.awaitQuota();
          }
          this.finishQuotaClock(); delete flow.quotaWait; this.event('note', null, 'Quota available; resuming saved work'); this.save(); return true;
        }
        if (w.since === undefined && this.stopped()) return false;
        w.confirmed = true; w.since ??= Date.now();
        w.reason = 'Waiting for quota above reserve';
        w.nextProbeAt = Math.min(requested + 300000, Math.max(requested + 1000, r.resetAt ?? requested + 30000));
      } catch (error) {
        if (this.isStopping) return false;
        if (error instanceof QuotaUnavailable) { this.finishQuotaClock(); w.manual = true; w.reason = error.message; this.save(); return false; }
        w.reason = 'Waiting for fresh quota reading'; w.nextProbeAt = Date.now() + 30000;
      }
      this.save();
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.wakeQuota = undefined; resolve(); };
        const timer = setTimeout(wake, Math.max(1, w.nextProbeAt! - Date.now())); this.wakeQuota = wake;
      });
    }
    return false;
  }
  private async schedule(): Promise<void> {
    // Known acceptance producers need no deliberately failing final checkpoint.
    const checks = new Set(this.commands('final'));
    this.reopenProducers([...checks].flatMap(command => this.checkPrerequisites(command)));
    // Resume a charged checkpoint repair before releasing another downstream wave.
    for (const id of this.scope) {
      const task = this.state.tasks[id];
      if (checkpointRepair(task) && ['pending', 'ready'].includes(task.status) && depsMet(task, this.state.tasks) && !gateBlocks(task)) {
        if (this.stopped()) return;
        await this.runChain([id]);
        if (task.status !== 'completed') return;
      }
    }
    const concurrency = Math.min(64, Math.max(1, this.opts.concurrency ?? this.state.settings.concurrency));
    for (const wave of chainWaves(this.state, this.scope)) {
      if (this.stopped() || this.state.flowState?.quotaWait) return;
      const previouslyDone = new Set(wave.flat().filter(id => this.state.tasks[id].status === 'completed'));
      const queue = [...wave], running = new Map<Promise<void>, string[]>();
      const touches = (chain: string[]) => chain.flatMap(id => this.state.tasks[id].node?.touches ?? []);
      while (queue.length || running.size) {
        if (!this.stopped() && !this.state.flowState?.quotaWait) for (let i = 0; i < queue.length && running.size < concurrency;) {
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
      if (wave.flat().some(id => !previouslyDone.has(id) && this.state.tasks[id].status === 'completed') && !this.stopped() && !this.state.flowState?.quotaWait) {
        let check = await this.checkpoint('wave', wave.flat());
        this.reopenProducers(check.results.flatMap(r => r.decision?.action === 'defer' ? r.decision.requires ?? [] : []));
        while (!check.passed && this.canRepair() && this.repairCommand() && this.repairable(check) && !this.stopped()) {
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
        if (this.stopped() || this.state.flowState?.quotaWait || !['pending', 'ready'].includes(task.status) || !depsMet(task, this.state.tasks) || gateBlocks(task)) break;
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
      const priorRepair = task.nodeState?.repairContext;
      if (!checkpointRepair(task) && !saved && !task.nodeState?.repairBaseline && priorRepair && task.nodeState?.decision?.action === 'hold' &&
        priorRepair.identity?.requirements === this.identity(this.integration!.path, [task.node!.verify]).requirements) {
        throw failure('Repair is held; retry cannot switch to implementation to replenish its exhausted or rejected allowance', 'budget');
      }
      if ((checkpointRepair(task) || task.nodeState?.repairBaseline) && task.attempts > 0 && !saved) return await this.recoverRepair(task, worker);
      if (saved) {
        if (saved.definition !== definition(task)) throw failure('Saved verified candidate belongs to a changed node; edit/retry must clear its candidate explicitly', 'integration');
        if (task.nodeState?.repairContext) this.assertRepairAuthority(task);
        task.status = 'running'; this.save();
        await this.land(task, saved);
        return this.complete(task);
      }
      if (task.nodeState?.verificationCorrection) return await this.resumeCorrectedVerification(task, worker);
      if (task.nodeState?.quotaCapture) this.pinInterruptedWork(task);
      let continuation = task.nodeState?.quotaWork;
      // A quota checkpoint already contains any replayed prerequisite edits.
      const dependencyWork = continuation ? undefined : task.nodeState?.dependencyWork;
      if (dependencyWork && (dependencyWork.definition !== definition(task) || dependencyWork.attempt !== task.attempts)) throw failure('Saved prerequisite recovery belongs to changed work; source preserved', 'integration');
      if (continuation && (continuation.definition !== definition(task) || continuation.attempt !== task.attempts || continuation.remainingMs <= 0 || continuation.dispatching || this.recovery.orphanPids.length)) throw failure('Interrupted work cannot safely resume; inspect saved source', 'budget');
      if (this.settings.quotaReservePercent !== undefined) {
        const selected = planAttempt(task.harnessChain ?? this.state.settings.harnessChain, Math.max(1, task.attemptsInCycle + (continuation ? 0 : 1)));
        const provider = this.provider(task, this.opts.workCommand?.(task) ?? selected?.harness?.cmd ?? task.cmd ?? '');
        const requested = Date.now(); let reading;
        try { const probe = this.probe(provider); if (probe) reading = await this.readQuota(probe); } catch { /* retry through wait path */ }
        if (!reading || !this.fresh(reading, requested) || reading.remainingPercent <= this.settings.quotaReservePercent) {
          if (this.isStopping) return false;
          this.requestQuotaWait(provider, 'Checking configured quota reserve', reading, !!reading && this.fresh(reading, requested)); this.save(); return false;
        }
      }
      if (this.state.flowState?.quotaWait || this.isStopping) return false;
      let base = '';
      for (; (continuation || task.attemptsInCycle < attemptLimit) && !this.stopped();) {
        task.status = 'running'; if (!continuation) { task.attempts++; task.attemptsInCycle++; }
        task.startedAt = now(); task.finishedAt = null; task.failureKind = null; task.result = null;
        task.nodeState = { ...task.nodeState, worker: worker.path };
        if (!checkpointRepair(task)) delete task.nodeState.decision;
        this.event('task-start', task.id, `Attempt ${task.attemptsInCycle}/${attemptLimit}; warm worker ${worker.path}`); this.save();
        try {
          if (!worker.prepared) {
            const prepare = this.opts.prepareCommand?.(task) ?? task.prepareCmd ?? this.state.settings.worktreePrepareCmd;
            if (prepare) await this.phase(task, 'setup', prepare, worker.path, worker);
            worker.prepared = true;
          }
          if (!base) {
            if (continuation) {
              const restored = git(worker.path, ['reset', '--hard', continuation.commit]);
              if (restored.code) throw failure('Cannot restore interrupted source: ' + restored.stderr, 'worktree');
            } else if (dependencyWork) {
              const restored = git(worker.path, ['cherry-pick', '--no-commit', dependencyWork.commit]);
              if (restored.code) { git(worker.path, ['cherry-pick', '--abort']); throw failure('Saved prerequisite edits conflict with integrated producers; source preserved', 'integration'); }
            } else this.reset(worker); base = git(worker.path, ['rev-parse', 'HEAD']).stdout;
          }
          const selected = planAttempt(task.harnessChain ?? this.state.settings.harnessChain, task.attemptsInCycle);
          const preset = selected?.harness;
          const cmd = checkpointRepair(task) ? task.cmd : this.opts.workCommand?.(task) ?? preset?.cmd ?? task.cmd;
          if (!cmd) throw failure('Node has no work command or harness', 'manual');
          task.harness = selected?.candidate.harness ?? null;
          const workTask = { ...task, spec: promptFor(task, task.attemptsInCycle > 1),
            model: task.model ?? selected?.candidate.model ?? null,
            variant: task.variant ?? selected?.candidate.variant ?? null };
          if (continuation) {
            worker.session = { ...continuation.session };
            continuation.dispatching = true; this.save(); // a crash in an unconfirmed dispatch must not replay its effects
          }
          const output = checkpointRepair(task)
            ? await this.guardedRepair(task, worker, cmd)
            : await this.phase(workTask, 'work', cmd, worker.path, worker, task);
          delete task.nodeState!.quotaWork; continuation = undefined;
          delete task.nodeState!.dependencyWork;
          (task.milestones ??= {}).implementedAt = now();
          await this.verifyNode(task, worker, cmd, base);
          if (checkpointRepair(task)) for (const command of this.verificationCommands(task).filter(command => command !== task.node!.verify)) {
            await this.phase(task, 'verify', command, worker.path, worker);
          }
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
          const interrupted = error as { quotaProvider?: string; remainingMs?: number };
          if (interrupted.quotaProvider && !worker.tainted) {
            worker.tainted = true;
            if (!task.nodeState?.repairBaseline) task.nodeState!.quotaCapture = {
              path: worker.path, head: git(worker.path, ['rev-parse', 'HEAD']).stdout, definition: definition(task),
              attempt: task.attempts, remainingMs: interrupted.remainingMs!, session: { ...worker.session },
            };
            task.status = 'pending'; task.pid = null; task.result = 'Quota interrupted; saved source';
            this.requestQuotaWait(interrupted.quotaProvider, 'Harness reported quota exhaustion');
            this.save();
            if (task.nodeState?.quotaCapture) { this.pinInterruptedWork(task); worker.tainted = false; }
            return false;
          }
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
          const phase = task.phaseHistory?.at(-1)?.phase as Phase ?? 'work';
          const priorDecision = task.nodeState?.decision;
          const diagnosis = task.nodeState?.decision ?? repairDecision(this.state, { command: task.cmd ?? '', output: task.lastRejection, phase, kind: task.failureKind });
          task.nodeState!.decision = diagnosis; this.save();
          if (!worker.tainted && !continuation && !checkpointRepair(task) && diagnosis.action === 'defer' && this.deferNode(task, attemptLimit, base, worker)) return false;
          if (continuation || priorDecision || checkpointRepair(task) || worker.tainted || task.attemptsInCycle >= attemptLimit) throw error;
          const chain = task.harnessChain ?? this.state.settings.harnessChain;
          const current = planAttempt(chain, task.attemptsInCycle), next = planAttempt(chain, task.attemptsInCycle + 1);
          const alternate = phase === 'work' && !this.opts.workCommand && transientProviderFailure(task.lastRejection) && current && next &&
            JSON.stringify(current.candidate) !== JSON.stringify(next.candidate);
          if (diagnosis.action !== 'repair' && !alternate) { this.event('note', task.id, `Automatic retry held: ${diagnosis.reason}`); throw error; }
          // The existing persisted implementation attempt limit bounds fallback.
          // No node/checkpoint repair allowance is spent or renewed.
          if (alternate) { worker.session = {}; this.event('note', task.id, `Transient provider failure; using authorized alternate ${next.candidate.harness}`); }
          delete task.nodeState!.decision;
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
  /** Resume verification of saved repair edits without another coding dispatch or allowance. */
  private async recoverRepair(task: Task, worker: Worker): Promise<boolean> {
    const saved = task.nodeState, baseline = saved?.repairBaseline, path = saved?.worker;
    if (!baseline || !path || !existsSync(path) || this.recovery.orphanPids.length) throw failure('Checkpoint repair allowance exhausted; saved repair needs inspection and retry cannot replenish its dispatch', 'budget');
    if (git(path, ['rev-parse', 'HEAD']).stdout !== baseline.head) throw failure('Repair recovery held: saved Git history changed', 'integration');
    const before = new Map(baseline.files), after = snapshot(path);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file));
    if (!changed.length) throw failure('Repair recovery held: no saved source changes; no additional repair allowance', 'budget');
    for (const file of changed) if (!task.node!.touches.some(p => overlaps(p, file)) || protectedRepairPath(file) || baseline.protectedPaths.some(p => overlaps(p, file))) throw failure(`Repair recovery policy violation: outside allowed scope or protected source: ${file}`, 'integration');
    this.assertRepairAuthority(task);
    const context = saved!.repairContext;
    if (!context || context.authority !== 'flow3-automatic') throw failure('Repair recovery lacks persisted authority', 'integration');
    // Preserve a commit object without advancing the saved worker's HEAD: a second
    // crash during recovery verification must leave the same baseline recoverable.
    const staged = git(path, ['add', '-A']);
    if (staged.code) throw failure(`Cannot stage recovered source: ${staged.stderr}`, 'integration');
    const caches = this.settings.cachePaths ?? ['node_modules', '.venv'];
    if (caches.length) {
      const excluded = git(path, ['reset', '--quiet', 'HEAD', '--', ...caches]);
      if (excluded.code) throw failure(`Cannot exclude recovered caches: ${excluded.stderr}`, 'integration');
    }
    const tree = git(path, ['write-tree']);
    if (tree.code) throw failure(`Cannot preserve recovered tree: ${tree.stderr}`, 'integration');
    const preserved = git(path, ['-c', 'user.name=DAG Orchestrator', '-c', 'user.email=dag@localhost', 'commit-tree', tree.stdout, '-p', baseline.head, '-m', `dag: preserve interrupted repair ${task.id}`]);
    if (preserved.code) throw failure(`Cannot preserve recovered source: ${preserved.stderr}`, 'integration');
    const commit = preserved.stdout;
    const reset = git(worker.path, ['reset', '--hard', commit]);
    if (reset.code) throw failure(`Cannot restore recovered source: ${reset.stderr}`, 'integration');
    task.status = 'running'; this.save();
    for (const command of this.verificationCommands(task)) {
      try { await this.phase(task, 'verify', command, worker.path, worker); }
      catch (error) {
        saved!.decision = repairDecision(this.state, { command, output: String(error), phase: 'verify' });
        this.save(); throw error;
      }
    }
    const branch = `dag-node/${this.state.id}-${task.id}-${task.attempts}`;
    const pinned = git(this.repo, ['branch', '-f', branch, commit]);
    if (pinned.code) throw failure(`Cannot pin recovered candidate: ${pinned.stderr}`, 'integration');
    task.branch = branch; task.commit = commit;
    const candidate: Candidate = { commit, base: baseline.head, attempt: task.attempts, definition: definition(task) };
    saved!.candidate = candidate; this.save();
    await this.land(task, candidate);
    removeWorktree(this.repo, path);
    return this.complete(task);
  }
  private verificationCommands(task: Task): string[] {
    const context = task.nodeState?.repairContext;
    return [...new Set([this.localVerification(task), ...(context?.verification ?? []).filter(command =>
      context?.owners.some(id => this.state.tasks[id]?.status === 'completed' && this.localVerification(this.state.tasks[id]) === command))])];
  }
  private correctedTasks(): Task[] { return Object.values(this.state.tasks).filter(t => t.nodeState?.verificationCorrection); }
  private localVerification(task: Task): string { return task.nodeState?.verificationCorrection?.local ?? task.node!.verify; }
  private checkPrerequisites(command: string): string[] {
    return [...new Set([...(this.settings.checkPrerequisites?.[command] ?? []),
      ...this.correctedTasks().flatMap(t => t.nodeState!.verificationCorrection!.original === command ? t.nodeState!.verificationCorrection!.requires : [])])];
  }
  private localCheckCommand(task: Task): string {
    return checkCommand(task.node!.local_check!, join(runPaths(this.opts.file!).dir, 'flow-local-checks'));
  }
  private localCheckSources(task: Task, path: string, files = task.node!.local_check!.files!): Record<string, string> {
    return Object.fromEntries(files.map(file => {
      const target = join(path, file);
      if (!existsSync(target) || !lstatSync(target).isFile()) throw failure(`Local check authority unavailable: protected test file ${file} is missing or not a regular file`, 'integration');
      return [file, hash(readFileSync(target))];
    }));
  }
  private assertVerificationCorrection(task: Task, path: string): void {
    const correction = task.nodeState?.verificationCorrection;
    if (!correction) return;
    if (!this.opts.file || !task.node?.local_check || correction.definition !== definition(task) || correction.original !== task.node.verify ||
      correction.local !== this.localCheckCommand(task) || correction.work.attempt !== task.attempts ||
      !correction.requires.includes(task.id) || correction.requires.some(id => !this.state.tasks[id]) ||
      task.node.local_check.files!.some(file => !Object.hasOwn(correction.checkSources, file)) ||
      JSON.stringify(correction.checkSources) !== JSON.stringify(this.localCheckSources(task, path, Object.keys(correction.checkSources)))) {
      throw failure(`Verification correction authority changed for ${task.id}; retain its original acceptance obligation and saved source`, 'integration');
    }
  }
  /** This is a check-staging correction, never an implementation edge or coding retry. */
  private correctVerification(task: Task, worker: Worker, base: string): boolean {
    const state = task.nodeState!, decision = state.decision!;
    if (state.verificationCorrection || checkpointRepair(task) || decision.action !== 'defer' || !decision.requires?.length) return false;
    const consumer = (id: string) => id !== task.id && transitiveDepSet(this.state, id).has(task.id);
    if (!decision.requires.some(consumer)) return false; // ordinary missing producer
    const refuse = (reason: string) => { decision.action = 'hold'; decision.reason = `Verification dependency cycle: ${reason}`; this.save(); return false; };
    if (/AssertionError|ERR_ASSERTION|SyntaxError|\berror TS\d+/i.test(state.latestFailedChecks?.[0]?.output ?? '')) return refuse('assertion or compiler diagnostics do not establish an unambiguous missing verification prerequisite');
    if (decision.requires.some(id => !consumer(id))) return refuse('mixed or ambiguous implementation and downstream verification prerequisites');
    if (!task.node!.local_check) return refuse('missing local_check authority; declare a meaningful local behavioral test instead of guessing another verifier');
    if (!this.opts.file || !this.opts.persist) return refuse('a durable run file and persistence adapter are required');
    if (state.repairContext || state.repairBaseline) return refuse('an existing charged repair authority cannot be restaged automatically');
    let sources: Record<string, string>;
    try {
      const integration = this.integration!.path, pkg = join(integration, 'package.json');
      const scripts = existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {} : {};
      const commands = checkScriptCommands([task.node!.verify], scripts);
      const protectedPaths = this.protectedPaths();
      const files = [...new Set([...task.node!.local_check!.files!, ...[...snapshot(integration).keys()].filter(file =>
        file === 'package.json' || protectedPaths.some(path => overlaps(path, file)) || commands.some(command => commandMentionsPath(command, file)))])];
      sources = this.localCheckSources(task, integration, files);
      if (JSON.stringify(sources) !== JSON.stringify(this.localCheckSources(task, worker.path, files))) return refuse('protected verification sources differ from integration; no authority to replace tests or requirements');
    } catch (error) { return refuse((error as Error).message); }
    const local = this.localCheckCommand(task);
    const saved = commitAll(worker.path, `dag: verification staging ${task.id}`, this.settings.cachePaths ?? ['node_modules', '.venv']);
    const commit = saved.commit ?? git(worker.path, ['rev-parse', 'HEAD']).stdout;
    const pin = git(this.repo, ['update-ref', `refs/dag/verification/${this.state.id}/${task.id}`, commit]);
    if (pin.code) throw failure(`Cannot pin source for verification correction: ${pin.stderr}`, 'integration');
    state.verificationCorrection = { definition: definition(task), original: task.node!.verify, local,
      requires: [...new Set([task.id, ...decision.requires, ...(this.settings.checkPrerequisites?.[task.node!.verify] ?? [])])],
      checkSources: sources, work: { commit, base, attempt: task.attempts } };
    // Persist the complete intent before any alternate verification or downstream dispatch.
    this.save();
    this.reopenProducers(state.verificationCorrection.requires);
    this.event('note', task.id, `Verification plan corrected: run declared local behavior; retain ${task.node!.verify} for final acceptance after ${decision.requires.join(', ')}`);
    this.save();
    return true;
  }
  private async resumeCorrectedVerification(task: Task, worker: Worker): Promise<boolean> {
    const saved = task.nodeState!.verificationCorrection!;
    if (this.recovery.orphanPids.length) throw failure('Verification correction recovery held: orphan executors need inspection', 'worktree');
    const restored = git(worker.path, ['reset', '--hard', saved.work.commit]);
    if (restored.code) throw failure(`Cannot restore corrected verification source: ${restored.stderr}`, 'worktree');
    this.assertVerificationCorrection(task, worker.path);
    task.nodeState!.worker = worker.path; task.status = 'running'; task.finishedAt = null; task.failureKind = null; this.save();
    if (!worker.prepared) {
      const prepare = this.opts.prepareCommand?.(task) ?? task.prepareCmd ?? this.state.settings.worktreePrepareCmd;
      if (prepare) await this.phase(task, 'setup', prepare, worker.path, worker);
      worker.prepared = true;
    }
    await this.verifyNode(task, worker, task.cmd ?? '', saved.work.base);
    (task.milestones ??= {}).checkedAt = now();
    commitAll(worker.path, `dag: ${task.id} verified saved implementation`, this.settings.cachePaths ?? ['node_modules', '.venv']);
    const commit = git(worker.path, ['rev-parse', 'HEAD']).stdout, branch = `dag-node/${this.state.id}-${task.id}-${task.attempts}`;
    const pin = git(this.repo, ['branch', '-f', branch, commit]);
    if (pin.code) throw failure(`Cannot pin corrected verified candidate: ${pin.stderr}`, 'integration');
    task.branch = branch; task.commit = commit; task.result = 'Verified saved implementation; original composed obligation retained';
    const candidate: Candidate = { commit, base: saved.work.base, attempt: task.attempts, definition: definition(task) };
    task.nodeState!.candidate = candidate; this.save();
    await this.land(task, candidate);
    return this.complete(task);
  }
  private async verifyNode(task: Task, worker: Worker, workCommand: string, base?: string): Promise<void> {
    const waiting = [...new Set([...(task.node!.verify_requires ?? []), ...(this.settings.checkPrerequisites?.[task.node!.verify] ?? [])])]
      .filter(id => id !== task.id && this.state.tasks[id]?.status !== 'completed');
    if (base && !task.nodeState?.verificationCorrection && !checkpointRepair(task) && !worker.tainted && !this.stopped() &&
      waiting.some(id => transitiveDepSet(this.state, id).has(task.id))) {
      const state = task.nodeState!, output = `Not executed: declared verification prerequisites are unfinished (${waiting.join(', ')})`;
      state.decision = repairDecision(this.state, { command: task.node!.verify, output, phase: 'verify', requires: waiting });
      state.latestFailedChecks = [{ command: task.node!.verify, passed: false, outcome: 'deferred', output, decision: state.decision }];
      (state.diagnosisHistory ??= []).push({ decision: { ...state.decision }, checks: state.latestFailedChecks, at: now() }); this.save();
      if (!this.correctVerification(task, worker, base)) throw failure(state.decision.reason, 'integration');
    }
    for (;;) {
      let failedCommand = this.localVerification(task);
      try {
        this.assertVerificationCorrection(task, worker.path);
        await this.phase(task, 'verify', failedCommand, worker.path, worker);
        this.assertVerificationCorrection(task, worker.path);
        if (!checkpointRepair(task)) for (const command of this.verificationCommands(task)) if (command !== this.localVerification(task)) { failedCommand = command; await this.phase(task, 'verify', command, worker.path, worker); }
        delete task.nodeState!.decision; return;
      }
      catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        const state = task.nodeState!;
        const ledger = (this.state.flowState!.nodeRepairs ??= {})[task.id] ??= { used: state.repairAttempts ?? 0, failures: state.repairFailures ?? [], history: [] };
        state.repairAttempts = ledger.used; state.repairFailures = ledger.failures;
        // Diagnose the actual failure: a declared unfinished consumer cannot mask
        // an assertion, timeout or provider failure as a missing prerequisite.
        const decision = repairDecision(this.state, { command: failedCommand, output, phase: 'verify', kind: (error as { kind?: string }).kind });
        if (state.repairFailures?.includes(decision.fingerprint)) {
          decision.action = 'hold'; decision.category = 'no-progress'; decision.reason = 'The same verifier failure remained after repair';
        }
        const repairLimit = this.settings.nodeRepairRounds ?? 1;
        if (decision.action === 'repair' && (state.repairAttempts ?? 0) >= repairLimit) {
          decision.action = 'hold'; decision.category = 'policy'; decision.reason = `Node repair budget exhausted: ${state.repairAttempts ?? 0}/${repairLimit}`;
        }
        state.decision = decision;
        state.latestFailedChecks = [{ command: failedCommand, passed: false, output, decision, evidenceRef: (error as { evidenceRef?: string }).evidenceRef }];
        (state.diagnosisHistory ??= []).push({ decision: { ...decision }, checks: state.latestFailedChecks, at: now() }); this.save();
        if (!this.stopped() && !worker.tainted && failedCommand === task.node!.verify && base &&
          this.correctVerification(task, worker, base)) continue;
        if (this.stopped() || worker.tainted || checkpointRepair(task) || decision.action !== 'repair') {
          this.event('note', task.id, `Node repair held: ${decision.reason}; used ${state.repairAttempts ?? 0} repair rounds`);
          throw error;
        }
        state.repairAttempts = ++ledger.used;
        ledger.failures.push(decision.fingerprint);
        state.repairContext = this.repairContext(task, decision, state.latestFailedChecks);
        state.repairContext.command = this.settings.repairCommand ?? workCommand;
        ledger.history.push(state.repairContext);
        this.event('task-repair', task.id, `In-place repair ${state.repairAttempts}: ${decision.reason}`); this.save();
        await this.guardedRepair(task, worker, this.settings.repairCommand ?? workCommand);
      }
    }
  }
  private protectedPaths(): string[] {
    return [...new Set([...(this.settings.repairProtectedPaths ?? []), ...(this.settings.acceptanceInputs ?? []),
      ...Object.values(this.state.tasks).flatMap(t => t.node?.local_check?.files ?? []),
      ...(this.state.planning?.manifest.sources.map(s => s.path) ?? []),
      ...(this.state.planning?.manifest.tasks.flatMap(t => (t.files ?? []).filter(f => ['frozen', 'test'].includes(f.role)).map(f => f.path)) ?? [])])];
  }
  private assertRepairAuthority(task: Task): void {
    const context = task.nodeState?.repairContext;
    if (!context || context.authority !== 'flow3-automatic' || JSON.stringify(context.scope) !== JSON.stringify(task.node!.touches)) throw failure('Repair policy violation: missing or changed authority/scope', 'integration');
    const origin = this.state.flowState!.checkpoints.find(c => c.id === context.checkpoint);
    const current = this.identity(this.integration!.path, origin ? this.commands(origin.kind) : [task.node!.verify]);
    if (context.identity && ['requirements', 'checks', 'inputs', 'environment'].some(key => current[key as keyof typeof current] !== context.identity![key as keyof typeof current])) throw failure('Repair policy violation: frozen acceptance authority changed', 'integration');
    const limit = context.charge.pool === 'node' ? this.settings.nodeRepairRounds ?? 1 : this.settings.repairRounds ?? 2;
    if (context.charge.used > Math.min(limit, context.charge.limit)) throw failure('Repair policy violation: durable allowance exhausted', 'budget');
  }
  private async guardedRepair(task: Task, worker: Worker, command: string): Promise<ExecOutcome> {
    this.assertRepairAuthority(task);
    const context = task.nodeState?.repairContext;
    if (context?.command !== command) throw Error('Repair policy violation: changed persisted repair command');
    const before = snapshot(worker.path), head = git(worker.path, ['rev-parse', 'HEAD']).stdout;
    const packageFile = join(worker.path, 'package.json');
    const scripts = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')).scripts ?? {} : {};
    const checks = checkScriptCommands([task.node!.verify, ...this.commands('wave'), ...this.commands('final')], scripts);
    const protectedPaths = [...this.protectedPaths(), ...[...before.keys()].filter(path => /\.(?:[cm]?[jt]sx?|py|sh|ps1|bat|cmd|rb)$/i.test(path) && checks.some(command => commandMentionsPath(command, path)))];
    const spec = repairBrief(task, protectedPaths, this.state.flowState?.nodeRepairs?.[task.id]?.history);
    task.nodeState!.repairBaseline = { head, files: [...before], protectedPaths }; this.save();
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

  private async phase(task: Task, phase: Phase, command: string, cwd: string, worker?: Worker, observed = task, tokens: Partial<ExecContext> = {}): Promise<CheckOutcome> {
    let evidenceRef: string | undefined;
    const priorArtifacts = ['verify', 'checkpoint', 'integration'].includes(phase) ? evidenceArtifacts(command, this.settings, cwd) : undefined;
    const checkedSource = phase === 'verify' ? { head: git(cwd, ['rev-parse', 'HEAD']).stdout, files: hash(JSON.stringify([...snapshot(cwd)])) } : undefined;
    const started = Date.now(); let lastOutput = started, finished = false, settled = false;
    let kill: (() => void) | undefined, rejectPhase: (error: Error) => void = () => {};
    let killed = false;
    const killOnce = () => { if (!killed && kill) { killed = true; try { kill(); } catch { /* already exited */ } } };
    const requestedTimeout = phase === 'work' ? this.opts.timeoutFor?.(observed) ?? observed.timeoutMs ?? this.opts.timeoutMs ?? this.settings.phaseTimeouts?.work ?? this.state.settings.timeoutMs
      : this.settings.phaseTimeouts?.[phase] ?? PHASE_TIMEOUTS[phase];
    const timeout = Math.min(phase === 'work' ? observed.nodeState?.quotaWork?.remainingMs ?? Infinity : Infinity, requestedTimeout || PHASE_TIMEOUTS[phase], this.deadline ? Math.max(1, this.deadline - Date.now()) : Infinity);
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
      ...tokens, cwd, executionProfile: 'lean', readOnly: phase === 'advisory' || phase === 'review', session: phase === 'work' ? worker?.session : undefined,
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
      if (['verify', 'checkpoint', 'integration', 'review'].includes(phase) && this.opts.file) {
        evidenceRef = join(runPaths(this.opts.file).dir, 'flow3', `check-${randomUUID()}.json`);
        atomicWriteJson(evidenceRef, { task: task.id, phase, command, startedAt: new Date(started).toISOString(),
          finishedAt: now(), source: checkedSource?.head ?? git(cwd, ['rev-parse', 'HEAD']).stdout,
          exitCode: outcome.exitCode, output: outcome.output, outputDigest: hash(outcome.output) });
      }
      if (checkedSource && (checkedSource.head !== git(cwd, ['rev-parse', 'HEAD']).stdout || checkedSource.files !== hash(JSON.stringify([...snapshot(cwd)])))) throw failure('Frozen source changed during verification');
      if (outcome.exitCode !== 0 && (phase === 'work' || phase === 'repair') && quotaSignal(outcome.output))
        throw Object.assign(failure('Harness reported quota exhaustion', 'interrupted'), { quotaProvider: this.provider(observed, command), remainingMs: Math.max(0, timeout - (Date.now() - started)) });
      if (outcome.exitCode !== 0) throw failure(`${phase} exit ${outcome.exitCode}: ${tail(outcome.output)}`);
      if (['verify', 'checkpoint', 'integration'].includes(phase)) {
        const packageFile = join(cwd, 'package.json');
        const scripts = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')).scripts ?? {} : {};
        const expanded = checkScriptCommands([command], scripts).join(' ; ');
        const problem = evidenceFailure(command, outcome, this.settings, cwd, started, expanded, priorArtifacts);
        if (problem) throw failure(problem);
        for (const corrected of this.correctedTasks()) if (command === this.localVerification(corrected)) {
          const name = corrected.node!.local_check!.behavior.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const passed = new RegExp(`^\\s*ok\\s+\\d+\\s+(?:-\\s+)?${name}\\s*$`, 'm');
          if (!passed.test(outcome.output)) throw failure(`Missing required evidence: passing named local behavior ${corrected.node!.local_check!.behavior} (skipped/file-only tests do not qualify)`);
        }
      }
      return { ...outcome, evidenceRef, artifacts: ['verify', 'checkpoint', 'integration'].includes(phase) ? evidenceArtifacts(command, this.settings, cwd) : undefined };
    } catch (error) {
      if (evidenceRef) Object.assign(error as object, { evidenceRef });
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
      ...this.correctedTasks().flatMap(t => [t.nodeState!.verificationCorrection!.original, this.localVerification(t)]),
      ...[...this.scope].filter(id => this.state.tasks[id].status === 'completed' && !checkpointRepair(this.state.tasks[id])).map(id => this.state.tasks[id].node!.verify)])];
  }
  private async checkpoint(kind: 'wave' | 'final', nodes: string[]): Promise<Checkpoint> {
    const path = this.integration!.path;
    const checkpoint: Checkpoint = { id: randomUUID(), kind, head: git(path, ['rev-parse', 'HEAD']).stdout, nodes,
      results: [], passed: false, outcome: 'running' };
    if (kind === 'final') this.finalCheckpointId = checkpoint.id;
    const task = this.control(`${kind} checkpoint`);
    try {
      for (const corrected of this.correctedTasks()) this.assertVerificationCorrection(corrected, path);
      if (!this.integrationPrepared && this.state.settings.worktreePrepareCmd) {
        await this.phase(task, 'setup', this.state.settings.worktreePrepareCmd, path);
        this.integrationPrepared = true;
      }
      const commands = this.commands(kind);
      checkpoint.identity = this.identity(path, commands);
      this.state.flowState!.checkpoints.push(checkpoint); this.save();
      if (!commands.length) checkpoint.results.push({ command: `${kind}Checks`, passed: false, output: `No ${kind} checks configured or detected; configure flow3.${kind}Checks` });
      if (kind === 'final' && !this.commands('wave').length) checkpoint.results.push({ command: 'waveChecks', passed: false, output: 'Configure build/typecheck wave commands in flow3.waveChecks' });
      if (kind === 'final' && !(this.settings.finalChecks?.length ?? this.detectFinalChecks().length) && !this.settings.additionalFinalChecks?.length) checkpoint.results.push({ command: 'finalChecks', passed: false, output: 'Configure full integration/tests/spec checks in flow3.finalChecks' });
      for (const command of commands) {
        if (this.stopped()) { checkpoint.results.push({ command, passed: false, output: 'Interrupted before execution', outcome: 'interrupted' }); break; }
        const requires = this.checkPrerequisites(command);
        if (requires.some(id => this.state.tasks[id]?.status !== 'completed')) {
          const decision = repairDecision(this.state, { command, output: '', phase: kind === 'wave' ? 'checkpoint' : 'integration', requires });
          checkpoint.results.push({ command, passed: false, output: decision.reason, decision, outcome: 'deferred', identity: checkpoint.identity.digest });
          this.event('note', null, `Checkpoint check ${decision.action}: ${decision.reason}`);
          continue;
        }
        try {
          const result = await this.phase(task, kind === 'wave' ? 'checkpoint' : 'integration', command, path);
          if (this.identity(path, commands).digest !== checkpoint.identity.digest || this.sourceDirty(path)) throw Error('Frozen acceptance inputs or source changed during checks');
          checkpoint.results.push({ command, passed: true, output: tail(result.output), outcome: 'passed', identity: checkpoint.identity.digest, evidenceRef: result.evidenceRef, exitCode: result.exitCode, outputDigest: hash(result.output), artifacts: result.artifacts });
        } catch (error) {
          const output = tail((error as Error).message);
          const decision = repairDecision(this.state, { command, output, phase: kind === 'wave' ? 'checkpoint' : 'integration', kind: (error as { kind?: string }).kind, requires });
          checkpoint.results.push({ command, passed: false, output, decision, outcome: /Stopped|killed|interrupt|cancel/i.test(output) ? 'interrupted' : /inconclusive|evidence|0 tests|no tests/i.test(output) ? 'inconclusive' : 'failed', identity: checkpoint.identity.digest, evidenceRef: (error as { evidenceRef?: string }).evidenceRef });
          this.event('note', null, `Checkpoint repair ${decision.action}: ${decision.reason}`);
          this.save();
          if (/Frozen acceptance inputs or source changed/.test(output)) break;
        }
      }
      // A checkpoint may generate ignored output, but may not silently alter accepted source.
      const dirty = git(path, ['status', '--porcelain', '--', '.', ...(this.settings.cachePaths ?? ['node_modules', '.venv']).map(cache => `:(exclude)${cache}`)]).stdout;
      if (dirty || git(path, ['rev-parse', 'HEAD']).stdout !== checkpoint.head || checkpoint.identity && this.identity(path, commands).digest !== checkpoint.identity.digest) {
        if (this.opts.file) atomicWriteJson(join(runPaths(this.opts.file).dir, 'flow3', `checkpoint-${checkpoint.id}.json`), {
          head: checkpoint.head, identity: checkpoint.identity, observedIdentity: this.identity(path, commands), status: dirty, patch: git(path, ['diff', '--binary', 'HEAD']).stdout,
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
    if (checkpoint.results.some(r => /(?:inputs or source changed|modified tracked)/i.test(r.output))) for (const result of checkpoint.results) {
      if (result.passed) { result.passed = false; result.outcome = 'invalidated'; result.output += '\nAcceptance identity mutated'; }
    }
    for (const result of checkpoint.results) if (result.passed && result.artifacts && JSON.stringify(result.artifacts) !== JSON.stringify(evidenceArtifacts(result.command, this.settings, path))) {
      result.passed = false; result.outcome = 'invalidated'; result.output += '\nRequired evidence changed or disappeared after its check';
      result.decision = repairDecision(this.state, { command: result.command, output: 'missing required evidence: ' + result.output, phase: kind === 'wave' ? 'checkpoint' : 'integration' });
    }
    checkpoint.passed = checkpoint.results.length > 0 && checkpoint.results.every(r => r.passed) && !this.stopped();
    checkpoint.outcome = this.stopped() ? 'interrupted' : checkpoint.passed ? 'passed' : 'failed';
    if (kind === 'final' && checkpoint.passed) for (const id of this.scope) {
      const node = this.state.tasks[id];
      if (node.status === 'completed') recordPlanningAcceptance(this.state, node, hash(JSON.stringify(checkpoint)));
    }
    if (!this.state.flowState!.checkpoints.some(c => c.id === checkpoint.id)) this.state.flowState!.checkpoints.push(checkpoint);
    this.event('note', null, `${kind} checkpoint ${checkpoint.passed ? 'pass' : 'fail'} at ${checkpoint.head}`); this.save();
    return checkpoint;
  }
  private canRepair(): boolean { return this.state.flowState!.repairRound < (this.settings.repairRounds ?? 2); }
  private repairable(check: Checkpoint): boolean {
    const failed = check.results.filter(r => !r.passed);
    if (!failed.length || failed.some(r => r.decision?.action !== 'repair')) return false;
    // Separate observations are retained. Without shared-cause evidence only one finding is repaired at a time.

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
  private required(): string[] { return this.state.flowState?.completion?.required ?? [...this.scope]; }
  /** Promote existing producers and their closure, without granting retry authority. */
  private reopenProducers(ids: string[]): boolean {
    const visited = new Set<string>(); let changed = false;
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const task = this.state.tasks[id];
      if (!task) throw Error(`Cannot reopen unknown producer ${id}; task discovery requires graph correction`);
      if (!this.scope.has(id)) { this.scope.add(id); changed = true; }
      if (!this.required().includes(id)) { this.required().push(id); changed = true; }
      for (const dep of [...task.deps, ...(task.node?.verify_requires ?? [])]) visit(dep);
    };
    for (const id of [...ids]) visit(id);
    if (changed) {
      this.schedulingChanged = true;
      const flow = this.state.flowState!;
      flow.completion!.optional = flow.completion!.optional.filter(id => !this.required().includes(id));
      flow.completion!.excluded = flow.completion!.excluded.filter(id => !this.required().includes(id));
      flow.implementationComplete = false;
      this.event('note', null, `Reopened producer scope: ${[...visited].join(', ')}`); this.save();
    }
    return changed;
  }
  /** Retain unverified edits while the same scheduler supplies a proven missing producer. */
  private deferNode(task: Task, attemptLimit: number, base: string, worker: Worker): boolean {
    const state = task.nodeState!, decision = state.decision!, producers = decision.requires ?? [];
    if (!producers.length || task.attemptsInCycle >= attemptLimit || state.repairBaseline || !base || this.sourceDirty(worker.path)) return false;
    const previous = task.deps;
    task.deps = [...new Set([...previous, ...producers])];
    const graph = checkGraph(this.state, false);
    if (!graph.valid) {
      task.deps = previous;
      decision.action = 'hold'; decision.reason = `Producer correction rejected: ${graph.errors.join('; ')}`; this.save(); return false;
    }
    // Squash only for replay: the original failed branch/history is retained.
    const tree = git(worker.path, ['rev-parse', 'HEAD^{tree}']).stdout;
    const saved = git(worker.path, ['-c', 'user.name=DAG Orchestrator', '-c', 'user.email=dag@localhost', 'commit-tree', tree, '-p', base, '-m', `dag: prerequisite recovery ${task.id}`]);
    if (saved.code || git(this.repo, ['update-ref', `refs/dag/prerequisites/${this.state.id}/${task.id}`, saved.stdout]).code) {
      task.deps = previous; throw failure('Cannot pin prerequisite recovery source; failed branch preserved', 'integration');
    }
    state.dependencyWork = { commit: saved.stdout, definition: definition(task), attempt: task.attempts };
    task.status = 'pending'; task.result = decision.reason; task.pid = null;
    this.schedulingChanged = true;
    this.reopenProducers(producers);
    this.event('note', task.id, `Deferred unverified implementation: ${decision.reason}`); this.save();
    return true;
  }
  private sourceDirty(path: string): string { return git(path, ['status', '--porcelain', '--', '.', ...(this.settings.cachePaths ?? ['node_modules', '.venv']).map(cache => `:(exclude)${cache}`)]).stdout; }
  private identity(path: string, commands: string[]) {
    return acceptanceIdentity(this.state, this.state.settings.flow3 ?? this.settings, path, git(path, ['rev-parse', 'HEAD']).stdout, commands);
  }
  private repairContext(task: Task, diagnosis: NonNullable<Task['nodeState']>['decision'] & {}, failedChecks: Checkpoint['results'], check?: Checkpoint): RepairContext {
    const scope = task.node!.touches;
    const owners = Object.values(this.state.tasks).filter(t => t.status === 'completed' && !checkpointRepair(t) && t.node?.touches.some(p => scope.some(s => overlaps(s, p))));
    const accepted = Object.values(this.state.tasks).filter(t => t.status === 'completed' && !checkpointRepair(t));
    for (let index = 0; index < owners.length; index++) for (const consumer of accepted) {
      if (!owners.includes(consumer) && (consumer.deps.includes(owners[index].id) || consumer.node?.relies_on.some(p => scope.some(s => overlaps(s, p))))) owners.push(consumer);
    }
    return { authority: 'flow3-automatic', command: check ? this.repairCommand() : undefined, checkpoint: check?.id, identity: check?.identity ?? this.identity(this.integration!.path, [task.node!.verify]),
      diagnosis, failedChecks, owners: owners.map(t => t.id), prerequisites: task.deps, scope,
      protectedPaths: this.protectedPaths(), verification: [...new Set([task.node!.verify, ...owners.map(t => this.localVerification(t))])],
      charge: { pool: check ? 'checkpoint' : 'node', used: check ? this.state.flowState!.repairRound : task.nodeState?.repairAttempts ?? 0,
        limit: check ? this.settings.repairRounds ?? 2 : this.settings.nodeRepairRounds ?? 1 },
      escalation: 'Hold on exhausted budget, repeated failure, no source change, missing prerequisite, changed authority or protected input; no new recovery allowance.' };
  }
  private addFix(check: Checkpoint): Task {
    const existing = this.state.flowState!.repairIntents?.find(i => i.context.checkpoint === check.id);
    if (existing) { this.materializeRepair(existing); return this.state.tasks[existing.id]; }
    const failed = check.results.filter(r => !r.passed).slice(0, 1);
    const focused = { ...check, results: failed };
    const prototype = { node: { touches: this.fixTouches(focused), verify: 'git diff --check' }, deps: [...this.scope].filter(id => this.state.tasks[id].status === 'completed') } as Task;
    this.state.flowState!.repairRound++;
    const context = this.repairContext(prototype, failed[0].decision!, failed, check);
    const intent: RepairIntent = { id: `repair-${check.id}`, status: 'pending', context };
    (this.state.flowState!.repairIntents ??= []).push(intent);
    (this.state.flowState!.repairFailures ??= []).push(...failed.map(r => r.decision!.fingerprint));
    this.save(); // finding + authority + charge + stable task ID are durable BEFORE graph mutation
    this.materializeRepair(intent);
    return this.state.tasks[intent.id];
  }
  private materializeRepair(intent: RepairIntent): void {
    const c = intent.context;
    const goal = `Fix only diagnosed checkpoint defects. Current diagnosis and exact failed checks:\n${JSON.stringify(c)}\nRetain negative analytical outcomes; do not alter requirements or acceptance sources.`;
    const previous = this.state.tasks[intent.id];
    if (!previous && intent.status === 'scheduled') throw Error(`Repair ${intent.id} was removed; explicit adjudication required`);
    if (previous && (!previous.node || previous.node.repair_of !== c.checkpoint || previous.cmd !== c.command || previous.node.goal !== goal || JSON.stringify(previous.node.touches) !== JSON.stringify(c.scope) || previous.node.verify !== 'git diff --check' || previous.spec !== goal || JSON.stringify(previous.deps) !== JSON.stringify(c.prerequisites))) throw Error(`Repair ${intent.id} definition changed; persisted authority cannot be transferred`);
    const task = previous ?? addTask(this.state, { id: intent.id, title: `Repair checkpoint ${c.checkpoint}`, spec: goal,
      cmd: c.command, deps: c.prerequisites,
      node: { goal, touches: c.scope, creates: [], relies_on: [], verify: 'git diff --check', repair_of: c.checkpoint }, maxAttempts: 1 });
    task.nodeState = { ...task.nodeState, repairCheckpoint: c.checkpoint, repairContext: c };
    this.scope.add(task.id); intent.status = 'scheduled'; this.save();
  }
  private resumeRepairIntents(): void {
    for (const intent of this.state.flowState!.repairIntents ?? []) this.materializeRepair(intent);
  }
  private async finalReview(check: Checkpoint): Promise<void> {
    const flow = this.state.flowState!;
    if (this.state.settings.finalReview === 'off') { flow.review = { identity: check.identity!.digest, status: 'off' }; return; }
    const harness = planAttempt(this.state.settings.harnessChain, 1)?.harness;
    const command = this.state.settings.finalReviewCmd ?? harness?.reviewCmd ?? ['opencode', 'claude', 'codex', 'cursor-agent', 'gemini'].map(name => findHarness(name)?.reviewCmd).find(Boolean);
    flow.review = { identity: check.identity!.digest, status: 'pending' }; this.save();
    let reviewing: string | undefined;
    const changed = () => !!this.sourceDirty(this.integration!.path) ||
      this.identity(this.integration!.path, check.results.map(result => result.command)).digest !== check.identity!.digest ||
      check.results.some(result => result.artifacts && JSON.stringify(result.artifacts) !== JSON.stringify(evidenceArtifacts(result.command, this.settings, this.integration!.path)));

    try {
      if (!command) throw Error('Configured final review has no review command');
      const tasks = [...this.scope].map(id => this.state.tasks[id]).filter(t => t.status === 'completed' && !t.covers);
      let output = '';
      const reviews = this.state.settings.finalReview === 'per-task' ? tasks : [this.control('final run review')];
      if (!reviews.length) throw Error('No eligible tasks supplied required review evidence');
      const results: NonNullable<NonNullable<typeof flow.review>['results']> = [];
      flow.review.results = results;
      for (const owner of reviews) {
        reviewing = owner.id;
        const spec = `Review accepted identity ${JSON.stringify(check.identity)} against requirements ${JSON.stringify(this.state.planning?.manifest ?? this.state.objective)}. ${JSON.stringify(tasks.map(t => ({ id: t.id, goal: t.node?.goal })))}\nReview scope: ${owner.id}. Inspect integrated source and report concrete evidence. Do not modify files. A negative analytical outcome is not inherently a defect. End with VERDICT: PASS or VERDICT: FAIL: reason.`;
        const base = this.state.settings.finalReview === 'per-task' ? owner.diffBase : flow.integrationBase;
        const diff = git(this.integration!.path, ['diff', base ?? check.head, check.head]).stdout;
        const directory = this.opts.file ? join(runPaths(this.opts.file).dir, 'reviews') : join(tmpdir(), `dag-flow3-review-${this.state.id}`);
        mkdirSync(directory, { recursive: true });
        const diffFile = join(directory, `flow3-${check.id}-${owner.id}.diff`); writeFileSync(diffFile, diff);
        const result = await this.phase({ ...owner, spec }, 'review', command, this.integration!.path, undefined, owner,
          { diffFile, diffBase: base ?? check.head, diffHead: check.head, diffStat: git(this.integration!.path, ['diff', '--stat', base ?? check.head, check.head]).stdout,
            files: git(this.integration!.path, ['diff', '--name-only', base ?? check.head, check.head]).stdout });
        output += result.output + '\n'; flow.review.output = output; this.save();

        if (changed()) throw Error('Frozen acceptance inputs or source changed during review');
        const verdict = parseVerdict(stripAnsi(result.output));
        results.push({ task: owner.id, verdict: verdict.kind === 'pass' ? 'pass' : 'fail', output: result.output, evidenceRef: result.evidenceRef });
        flow.review.results = results; this.save();
        if (verdict.kind !== 'pass') {
          flow.review = { identity: check.identity!.digest, status: 'fail', output, results };
          // Reviewer prose supplies evidence, not automatic modification authority.
          return;
        }
      }
      flow.review = { identity: check.identity!.digest, status: 'pass', output, results };
    } catch (error) {
      if (reviewing && !flow.review?.results?.some(result => result.task === reviewing)) {
        (flow.review!.results ??= []).push({ task: reviewing, verdict: 'error', output: String(error), evidenceRef: (error as { evidenceRef?: string }).evidenceRef });
      }
      if (changed()) {
        check.passed = false; check.outcome = 'failed';
        const path = this.integration!.path;
        if (this.opts.file) atomicWriteJson(join(runPaths(this.opts.file).dir, 'flow3', `review-mutation-${check.id}.json`), {
          identity: check.identity, observedIdentity: this.identity(path, check.results.map(result => result.command)),
          status: this.sourceDirty(path), patch: git(path, ['diff', '--binary', check.head]).stdout,
        });
        if (!this.integrationTainted) {
          git(path, ['reset', '--hard', check.head]);
          git(path, ['clean', '-fd', ...((this.settings.cachePaths ?? ['node_modules', '.venv']).flatMap(cache => ['-e', cache]))]);
        }
        for (const result of check.results) { result.passed = false; result.outcome = 'invalidated'; result.output += '\nSource or acceptance inputs changed during review'; }
      }
      flow.review = { identity: check.identity!.digest, status: 'error', output: [flow.review?.output, String(error)].filter(Boolean).join('\n'), results: flow.review?.results };
    }
    finally { (flow.reviewHistory ??= []).push({ ...flow.review! }); this.save(); }
  }
  private startAdvisory(): void {
    if (this.stopped()) return;
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
