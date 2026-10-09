import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const DEFAULT_WORKERS = [{ model: 'gpt-6-luna', reasoning: 'xhigh', attempts: 3 }, { model: 'gpt-6.1-sol', reasoning: 'medium', attempts: 3 }, { model: 'gpt-6.1-sol', reasoning: 'xhigh', attempts: 4 }];
export function safePath(path) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || /^[A-Za-z]:|\\|\0|\r|\n/.test(path) || path.split('/').some(p => !p || p === '..' || p === '.' || p === '.git'))
        throw new Error(`Unsafe contract path: ${path}`);
    return path;
}
export function command(value) {
    if (!value || typeof value.program !== 'string' || !value.program || !Array.isArray(value.args) || value.args.some(x => typeof x !== 'string' || /[\0\r\n]/.test(x)))
        throw new Error('Use a program and argument vector');
    if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 7200000)
        throw new Error('Command deadline must be 1..7200000ms');
    return value;
}
export function loadConfig(path) {
    const bytes = readFileSync(path, 'utf8'), cfg = JSON.parse(bytes);
    if (cfg.version !== 1 || !cfg.runFile || !cfg.tasks || Array.isArray(cfg.tasks))
        throw new Error('Invalid reliability manifest');
    cfg.policy = { wallMs: 86400000, engineTimeoutMs: 900000, incidentsPerTask: 2, incidentsPerRun: 12, infraRetries: 2, scopeRevisions: 2, concurrency: 1, workers: DEFAULT_WORKERS, ...cfg.policy };
    for (const key of ['wallMs', 'incidentsPerTask', 'incidentsPerRun', 'infraRetries', 'scopeRevisions', 'concurrency'])
        if (!Number.isSafeInteger(cfg.policy[key]) || cfg.policy[key] < 1)
            throw new Error(`Invalid policy ${key}`);
    if (cfg.policy.concurrency > 64)
        throw new Error('Concurrency exceeds engine limit');
    command({ program: 'engine', args: [], timeoutMs: cfg.policy.engineTimeoutMs });
    if (!Array.isArray(cfg.policy.workers) || !cfg.policy.workers.length)
        throw new Error('Missing model policy');
    for (const p of cfg.policy.workers)
        if (!DEFAULT_WORKERS.some(x => x.model === p.model && x.reasoning === p.reasoning) || !Number.isSafeInteger(p.attempts) || p.attempts < 1 || p.attempts > 10)
            throw new Error('Unauthorized model policy');
    for (const c of Object.values(cfg.commands || {}))
        command(c);
    for (const key of ['work', 'diagnose', 'repair', 'review']) {
        const c = cfg.commands?.[key];
        if (c && c.kind !== 'deterministic' && (!c.args.some(a => a.includes('{model}')) || !c.args.some(a => a.includes('{reasoning}'))))
            throw new Error(`${key} adapter must accept the controlled model and reasoning arguments`);
    }
    for (const key of ['diagnose', 'repair', 'review'])
        if (!cfg.commands?.[key])
            throw new Error(`Missing ${key} adapter`);
    cfg.capacities = { ...(cfg.capacities || {}) };
    for (const n of Object.values(cfg.capacities))
        if (!Number.isSafeInteger(n) || n < 1)
            throw new Error('Invalid resource capacity');
    for (const [id, u] of Object.entries(cfg.tasks)) {
        if (!/^[A-Za-z0-9_-]+$/.test(id) || !u.entryPoint || !u.reviewBoundary || !Array.isArray(u.requirements) || !u.requirements.length || u.requirements.some(r => typeof r !== 'string' || !r.trim()) || !Array.isArray(u.files) || !u.files.length || !Array.isArray(u.checks) || !u.checks.length)
            throw new Error(`Incomplete task contract ${id}`);
        const seen = new Set();
        for (const f of u.files) {
            safePath(f.path);
            if (seen.has(f.path) || !['implementation', 'test', 'frozen', 'generated'].includes(f.role))
                throw new Error(`Invalid file role ${id}`);
            seen.add(f.path);
            if (f.role === 'frozen' && !/^[a-f0-9]{64}$/.test(f.digest || ''))
                throw new Error('Frozen file needs digest');
        }
        if (!seen.has(u.entryPoint))
            throw new Error(`Entry point is not owned: ${id}`);
        for (const c of u.checks)
            command(c);
        for (const p of u.inputs || []) {
            if (!p.owner || !p.contract)
                throw new Error('Input probe needs owner and contract');
            command(p.check);
        }
        for (const [name, n] of Object.entries(u.resources || {}))
            if (!Number.isSafeInteger(n) || n < 1 || !cfg.capacities[name] || n > cfg.capacities[name])
                throw new Error(`Unachievable resource demand ${id}:${name}`);
    }
    return { cfg, revision: hash(bytes), path: resolve(path) };
}
export function upstream(run, id) {
    const seen = new Set(), visiting = new Set();
    const visit = key => {
        if (visiting.has(key))
            throw new Error('Cyclic contract graph');
        if (seen.has(key))
            return;
        if (!run.tasks[key])
            throw new Error(`Unknown dependency ${key}`);
        visiting.add(key);
        for (const dep of run.tasks[key].deps || [])
            visit(dep);
        visiting.delete(key);
        seen.add(key);
    };
    visit(id);
    seen.delete(id);
    return seen;
}
export function preflight(cfg, run) {
    const roles = new Map();
    for (const u of Object.values(cfg.tasks)) for (const f of u.files) {
        const prior = roles.get(f.path);
        if (prior && prior !== f.role) throw new Error(`Conflicting file roles: ${f.path}`);
        roles.set(f.path, f.role);
    }
    for (const id of Object.keys(run.tasks)) {
        if (run.tasks[id].status === 'skipped')
            continue;
        const u = cfg.tasks[id];
        if (!u)
            throw new Error(`Missing registered task contract ${id}`);
        if (!u.deterministic && !cfg.commands.work)
            throw new Error(`Agent task needs a profile-controlled work adapter: ${id}`);
        if ((run.tasks[id].planCmd || run.tasks[id].reviewCmd || run.tasks[id].reviewers?.length || run.settings?.finalReview && run.settings.finalReview !== 'off') && !cfg.policy.replaceLegacyReview)
            throw new Error('Explicit replaceLegacyReview policy required; controller owns review and retry routing');
        const deps = upstream(run, id);
        for (const p of u.inputs || [])
            if (!deps.has(p.owner) || !cfg.tasks[p.owner])
                throw new Error(`Input ${p.contract} depends on a future/unregistered owner ${p.owner}`);
    }
    return { tasks: Object.keys(run.tasks).length, contracts: Object.keys(cfg.tasks).length };
}
export function repairScope(cfg, run, id, requested = []) {
    const allowed = upstream(run, id);
    allowed.add(id);
    const own = cfg.tasks[id].files.filter(f => f.role === 'implementation' || f.role === 'test' || f.role === 'generated').map(f => f.path);
    const files = new Set(own);
    for (const path of requested) {
        safePath(path);
        if (![...allowed].some(owner => cfg.tasks[owner]?.files.some(f => f.path === path && f.role === 'implementation')))
            throw new Error(`No upstream implementation authority: ${path}`);
        files.add(path);
    }
    if (files.size > 64)
        throw new Error('Repair scope exceeds 64 files');
    return [...files];
}
export function chooseBatch(cfg, run, suspended = new Set()) {
    const chosen = [], used = {}, writes = new Set();
    for (const t of Object.values(run.tasks).sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
        if (!['pending', 'ready'].includes(t.status) || suspended.has(t.id) || !t.cmd || t.gate && t.gate.approved !== true || !t.deps.every(id => run.tasks[id]?.status === 'completed'))
            continue;
        const u = cfg.tasks[t.id];
        if (!u)
            continue;
        const paths = u.files.filter(f => f.role !== 'frozen').map(f => f.path);
        if (paths.some(p => writes.has(p)) || Object.entries(u.resources || {}).some(([name, n]) => (used[name] || 0) + n > cfg.capacities[name]))
            continue;
        chosen.push(t.id);
        paths.forEach(p => writes.add(p));
        for (const [name, n] of Object.entries(u.resources || {}))
            used[name] = (used[name] || 0) + n;
        if (chosen.length >= cfg.policy.concurrency)
            break;
    }
    return chosen;
}
export function git(cwd, args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0)
        throw new Error(r.stderr || r.stdout || 'Git failed');
    return r.stdout.trim();
}
function testCalls(path, text) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true), printer = ts.createPrinter(), out = [];
    const visit = node => {
        if (ts.isCallExpression(node) && /^(?:test|it)(?:\.(?:skip|only|todo))?$/.test(node.expression.getText(source)))
            out.push(printer.printNode(ts.EmitHint.Unspecified, node, source));
        ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
}
function testViolation(path, validationRule, message, owner) {
    return Object.assign(new Error(message), { failure: { version: 1, code: 'implementation', stage: 'validation', validationRule, file: path, ...(owner ? { owner } : {}), evidence: [message] } });
}
function preserveTestModule(path, old, text) {
    const parse = value => ts.createSourceFile(path, value, ts.ScriptTarget.Latest, true), printer = ts.createPrinter();
    const before = parse(old), after = parse(text), remaining = [...after.statements];
    let cursor = 0;
    for (const node of before.statements) {
        const printed = printer.printNode(ts.EmitHint.Unspecified, node, before);
        const at = remaining.findIndex((candidate, index) => index >= cursor && printer.printNode(ts.EmitHint.Unspecified, candidate, after) === printed);
        if (at < 0)
            throw testViolation(path, 'acceptance_modified', `Existing acceptance changed: ${path}`);
        remaining[at] = null;
        cursor = at + 1;
    }
    for (const node of remaining.filter(Boolean))
        if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression) || !/^(?:test|it|describe|suite)$/.test(node.expression.expression.getText(after)))
            throw testViolation(path, 'test_support', `New test support code requires a separate registered file: ${path}`);
}
export function guardDiff(cfg, id, cwd, base, scope = repairScope(cfg, { tasks: { [id]: { deps: [] } } }, id)) {
    if (git(cwd, ['rev-parse', 'HEAD']) !== base)
        throw new Error('Worker changed Git history');
    const changed = [...new Set([...git(cwd, ['diff', '--name-only', base]).split(/\r?\n/), ...git(cwd, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/)].filter(Boolean))];
    if (changed.some(p => !scope.includes(p)))
        throw new Error('Worker changed an unowned file: ' + changed.filter(p => !scope.includes(p)).join(','));
    if (git(cwd, ['diff', '--diff-filter=D', '--name-only', base]))
        throw new Error('Worker deleted tracked evidence');
    const roles = new Map(Object.values(cfg.tasks).flatMap(u => u.files).map(f => [f.path, f]));
    for (const f of roles.values()) {
        if (f.role === 'frozen' && (!existsSync(resolve(cwd, f.path)) || hash(readFileSync(resolve(cwd, f.path))) !== f.digest))
            throw new Error(`Frozen contract changed: ${f.path}`);
        if (f.role !== 'test' || !changed.includes(f.path))
            continue;
        let old = '';
        try {
            old = git(cwd, ['show', `${base}:${f.path}`]);
        }
        catch { }
        if (!old)
            continue;
        const text = readFileSync(resolve(cwd, f.path), 'utf8');
        if (/\.(?:ts|js|mjs|cjs)$/.test(f.path)) {
            try { preserveTestModule(f.path, old, text); }
            catch (error) { if (error.failure) error.failure.owner = id; throw error; }
            const available = testCalls(f.path, text);
            for (const call of testCalls(f.path, old)) {
                const at = available.indexOf(call);
                if (at < 0)
                    throw testViolation(f.path, 'acceptance_modified', `Existing acceptance changed: ${f.path}`, id);
                available.splice(at, 1);
            }
        }
        else if (f.path.endsWith('.py')) {
            const script = 'import ast,json,sys; a,b=json.load(sys.stdin); nodes=lambda s:[ast.dump(n,include_attributes=False) for n in ast.parse(s).body]; x,y=nodes(a),nodes(b); cursor=0\nfor node in x:\n try: cursor=y.index(node,cursor)+1\n except ValueError: sys.exit(1)';
            if (spawnSync('python', ['-c', script], { input: JSON.stringify([old, text]), cwd, windowsHide: true, timeout: 10000 }).status !== 0)
                throw testViolation(f.path, 'acceptance_modified', `Existing Python acceptance changed: ${f.path}`, id);
        }
        else if (!text.includes(old))
            throw testViolation(f.path, 'acceptance_modified', `Existing acceptance changed: ${f.path}`, id);
    }
    return changed;
}
export function makeTaskGuard(context) {
    return async (task, cwd, base) => {
        if (hash(readFileSync(context.path, 'utf8')) !== context.revision)
            throw new Error('Reliability manifest changed during execution');
        try {
            guardDiff(context.cfg, task.id, cwd, base, context.cfg.tasks[task.id].files.filter(f => f.role !== 'frozen').map(f => f.path));
        }
        catch (e) {
            throw Object.assign(new Error('DAG_FAILURE: ' + JSON.stringify(e.failure || { version: 1, code: 'ownership', stage: 'validation', owner: task.id, evidence: [e.message] })), { kind: 'review' });
        }
    };
}
export function contained(root, path) {
    const target = resolve(root, path), rel = relative(root, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
        throw new Error('Path escapes project');
    return target;
}
export function sourceIdentity(cwd, cfg) {
    const files = [...new Set([...Object.values(cfg.tasks).flatMap(u => u.files.map(f => f.path)), 'package-lock.json', 'pnpm-lock.yaml', 'uv.lock', 'pyproject.toml', 'package.json'])].sort();
    return hash({ node: process.version, platform: process.platform, arch: process.arch, head: git(cwd, ['rev-parse', 'HEAD']), diff: git(cwd, ['diff', 'HEAD']), files: files.map(path => [path, existsSync(resolve(cwd, path)) ? hash(readFileSync(resolve(cwd, path))) : null]) });
}
export const graphIdentity = run => hash(Object.values(run.tasks).map(t => ({ id: t.id, title: t.title, spec: t.spec, deps: t.deps, cmd: t.cmd, prepareCmd: t.prepareCmd, planCmd: t.planCmd, reviewCmd: t.reviewCmd, reviewers: t.reviewers })));
