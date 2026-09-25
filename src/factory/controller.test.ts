import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Executor } from '../runner.js';
import { loadRun, retryTask, runPaths, saveRun } from '../store.js';
import { traceRequirement } from './graph-model.js';
import { resumeFactory, startFactory, type StructuredFactoryGoal } from './controller.js';
import { VERIFICATION_CATEGORIES } from './verification.js';

test('runs and resumes a complete factory cycle through DagRunner with requirement trace and recertification', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-factory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(join(root, 'src', 'auth.ts'), 'export function readPrincipal(): string { return "owner"; }\n');
  writeFileSync(join(root, 'src', 'trace.ts'), 'export function readTrace(): string { return "span"; }\n');
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
  };

  let firstImplementationFailed = false;
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
      output = JSON.stringify([
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
      ]) + '\n';
    } else if (task.title.startsWith('Verify defect hypothesis:')) {
      const evidence = task.spec.match(/"id"\s*:\s*"(context:v1:[a-f0-9]+)"/);
      assert.ok(evidence, 'verification packet includes source-linked evidence');
      output = JSON.stringify({
        verdict: 'verified', confidence: 0.96, reachability: 'confirmed',
        inspectedCategories: [...VERIFICATION_CATEGORIES],
        evidenceFor: [{ evidenceId: evidence[1], rationale: 'The cited source and reachable call path reproduce the missing context.' }],
        evidenceAgainst: [], reasoning: 'The assertion fails on the reachable async path.',
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
      for (const path of ['src/auth.ts', 'src/trace.ts']) {
        const file = join(ctx.cwd ?? root, path);
        writeFileSync(file, `${readFileSync(file, 'utf8')}\n// context propagation remediation\n`);
      }
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

  const resumed = await resumeFactory(runFile, { executor, cwd: root });
  assert.equal(resumed.state.status, 'completed', resumed.summary);
  assert.equal(resumed.state.stage, 'complete');
  assert.equal(resumed.certification?.status, 'certified');
  assert.equal(resumed.certification?.deterministicChecks.some((item) => item.id.startsWith('regression-')), true);
  assert.ok(Object.keys(resumed.state.tasks.verification).length >= 2);
  assert.ok(Object.keys(resumed.state.tasks.remediation).length >= 4);
  assert.ok(Object.keys(resumed.state.tasks.recertification).length > 0);

  const savedRun = loadRun(runFile);
  assert.equal(savedRun.storageVersion, 2);
  const taskIds = [
    ...Object.values(resumed.state.tasks.implementation), ...Object.values(resumed.state.tasks.checks),
    ...(resumed.state.tasks.review ? [resumed.state.tasks.review] : []), ...Object.values(resumed.state.tasks.verification),
    ...(resumed.state.tasks.rootCause ? [resumed.state.tasks.rootCause] : []), ...Object.values(resumed.state.tasks.remediation),
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
});
