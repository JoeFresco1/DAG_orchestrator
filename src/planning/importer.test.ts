import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFragments, type PlanningFragments } from './importer.js';
import { digest, assertPlanningRequirementsPreserved, type PlanningManifest } from './contracts.js';
import { admitPlanningTask } from './validation.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

function fragment(): PlanningManifest {
  const check = { id: 'check', program: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1000 };
  return { version: 2, id: 'fragment', title: 'Fragment', sources: [], requirements: [
    { id: 'r', title: 'Requirement', description: 'Original requirement unchanged', acceptance: ['c'] }],
    criteria: [{ id: 'c', text: 'Runtime works', requirement: 'r', stage: 'local', owner: 'task_runtime', contributors: ['task_runtime'], checks: ['check'] }],
    tasks: [{ id: 'task_runtime', title: 'Runtime', objective: 'Implement runtime', reviewBoundary: 'Runtime behavior', requirements: ['r'], acceptance: ['c'],
      checks: [check], files: [{ path: 'src/runtime.ts', role: 'implementation' }], provides: [{ id: 'runtime', contract: 'Runtime v1', check }] }] };
}
function input(): PlanningFragments {
  const commit = 'a'.repeat(40);
  return { version: 1, id: 'merged', title: 'Merged', baseline: { commit, sources: [] }, fragments: ['first', 'second'].map(namespace => ({
    namespace, baselineCommit: commit, manifest: fragment(), sharedTasks: ['task_runtime'] })) };
}
test('normalization preserves namespaced provenance and executes an explicit shared producer once', () => {
  const source = input(), result = normalizeFragments(source);
  assert.equal(result.report.valid, true, JSON.stringify(result.report.findings));
  assert.equal(result.manifest.tasks.length, 1);
  assert.deepEqual(result.manifest.tasks[0]!.requirements, ['first:r', 'second:r']);
  assert.deepEqual(result.manifest.criteria.map(c => c.id), ['first:c', 'second:c']);
  assert.equal(result.manifest.provenance!.fragments[0]!.criteria.c, 'first:c');
  assert.equal(source.fragments[0]!.manifest.tasks[0]!.requirements[0], 'r');
  source.fragments.reverse();
  assert.equal(digest(normalizeFragments(source)), digest(result));
});
test('source, baseline, executable and producer conflicts fail deterministically without dropping requirements', () => {
  for (const kind of ['source', 'baseline', 'identity', 'producer', 'interface']) {
    const source = input();
    if (kind === 'source') source.fragments.forEach((f, i) => f.manifest.sources.push({ path: 'spec.md', sha256: String(i).repeat(64) }));
    if (kind === 'baseline') source.fragments[1]!.baselineCommit = 'b'.repeat(40);
    if (kind === 'identity') source.fragments[1]!.manifest.tasks[0]!.objective = 'Different runtime';
    if (kind === 'producer') source.fragments.forEach(f => f.sharedTasks = []);
    if (kind === 'interface') {
      source.fragments.forEach((f, i) => {
        f.sharedTasks = []; f.manifest.tasks[0]!.provides = [];
        f.manifest.tasks[0]!.interfaces = [{ id: 'public-api', version: String(i) }];
      });
    }
    const result = normalizeFragments(source);
    assert.equal(result.report.valid, false);
    assert.ok(result.report.findings.some(f => f.rule === `import.${kind}-conflict`), JSON.stringify(result.report.findings));
    assert.equal(result.manifest.requirements.length, 2);
    source.fragments.reverse(); assert.equal(digest(normalizeFragments(source)), digest(result));
  }
});
test('task dependencies and input producer owners cannot merge across local identity domains', () => {
  const source = input(); source.fragments.forEach(f => f.manifest.tasks[0]!.dependencies = [{ owner: 'task_local', reason: 'Uses local', evidence: ['local'] }]);
  assert.ok(normalizeFragments(source).report.findings.some(f => f.rule === 'import.identity-conflict'));
});
test('duplicate identities within a fragment block instead of silently overwriting work', () => {
  const source = input(); source.fragments[0]!.manifest.tasks.push(structuredClone(source.fragments[0]!.manifest.tasks[0]!));
  assert.throws(() => normalizeFragments(source), /Duplicate task identity/);
});
test('planning correction cannot discard or rewrite original fragment provenance', () => {
  const { manifest } = normalizeFragments(input());
  for (const mutation of ['drop', 'baseline', 'mapping']) {
    const amended = structuredClone(manifest);
    if (mutation === 'drop') delete amended.provenance;
    if (mutation === 'baseline') amended.provenance!.baselineCommit = 'b'.repeat(40);
    if (mutation === 'mapping') amended.provenance!.fragments[0]!.requirements.r = 'replacement';
    assert.throws(() => assertPlanningRequirementsPreserved(manifest, amended), /import provenance/);
  }
  assert.doesNotThrow(() => assertPlanningRequirementsPreserved(manifest, structuredClone(manifest)));
});
test('write admission detects directory overlap and normalized host paths atomically with capacities', () => {
  const plan = fragment(), second = structuredClone(plan.tasks[0]!); second.id = 'task_second'; plan.tasks.push(second);
  second.files = [{ path: 'src', role: 'implementation' }];
  assert.equal(admitPlanningTask(plan, 'task_second', ['task_runtime']), false);
  second.files = [{ path: 'src/sub/../runtime.ts', role: 'implementation' }];
  assert.equal(admitPlanningTask(plan, 'task_second', ['task_runtime']), false);
  if (process.platform === 'win32') {
    second.files = [{ path: 'SRC/RUNTIME.TS', role: 'implementation' }];
    assert.equal(admitPlanningTask(plan, 'task_second', ['task_runtime']), false);
  }
  second.files = [{ path: 'other.ts', role: 'implementation' }]; plan.capacities = { cpu: 1 };
  plan.tasks.forEach(t => t.resources = { cpu: 1 });
  assert.equal(admitPlanningTask(plan, 'task_second', ['task_runtime']), false);
  assert.equal(admitPlanningTask(plan, 'task_second', []), true);
});
test('normalizer CLI verifies pinned Git sources, writes a usable manifest, and blocks another baseline', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-fragments-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  git('init'); writeFileSync(join(dir, 'baseline.ts'), 'original\n'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'baseline');
  const source = input(), commit = git('rev-parse', 'HEAD'); source.baseline.commit = commit;
  source.baseline.sources = [{ path: 'baseline.ts', sha256: digest('original\n') }];
  source.fragments.forEach(f => f.baselineCommit = commit);
  // The original Git baseline stays pinned while implementation changes the working tree.
  writeFileSync(join(dir, 'baseline.ts'), 'updated\n');
  const fragmentsFile = join(dir, 'fragments.json'), out = join(dir, 'plan.json');
  writeFileSync(fragmentsFile, JSON.stringify(source));
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const run = (): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [cli, 'plan', 'normalize', '--fragments', fragmentsFile,
    '--out', out, '--cwd', dir, '--json'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  const first = run(); assert.equal(first.status, 0, String(first.stderr));
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).provenance.baselineCommit, commit);
  source.baseline.sources[0]!.sha256 = 'b'.repeat(64); writeFileSync(fragmentsFile, JSON.stringify(source));
  const blocked = run(); assert.equal(blocked.status, 1); assert.match(String(blocked.stdout), /import.baseline-source/);
  assert.notEqual(JSON.parse(readFileSync(out, 'utf8')).provenance.baselineSources[0].sha256, 'b'.repeat(64));
});
test('write admission resolves existing directory aliases for newly created files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-owned-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src')); symlinkSync(join(dir, 'src'), join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = fragment(), second = structuredClone(plan.tasks[0]!); second.id = 'task_second';
  second.files = [{ path: 'alias/runtime.ts', role: 'implementation' }]; plan.tasks.push(second);
  assert.equal(admitPlanningTask(plan, 'task_second', ['task_runtime'], dir), false);
});
