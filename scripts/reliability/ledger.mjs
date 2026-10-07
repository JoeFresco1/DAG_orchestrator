import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { identity, sameProcess } from './process.mjs';
export function atomic(path, value) { const temp = path + '.' + randomUUID() + '.tmp', fd = openSync(temp, 'wx'); try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
}
finally {
    closeSync(fd);
} renameSync(temp, path); }
export function openLedger(directory, runId, revision, policy) {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'controller.json');
    const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, runId, revision, sequence: 0, createdAt: Date.now(), deadline: Date.now() + policy.wallMs, incidents: {}, suspended: {}, attempts: {}, checks: {}, metrics: { manualInterventions: 0, costUsd: null }, history: [] };
    if (state.runId !== runId || state.revision !== revision)
        throw new Error('Controller identity/contract changed; explicit stopped amendment required');
    const save = (event, details = {}) => { state.sequence++; state.updatedAt = Date.now(); if (event) {
        const entry = { sequence: state.sequence, at: state.updatedAt, event, ...details };
        state.history.push(entry);
        appendFileSync(join(directory, 'events.jsonl'), JSON.stringify(entry) + '\n');
    } atomic(path, state); };
    return { state, save, directory, path };
}
export function lease(directory) {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'controller.lock'), token = randomUUID(), owner = identity(process.pid);
    if (!owner)
        throw new Error('Cannot establish controller identity');
    for (let n = 0; n < 2; n++)
        try {
            writeFileSync(path, JSON.stringify({ token, owner }), { flag: 'wx' });
            return () => { if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).token === token)
                unlinkSync(path); };
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
            const prior = JSON.parse(readFileSync(path, 'utf8'));
            if (sameProcess(prior.owner))
                throw new Error('Another verified controller owns this run');
            unlinkSync(path);
        }
    throw new Error('Controller lease race; retry safely');
}
export function report(ledger, run) {
    const incidents = Object.values(ledger.state.incidents), attempts = Object.values(ledger.state.attempts).flat();
    const completed = Object.values(run.tasks).filter(t => t.status === 'completed');
    return { version: 1, runId: run.id, stage: ledger.state.active?.stage || 'idle', active: ledger.state.active || null, lastMeaningfulProgress: ledger.state.lastMeaningfulProgress || null, deadline: ledger.state.deadline, remainingWallMs: Math.max(0, ledger.state.deadline - Date.now()), completed: completed.length, total: Object.keys(run.tasks).length, unfinished: Object.values(run.tasks).filter(t => !['completed', 'skipped'].includes(t.status)).length, stopReason: ledger.state.stopReason || null, suspended: ledger.state.suspended, incidents: incidents.map(i => ({ id: i.id, taskId: i.taskId, phase: i.phase, fingerprint: i.fingerprint, owner: i.failure.owner, nextAction: i.nextAction, profile: i.profile, remainingAttempts: i.remainingAttempts, reason: i.reason })), metrics: { ...ledger.state.metrics, uniqueIncidents: incidents.length, automaticallyResolved: incidents.filter(i => i.phase === 'resolved').length, semanticRejections: Object.values(ledger.state.semanticCounts || {}).reduce((a, b) => a + b, 0), infrastructureRetries: Object.values(ledger.state.infrastructureCounts || {}).reduce((a, b) => a + b, 0), firstAttemptAccepted: Object.values(ledger.state.attempts).filter(a => a.length === 1 && a[0].accepted).length, acceptedPerWorkerHour: attempts.reduce((n, a) => n + (a.elapsedMs || 0), 0) ? attempts.filter(a => a.accepted).length / (attempts.reduce((n, a) => n + (a.elapsedMs || 0), 0) / 3600000) : null } };
}
