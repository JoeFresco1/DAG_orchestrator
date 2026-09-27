import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Executor } from '../runner.js';
import { addTask, loadRun, newRun, retryTask, runPaths, saveRun } from '../store.js';
import { traceRequirement } from './graph-model.js';
import { factoryReviewReport, factoryStatus, fixFactoryReview, resumeFactory, startFactory, type StructuredFactoryGoal } from './controller.js';
import { VERIFICATION_CATEGORIES } from './verification.js';

test('runs and resumes a complete factory cycle through DagRunner with requirement trace and recertification', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-factory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(join(root, 'src', 'auth.ts'), 'export function readPrincipal(): string { return ""; }\n');
  writeFileSync(join(root, 'src', 'trace.ts'), 'export function readTrace(): string { return ""; }\n');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'factory-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Factory Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });

  const runFile = join(root, 'dag.run.json');
  const goal: StructuredFactoryGoal = {
    schemaVersion: 1,
    goal: { id: 'context-preservation', title: 'Preserve request context', description: 'Keep auth and trace context across async calls.' },
    requirements: [{
      id: 'async-context', title: 'Context survives async work', description: 'The service keeps both auth and trace context.',
      acceptanceCriteria: ['Authorization sees the principal after await.', 'Tracing retains the span after callbacks.'],
    }],
    implementation: [{
      id: 'context-service', title: 'Implement context preservation', spec: 'Preserve auth and trace values across async boundaries.',
      cmd: 'fake implement', requirementIds: ['async-context'], codeUnits: ['src/auth.ts', 'src/trace.ts'], maxAttempts: 1,
    }],
    checks: [{ id: 'typecheck', title: 'Typecheck the implementation', cmd: 'fake typecheck' }],
    phases: {
      review: { command: 'fake review' },
      verification: { command: 'fake verify' },
      rootCause: { command: 'fake root-cause' },
      remediation: { command: 'fake remediate' },
      regression: { command: 'fake regression' },
      recertification: { reviewCmd: 'fake recertify' },
    },
    coverage: { criticalFlow: 1, weightedRisk: 0.96 },
    convergencePolicy: {
      minimumMeaningfulReviewUnits: 1, maximumWeightedResidualRisk: 0,
      minimumReleaseConfidence: 1, maximumNovelVerifiedDefectsPer1000Requests: 0,
      minimumRequestsForYield: 1, minimumWeightedRiskCoverage: 0.95,
      minimumCriticalFlowCoverage: 1, requiredCriticalFlowIds: ['async-context'],
      requiredDeterministicCheckIds: ['regression-factory-claim-context-preservation-async-context'],
      minimumRemainingBudget: { requests: 1 },
    },
  };

  let firstImplementationFailed = false;
  let recheckMode: 'unresolved' | 'stale' | 'resolved' = 'unresolved';
  const executor: Executor = async (task, ctx, cmdOverride) => {
    let output = 'ok\n';
    let exitCode = 0;
    if (cmdOverride === goal.phases.recertification.reviewCmd) {
      output = 'VERDICT: PASS\n';
    } else if (task.title === 'Implement context preservation' && !firstImplementationFailed) {
      firstImplementationFailed = true;
      output = 'temporary failure\n';
      exitCode = 1;
    } else if (task.title.startsWith('Factory review:')) {
      output = JSON.stringify({ reviewedFiles: ['src/auth.ts', 'src/trace.ts'], observations: [
        {
          id: 'F-auth', title: 'Authentication context disappears after await',
          description: 'Authorization reads no principal after the asynchronous boundary.',
          category: 'authentication', files: ['src/auth.ts'], failureScenario: 'The authorization guard receives no principal after await.',
        },
        {
          id: 'F-trace', title: 'Trace span disappears after callback',
          description: 'The exporter receives no span when the callback returns.',
          category: 'observability', files: ['src/trace.ts'], failureScenario: 'The exporter has no trace span after the callback returns.',
        },
      ] }) + '\n';
    } else if (task.title.startsWith('Verify defect hypothesis:')) {
      const evidence = task.spec.match(/"id"\s*:\s*"(context:v1:[a-f0-9]+)"/);
      assert.ok(evidence, 'verification packet includes source-linked evidence');
      output = JSON.stringify({
        verdict: 'verified', confidence: 0.96, reachability: 'confirmed',
        inspectedCategories: [...VERIFICATION_CATEGORIES],
        evidenceFor: [{ evidenceId: evidence[1], rationale: 'The cited source and reachable call path reproduce the missing context.' }],
        evidenceAgainst: [], reasoning: 'The assertion fails on the reachable async path.',
      }) + '\n';
    } else if (task.title.startsWith('Recheck repaired defect:')) {
      const evidence = task.spec.match(/"id"\s*:\s*"(context:v1:[a-f0-9]+)"/);
      assert.ok(evidence, 'fresh verification packet cites current source');
      const source = JSON.parse(readFileSync(join(runPaths(runFile).factory, 'remediation-verification-source-v1.json'), 'utf8')) as
        { sourceEvidenceIds: Record<string, string[]> };
      const currentEvidenceId = Object.values(source.sourceEvidenceIds).flat().find((id) => task.spec.includes(id));
      assert.ok(currentEvidenceId, 'recheck cites source from the current commit');
      const packets = JSON.parse(readFileSync(join(runPaths(runFile).factory, 'remediation-verification-packets-v1.json'), 'utf8')) as
        Record<string, { sha256: string; evidence: Array<{ id: string; category: string }> }>;
      const packet = Object.values(packets).find((item) => task.spec.includes(item.sha256))!;
      const staleEvidenceId = packet.evidence.find((item) => item.category === 'counterevidence')?.id;
      if (recheckMode === 'stale') assert.ok(staleEvidenceId, 'prior finding is present but cannot prove the repair');
      output = JSON.stringify({
        verdict: recheckMode === 'unresolved' ? 'verified' : 'rejected', confidence: 0.96,
        reachability: recheckMode === 'unresolved' ? 'confirmed' : 'refuted', inspectedCategories: [...VERIFICATION_CATEGORIES],
        evidenceFor: recheckMode === 'unresolved' ? [{ evidenceId: evidence[1], rationale: 'The original failure remains reproducible.' }] : [],
        evidenceAgainst: recheckMode === 'unresolved' ? [] : [{ evidenceId: recheckMode === 'stale' ? staleEvidenceId : currentEvidenceId, rationale: 'The current implementation carries the context value.' }],
        reasoning: recheckMode === 'resolved' ? 'The original failure is not reproducible after the fix.' : 'The original failure still needs current evidence.',
      }) + '\n';
    } else if (task.title.startsWith('Assess shared root causes')) {
      const start = task.spec.lastIndexOf('\n[');
      assert.ok(start >= 0, 'root-cause task contains the verified defect records');
      const defects = JSON.parse(task.spec.slice(start + 1)) as Array<{ id: string; verification: { evidence_for: Array<{ evidenceId: string }> } }>;
      assert.equal(defects.length, 2);
      output = JSON.stringify([{
        title: 'No explicit async context propagation',
        explanation: 'Authentication and tracing values are not carried over asynchronous boundaries.',
        defect_ids: defects.map((item) => item.id),
        affected_components: ['request-context'],
        remediation_scope: ['service layer', 'API contract'],
        evidence: defects.map((item) => ({ defect_id: item.id, evidence_id: item.verification.evidence_for[0]!.evidenceId, rationale: 'The verified execution path loses its context value.' })),
      }]) + '\n';
    } else if (task.title.startsWith('Repair root cause:')) {
      writeFileSync(join(ctx.cwd ?? root, 'src', 'auth.ts'), 'export function readPrincipal(): string { return "owner"; }\n');
      writeFileSync(join(ctx.cwd ?? root, 'src', 'trace.ts'), 'export function readTrace(): string { return "span"; }\n');
      execFileSync('git', ['add', 'src/auth.ts', 'src/trace.ts'], { cwd: ctx.cwd ?? root });
      execFileSync('git', ['commit', '-m', 'repair context propagation'], { cwd: ctx.cwd ?? root, stdio: 'ignore' });
      output = 'shared root cause repaired\n';
    }
    ctx.onOutput(output);
    ctx.setPid(null);
    return { output, exitCode };
  };

  const started = await startFactory(goal, runFile, { executor, cwd: root });
  assert.equal(started.state.stage, 'implementation');
  assert.equal(started.state.status, 'waiting');
  const persisted = loadRun(runFile);
  const implementationId = started.state.tasks.implementation['context-service']!;
  assert.equal(persisted.tasks[implementationId]?.status, 'failed');
  retryTask(persisted, implementationId, true);
  saveRun(persisted, runFile);

  writeFileSync(join(root, 'src', 'auth.ts'), `${readFileSync(join(root, 'src', 'auth.ts'), 'utf8')}\n// uncommitted change\n`);
  const dirty = await resumeFactory(runFile, { executor, cwd: root });
  assert.equal(dirty.state.stage, 'quality');
  assert.equal(dirty.state.status, 'waiting');
  assert.match(dirty.state.lastError ?? '', /committed, clean source tree/);
  execFileSync('git', ['restore', '--', 'src/auth.ts'], { cwd: root });

  const unresolved = await resumeFactory(runFile, { executor, cwd: root });
  assert.equal(unresolved.state.stage, 'remediation_verification');
  assert.equal(unresolved.state.status, 'waiting');
  assert.match(unresolved.state.lastError ?? '', /remains unresolved/);
  const retryRun = loadRun(runFile);
  for (const id of Object.values(unresolved.state.tasks.remediationVerification)) retryTask(retryRun, id, false);
  saveRun(retryRun, runFile);
  recheckMode = 'stale';
  const staleCitation = await resumeFactory(runFile, { executor, cwd: root });
  assert.equal(staleCitation.state.stage, 'remediation_verification');
  assert.match(staleCitation.state.lastError ?? '', /lacks conclusive post-remediation evidence/);
  const finalRetry = loadRun(runFile);
  for (const id of Object.values(staleCitation.state.tasks.remediationVerification)) retryTask(finalRetry, id, false);
  saveRun(finalRetry, runFile);
  recheckMode = 'resolved';

  const notConverged = await resumeFactory(runFile, {
    executor, cwd: root, convergencePolicy: { ...goal.convergencePolicy!, minimumRequestsForYield: 1000 },
  });
  assert.equal(notConverged.state.stage, 'convergence');
  assert.equal(notConverged.state.status, 'waiting');
  assert.match(notConverged.state.lastError ?? '', /has not converged/);
  const resumed = await resumeFactory(runFile, { executor, cwd: root });
  assert.equal(resumed.state.status, 'completed', resumed.summary);
  assert.equal(resumed.state.stage, 'complete');
  assert.equal(resumed.certification?.status, 'certified');
  assert.equal(resumed.certification?.deterministicChecks.some((item) => item.id.startsWith('regression-')), true);
  assert.ok(Object.keys(resumed.state.tasks.verification).length >= 2);
  assert.ok(Object.keys(resumed.state.tasks.remediation).length >= 4);
  assert.equal(Object.keys(resumed.state.tasks.remediationVerification).length, 2);
  assert.ok(Object.keys(resumed.state.tasks.recertification).length > 0);

  const savedRun = loadRun(runFile);
  assert.equal(savedRun.storageVersion, 2);
  const taskIds = [
    ...Object.values(resumed.state.tasks.implementation), ...Object.values(resumed.state.tasks.checks),
    ...(resumed.state.tasks.review ? [resumed.state.tasks.review] : []), ...Object.values(resumed.state.tasks.verification),
    ...(resumed.state.tasks.rootCause ? [resumed.state.tasks.rootCause] : []), ...Object.values(resumed.state.tasks.remediation),
    ...Object.values(resumed.state.tasks.remediationVerification),
    ...(resumed.state.tasks.regression ? [resumed.state.tasks.regression] : []), ...Object.values(resumed.state.tasks.recertification),
  ];
  for (const id of taskIds) {
    assert.equal(savedRun.tasks[id]?.status, 'completed', `factory task ${id} completed through the DAG runner`);
  }
  const model = JSON.parse(readFileSync(join(runPaths(runFile).factory, 'graph-model-v1.json'), 'utf8'));
  const requirement = model.graphs.requirement.entities.find((item: { kind: string }) => item.kind === 'requirement');
  assert.ok(requirement);
  const traces = traceRequirement(model, requirement.id);
  assert.ok(traces.some((path) => path.some((id) => id.startsWith('defect:v1:root-cause.')) && path.some((id) => id.startsWith('execution:v1:task_'))));
  const manifest = JSON.parse(readFileSync(join(runPaths(runFile).factory, 'manifest.json'), 'utf8'));
  assert.ok(manifest.artifacts.some((item: { path: string }) => item.path === 'certification-v1.json'));
  assert.ok(manifest.evidence.some((item: { kind: string }) => item.kind === 'review'));

  const repeated = await resumeFactory(runFile, { executor, cwd: root });
  assert.equal(repeated.state.status, 'completed');
  assert.equal(Object.keys(loadRun(runFile).tasks).length, Object.keys(savedRun.tasks).length);
  writeFileSync(join(root, 'src', 'auth.ts'), 'export function readPrincipal(): string { return "changed"; }\n');
  execFileSync('git', ['add', 'src/auth.ts'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'change after certification'], { cwd: root, stdio: 'ignore' });
  assert.equal(factoryStatus(runFile).state.status, 'waiting');
  assert.match(factoryStatus(runFile).state.lastError ?? '', /certificate is stale/);
  assert.equal((await resumeFactory(runFile, { executor, cwd: root })).state.status, 'waiting');
});

test('reviews an existing repository and prior DAG without implementation tasks', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-factory-existing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.gitignore'), 'dag*.json*\ndag*.d/\n');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(join(root, 'src', 'service.ts'), 'export function getOwner(): string { return "owner"; }\n');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'factory-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Factory Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'existing app'], { cwd: root, stdio: 'ignore' });

  const priorFile = join(root, 'dag.previous.json');
  const prior = newRun('Original owner spec');
  const built = addTask(prior, { title: 'Implement owner behavior', spec: 'The owner must be present.', cmd: 'fake implement' });
  built.status = 'completed';
  built.result = 'implemented';
  saveRun(prior, priorFile);

  const goal: StructuredFactoryGoal = {
    schemaVersion: 1, mode: 'review',
    goal: { id: 'owner-review', title: 'Review existing owner behavior', description: 'Audit the existing service.' },
    requirements: [{ id: 'owner', title: 'Owner exists', description: 'Every service result has an owner.', acceptanceCriteria: ['getOwner returns a non-empty value.'] }],
    implementation: [], review: { codeUnits: ['src/service.ts'], sourceRunFile: priorFile },
    checks: [{ id: 'typecheck', title: 'Typecheck', cmd: 'fake typecheck' }],
    phases: {
      review: { command: 'fake review' }, verification: { command: 'fake verify' },
      rootCause: { command: 'fake root-cause' }, remediation: { command: 'fake remediate' },
      regression: { command: 'fake regression' }, recertification: { reviewCmd: 'fake recertify' },
    },
    coverage: { criticalFlow: 1, weightedRisk: 1 },
  };
  let reviewSpec = '';
  const executor: Executor = async (task, ctx, cmdOverride) => {
    if (task.title.startsWith('Factory review:')) reviewSpec = task.spec;
    const output = cmdOverride === 'fake recertify' ? 'VERDICT: PASS\n' : task.title.startsWith('Factory review:') ? '{"observations":[],"reviewedFiles":["src/service.ts"]}\n' : 'ok\n';
    ctx.onOutput(output);
    ctx.setPid(null);
    return { output, exitCode: 0 };
  };
  const file = join(root, 'dag.review.json');
  const result = await startFactory(goal, file, { cwd: root, executor });
  assert.equal(result.state.stage, 'complete', result.summary);
  assert.equal(result.state.status, 'completed');
  assert.equal(Object.keys(result.state.tasks.implementation).length, 0);
  assert.ok(result.state.tasks.review);
  assert.equal(result.certification?.status, 'certified');
  assert.match(reviewSpec, /Original owner spec/);
  assert.match(reviewSpec, /src\/service\.ts/);
  assert.equal(loadRun(priorFile).tasks[built.id]?.status, 'completed');
  const decision = JSON.parse(readFileSync(join(runPaths(file).factory, 'convergence-decision-v1.json'), 'utf8'));
  assert.equal(decision.status, 'stop');
  assert.equal(decision.summary.windowRequestCount, 1);

  const legacyExecutor: Executor = async (task, ctx, cmdOverride) => {
    const output = cmdOverride === 'fake recertify' ? 'VERDICT: PASS\n' :
      task.title.startsWith('Factory review:') ? '[]\n' : 'ok\n';
    ctx.onOutput(output);
    ctx.setPid(null);
    return { output, exitCode: 0 };
  };
  const legacy = await startFactory(goal, join(root, 'dag.legacy-review.json'), { cwd: root, executor: legacyExecutor });
  assert.equal(legacy.state.stage, 'convergence');
  assert.equal(legacy.state.status, 'waiting');
  assert.match(legacy.state.lastError ?? '', /measured reviewed-file risk coverage/);

  writeFileSync(join(root, 'review.cjs'), 'console.log(JSON.stringify({observations:[],reviewedFiles:["src/service.ts"]}))\n');
  writeFileSync(join(root, 'recert.cjs'), 'console.log("VERDICT: PASS")\n');
  execFileSync('git', ['add', 'review.cjs', 'recert.cjs'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'review commands'], { cwd: root, stdio: 'ignore' });
  const cliGoal = {
    ...goal, mode: 'build', implementation: [{
      id: 'unused', title: 'Would implement owner', spec: 'Do not run in review mode.',
      cmd: 'node missing-implementer.cjs', requirementIds: ['owner'], codeUnits: ['src/service.ts'],
    }],
    phases: {
      ...goal.phases,
      review: { command: 'node review.cjs' },
      regression: { command: 'node --version' },
      recertification: { reviewCmd: 'node recert.cjs' },
    },
    checks: [{ id: 'node', title: 'Node available', cmd: 'node --version' }],
  };
  const goalFile = join(root, 'dag.goal.json');
  const cliFile = join(root, 'dag.cli-review.json');
  writeFileSync(goalFile, JSON.stringify(cliGoal));
  try {
    execFileSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'factory', 'review', '--goal', goalFile,
      '--source-run', priorFile, '--file', cliFile], { cwd: root, stdio: 'pipe' });
  } catch (error) {
    const gitStatus = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${(error as { stdout?: Buffer }).stdout?.toString() ?? ''}\ngit status: ${gitStatus}`);
  }
  assert.equal(factoryStatus(cliFile).state.status, 'completed');
  assert.equal(Object.keys(loadRun(cliFile).tasks).some((id) => id.includes('unused')), false);

  const repoFile = join(root, 'dag.repo-review.json');
  try {
    execFileSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'factory', 'review', '--file', repoFile,
      '--cmd', 'node review.cjs', '--recert-cmd', 'node recert.cjs', '--check', 'node --version'], { cwd: root, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${(error as { stdout?: Buffer }).stdout?.toString() ?? ''}`);
  }
  assert.equal(factoryStatus(repoFile).state.status, 'completed');
  const generatedGoal = JSON.parse(readFileSync(join(runPaths(repoFile).factory, 'goal-v1.json'), 'utf8'));
  assert.equal(generatedGoal.mode, 'review');
  assert.deepEqual(generatedGoal.implementation, []);
  assert.deepEqual(generatedGoal.coverage, { criticalFlow: 1, weightedRisk: 0 });
  assert.deepEqual(generatedGoal.review.codeUnits, ['src/service.ts']);
  const cliReport = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'factory', 'report',
    '--file', repoFile, '--json'], { cwd: root, encoding: 'utf8' }));
  assert.equal(cliReport.verifiedDefects.length, 0);

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'existing-app', scripts: { test: 'node --version' } }));
  execFileSync('git', ['add', 'package.json'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'add test script'], { cwd: root, stdio: 'ignore' });
  const autoCheckFile = join(root, 'dag.auto-check.json');
  try {
    execFileSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'factory', 'review', '--file', autoCheckFile,
      '--cmd', 'node review.cjs', '--recert-cmd', 'node recert.cjs'], { cwd: root, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${(error as { stdout?: Buffer }).stdout?.toString() ?? ''}`);
  }
  const autoGoal = JSON.parse(readFileSync(join(runPaths(autoCheckFile).factory, 'goal-v1.json'), 'utf8'));
  assert.equal(autoGoal.checks[0].cmd, process.platform === 'win32' ? 'cmd /c npm run test' : 'npm run test');
  assert.equal(factoryStatus(autoCheckFile).state.status, 'completed');
});

test('reports verified findings before creating repair tasks and requires an explicit fix decision', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-factory-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.gitignore'), 'dag*.json*\ndag*.d/\n');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(join(root, 'src', 'service.ts'), 'export function getOwner(): string { return ""; }\n');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'factory-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Factory Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'existing app'], { cwd: root, stdio: 'ignore' });
  const goal: StructuredFactoryGoal = {
    schemaVersion: 1, mode: 'review',
    goal: { id: 'owner', title: 'Review owner', description: 'Check existing owner behavior.' },
    requirements: [{ id: 'owner', title: 'Owner required', description: 'Owner must be populated.', acceptanceCriteria: ['getOwner returns a value.'] }],
    implementation: [], review: { codeUnits: ['src/service.ts'] },
    checks: [{ id: 'node', title: 'Check tool', cmd: 'fake check' }],
    phases: {
      review: { command: 'fake review' }, verification: { command: 'fake verify' },
      rootCause: { command: 'fake root-cause' }, remediation: { command: 'fake remediate' },
      regression: { command: 'fake regression' }, recertification: { reviewCmd: 'fake recertify' },
    },
    coverage: { criticalFlow: 1, weightedRisk: 1 },
  };
  const executor: Executor = async (task, ctx) => {
    let output = 'ok\n';
    let exitCode = 0;
    if (task.title.startsWith('Factory review:')) output = JSON.stringify([{
      id: 'owner-empty', title: 'Owner is empty', description: 'The service returns an empty owner.',
      category: 'correctness', files: ['src/service.ts'], failureScenario: 'getOwner returns an empty string.',
    }]);
    else if (task.title.startsWith('Verify defect hypothesis:')) {
      const evidence = task.spec.match(/"id"\s*:\s*"(context:v1:[a-f0-9]+)"/);
      assert.ok(evidence);
      output = JSON.stringify({
        verdict: 'verified', confidence: 0.96, reachability: 'confirmed', inspectedCategories: [...VERIFICATION_CATEGORIES],
        evidenceFor: [{ evidenceId: evidence[1], rationale: 'Current source returns an empty owner.' }],
        evidenceAgainst: [], reasoning: 'The failure is reachable.',
      });
    } else if (task.title.startsWith('Assess shared root causes')) output = '[]';
    else if (task.title.startsWith('Fix verified defect:')) { output = 'repair failed'; exitCode = 1; }
    ctx.onOutput(output);
    ctx.setPid(null);
    return { output, exitCode };
  };
  const file = join(root, 'dag.review.json');
  const result = await startFactory(goal, file, { cwd: root, executor });
  assert.equal(result.state.stage, 'report', result.summary);
  assert.equal(result.state.status, 'waiting');
  assert.equal(Object.keys(result.state.tasks.remediation).length, 0);
  const report = factoryReviewReport(file);
  assert.equal(report.verifiedDefects.length, 1);
  assert.ok(report.proposedRemediationTasks > 0);
  assert.equal((await resumeFactory(file, { cwd: root, executor })).state.stage, 'report');
  assert.equal(Object.keys(loadRun(file).tasks).some((id) => loadRun(file).tasks[id]?.title.startsWith('Fix verified defect:')), false);
  const cliReport = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'factory', 'report',
    '--file', file, '--json'], { cwd: root, encoding: 'utf8' }));
  assert.equal(cliReport.verifiedDefects.length, 1);
  execFileSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'factory', 'close', '--file', file], { cwd: root, stdio: 'pipe' });
  assert.equal(factoryStatus(file).state.stage, 'reported');
  assert.equal(factoryStatus(file).state.status, 'completed');
  writeFileSync(join(root, 'src', 'service.ts'), 'export function getOwner(): string { return "changed"; }\n');
  assert.equal(factoryStatus(file).state.status, 'waiting');
  await assert.rejects(() => fixFactoryReview(file, { cwd: root, executor }), /source tree|source changed/);
  execFileSync('git', ['restore', '--', 'src/service.ts'], { cwd: root });
  const fixing = await fixFactoryReview(file, { cwd: root, executor });
  assert.equal(fixing.state.stage, 'remediation');
  assert.ok(Object.keys(fixing.state.tasks.remediation).length > 0);
  assert.equal(fixing.state.status, 'waiting');

  const changingExecutor: Executor = async (task, ctx) => {
    if (task.title.startsWith('Factory review:')) {
      writeFileSync(join(root, 'src', 'service.ts'), 'export function getOwner(): string { return "changed early"; }\n');
      execFileSync('git', ['add', 'src/service.ts'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'unexpected review edit'], { cwd: root, stdio: 'ignore' });
    }
    const output = task.title.startsWith('Factory review:') ? '[]\n' : 'ok\n';
    ctx.onOutput(output);
    ctx.setPid(null);
    return { output, exitCode: 0 };
  };
  const changedEarly = await startFactory(goal, join(root, 'dag.unsafe-review.json'), { cwd: root, executor: changingExecutor });
  assert.equal(changedEarly.state.stage, 'quality');
  assert.match(changedEarly.state.lastError ?? '', /review source changed before the report/);
});
