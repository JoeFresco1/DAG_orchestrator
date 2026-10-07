import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { loadConfig, makeTaskGuard, hash, git, sourceIdentity } from './contracts.mjs';
import { runCommand, sameProcess } from './process.mjs';
import { reviewOutcome, profileFor } from './protocol.mjs';
import { atomic } from './ledger.mjs';
import { runPaths } from '../../dist/store.js';
import { checked } from './checks.mjs';
export async function runnerHooks(path, run, file) {
    const context = loadConfig(path), { cfg } = context, dir = join(runPaths(resolve(file)).dir, 'reliability');
    const ledger = JSON.parse(readFileSync(join(dir, 'controller.json'), 'utf8'));
    const owner = JSON.parse(readFileSync(join(dir, 'controller.lock'), 'utf8')).owner;
    if (owner.pid !== process.ppid || !sameProcess(owner))
        throw Error('Managed engine must be launched by the verified controller');
    if (ledger.revision !== context.revision || ledger.runId !== run.id)
        throw Error('Controller receipt does not match this run');
    const profiles = {};
    const tokens = task => { profiles[task.id] ??= profileFor(cfg.policy, ledger.semanticCounts?.[task.id] || 0); return { taskId: task.id, spec: task.spec, model: profiles[task.id].model, reasoning: profiles[task.id].reasoning }; };
    const render = (c, task) => [c.program, ...c.args].map(s => JSON.stringify(s.replace(/\{(taskId|model|reasoning)\}/g, (_, key) => tokens(task)[key]))).join(' ');
    return { controllerManaged: true, contractGuard: makeTaskGuard(context),
        timeoutFor: task => Math.max(1, Math.min(task.timeoutMs ?? run.settings.timeoutMs ?? 900000, cfg.commands.work?.timeoutMs ?? 900000, ledger.deadline-Date.now())),
        ...(cfg.commands.work ? { workCommand: task => render(cfg.commands.work, task) } : {}),
        ...(cfg.commands.prepare ? { prepareCommand: task => render(cfg.commands.prepare, task) } : {}),
        postcondition: async (task, cwd, base) => {
            const receipts = [];
            for (const check of [...cfg.tasks[task.id].checks, ...(cfg.commands.integration ? [cfg.commands.integration] : [])]) {
                const r = await checked(check, { cfg, revision: context.revision, cwd, directory: dir, execute: c => runCommand(c, { cwd, deadline: ledger.deadline, tokens: tokens(task) }) });
                receipts.push({ command: check, ...r });
                if (r.code !== 0)
                    throw Object.assign(Error('DAG_FAILURE: ' + JSON.stringify({ version: 1, code: 'implementation', stage: 'validation', owner: task.id, test: check.program, evidence: [r.output || 'Check returned nonzero'] })), { kind: 'review' });
            }
            const verifiedSource = sourceIdentity(cwd, cfg);
            const review = await runCommand(cfg.commands.review, { cwd, deadline: ledger.deadline, tokens: tokens(task), env: { DAG_TASK: task.id, DAG_MODEL: profiles[task.id].model, DAG_REASONING: profiles[task.id].reasoning } });
            if (sourceIdentity(cwd, cfg) !== verifiedSource)
                throw Object.assign(Error('DAG_FAILURE: ' + JSON.stringify({ version: 1, code: 'review_dispute', stage: 'review', owner: task.id, evidence: ['Reviewer changed verified sources'] })), { kind: 'review' });
            let verdict;
            try { verdict = reviewOutcome(review.output, cfg.tasks[task.id].requirements); }
            catch(error) {throw Object.assign(Error('DAG_FAILURE: '+JSON.stringify(error.failure)),{kind:'review'});}
            if (review.code !== 0 || verdict.verdict !== 'pass')
                throw Object.assign(Error('DAG_FAILURE: ' + JSON.stringify({ version: 1, code: verdict.verdict === 'fail' ? 'implementation' : 'review_dispute', stage: 'review', owner: task.id, evidence: [JSON.stringify(verdict)] })), { kind: 'review' });
            mkdirSync(join(dir, 'receipts'), { recursive: true });
            atomic(join(dir, 'receipts', task.id + '.json'), { taskId: task.id, base, revision: context.revision, profile: profiles[task.id], checks: receipts, review: verdict, tree: hash(git(cwd, ['diff', base])), at: Date.now() });
        } };
}
