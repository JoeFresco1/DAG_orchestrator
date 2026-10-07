import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRun, assertNoForeignLock, runPaths } from '../../dist/store.js';
import { ensureIntegrationWorktree, snapshotExcludes } from '../../dist/git-worktree.js';
import { loadConfig, preflight, chooseBatch, repairScope, guardDiff, git, hash, sourceIdentity, graphIdentity } from './contracts.mjs';
import { failure, taskFailure, marker, fingerprint, disposition, profileFor, reviewOutcome, lessonCandidate } from './protocol.mjs';
import { openLedger, lease, report, atomic } from './ledger.mjs';
import { runCommand, terminateOwned } from './process.mjs';
import { checked } from './checks.mjs';
const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
export async function reliable(action, configPath, options = {}) {
    const context = loadConfig(configPath), { cfg, revision } = context, file = resolve(dirname(context.path), cfg.runFile), root = dirname(file), directory = join(runPaths(file).dir, 'reliability');
    let run = loadRun(file);
    preflight(cfg, run);
    if (action === 'preflight')
        return preflight(cfg, run);
    if (!['run', 'resume', 'status', 'audit', 'amend'].includes(action))
        throw Error('Expected run, resume, status, audit, amend or preflight');
    if (action === 'amend') {
        if (!options.reason?.trim())
            throw Error('Stopped amendment requires a recorded reason');
        const releaseAmend = lease(directory);
        try {
            assertNoForeignLock(file);
            if (Object.values(run.tasks).some(t => t.status === 'running'))
                throw Error('Stop the engine before amending');
            const old = JSON.parse(readFileSync(join(directory, 'controller.json'), 'utf8'));
            if (old.runId !== run.id)
                throw Error('Run identity changed');
            const amendments = old.amendments || [];
            amendments.push({ at: Date.now(), previousRevision: old.revision, revision, reason: options.reason });
            old.amendments = amendments;
            old.revision = revision;
            old.graphRevision = graphIdentity(run);
            old.metrics.manualInterventions++;
            for (const i of Object.values(old.incidents))
                if (!['resolved', 'requeued'].includes(i.phase)) {
                    i.phase = 'exhausted';
                    i.reason = 'Contract superseded by explicit amendment';
                }
            for (const id of options.release || [])
                delete old.suspended[id];
            atomic(join(directory, 'controller.json'), old);
            return { revision, amendments, budgetsPreserved: true };
        }
        finally {
            releaseAmend();
        }
    }
    if (['status', 'audit'].includes(action) && !existsSync(join(directory, 'controller.json')))
        return { runId: run.id, stage: 'not_started' };
    const ledger = openLedger(directory, run.id, revision, cfg.policy), s = ledger.state;
    s.graphRevision ??= graphIdentity(run);
    s.semanticCounts ??= {};
    s.infrastructureCounts ??= {};
    if (action === 'status')
        return report(ledger, run);
    if (action === 'audit')
        return { ...report(ledger, run), lessons: Object.values(s.incidents).map(lessonCandidate), certified: false };
    const release = lease(directory);
    const execute = async (spec, cwd, tokens = {}, stage = 'command') => {
        s.active = { stage, taskId: tokens.taskId || null };
        ledger.save('stage-start', s.active);
        try {
            return await runCommand({ ...spec, stage }, { cwd, deadline: s.deadline, tokens, env: { DAG_CONTROLLER_TOKEN: JSON.parse(readFileSync(join(directory, 'controller.lock'), 'utf8')).token }, onStart: receipt => { s.active.receipt = receipt; ledger.save(); }, onProgress: p => { s.lastMeaningfulProgress = p.at; ledger.save(); } });
        }
        finally {
            s.active = null;
            ledger.save('stage-end', { stage });
        }
    };
    const dag = (args) => execute({ program: process.execPath, args: [cli, ...args, '--file', file, '--json'], timeoutMs: 900000 }, root, {}, 'engine');
    const suspend = (id, f, reason) => { s.suspended[id] = { failure: f, reason, at: Date.now() }; ledger.save('suspend', { taskId: id, reason }); };
    async function recover(id, f) {
        if (['quota', 'authentication', 'model_unavailable', 'user_stop', 'contract', 'review_dispute', 'budget'].includes(f.code)) {
            suspend(id, f, disposition(f));
            return;
        }
        let incident = Object.values(s.incidents).find(i => i.taskId === id && !['resolved', 'exhausted'].includes(i.phase));
        if (!incident) {
            if (Object.values(s.incidents).filter(i => i.taskId === id).length >= cfg.policy.incidentsPerTask || Object.keys(s.incidents).length >= cfg.policy.incidentsPerRun) {
                suspend(id, f, 'Incident budget exhausted');
                return;
            }
            incident = { id: 'incident_' + hash({ id, sequence: s.sequence }).slice(0, 12), taskId: id, failure: f, fingerprint: fingerprint(f, revision), phase: 'diagnose', rejections: 0, infraRetries: 0 };
            s.incidents[incident.id] = incident;
            ledger.save('incident', { taskId: id });
        }
        const i = incident, tokens = { taskId: id, incidentFile: join(directory, i.id + '.json') };
        atomic(tokens.incidentFile, { ...i, contract: cfg.tasks[id], task: run.tasks[id], runFile: file });
        if (i.phase === 'diagnose') {
            Object.assign(tokens, { model: 'gpt-6-luna', reasoning: 'xhigh' });
            const r = await execute(cfg.commands.diagnose, root, tokens, 'diagnose'), d = marker(r.output, 'DAG_DIAGNOSIS');
            if (r.code !== 0 || !d) {
                suspend(id, f, 'Diagnostic produced no typed diagnosis');
                return;
            }
            i.failure = failure(d.failure);
            i.scope = repairScope(cfg, run, id, d.requestedFiles || []);
            i.nextAction = disposition(i.failure);
            if (!['repair', 'resolve_owner', 'repair_environment'].includes(i.nextAction)) {
                suspend(id, i.failure, i.nextAction);
                return;
            }
            i.phase = 'prepare';
            ledger.save('classified', { taskId: id });
        }
        if (i.phase === 'prepare') {
            i.base ??= git(root, ['rev-parse', `dag/${run.id}`]);
            i.worktree ??= join(directory, i.id);
            ledger.save('prepare-receipt', { taskId: id });
            if (!existsSync(i.worktree))
                git(root, ['worktree', 'add', '--detach', i.worktree, i.base]);
            if (git(i.worktree, ['rev-parse', 'HEAD']) !== i.base)
                throw Error('Prepared worktree identity changed');
            if (cfg.commands.prepare) {
                const r = await execute(cfg.commands.prepare, i.worktree, tokens, 'prepare');
                if (r.code !== 0)
                    throw Object.assign(Error(r.output || 'Dependency preparation failed'), { failure: { version: 1, code: 'environment', stage: 'prepare', owner: id, evidence: [r.output || 'Prepare returned nonzero'] } });
            }
            i.phase = 'repair';
            ledger.save('prepared', { taskId: id });
        }
        const scopeFile = join(directory, i.id + '.scope.json');
        atomic(scopeFile, { files: i.scope, requirements: cfg.tasks[id].requirements });
        tokens.scopeFile = scopeFile;
        if (i.phase === 'repair') {
            i.profile = profileFor(cfg.policy, s.semanticCounts[id] || 0);
            Object.assign(tokens, i.profile);
            ledger.save('repair-attempt', { taskId: id, profile: i.profile });
            const before = git(i.worktree, ['diff', i.base]);
            s.attempts[id] ??= [];
            const attempt = { kind: 'repair', at: Date.now(), profile: i.profile, accepted: false };
            s.attempts[id].push(attempt);
            ledger.save();
            const r = await execute(cfg.commands.repair, i.worktree, tokens, 'repair');
            attempt.elapsedMs = r.elapsedMs;
            attempt.semanticRejected = r.code !== 0 && marker(r.output, 'DAG_FAILURE')?.code === 'implementation';
            ledger.save('repair-command-finished', { taskId: id });
            guardDiff(cfg, id, i.worktree, i.base, i.scope);
            if (r.code !== 0) {
                const request = marker(r.output, 'DAG_SCOPE_REQUEST');
                if (request) {
                    if (!Array.isArray(request.files) || !request.files.length || typeof request.reason !== 'string' || !request.reason.trim() || (i.scopeRevisions || 0) >= cfg.policy.scopeRevisions)
                        throw Error('Invalid or exhausted scope revision request');
                    const expanded = repairScope(cfg, run, id, [...i.scope.filter(path => !cfg.tasks[id].files.some(f => f.path === path)), ...request.files]);
                    if (expanded.every(path => i.scope.includes(path)))
                        throw Error('Scope request made no ownership progress');
                    i.scope = expanded;
                    i.scopeRevisions = (i.scopeRevisions || 0) + 1;
                    ledger.save('scope-authorized', { taskId: id, files: request.files, reason: request.reason });
                    return;
                }
                const packet = marker(r.output, 'DAG_FAILURE');
                const fault = packet ? failure(packet) : { version: 1, code: 'unknown', stage: 'repair', evidence: [r.output || 'Repair exited nonzero'] };
                if (fault.code === 'implementation') {
                    s.semanticCounts[id] = (s.semanticCounts[id] || 0) + 1;
                    i.rejections++;
                    ledger.save('repair-rejected', { taskId: id });
                }
                else
                    suspend(id, fault, disposition(fault));
                return;
            }
            if (git(i.worktree, ['diff', i.base]) === before && !git(i.worktree, ['ls-files', '--others', '--exclude-standard']) && !(i.interruptedRepair && before)) {
                suspend(id, i.failure, 'Repair made no source progress');
                return;
            }
            delete i.interruptedRepair;
            i.phase = 'verify';
            ledger.save('repaired', { taskId: id });
        }
        Object.assign(tokens, i.profile);
        if (i.phase === 'verify') {
            const owners = Object.entries(cfg.tasks).filter(([owner, u]) => owner !== id && u.files.some(f => i.scope.includes(f.path))).map(([, u]) => u);
            i.checkReceipts = [];
            for (const check of [...cfg.tasks[id].checks, ...owners.flatMap(u => u.checks), ...(cfg.tasks[id].inputs || []).map(p => p.check), ...(cfg.commands.integration ? [cfg.commands.integration] : [])]) {
                const r = await checked(check, { cfg, revision, cwd: i.worktree, directory, execute: c => execute(c, i.worktree, tokens, 'verify') });
                i.checkReceipts.push({ command: check, ...r });
                ledger.save('check', { taskId: id });
                if (r.code !== 0) {
                    s.semanticCounts[id] = (s.semanticCounts[id] || 0) + 1;
                    i.rejections++;
                    i.phase = 'repair';
                    ledger.save('check-rejected', { taskId: id });
                    return;
                }
            }
            i.verifiedSource = sourceIdentity(i.worktree, cfg);
            i.phase = 'review';
            ledger.save();
        }
        if (i.phase === 'review') {
            const r = await execute(cfg.commands.review, i.worktree, tokens, 'review');
            i.review = reviewOutcome(r.output, cfg.tasks[id].requirements);
            if (i.verifiedSource && sourceIdentity(i.worktree, cfg) !== i.verifiedSource) {
                suspend(id, { version: 1, code: 'review_dispute', stage: 'review', evidence: ['Reviewer changed verified sources'] }, 'Reviewer changed verified sources');
                return;
            }
            if (r.code !== 0 || i.review.verdict === 'inconclusive') {
                suspend(id, { version: 1, code: 'review_dispute', stage: 'review', evidence: [r.output] }, 'Review requires adjudication');
                return;
            }
            if (i.review.verdict === 'fail') {
                s.semanticCounts[id] = (s.semanticCounts[id] || 0) + 1;
                i.rejections++;
                i.phase = 'repair';
                ledger.save('review-rejected', { taskId: id });
                return;
            }
            guardDiff(cfg, id, i.worktree, i.base, i.scope);
            i.phase = 'commit';
            ledger.save('review-accepted', { taskId: id });
        }
        if (i.phase === 'commit') {
            const head = git(i.worktree, ['rev-parse', 'HEAD']);
            if (head === i.base) {
                guardDiff(cfg, id, i.worktree, i.base, i.scope);
                git(i.worktree, ['add', '--', ...i.scope]);
                git(i.worktree, ['-c', 'user.name=DAG Reliability', '-c', 'user.email=dag@localhost', 'commit', '-m', `Reliability repair ${i.id}`]);
            }
            else if (git(i.worktree, ['log', '-1', '--format=%s']) !== `Reliability repair ${i.id}` || git(i.worktree, ['rev-parse', 'HEAD^']) !== i.base)
                throw Error('Unexpected commit during recovery');
            i.receipt = { base: i.base, commit: git(i.worktree, ['rev-parse', 'HEAD']) };
            i.phase = 'publish';
            ledger.save('publication-receipt', { taskId: id });
        }
        if (i.phase === 'publish') {
            const head = git(root, ['rev-parse', `dag/${run.id}`]);
            if (head !== i.receipt.commit) {
                if (head !== i.receipt.base) {
                    suspend(id, i.failure, 'Integration changed; repair needs new validation');
                    return;
                }
                const entries = git(root, ['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/);
                const entry = entries.find(e => e.includes(`branch refs/heads/dag/${run.id}`));
                if (entry) {
                    const cwd = entry.split(/\r?\n/)[0].slice(9);
                    if (git(cwd, ['status', '--porcelain']))
                        throw Error('Integration worktree is dirty');
                    git(cwd, ['merge', '--ff-only', i.receipt.commit]);
                }
                else
                    git(root, ['update-ref', `refs/heads/dag/${run.id}`, i.receipt.commit, i.receipt.base]);
            }
            i.phase = 'published';
            ledger.save('published', { taskId: id });
        }
        if (i.phase === 'published') {
            run = loadRun(file);
            if (run.tasks[id].status === 'failed') {
                const r = await dag(['retry', '--id', id, '--cascade']);
                if (r.code !== 0)
                    throw Error(r.output);
            }
            i.phase = 'requeued';
            ledger.save('requeued', { taskId: id });
        }
    }
    try {
        assertNoForeignLock(file);
        if (s.active?.receipt?.owners) {
            if (s.active.stage === 'repair')
                for (const i of Object.values(s.incidents))
                    if (i.taskId === s.active.taskId)
                        i.interruptedRepair = true;
            terminateOwned(s.active.receipt.owners);
            s.active = null;
            ledger.save('owned-stage-reaped');
        }
        if (Object.values(run.tasks).some(t => t.status === 'running')) {
            const r = await dag(['resume']);
            if (r.code !== 0)
                throw Error(r.output);
            run = loadRun(file);
        }
        if (action === 'resume' && cfg.commands.availability)
            for (const [id, entry] of Object.entries(s.suspended))
                if (['quota', 'authentication', 'model_unavailable'].includes(entry.failure.code)) {
                    const r = await execute(cfg.commands.availability, root, { taskId: id }, 'availability');
                    if (r.code === 0) {
                        delete s.suspended[id];
                        ledger.save('provider-restored', { taskId: id });
                    }
                }
        ledger.save('controller-start');
        ensureIntegrationWorktree(root, run.id, undefined, snapshotExcludes(file, root));
        for (let rounds = 0; rounds < 10000 && Date.now() < s.deadline; rounds++) {
            if (hash(readFileSync(context.path, 'utf8')) !== revision)
                throw Error('Reliability configuration changed during execution');
            run = loadRun(file);
            if (graphIdentity(run) !== s.graphRevision)
                throw Error('Task contracts changed; stopped amendment required');
            for (const i of Object.values(s.incidents))
                if (i.phase === 'requeued' && run.tasks[i.taskId].status === 'completed') {
                    i.phase = 'resolved';
                    ledger.save('resolved', { taskId: i.taskId });
                }
            let repaired = false;
            for (const t of Object.values(run.tasks))
                if (t.status === 'failed' && !s.suspended[t.id]) {
                    const existing = Object.values(s.incidents).find(i => i.taskId === t.id && i.phase === 'requeued');
                    if (existing) {
                        existing.phase = 'diagnose';
                        existing.failure = taskFailure(t);
                        delete existing.base;
                        delete existing.receipt;
                        delete existing.verifiedSource;
                        existing.worktree = join(directory, existing.id + '-round-' + s.sequence);
                        ledger.save('fresh-task-rejected', { taskId: t.id });
                    }
                    try {
                        await recover(t.id, taskFailure(t));
                    }
                    catch (e) {
                        const fault = e.failure || { version: 1, code: 'contract', stage: 'recovery', owner: t.id, evidence: [e.message] };
                        if (fault.code === 'environment' && (s.infrastructureCounts[t.id] || 0) < cfg.policy.infraRetries) {
                            s.infrastructureCounts[t.id] = (s.infrastructureCounts[t.id] || 0) + 1;
                            ledger.save('infrastructure-retry', { taskId: t.id });
                        }
                        else
                            suspend(t.id, fault, disposition(fault));
                    }
                    repaired = true;
                }
            for (const i of Object.values(s.incidents))
                if (!['resolved', 'requeued', 'exhausted'].includes(i.phase) && run.tasks[i.taskId].status !== 'failed' && !s.suspended[i.taskId]) {
                    try {
                        await recover(i.taskId, i.failure);
                        repaired = true;
                    }
                    catch (e) {
                        suspend(i.taskId, e.failure || { version: 1, code: 'contract', stage: 'recovery', evidence: [e.message] }, e.message);
                    }
                }
            const suspended = new Set(Object.keys(s.suspended));
            for (const id of Object.keys(run.tasks))
                if ([...suspended].some(dep => run.tasks[id].deps.includes(dep)))
                    suspended.add(id);
            const batch = chooseBatch(cfg, run, suspended);
            if (!batch.length) {
                if (repaired && !Object.keys(s.suspended).length)
                    continue;
                break;
            }
            const failedProbes = new Set();
            for (const id of batch) {
                for (const p of cfg.tasks[id].inputs || []) {
                    const branch = git(root, ['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/).find(e => e.includes(`branch refs/heads/dag/${run.id}`));
                    const cwd = branch ? branch.split(/\r?\n/)[0].slice(9) : root;
                    const r = await execute(p.check, cwd, { taskId: id }, 'preflight');
                    if (r.code !== 0) {
                        failedProbes.add(id);
                        try {
                            await recover(id, { version: 1, code: 'ownership', stage: 'preflight', owner: p.owner, test: p.contract, evidence: [r.output || 'Consumed input probe failed'] });
                        }
                        catch (e) {
                            suspend(id, e.failure || { version: 1, code: 'contract', stage: 'preflight', evidence: [e.message] }, e.message);
                        }
                    }
                }
            }
            const launch = batch.filter(id => !s.suspended[id] && !failedProbes.has(id));
            if (!launch.length)
                continue;
            const at = Date.now(), beforeAttempts = Object.fromEntries(launch.map(id => [id, run.tasks[id].attempts]));
            for (const id of launch) {
                s.attempts[id] ??= [];
                s.attempts[id].push({ at, profile: profileFor(cfg.policy, s.semanticCounts[id] || 0) });
            }
            ledger.save('dispatch', { tasks: launch });
            let engine;
            try {
                engine = await dag(['run', '--only', launch.join(','), '--worktree', 'task', '--concurrency', String(launch.length), '--reliability-config', context.path]);
            }
            catch (e) {
                engine = { code: 1, output: e.message };
            }
            run = loadRun(file);
            if (engine.code !== 0)
                for (const id of launch)
                    if (run.tasks[id].attempts === beforeAttempts[id] || run.tasks[id].status === 'running') {
                        s.infrastructureCounts[id] = (s.infrastructureCounts[id] || 0) + 1;
                        if (s.infrastructureCounts[id] > cfg.policy.infraRetries)
                            suspend(id, { version: 1, code: 'environment', stage: 'engine', evidence: [engine.output || 'Engine produced no terminal task outcome'] }, 'Engine infrastructure budget exhausted');
                    }
            if (Object.values(run.tasks).some(t => t.status === 'running'))
                await dag(['resume']);
            run = loadRun(file);
            for (const id of launch) {
                const a = s.attempts[id].at(-1);
                a.elapsedMs = (Date.now() - at) / launch.length;
                a.accepted = run.tasks[id].status === 'completed';
                a.semanticRejected = run.tasks[id].status === 'failed' && taskFailure(run.tasks[id]).code === 'implementation';
                if (a.semanticRejected)
                    s.semanticCounts[id] = (s.semanticCounts[id] || 0) + 1;
            }
            ledger.save('batch-finished');
        }
        s.stopReason = Date.now() >= s.deadline ? 'wall_budget_exhausted' : Object.keys(s.suspended).length ? 'suspended' : 'converged_or_waiting';
        ledger.save('controller-stop', { reason: s.stopReason });
        return report(ledger, loadRun(file));
    }
    finally {
        release();
    }
}
