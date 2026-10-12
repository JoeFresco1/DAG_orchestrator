import { posix, relative, resolve, isAbsolute } from 'node:path';
import ts from 'typescript';
import { digest, type PlanningManifest, type PlanningFinding } from './contracts.js';
import type { Run } from '../types.js';

const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.py'];
const scriptPath = (s: string) => /\.(?:[cm]?[jt]sx?|json|py)$/.test(s);
const normalize = (s: string) => posix.normalize(s.replaceAll('\\', '/')).replace(/^\.\//, '');
function ancestors(plan: PlanningManifest, id: string, deps: Record<string, { owner: string }[]>, seen = new Set<string>()): Set<string> {
  for (const d of deps[id] ?? []) if (!seen.has(d.owner)) { seen.add(d.owner); ancestors(plan, d.owner, deps, seen); }
  return seen;
}
function finding(task: string, owners: string[], file: string, evidence: string[], rule = 'acceptance.future'): PlanningFinding {
  const tasks = [...new Set([task, ...owners])];
  return { id: digest({ rule, tasks, file }).slice(0, 24), rule, tasks, references: [file], evidence,
    severity: 'error', blocking: true, message: rule === 'acceptance.future'
      ? `Acceptance for ${task} references ${file}, owned outside its prerequisites`
      : `Acceptance input ${file} has no task producer or verified baseline`,
    correction: 'Assign the acceptance to its proper stage, declare its producer dependency, or pin an existing baseline; do not retry implementation' };
}

/** Only literal argv paths and static JS/TS imports are authoritative here.
 * Dynamic loaders, globs and package scripts need explicit check.files. */
export function lintAcceptance(plan: PlanningManifest, deps: Record<string, { owner: string }[]>, read?: (file: string) => Buffer): PlanningFinding[] {
  const results: PlanningFinding[] = [];
  const owned = new Set(plan.tasks.flatMap(t => (t.files ?? []).map(f => f.path)));
  const known = (file: string) => owned.has(file) || plan.sources.some(s => s.path === file);
  for (const task of plan.tasks) {
    const warn = (evidence: string) => results.push({ id: digest({ task: task.id, evidence }).slice(0, 24), rule: 'acceptance.untraced', tasks: [task.id], references: [task.id], evidence: [evidence], severity: 'warning', blocking: false,
      message: 'Acceptance references cannot be completely traced statically', correction: 'Declare dynamically loaded files in check.files; pin baseline inputs and register task outputs' });
    const available = ancestors(plan, task.id, deps); available.add(task.id);
    const baseline = new Map([...plan.sources, ...(task.inputs ?? []).flatMap(i => i.baseline ? [i.baseline] : []),
      ...(task.files ?? []).flatMap(f => f.role === 'frozen' ? [{ path: f.path, sha256: f.digest! }] : [])].map(s => [s.path, s.sha256]));
    const seen = new Set<string>();
    const inspect = (raw: string, trail: string[]) => {
      const file = normalize(raw); if (seen.has(file)) return; seen.add(file);
      if (file === '..' || file.startsWith('../') || isAbsolute(file) || /^[A-Za-z]:/.test(file)) return;
      const owners = plan.tasks.filter(t => (t.files ?? []).some(f => f.path === file && f.role !== 'frozen')).map(t => t.id);
      let bytes: Buffer | undefined; try { bytes = read?.(file); } catch { /* Planned outputs may not exist yet. */ }
      const pinned = baseline.has(file) && (!read || bytes !== undefined && digest(bytes) === baseline.get(file));
      // Existing files do not imply baseline authority. An unavailable producer
      // cannot be masked by stale bytes left in the current checkout.
      if (!owners.some(id => available.has(id)) && !pinned) results.push(finding(task.id, owners, file, trail, owners.length ? 'acceptance.future' : 'acceptance.input'));
      if (bytes === undefined) { if (read && owners.some(id => available.has(id))) warn(`Planned acceptance source ${file} is not available for import inspection yet`); return; }
      if (!/\.[cm]?[jt]sx?$/.test(file)) { if (file.endsWith('.py')) warn(`Python imports in ${file} require explicit check.files`); return; }
      const source = bytes.toString('utf8');
      if (/\b(?:import|require)\s*\(\s*[^'"\s]/.test(source)) warn(`Dynamic module loader in ${file}`);
      const imports = ts.preProcessFile(source, true, true).importedFiles;
      for (const entry of imports) {
        if (!entry.fileName.startsWith('.')) { if (!entry.fileName.startsWith('node:')) warn(`Package or alias import ${entry.fileName} in ${file}; local aliases need check.files`); continue; }
        const stem = normalize(posix.join(posix.dirname(file), entry.fileName));
        const candidates = [stem, ...extensions.map(e => stem + e), ...extensions.map(e => `${stem}/index${e}`),
          ...(/\.[cm]?js$/.test(stem) ? [stem.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts')] : [])];
        const target = candidates.find(known) ?? candidates.find(c => { try { return read?.(c) !== undefined; } catch { return false; } }) ?? stem;
        inspect(target, [...trail, `${file} imports ${entry.fileName}`]);
      }
    };
    for (const check of [...task.checks, ...(task.provides ?? []).map(p => p.check), ...(task.inputs ?? []).flatMap(i => i.check ? [i.check] : [])]) {
      const files = [...(check.files ?? [])];
      if (check.args.some(arg => /[*?{}]/.test(arg) && !arg.includes(' ')) || /^(?:pnpm|npm|yarn)(?:\.cmd)?$/.test(check.program)) warn(`Check ${check.id} uses a glob or package script; declare its acceptance files`);
      for (let i = 0; i < check.args.length; i++) {
        const arg = check.args[i]!;
        if (['-e', '--eval', '-p', '--print', '-c'].includes(arg)) { i++; continue; }
        const previous = check.args[i - 1];
        // Unknown option values are not proven file references. Installed
        // harness entrypoints belong to the environment, not a DAG producer.
        if (previous?.startsWith('-') && !['--test', '--run', '-r', '--require', '--import'].includes(previous)) continue;
        if (normalize(arg).startsWith('node_modules/')) continue;
        if (!arg.startsWith('-') && !/[\s*?{}]/.test(arg) && scriptPath(arg) && !isAbsolute(arg) && !/^[A-Za-z]:/.test(arg)) files.push(arg);
      }
      for (const file of files) inspect(file, [`Check ${check.id}: ${check.program} ${JSON.stringify(check.args)}`]);
    }
  }
  return [...new Map(results.map(f => [f.id, f])).values()];
}

/** Runtime text is evidence only when it names an exact registered future file. */
export function forwardReferenceFailure(run: Run, taskId: string, message: string, cwd: string): PlanningFinding[] {
  const plan = run.planning?.manifest; if (!plan) return [];
  const deps = Object.fromEntries(Object.values(run.tasks).map(t => [t.id, t.deps.map(owner => ({ owner }))]));
  const available = ancestors(plan, taskId, deps); available.add(taskId);
  const match = message.match(/(?:Cannot find module|Module not found:.*?|ENOENT:.*?(?:open|stat|scandir))\s*['"]([^'"\r\n]+)['"]/);
  if (!match) return [];
  if (!match[0].startsWith('ENOENT:') && !match[1]!.startsWith('.') && !isAbsolute(match[1]!) && !/^[A-Za-z]:/.test(match[1]!)) return [];
  const file = normalize(relative(cwd, resolve(cwd, match[1]!)));
  const owners = plan.tasks.filter(t => (t.files ?? []).some(f => f.path === file && f.role !== 'frozen')).map(t => t.id);
  if (!owners.length || owners.some(id => available.has(id)) || owners.some(id => run.tasks[id]?.status === 'completed')) return [];
  return [finding(taskId, owners, file, [message.slice(-2000), `Registered owners: ${owners.join(', ')}`])];
}
