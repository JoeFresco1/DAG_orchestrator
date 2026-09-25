// Seed the software-factory roadmap into an empty DAG run.
// Usage: node scripts/seed-factory-dag.mjs --file <run-file>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const fileFlag = process.argv.indexOf('--file');
if (fileFlag < 0 || !process.argv[fileFlag + 1]) {
  throw new Error('usage: node scripts/seed-factory-dag.mjs --file <run-file>');
}
const runFile = resolve(process.argv[fileFlag + 1]);
const specPath = 'docs/specs/software-factory-v0.1.md';
const spec = readFileSync(specPath, 'utf8');
const cli = resolve('dist/cli.js');
const run = JSON.parse(readFileSync(runFile, 'utf8'));
if (Object.keys(run.tasks ?? {}).length !== 0) {
  throw new Error(`run ${run.id} is not empty; refusing to seed twice`);
}

const workCmd = 'codex exec --approve-for-me -m gpt-6-luna -c model_reasoning_effort=max "{spec} Before finishing, run pnpm typecheck and relevant tests, and fix any failures. On retry, address this prior rejection: {lastRejection}"';
const checkCmd = 'pnpm test';
const typecheckCmd = 'pnpm typecheck';
const tasks = [
  {
    key: 'preflight',
    title: 'Preflight: restore passing runner baseline',
    deps: [],
    output: 'A focused correction in src/runner.ts and/or src/runner.test.ts, with regression coverage for stopping a real process tree.',
    acceptance: 'The existing Windows failure `stop should not wait for the full grace when the kill works` is resolved without weakening the stop guarantee. `node --test --test-name-pattern "stops a real process tree" dist/runner.test.js`, pnpm typecheck, and pnpm test pass.',
    sections: 'The current branch failed pnpm test on 2026-09-25: 116 passed, one failed in the stop/process-tree test. The focused test also failed and left a child process until interrupted.',
  },
  {
    key: 'foundation',
    title: 'Foundation: shared factory contracts and integration map',
    deps: ['preflight'],
    output: 'docs/specs/software-factory-architecture.md and minimal shared types in src/factory/contracts.ts with focused tests.',
    acceptance: 'Document how factory data attaches to the existing Run and sidecar storage, the versioned identifiers and evidence references, and exact extension points in src/runner.ts, src/store.ts, and src/graph.ts. Add no second executor or scheduler. pnpm typecheck and focused tests pass.',
    sections: 'Read sections 1, 2, 13, 32, and 33 of the source specification.',
  },
  { key: '13', deps: ['foundation'], output: 'src/factory/graph-model.ts and tests for typed requirement, code, execution, and defect entities and edges.', acceptance: 'Round-trip the four graph kinds and cross-graph links; reject dangling or ill-typed references; trace a requirement through code, task, defect, and fix using deterministic queries.' },
  { key: '04', deps: ['13'], output: 'src/factory/code-graph.ts and tests, plus deterministic indexing adapters for this TypeScript repository.', acceptance: 'Index files, symbols, imports/calls, tests, and relevant schema relationships; support the four example impact queries with stable IDs and incremental updates. Derive relationships using tooling rather than an LLM.' },
  { key: '02', deps: ['04'], output: 'src/factory/risk.ts and tests.', acceptance: 'Rank reviewable units without an LLM using deterministic signals, explain sub-scores and missing signals, and keep risk ordering stable for identical repository evidence.' },
  { key: '03', deps: ['02'], output: 'src/factory/risk-coverage.ts and tests.', acceptance: 'Report both audit coverage and weighted risk coverage, including residual risk; a high-risk reviewed unit must contribute more than an equal-sized low-risk unit.' },
  { key: '05', deps: ['04'], output: 'src/factory/review-units.ts and tests.', acceptance: 'Construct bounded, coherent graph neighborhoods with nucleus, inbound, outbound, lateral, tests, and contracts; cap context size and avoid quadratic pairwise units at high-degree nodes.' },
  { key: '06', deps: ['04', '05'], output: 'src/factory/context-compiler.ts and tests.', acceptance: 'Compile deterministic evidence packets from symbols, callers, callees, tests, relevant spec clauses and diagnostics; record provenance and allow explicit context expansion when the packet is insufficient.' },
  { key: '01', deps: ['02', '03', '05', '06'], output: 'src/factory/review-router.ts, tests, and integration with existing review scheduling in src/runner.ts.', acceptance: 'Persist a reproducible machine-readable review plan; record reasons for each selected and skipped stage; skip redundant agent reviews when deterministic evidence suffices; cover high-risk escalation and budget limits.' },
  { key: '18', deps: ['01'], output: 'src/factory/review-intensity.ts and tests, wired through the review router.', acceptance: 'Reassign depth after new deterministic findings, contradictions, changed contracts, or verified defects; show why low-risk work remains shallow and high-risk work escalates.' },
  { key: 'phase-a', deps: ['01', '18'], title: 'Phase A integration: risk-directed review', output: 'Integrated Phase A behavior and regression tests.', acceptance: 'Exercise risk scoring, coherent units, context packets, router decisions and dynamic escalation end to end. pnpm test and pnpm typecheck pass.', command: checkCmd },

  { key: '07', deps: ['phase-a'], output: 'src/factory/observations.ts and tests.', acceptance: 'Normalize observations deterministically, retain exact duplicates as corroboration, and cluster related observations by symbols, graph paths, failure scenario and semantic evidence.' },
  { key: '08', deps: ['07'], output: 'src/factory/hypotheses.ts and tests.', acceptance: 'Create versioned, testable claims from observation clusters with linked source IDs, affected paths, confidence and status; preserve the observation/hypothesis distinction.' },
  { key: '09', deps: ['08', '04'], output: 'src/factory/preverification.ts and tests.', acceptance: 'Check symbol and line existence, graph reachability, guards and type/static-analysis contradictions where deterministic evidence is available; reject only proven-invalid claims and send unresolved claims onward.' },
  { key: '10', deps: ['09', '06'], output: 'src/factory/verification.ts and tests plus an existing-run reviewer adapter.', acceptance: 'Challenge plausible hypotheses using implementation, callers, guards, tests and counterevidence; emit reproducible verdict evidence and never modify code during verification.' },
  { key: '11', deps: ['10'], output: 'src/factory/disputes.ts and tests.', acceptance: 'Turn conflicting reviewer claims into a bounded disputed proposition with evidence for and against, then pass only its open question to adjudication.' },
  { key: 'phase-b', deps: ['07', '08', '09', '10', '11'], title: 'Phase B integration: hypotheses and verification', output: 'Integrated Phase B behavior and regression tests.', acceptance: 'Exercise raw observations through normalization, clustering, hypothesis creation, deterministic challenge, adversarial verification and dispute creation. pnpm test and pnpm typecheck pass.', command: checkCmd },

  { key: '12', deps: ['phase-b'], output: 'src/factory/root-causes.ts and tests.', acceptance: 'Link distinct verified defects to shared root causes without collapsing the defects themselves; retain evidence, affected components, severity and remediation scope.' },
  { key: '30', deps: ['12', '13'], output: 'src/factory/remediation.ts and tests, integrated with existing DAG task creation.', acceptance: 'Compile verified root causes into bounded fix tasks with dependencies, acceptance checks and trace links; avoid creating duplicate symptom-level repairs.' },
  { key: 'phase-c', deps: ['12', '30'], title: 'Phase C integration: root-cause remediation', output: 'Integrated Phase C behavior and regression tests.', acceptance: 'Verify a shared root cause produces one coherent remediation plan with traceability back to all verified defects. pnpm test and pnpm typecheck pass.', command: checkCmd },

  { key: '14', deps: ['04', 'phase-a'], output: 'src/factory/project-memory.ts and tests using versioned run-sidecar persistence.', acceptance: 'Persist evidence-backed subsystem memory by repository commit and architecture hash; invalidate stale facts and resume from known architecture plus changes.' },
  { key: '28', deps: ['14', '03'], output: 'src/factory/certification.ts and tests.', acceptance: 'Create a versioned certification object tied to commit, spec graph, architecture graph, deterministic checks, review evidence, accepted risks and residual findings.' },
  { key: '15', deps: ['28'], output: 'src/factory/baseline.ts and tests.', acceptance: 'Certify a commit only when configured checks and risk-coverage thresholds pass; save residual findings and refuse silent promotion of a failing baseline.' },
  { key: '16', deps: ['04', '15'], output: 'src/factory/impact.ts and tests.', acceptance: 'Map changed symbols/contracts to affected graph paths, requirements, tests and certified assumptions; produce a reproducible impact set.' },
  { key: '29', deps: ['16', '28'], output: 'src/factory/certification-invalidation.ts and tests.', acceptance: 'Invalidate precisely the certification claims touched by semantic impact and retain unaffected evidence with its original provenance.' },
  { key: '17', deps: ['29', '15'], output: 'src/factory/recertification.ts and tests, connected to the existing review scheduler.', acceptance: 'Re-run checks and reviews for invalidated claims, carry forward unaffected evidence, and issue a new certification object only after affected claims pass.' },
  { key: 'phase-d', deps: ['14', '15', '16', '17', '28', '29'], title: 'Phase D integration: incremental certification', output: 'Integrated Phase D behavior and regression tests.', acceptance: 'Verify a certified baseline, one narrow code change, precise invalidation and targeted recertification. pnpm test and pnpm typecheck pass.', command: checkCmd },

  { key: '27', deps: ['foundation'], output: 'src/factory/telemetry.ts and tests reusing structured attempt history.', acceptance: 'Record counts, latency, cost proxies, reviewer outcomes, verified defects, false positives and risk coverage without altering routing decisions.' },
  { key: '19', deps: ['phase-b', '27'], output: 'src/factory/reviewer-calibration.ts and tests.', acceptance: 'Estimate reviewer precision and verified discovery by category from historical verdicts; retain sample sizes and avoid treating unverified claims as ground truth.' },
  { key: '20', deps: ['19', '10'], output: 'src/factory/confidence.ts and tests.', acceptance: 'Calibrate confidence using corroborating and contradictory evidence; expose uncertainty and prevent a bare model score from becoming certified truth.' },
  { key: '21', deps: ['19'], output: 'src/factory/model-router.ts and tests, integrated with existing harness/model selection.', acceptance: 'Select a model/harness from task risk, review type, calibrated performance and budget while preserving explicit user overrides and a recorded decision reason.' },
  { key: '26', deps: ['phase-b'], output: 'src/factory/negative-evidence.ts and tests.', acceptance: 'Store disproven hypotheses and false-positive patterns with evidence and repository version; reuse them only while their assumptions remain valid.' },
  { key: 'phase-e', deps: ['19', '20', '21', '26', '27'], title: 'Phase E integration: learning and telemetry', output: 'Integrated Phase E behavior and regression tests.', acceptance: 'Verify telemetry feeds calibration and model choices, while negative evidence suppresses repeated invalid claims without hiding new evidence. pnpm test and pnpm typecheck pass.', command: checkCmd },

  { key: '22', deps: ['phase-a', '27'], output: 'src/factory/review-budget.ts and tests.', acceptance: 'Enforce configurable limits for review time, model use and risk coverage with explicit accounting and an escalation path for high-risk work.' },
  { key: '23', deps: ['22', '20'], output: 'src/factory/information-gain.ts and tests.', acceptance: 'Rank optional review actions by expected risk reduction per estimated cost using recorded evidence and deterministic tie-breaking.' },
  { key: '24', deps: ['23'], output: 'src/factory/confidence-frontier.ts and tests.', acceptance: 'Expose which unresolved claims can still alter release confidence, and prioritize those claims over low-value repeat reviews.' },
  { key: '25', deps: ['24', '17'], output: 'src/factory/convergence.ts and tests.', acceptance: 'Stop review or require escalation using explicit risk, confidence, budget and certification thresholds; persist the decision and its evidence.' },
  { key: 'phase-f', deps: ['22', '23', '24', '25'], title: 'Phase F integration: economic control', output: 'Integrated Phase F behavior and regression tests.', acceptance: 'Verify a finite budget prioritizes high-value review, reaches an explainable frontier, and converges or escalates without an infinite loop. pnpm test and pnpm typecheck pass.', command: checkCmd },

  { key: '31', deps: ['phase-c', 'phase-d', 'phase-e', 'phase-f'], output: 'End-to-end factory controller integrated into the existing DAG orchestrator, tests, and operator documentation.', acceptance: 'Starting from a structured goal, exercise requirement trace, implementation tasks, review, hypothesis verification, root-cause remediation, regression checks and recertification through the existing executor. Resume safely from persisted state.' },
  { key: 'final', deps: ['31'], title: 'Final integration: software factory regression suite', output: 'Passing end-to-end regression suite and documented run result.', acceptance: 'pnpm test and pnpm typecheck pass; every SPEC 01–31 has a traceable implementation and deterministic or reproducible acceptance evidence.', command: checkCmd },
];

function sectionFor(key) {
  const n = Number(key);
  const match = spec.match(new RegExp(`^# SPEC ${String(n).padStart(2, '0')}[^\\n]*[\\s\\S]*?(?=^# SPEC \\d{2}|^# 32\\.|$(?![\\s\\S]))`, 'm'));
  if (!match) throw new Error(`missing SPEC ${key} in ${specPath}`);
  return match[0].trim();
}

function callCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--file', runFile, '--json'], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${args[0]} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

const ids = new Map();
for (const item of tasks) {
  const isSpec = /^\d{2}$/.test(item.key);
  const title = item.title ?? sectionFor(item.key).split('\n', 1)[0].replace(/^# /, '');
  const taskSpec = [
    `Inputs: ${specPath}; docs/specs/software-factory-architecture.md; existing src/runner.ts, src/store.ts, src/graph.ts; direct dependencies: ${item.deps.join(', ') || 'none'}.`,
    'Extend the existing DAG orchestrator; do not build a separate executor or scheduler. Preserve the public CLI and current run format unless a versioned migration is included.',
    item.sections ?? '',
    `Outputs: ${item.output}`,
    `Acceptance: ${item.acceptance}`,
    isSpec ? `Requirements:\n${sectionFor(item.key)}` : '',
  ].filter(Boolean).join('\n\n');
  const deps = item.deps.map((key) => {
    const id = ids.get(key);
    if (!id) throw new Error(`dependency ${key} for ${item.key} has not been created`);
    return id;
  });
  const args = ['add', '--title', title, '--spec', taskSpec, '--cmd', item.command ?? workCmd];
  if (deps.length) args.push('--deps', deps.join(','));
  if (!item.command) args.push('--retries', '1', '--timeout', '7200', '--silence', '900');
  const created = callCli(args);
  if (!item.command) {
    callCli(['reviewer', 'add', '--id', created.id, '--name', 'typecheck', '--cmd', typecheckCmd, '--when', 'always', '--verdict', 'exit-code']);
  }
  if (item.key === 'preflight') {
    callCli(['reviewer', 'add', '--id', created.id, '--name', 'tests', '--cmd', checkCmd, '--when', 'always', '--verdict', 'exit-code']);
  }
  ids.set(item.key, created.id);
  process.stdout.write(`${item.key}\t${created.id}\t${title}\n`);
}
process.stdout.write(`Seeded ${ids.size} tasks into ${run.id}\n`);
