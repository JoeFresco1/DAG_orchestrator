// A disposable, local Flow 3 campaign that kills real CLI processes at each
// durable boundary, recovers them through supported commands, and records the
// observed result. It deliberately does not execute commands from a caller's
// run file.
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countFlag, emit, flag } from '../cli-args.js';
import { git } from '../git-worktree.js';
import { compileFlowPlan } from '../flow3/graph.js';
import {
  CRASH_BOUNDARIES,
  completeCrashCampaignReport,
  createCrashCampaignReport,
  interruptCrashCampaignReport,
  isCrashCampaignSuccessful,
  loadCrashCampaignReport,
  recordCrashCampaignIteration,
  resumeCrashCampaignReport,
  saveCrashCampaignReport,
  type CrashBoundary,
  type CrashCampaignAttribution,
  type CrashCampaignEvidence,
  type CrashCampaignIteration,
  type CrashCampaignRecoveryAction,
  type CrashCampaignReport,
} from '../flow3/crash-certification-report.js';
import { acquirePathLock, attemptLogPath, loadRun, runPaths, saveRun } from '../store.js';
import type { Run, Task } from '../types.js';

const thisFile = fileURLToPath(import.meta.url);
const isSource = thisFile.endsWith('.ts');
const projectDir = resolve(dirname(thisFile), '../..');
const cliFile = resolve(dirname(thisFile), isSource ? '../cli.ts' : '../cli.js');
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const time = (): string => new Date().toISOString();
const pause = (ms: number): Promise<void> => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

interface Scenario {
  root: string;
  file: string;
  runId: string;
  staleRelease: string;
}

class CampaignInterrupted extends Error {
  constructor() { super('Campaign interrupted'); }
}

function cliArgs(command: string, args: string[]): string[] {
  return [...(isSource ? ['--import', 'tsx'] : []), cliFile, command, ...args, '--json'];
}

function invokeCli(command: string, args: string[], timeout = 120_000, env: NodeJS.ProcessEnv = process.env): CliResult {
  const result = spawnSync(process.execPath, cliArgs(command, args), {
    cwd: projectDir,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function jsonResult(result: CliResult): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function recoveryAction(command: string, args: string[], startedAt: string, result: CliResult): CrashCampaignRecoveryAction {
  return {
    command: `dag ${command}`,
    args,
    startedAt,
    finishedAt: time(),
    exitCode: result.exitCode,
    disposition: result.exitCode === 0 ? 'command-completed' : 'command-failed',
    detail: [result.error, result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n').slice(-1800) || 'No output',
  };
}

function createRun(runId?: string): Run {
  const { run } = compileFlowPlan({
    version: 3,
    title: 'Local crash recovery certification fixture',
    nodes: [
      {
        id: 'alpha', goal: 'Create the accepted baseline artifact', depends_on: [],
        touches: ['alpha.txt'], creates: ['alpha.txt'], relies_on: [],
        cmd: 'node fixture-worker.mjs alpha', verify: 'node --check fixture-worker.mjs',
      },
      {
        id: 'salvage', goal: 'Create a failed artifact that must remain salvageable', depends_on: [],
        touches: ['salvage.txt'], creates: ['salvage.txt'], relies_on: [],
        cmd: 'node fixture-worker.mjs salvage', verify: 'node --check fixture-worker.mjs',
      },
      {
        id: 'bravo', goal: 'Create the task used for boundary injection', depends_on: ['alpha'],
        touches: ['bravo.txt'], creates: ['bravo.txt'], relies_on: ['alpha.txt'],
        cmd: 'node fixture-worker.mjs bravo', verify: 'node --check fixture-worker.mjs',
      },
      {
        id: 'charlie', goal: 'Complete the representative dependent task', depends_on: ['bravo'],
        touches: ['charlie.txt'], creates: ['charlie.txt'], relies_on: ['bravo.txt'],
        cmd: 'node fixture-worker.mjs charlie', verify: 'node --check fixture-worker.mjs',
      },
    ],
    settings: {
      waveChecks: ['node --check fixture-worker.mjs'],
      finalChecks: ['node --check fixture-worker.mjs'],
      repairRounds: 0,
    },
  });
  if (runId) run.id = runId;
  run.settings.finalReview = 'off';
  run.settings.concurrency = 1;
  run.settings.maxAttempts = 1;
  run.flowState ??= { version: 3, repairRound: 0, checkpoints: [], issues: [] };
  run.flowState.reservedCents = 125;
  return run;
}

function makeScenario(path: string, runId: string): Scenario {
  const root = resolve(path);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.gitignore'), '/dag.run.json\n/dag.run.json.lock\n/dag.run.json.d/\n');
  writeFileSync(join(root, 'fixture-worker.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "import { fileURLToPath } from 'node:url';",
    "const id = process.argv[2];",
    "const target = id + '.txt';",
    "writeFileSync(target, 'fixture artifact for ' + id + '\\n');",
    "console.log('fixture command completed for ' + id);",
    "if (id === 'bravo' && process.env.DAG_CRASH_CERTIFY_STALE_FILE) {",
    "  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixture-late-worker.mjs', import.meta.url)), process.cwd(), process.env.DAG_CRASH_CERTIFY_STALE_FILE], { detached: true, stdio: 'ignore', windowsHide: true });",
    "  child.unref();",
    "}",
    "if (id === 'salvage') process.exitCode = 23;",
  ].join('\n'));
  writeFileSync(join(root, 'fixture-late-worker.mjs'), [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const [worktree, release] = process.argv.slice(2);",
    "while (!existsSync(release)) await new Promise(resolveDelay => setTimeout(resolveDelay, 25));",
    "writeFileSync(join(worktree, 'late-worker.txt'), 'stale worker wrote after recovery\\n');",
    "writeFileSync(release + '.done', 'late write observed\\n');",
  ].join('\n'));
  const initialized = git(root, ['init', '-q']);
  if (initialized.code) throw Error(`git init failed: ${initialized.stderr}`);
  git(root, ['config', 'user.name', 'Crash Certifier']);
  git(root, ['config', 'user.email', 'crash-certifier@localhost']);
  const staged = git(root, ['add', '.gitignore', 'fixture-worker.mjs', 'fixture-late-worker.mjs']);
  if (staged.code) throw Error(`git add failed: ${staged.stderr}`);
  const committed = git(root, ['-c', 'user.name=Crash Certifier', '-c', 'user.email=crash-certifier@localhost', 'commit', '-q', '-m', 'crash certification fixture']);
  if (committed.code) throw Error(`fixture commit failed: ${committed.stderr}`);
  const file = join(root, 'dag.run.json');
  saveRun(createRun(runId), file);
  return { root, file, runId, staleRelease: join(root, 'late-worker.release') };
}

function acceptedRecord(task: Task): unknown {
  return {
    id: task.id,
    status: task.status,
    attempts: task.attempts,
    attemptsInCycle: task.attemptsInCycle,
    result: task.result,
    branch: task.branch,
    commit: task.commit,
    diffBase: task.diffBase,
    diffHead: task.diffHead,
    candidate: task.nodeState?.candidate,
    dispatchHistory: task.dispatchHistory,
    phaseHistory: task.phaseHistory,
    milestones: task.milestones,
  };
}

function definitionDigest(task: Task): string {
  return digest(JSON.stringify({ node: task.node, spec: task.spec, cmd: task.cmd, deps: task.deps, chain: task.harnessChain }));
}

function recordEvidence(kind: string, ref: string, detail?: string): CrashCampaignEvidence {
  return {
    kind,
    ref,
    ...(existsSync(ref) && !ref.startsWith('refs/') ? { sha256: digest(readFileSync(ref)) } : {}),
    ...(detail ? { detail } : {}),
  };
}

async function waitForMarker(path: string, child: ChildProcess, signal: AbortSignal, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new CampaignInterrupted();
    if (existsSync(path)) return readFileSync(path, 'utf8');
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`Injected runner exited before reaching its boundary (exit ${child.exitCode}, signal ${child.signalCode})`);
    await pause(20);
  }
  throw Error(`Timed out waiting for the ${path} crash barrier`);
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit, rejectExit) => {
      child.once('exit', () => resolveExit());
      child.once('error', rejectExit);
    }),
    pause(timeoutMs).then(() => { throw Error('Timed out waiting for the injected process to terminate'); }),
  ]);
}

async function waitForFile(path: string, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new CampaignInterrupted();
    if (existsSync(path)) return true;
    await pause(25);
  }
  return false;
}

function addIssue(issues: string[], condition: boolean, message: string): void {
  if (!condition && !issues.includes(message)) issues.push(message);
}

function checkAcceptedGitState(repo: string, run: Run, task: Task, issues: string[], evidence: CrashCampaignEvidence[]): void {
  const candidate = task.nodeState?.candidate;
  const integrationBranch = `dag/${run.id}`;
  const taskBranch = task.branch ? `refs/heads/${task.branch}` : '';
  addIssue(issues, task.status === 'completed', `${task.id} was not completed after recovery`);
  addIssue(issues, !!task.commit && !!task.diffHead && !!candidate, `${task.id} is missing source, integration, or candidate attribution`);
  if (!candidate || !task.commit || !task.diffHead) return;
  addIssue(issues, candidate.commit === task.commit, `${task.id} candidate commit does not match its accepted source commit`);
  addIssue(issues, candidate.attempt === task.attempts, `${task.id} candidate attempt does not match the accepted attempt`);
  addIssue(issues, candidate.definition === definitionDigest(task), `${task.id} candidate definition digest does not match its node definition`);
  addIssue(issues, !!taskBranch && git(repo, ['show-ref', '--verify', taskBranch]).code === 0, `${task.id} candidate branch is missing`);
  addIssue(issues, git(repo, ['merge-base', '--is-ancestor', task.diffHead, integrationBranch]).code === 0,
    `${task.id} integrated commit is not an ancestor of ${integrationBranch}`);
  const branchCommit = taskBranch ? git(repo, ['rev-parse', taskBranch]).stdout : '';
  addIssue(issues, branchCommit === candidate.commit, `${task.id} candidate ref does not resolve to its recorded source commit`);

  const candidateRecord = candidate as unknown as Record<string, unknown>;
  const nodeState = task.nodeState as unknown as Record<string, unknown> | undefined;
  const acceptance = (candidateRecord.acceptance ?? nodeState?.acceptance) as Record<string, unknown> | undefined;
  const evidenceRef = (candidateRecord.evidenceRef ?? nodeState?.evidenceRef ?? acceptance?.evidenceRef) as string | undefined;
  if (evidenceRef && existsSync(evidenceRef)) {
    evidence.push(recordEvidence('accepted-verification-evidence', evidenceRef, `${task.id} has an accepted evidence reference`));
    let parsed: Record<string, unknown> | undefined;
    try { parsed = JSON.parse(readFileSync(evidenceRef, 'utf8')) as Record<string, unknown>; } catch { /* reported below */ }
    addIssue(issues, parsed?.task === task.id && parsed.phase === 'verify', `${task.id} accepted evidence does not identify its verification`);
  } else {
    evidence.push({ kind: 'accepted-verification-evidence', ref: task.id, detail: 'No durable evidence reference is attached to the accepted task or candidate' });
    issues.push(`${task.id} accepted record has no durable verification evidence reference`);
  }

  const candidatePrefix = `refs/heads/dag-node/${run.id}-${task.id}-`;
  const refs = git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', candidatePrefix]).stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const line of refs) {
    const [ref, commit] = line.split(' ');
    if (commit !== candidate.commit) {
      evidence.push({ kind: 'unmatched-candidate-ref', ref, detail: `Ref resolves to ${commit}; accepted candidate is ${candidate.commit}` });
      issues.push(`${task.id} has an unmatched candidate ref ${ref}`);
    }
  }
}

async function exerciseBoundary(
  boundary: CrashBoundary,
  fixtureRoot: string,
  runId: string,
  signal: AbortSignal,
): Promise<CrashCampaignIteration | undefined> {
  const startedAt = time();
  const scenarioPath = join(fixtureRoot, boundary, randomUUID());
  const actions: CrashCampaignRecoveryAction[] = [];
  const evidence: CrashCampaignEvidence[] = [];
  const issues: string[] = [];
  let scenario: Scenario | undefined;
  let child: ChildProcess | undefined;
  let markerEvent: (Record<string, unknown> & { boundary?: string }) | undefined;
  let killed = false;
  let beforeAccepted: Record<string, string> = {};
  let beforeBudget: { reservedCents?: number; repairRound: number } | undefined;
  let beforeBetaAttempts = 0;
  let beforeBetaPhaseHistory: NonNullable<Task['phaseHistory']> = [];
  let beforeBetaDispatchHistory: NonNullable<Task['dispatchHistory']> = [];
  let oldWorkerPath: string | undefined;
  let preKillDispatchId: string | undefined;
  let targetOutput: CliResult | undefined;
  let recoveredRun: Run | undefined;

  const doRecovery = (command: string, args: string[]): CliResult => {
    const actionStarted = time();
    const result = invokeCli(command, args);
    actions.push(recoveryAction(command, args, actionStarted, result));
    return result;
  };

  try {
    if (signal.aborted) throw new CampaignInterrupted();
    scenario = makeScenario(scenarioPath, runId);
    const fileArgs = ['--file', scenario.file];
    const baseline = invokeCli('run', [...fileArgs, '--only', 'alpha,salvage', '--concurrency', '1', '--retries', '0']);
    const seeded = loadRun(scenario.file);
    const alpha = seeded.tasks.alpha;
    const salvage = seeded.tasks.salvage;
    addIssue(issues, alpha.status === 'completed', 'Fixture did not produce its accepted alpha baseline through dag run');
    addIssue(issues, salvage.status === 'failed' && !!salvage.result, 'Fixture did not produce its failed salvage task through dag run');
    addIssue(issues, !!salvage.branch && salvage.branch.startsWith(`dag-failed/${runId}-salvage-`), 'Fixture failed task has no salvage branch');
    if (salvage.branch) addIssue(issues, git(scenario.root, ['show-ref', '--verify', `refs/heads/${salvage.branch}`]).code === 0, 'Fixture salvage branch is not reachable');
    evidence.push({ kind: 'fixture-seed-run', ref: scenario.file, detail: `dag run exit ${baseline.exitCode}; alpha=${alpha.status}; salvage=${salvage.status}` });
    beforeAccepted = { alpha: JSON.stringify(acceptedRecord(alpha)) };
    beforeBudget = { reservedCents: seeded.flowState?.reservedCents, repairRound: seeded.flowState?.repairRound ?? 0 };
    const salvageRecord = JSON.stringify({
      status: salvage.status, result: salvage.result, branch: salvage.branch, commit: salvage.commit,
      attempts: salvage.attempts, attemptsInCycle: salvage.attemptsInCycle, failureKind: salvage.failureKind, exitCode: salvage.exitCode,
    });
    const salvageResult = salvage.result;
    const salvageBranch = salvage.branch;
    const salvageCommit = salvage.commit;
    const salvageLog = attemptLogPath(scenario.file, 'salvage', salvage.attempts);
    addIssue(issues, existsSync(salvageLog), 'Failed salvage attempt log is missing before injection');
    const salvageLogDigest = existsSync(salvageLog) ? digest(readFileSync(salvageLog)) : undefined;

    const marker = join(scenario.root, `boundary-${boundary}.ready.json`);
    const release = `${marker}.release`;
    const injectionEnv = {
      ...process.env,
      DAG_FLOW3_TEST_CRASH_BOUNDARY: boundary,
      DAG_FLOW3_TEST_CRASH_READY_FILE: marker,
      DAG_FLOW3_TEST_CRASH_RELEASE_FILE: release,
      ...(boundary === 'result-capture' ? { DAG_CRASH_CERTIFY_STALE_FILE: scenario.staleRelease } : {}),
    };
    child = spawn(process.execPath, cliArgs('run', [
      '--file', scenario.file, '--only', 'bravo,charlie', '--concurrency', '1', '--retries', '2',
    ]), { cwd: projectDir, env: injectionEnv, stdio: 'ignore', windowsHide: true });
    const markerText = await waitForMarker(marker, child, signal, 30_000);
    const parsedMarker = JSON.parse(markerText) as Record<string, unknown> & { boundary?: string };
    markerEvent = parsedMarker;
    addIssue(issues, parsedMarker.boundary === boundary, `Probe published ${String(parsedMarker.boundary)} while ${boundary} was selected`);
    addIssue(issues, parsedMarker.runId === runId, 'Boundary marker run id does not match its campaign');
    if (boundary === 'finalization') {
      addIssue(issues, parsedMarker.taskId === undefined && parsedMarker.attempt === 0, 'Finalization marker unexpectedly identifies a task attempt');
    } else {
      addIssue(issues, parsedMarker.taskId === 'bravo' && typeof parsedMarker.attemptId === 'string', `${boundary} marker lacks its target attempt identity`);
    }
    evidence.push(recordEvidence('boundary-marker', marker, `${boundary}: ${markerText.trim()}`));

    const beforeKill = loadRun(scenario.file);
    const beta = beforeKill.tasks.bravo;
    beforeBetaAttempts = beta.attempts;
    beforeBetaPhaseHistory = structuredClone(beta.phaseHistory ?? []);
    beforeBetaDispatchHistory = structuredClone(beta.dispatchHistory ?? []);
    oldWorkerPath = beta.nodeState?.worker;
    preKillDispatchId = typeof parsedMarker.attemptId === 'string' ? parsedMarker.attemptId : undefined;
    if (boundary === 'worker-launch') addIssue(issues, beta.dispatchHistory?.at(-1)?.disposition === 'not-dispatched', 'Worker-launch kill did not occur before dispatch');
    if (boundary === 'result-capture') addIssue(issues, beta.dispatchHistory?.at(-1)?.disposition === 'ambiguous', 'Result-capture kill was not observed as ambiguous');
    if (boundary === 'verdict-persistence') {
      addIssue(issues, typeof parsedMarker.durableRef === 'string' && existsSync(parsedMarker.durableRef), 'Verifier evidence was not durable at its boundary');
      if (typeof parsedMarker.durableRef === 'string' && existsSync(parsedMarker.durableRef)) {
        try {
          const check = JSON.parse(readFileSync(parsedMarker.durableRef, 'utf8')) as { task?: string; phase?: string; exitCode?: number };
          addIssue(issues, check.task === 'bravo' && check.phase === 'verify' && check.exitCode === 0, 'Verdict evidence does not describe a passing bravo verification');
          evidence.push(recordEvidence('verdict-evidence', parsedMarker.durableRef, 'Durable verifier result at the injected boundary'));
        } catch { issues.push('Verdict evidence could not be read'); }
      }
    }
    if (boundary === 'commit') {
      addIssue(issues, typeof parsedMarker.durableRef === 'string' && parsedMarker.durableRef.startsWith('refs/heads/dag-node/'), 'Commit boundary did not expose a candidate ref');
      if (typeof parsedMarker.durableRef === 'string') addIssue(issues, git(scenario.root, ['show-ref', '--verify', parsedMarker.durableRef]).code === 0, 'Candidate ref was not created before the kill');
      addIssue(issues, beta.nodeState?.candidate === undefined, 'Commit boundary happened after candidate state was persisted');
    }
    if (boundary === 'merge') {
      addIssue(issues, beta.status === 'running' && beta.diffHead === parsedMarker.durableRef, 'Merge boundary did not precede task completion with the integration head saved');
    }
    if (boundary === 'finalization') {
      addIssue(issues, beforeKill.tasks.bravo.status === 'completed' && beforeKill.flowState?.acceptanceStatus === 'passed', 'Finalization boundary did not follow accepted task and checkpoint persistence');
    }
    const firstDispatch = beta.dispatchHistory?.find(item => item.attemptId === preKillDispatchId);
    addIssue(issues, boundary === 'finalization' || !!firstDispatch, 'Injected attempt is absent from the durable dispatch history');
    if (firstDispatch) evidence.push({ kind: 'attempt-history-before-kill', ref: scenario.file, detail: JSON.stringify(firstDispatch) });
    const betaLog = attemptLogPath(scenario.file, 'bravo', beta.attempts);
    if (existsSync(betaLog)) evidence.push(recordEvidence('attempt-log-before-kill', betaLog));
    evidence.push({ kind: 'accepted-state-before-kill', ref: scenario.file, sha256: digest(JSON.stringify(beforeAccepted)), detail: 'Accepted alpha task snapshot' });

    const killSent = child.kill('SIGKILL');
    await waitForExit(child);
    killed = killSent && (child.signalCode !== null || child.exitCode !== 0);
    addIssue(issues, killed, 'The runner process was not conclusively terminated after publishing its boundary marker');
    evidence.push({
      kind: 'process-termination',
      ref: `pid:${child.pid ?? 'unknown'}`,
      detail: `boundary=${boundary}; signal=SIGKILL; killAccepted=${killSent}; signalCode=${child.signalCode ?? 'none'}; exitCode=${child.exitCode ?? 'none'}`,
    });
    child = undefined;

    const resumeArgs = [...fileArgs];
    const resume = doRecovery('resume', resumeArgs);
    const resumed = jsonResult(resume);
    addIssue(issues, resume.exitCode === 0 && !!resumed, 'Supported dag resume did not return a usable recovery result');
    const ambiguous = Array.isArray(resumed?.ambiguous) && resumed!.ambiguous.includes('bravo');
    if (boundary === 'result-capture') {
      addIssue(issues, ambiguous, 'Dispatched work without a captured result was not held for explicit reconciliation');
      const held = loadRun(scenario.file).tasks.bravo;
      addIssue(issues, held.status === 'failed' && held.attempts === beforeBetaAttempts, 'Ambiguous work was re-executed before an explicit resolution');
      evidence.push({ kind: 'ambiguous-effect-held', ref: scenario.file, detail: `status=${held.status}; attempts=${held.attempts}; ${String(held.result)}` });
      const resolveArgs = [...fileArgs, '--resolve-ambiguous', 'bravo', '--resolution', 'safe-to-repeat', '--reason', 'The fixture writes only a deterministic file in an isolated Git worktree; the campaign records this explicit repeat decision.'];
      const resolved = doRecovery('resume', resolveArgs);
      const resolvedJson = jsonResult(resolved);
      addIssue(issues, resolved.exitCode === 0 && Array.isArray(resolvedJson?.resolved) && resolvedJson.resolved.includes('bravo'), 'Explicit ambiguity resolution was not recorded by dag resume');
      const resolutionRecord = loadRun(scenario.file).tasks.bravo.dispatchHistory?.find(item => item.attemptId === preKillDispatchId);
      addIssue(issues, resolutionRecord?.disposition === 'resolved' && resolutionRecord.resolution === 'safe-to-repeat' && !!resolutionRecord.resolutionReason,
        'The ambiguous dispatch has no durable operator resolution');
      if (resolutionRecord) evidence.push({ kind: 'ambiguous-resolution', ref: scenario.file, detail: JSON.stringify(resolutionRecord) });
    } else {
      addIssue(issues, !ambiguous, `${boundary} unexpectedly routed known work through ambiguous reconciliation`);
    }

    const runArgs = [...fileArgs, '--only', 'bravo,charlie', '--concurrency', '1', '--retries', '2'];
    const recoveryStarted = time();
    targetOutput = invokeCli('run', runArgs, 120_000);
    actions.push(recoveryAction('run', runArgs, recoveryStarted, targetOutput));
    evidence.push({ kind: 'recovery-run-output', ref: scenario.file, detail: `exit=${targetOutput.exitCode}; ${targetOutput.stdout.trim()} ${targetOutput.stderr.trim()}`.slice(0, 1800) });
    recoveredRun = loadRun(scenario.file);

    if (boundary === 'result-capture') {
      writeFileSync(scenario.staleRelease, 'release stale worker after recovery\n');
      const staleDone = await waitForFile(`${scenario.staleRelease}.done`, signal, 10_000);
      addIssue(issues, staleDone, 'The delayed stale worker did not complete its late worktree write');
      if (oldWorkerPath && staleDone) {
        const lateFile = join(oldWorkerPath, 'late-worker.txt');
        addIssue(issues, existsSync(lateFile), 'The stale worker did not write to its pre-recovery worktree');
        const afterLate = loadRun(scenario.file);
        const currentBeta = afterLate.tasks.bravo;
        addIssue(issues, JSON.stringify(acceptedRecord(currentBeta)) === JSON.stringify(acceptedRecord(recoveredRun.tasks.bravo)),
          'A late worker changed the durable accepted task record');
        addIssue(issues, git(scenario.root, ['show', `dag/${runId}:late-worker.txt`]).code !== 0,
          'A stale worktree write appeared on the accepted integration branch');
        evidence.push({ kind: 'stale-worker-late-write', ref: lateFile, detail: 'The delayed process wrote only to the old task worktree after recovery' });
        evidence.push(recordEvidence('durable-state-after-stale-write', runPaths(scenario.file).state));
      } else {
        issues.push('Stale worker could not be attributed to the old worker worktree');
      }
      recoveredRun = loadRun(scenario.file);
    }

    const after = recoveredRun;
    for (const [id, snapshot] of Object.entries(beforeAccepted)) {
      const task = after.tasks[id];
      addIssue(issues, !!task && JSON.stringify(acceptedRecord(task)) === snapshot, `Previously accepted task ${id} changed during recovery`);
      if (task?.diffHead) addIssue(issues, git(scenario.root, ['merge-base', '--is-ancestor', task.diffHead, `dag/${runId}`]).code === 0,
        `Previously accepted integration commit for ${id} is missing from Git`);
    }
    const recoveredSalvage = after.tasks.salvage;
    const afterSalvageRecord = JSON.stringify({
      status: recoveredSalvage.status, result: recoveredSalvage.result, branch: recoveredSalvage.branch, commit: recoveredSalvage.commit,
      attempts: recoveredSalvage.attempts, attemptsInCycle: recoveredSalvage.attemptsInCycle,
      failureKind: recoveredSalvage.failureKind, exitCode: recoveredSalvage.exitCode,
    });
    addIssue(issues, afterSalvageRecord === salvageRecord, 'Failed-work salvage state or failure reason changed during recovery');
    addIssue(issues, !!salvageBranch && git(scenario.root, ['show-ref', '--verify', `refs/heads/${salvageBranch}`]).code === 0, 'Failed-work salvage branch is no longer reachable');
    addIssue(issues, !!salvageCommit && git(scenario.root, ['cat-file', '-e', `${salvageCommit}^{commit}`]).code === 0, 'Failed-work salvage commit is missing');
    addIssue(issues, existsSync(salvageLog) && after.tasks.salvage.result === salvageResult &&
      (salvageLogDigest === undefined || digest(readFileSync(salvageLog)) === salvageLogDigest), 'Failed-work salvage log, attempts, or exact failure reason changed');
    evidence.push(recordEvidence('salvage-branch', salvageBranch ? `refs/heads/${salvageBranch}` : 'missing', `commit=${salvageCommit ?? 'missing'}; result=${salvageResult ?? 'missing'}`));
    if (existsSync(salvageLog)) evidence.push(recordEvidence('salvage-attempt-log', salvageLog));

    addIssue(issues, after.flowState?.reservedCents === beforeBudget?.reservedCents, 'Cumulative spend reservation changed during crash recovery');
    addIssue(issues, (after.flowState?.repairRound ?? 0) >= (beforeBudget?.repairRound ?? 0), 'Repair-round history decreased during crash recovery');
    const recoveredBeta = after.tasks.bravo;
    addIssue(issues, recoveredBeta.attempts >= beforeBetaAttempts, 'Lifetime attempt count decreased during crash recovery');
    if (preKillDispatchId) addIssue(issues, !!recoveredBeta.dispatchHistory?.some(item => item.attemptId === preKillDispatchId), 'Pre-kill dispatch history was lost');
    for (const prior of beforeBetaDispatchHistory) {
      const current = recoveredBeta.dispatchHistory?.find(item => item.attemptId === prior.attemptId);
      addIssue(issues, !!current, `Dispatch record ${prior.attemptId} was lost during recovery`);
      if (!current) continue;
      for (const [key, value] of Object.entries(prior)) {
        if (key === 'disposition' && value === 'ambiguous' && current.disposition === 'resolved') continue;
        addIssue(issues, JSON.stringify((current as unknown as Record<string, unknown>)[key]) === JSON.stringify(value),
          `Dispatch record ${prior.attemptId} field ${key} changed during recovery`);
      }
    }
    for (const prior of beforeBetaPhaseHistory) {
      addIssue(issues, !!recoveredBeta.phaseHistory?.some(item => JSON.stringify(item) === JSON.stringify(prior)),
        `Recorded ${prior.phase} history for attempt ${prior.attempt} was lost during recovery`);
    }
    evidence.push({ kind: 'attempt-budget-after-recovery', ref: runPaths(scenario.file).state,
      detail: `bravo attempts=${recoveredBeta.attempts}; reservedCents=${after.flowState?.reservedCents ?? 0}; repairRound=${after.flowState?.repairRound ?? 0}` });
    evidence.push(recordEvidence('accepted-state-after-recovery', runPaths(scenario.file).state));
    for (const task of Object.values(after.tasks).filter(item => item.status === 'completed')) {
      checkAcceptedGitState(scenario.root, after, task, issues, evidence);
    }
    evidence.push({ kind: 'git-store-reconciliation', ref: `refs/heads/dag/${runId}`,
      detail: `integrationHead=${git(scenario.root, ['rev-parse', `dag/${runId}`]).stdout}; accepted=${Object.values(after.tasks).filter(task => task.status === 'completed').map(task => task.id).join(',')}` });
  } catch (error) {
    if (signal.aborted || error instanceof CampaignInterrupted) throw new CampaignInterrupted();
    issues.push(error instanceof Error ? error.message : String(error));
    if (scenario && actions.length === 0) {
      const args = ['--file', scenario.file];
      const started = time();
      const result = invokeCli('resume', args);
      actions.push(recoveryAction('resume', args, started, result));
      evidence.push({ kind: 'recovery-after-campaign-error', ref: scenario.file, detail: `${result.stdout.trim()} ${result.stderr.trim()}`.slice(0, 1200) });
    }
  } finally {
    if (scenario && !existsSync(scenario.staleRelease)) {
      writeFileSync(scenario.staleRelease, 'release stale worker during campaign cleanup\n');
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      try { await waitForExit(child); } catch { /* Keep the campaign failure evidence below. */ }
    }
  }

  if (signal.aborted) throw new CampaignInterrupted();
  if (actions.length === 0) {
    const args = scenario ? ['--file', scenario.file] : [];
    actions.push(recoveryAction('resume', args, time(), { exitCode: -1, stdout: '', stderr: '', error: 'No recovery command completed' }));
  }
  if (evidence.length === 0) evidence.push({ kind: 'campaign-observation', ref: scenarioPath, detail: 'No boundary evidence could be collected' });
  const finalRun = recoveredRun ?? (scenario && existsSync(scenario.file) ? loadRun(scenario.file) : undefined);
  const task = boundary === 'finalization' ? finalRun?.tasks.bravo : finalRun?.tasks.bravo;
  const candidate = task?.nodeState?.candidate;
  const currentAttempt = task?.dispatchHistory?.slice().reverse().find(item => item.attempt === task.attempts && item.phase === 'work');
  const attribution: CrashCampaignAttribution = {
    runId,
    ...(task ? { taskId: task.id } : {}),
    ...(currentAttempt?.attemptId ? { attemptId: currentAttempt.attemptId } : preKillDispatchId ? { attemptId: preKillDispatchId } : {}),
    ...(task && task.attempts > 0 ? { attempt: task.attempts } : {}),
    ...(candidate?.definition ? { definitionDigest: candidate.definition } : {}),
    ...(candidate?.commit ? { sourceCommit: candidate.commit } : task?.commit ? { sourceCommit: task.commit } : {}),
    ...(task?.diffHead ? { integratedCommit: task.diffHead } : {}),
  };
  const finish = time();
  return {
    iterationId: randomUUID(),
    boundary,
    outcome: issues.length === 0 && killed ? 'completed' : 'failed',
    killPoint: markerEvent ? `${boundary} after durable operation; process ${killed ? 'terminated' : 'termination unconfirmed'}` : `${boundary} injection was not observed`,
    startedAt,
    finishedAt: finish,
    recoveryActions: actions,
    evidence,
    attribution,
    ...(issues.length ? { failureReason: [...new Set(issues)].join('; ').slice(0, 3500) } : {}),
  };
}

export interface RunCrashCampaignOptions {
  reportPath: string;
  campaignId?: string;
  maxBoundaries?: number;
  signal?: AbortSignal;
}

/** Execute or resume a real local process-termination campaign. */
export async function runCrashCampaign(options: RunCrashCampaignOptions): Promise<CrashCampaignReport> {
  const reportPath = resolve(options.reportPath);
  const fixtureRoot = `${reportPath}.fixtures`;
  mkdirSync(dirname(reportPath), { recursive: true });
  mkdirSync(fixtureRoot, { recursive: true });
  let report: CrashCampaignReport;
  if (existsSync(reportPath)) {
    report = loadCrashCampaignReport(reportPath);
    if (options.campaignId && options.campaignId !== report.campaignId) throw Error(`Report belongs to campaign ${report.campaignId}, not ${options.campaignId}`);
    if (report.status === 'complete') return report;
    // An in-progress file on entry means the previous driver left without its
    // signal handler (for example, after a forced process kill). Preserve that
    // interruption in the report before continuing its unrecorded boundary.
    if (report.status === 'in-progress') {
      report = interruptCrashCampaignReport(report);
      saveCrashCampaignReport(reportPath, report);
    }
    report = resumeCrashCampaignReport(report);
    saveCrashCampaignReport(reportPath, report);
  } else {
    const template = createRun();
    report = createCrashCampaignReport({ runId: template.id, campaignId: options.campaignId });
    saveCrashCampaignReport(reportPath, report);
  }

  const signal = options.signal ?? new AbortController().signal;
  const pending = CRASH_BOUNDARIES.filter(boundary => report.boundaries[boundary].iterations.length === 0);
  const limit = options.maxBoundaries ?? pending.length;
  let runCount = 0;
  for (const boundary of pending) {
    if (signal.aborted || runCount >= limit) break;
    let iteration: Awaited<ReturnType<typeof exerciseBoundary>>;
    try {
      iteration = await exerciseBoundary(boundary, fixtureRoot, report.runId, signal);
    } catch (error) {
      if (signal.aborted || error instanceof CampaignInterrupted) break;
      throw error;
    }
    if (!iteration) break;
    report = recordCrashCampaignIteration(report, iteration);
    saveCrashCampaignReport(reportPath, report);
    runCount++;
  }

  const stillPending = CRASH_BOUNDARIES.some(boundary => report.boundaries[boundary].iterations.length === 0);
  if (signal.aborted || stillPending) {
    report = interruptCrashCampaignReport(report);
    saveCrashCampaignReport(reportPath, report);
    return report;
  }
  report = completeCrashCampaignReport(report);
  saveCrashCampaignReport(reportPath, report);
  return report;
}

/** `dag crash-certify` exercises a disposable multi-task Git fixture locally. */
export async function crashCertifyCmd(argv: string[]): Promise<void> {
  if (argv.includes('--report') && !flag(argv, 'report')) throw Error('--report needs a value');
  if (argv.includes('--campaign-id') && !flag(argv, 'campaign-id')) throw Error('--campaign-id needs a value');
  if (argv.includes('--max-boundaries') && !flag(argv, 'max-boundaries')) throw Error('--max-boundaries needs a value');
  const campaignId = flag(argv, 'campaign-id');
  if (campaignId && (!/^[A-Za-z0-9._-]+$/.test(campaignId) || campaignId === '.' || campaignId === '..')) {
    throw Error('--campaign-id must be a safe file-name segment');
  }
  const defaultReport = join(process.cwd(), '.dag-crash-certification', `${campaignId ?? 'campaign'}.json`);
  const reportPath = resolve(flag(argv, 'report') ?? defaultReport);
  const maxBoundaries = countFlag(argv, 'max-boundaries', 1);
  const releaseCampaignLock = acquirePathLock(`${reportPath}.lock`, 'dag crash-certify');
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const report = await runCrashCampaign({ reportPath, campaignId, maxBoundaries, signal: controller.signal });
    const data = { reportPath, ...report };
    emit(argv, data, () => {
      const lines = CRASH_BOUNDARIES.map(boundary => `${boundary}: ${report.boundaries[boundary].outcome}`);
      return [`Crash certification ${report.status} (${report.campaignId})`, `report: ${reportPath}`, ...lines].join('\n');
    });
    if (report.status === 'interrupted') process.exitCode = 2;
    else if (!isCrashCampaignSuccessful(report)) process.exitCode = 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    releaseCampaignLock();
  }
}
