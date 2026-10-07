import { hash } from './contracts.mjs';
export const CODES = ['implementation', 'ownership', 'contract', 'environment', 'quota', 'authentication', 'model_unavailable', 'review_dispute', 'unknown', 'user_stop', 'budget'];
export function failure(value) {
    if (!value || value.version !== 1 || !CODES.includes(value.code) || typeof value.stage !== 'string' || !value.stage || !Array.isArray(value.evidence) || !value.evidence.length || value.evidence.some(x => typeof x !== 'string' || !x))
        throw new Error('Invalid typed failure');
    for (const key of ['owner', 'test', 'requirement'])
        if (value[key] !== undefined && typeof value[key] !== 'string')
            throw new Error(`Invalid failure ${key}`);
    return value;
}
export function marker(output, name) {
    const lines = String(output).split(/\r?\n/).filter(line => line.startsWith(name + ': '));
    return lines.length ? JSON.parse(lines.at(-1).slice(name.length + 2)) : null;
}
export function taskFailure(task) {
    const packet = marker(task.result || '', 'DAG_FAILURE');
    if (packet)
        return failure(packet);
    const code = ['killed', 'manual'].includes(task.failureKind) ? 'user_stop' : ['spawn', 'timeout', 'stalled', 'setup', 'worktree', 'interrupted'].includes(task.failureKind) ? 'environment' : task.failureKind === 'review' ? 'implementation' : 'unknown';
    return failure({ version: 1, code, stage: task.failureKind || 'work', owner: task.id, evidence: [task.result || 'No structured outcome supplied'], legacy: true });
}
export function fingerprint(f, revision) { return hash({ code: f.code, stage: f.stage, owner: f.owner || null, test: f.test || null, requirement: f.requirement || null, revision }); }
export function disposition(f) {
    return ({ implementation: 'repair', ownership: 'resolve_owner', contract: 'suspend_decision', environment: 'repair_environment', quota: 'suspend_provider', authentication: 'suspend_provider', model_unavailable: 'suspend_provider', review_dispute: 'adjudicate', unknown: 'diagnose', user_stop: 'suspend_operator', budget: 'exhausted' })[f.code];
}
export function validateReview(value, requirements) {
    if (!value || !['pass', 'fail', 'inconclusive'].includes(value.verdict) || !Array.isArray(value.findings))
        throw new Error('Missing structured independent review');
    for (const f of value.findings) {
        if (!['blocker', 'uncertain', 'suggestion'].includes(f.severity) || typeof f.reason !== 'string' || !f.reason)
            throw new Error('Invalid review finding');
        if (f.severity === 'blocker' && (!requirements.includes(f.requirement) || !Array.isArray(f.evidence) || !f.evidence.length || !f.evidence.every(x => typeof x === 'string' && x.trim()) || !f.test && !f.codePath))
            throw new Error('Review blocker needs accepted requirement, evidence and reproduction/code path');
    }
    if (value.verdict === 'pass' && value.findings.some(f => f.severity !== 'suggestion'))
        throw new Error('Review pass contradicts unresolved findings');
    if (value.verdict === 'fail' && !value.findings.some(f => f.severity === 'blocker'))
        throw new Error('Review rejection has no grounded blocker');
    return value;
}
export function profileFor(policy, rejections) {
    let count = rejections;
    for (const { attempts, ...profile } of policy.workers) {
        if (count < attempts)
            return profile;
        count -= attempts;
    }
    throw Object.assign(new Error('Authorized model attempts exhausted'), { failure: { version: 1, code: 'budget', stage: 'routing', evidence: ['Configured model ladder exhausted; Astra is not authorized'] } });
}
export function lessonCandidate(incident) {
    return { version: 1, status: 'candidate', fingerprint: incident.fingerprint, cause: incident.failure, regression: incident.regression || null, evidence: incident.receipt ? { commit: incident.receipt.commit, review: incident.review, checks: incident.checkReceipts } : null, promotionAllowed: false, reason: 'Requires demonstrated correction, controls and a separate applicability review; never auto-install a skill' };
}
export function reviewOutcome(output, requirements) {
    try {
        return validateReview(marker(output, 'DAG_REVIEW'), requirements);
    }
    catch (error) {
        throw Object.assign(error, { failure: { version: 1, code: 'review_dispute', stage: 'review', evidence: [error.message] } });
    }
}
