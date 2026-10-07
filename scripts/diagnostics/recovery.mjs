import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { rejectedWorkAttemptIds, validateDiagnosis } from './core.mjs';

/** Terminal infrastructure failures must not wait for semantic rejection counts. */
export function recoveryTrigger(task, events, taskId, every = 3) {
  if (task.status !== 'failed') return null;
  const result = String(task.result ?? '');
  if (/usage limit|rate limit|quota|authentication|unauthorized|model.*unavailable/i.test(result)) return null;
  const attempt = task.attempts;
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  const kind = task.failureKind;
  const rejected = rejectedWorkAttemptIds(events, taskId);
  const reason = /BUILD_DIAGNOSTIC_HOLD/.test(result) ? 'controller_hold'
    : ['timeout', 'stalled', 'spawn', 'worktree'].includes(kind) ? 'infrastructure'
    : rejected.length >= every ? 'repeated_rejection' : null;
  return reason ? { reason, rejectedAttempts: rejected, terminalFailure: { attempt, kind, result } } : null;
}

function save(path, record) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record, null, 2)); renameSync(temp, path);
}

/**
 * Controller-owned recovery, after runner shutdown. Hooks contain project authority;
 * diagnostic output never grants file scope or changes acceptance. Publication and
 * requeue are separate: neither a model response nor green tests approve a task.
 */
export async function recoverIncident({ directory, incident, policy, hooks }) {
  for (const key of ['runId', 'taskId']) if (!/^[A-Za-z0-9_-]+$/.test(incident[key] ?? '')) throw new Error('Invalid recovery identity');
  if (!incident.contractRevision || !incident.trigger?.terminalFailure) throw new Error('Recovery must bind an exact contract and failure');
  const limits = { maxPerTask: 2, maxPerRun: 6, maxAttempts: 10, wallMs: 2 * 60 * 60 * 1000, ...policy };
  for (const key of ['maxPerTask', 'maxPerRun', 'maxAttempts', 'wallMs']) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new Error('Invalid recovery budget');
  mkdirSync(directory, { recursive: true });
  const key = createHash('sha256').update(JSON.stringify(incident)).digest('hex');
  const path = join(directory, `${key}.json`), mutex = join(directory, 'controller.lock');
  try { writeFileSync(mutex, JSON.stringify({ pid: process.pid, incident: key }), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(readFileSync(mutex, 'utf8'));
    let alive = false; try { process.kill(previous.pid, 0); alive = true; } catch {}
    if (alive) throw new Error('Another recovery controller is active');
    unlinkSync(mutex); writeFileSync(mutex, JSON.stringify({ pid: process.pid, incident: key }), { flag: 'wx' });
  }
  let record;
  const persist = phase => { record.phase = phase; record.updatedAt = new Date().toISOString(); save(path, record); hooks.onProgress?.(record); };
  try {
    await hooks.assertStopped();
    if (existsSync(path)) {
      record = JSON.parse(readFileSync(path, 'utf8'));
      if (record.phase === 'completed') return record;
      if (record.phase === 'publishing' && hooks.recoverPublication) {
        record.receipt = await hooks.recoverPublication(record);
        if (record.receipt) persist('published');
      }
      if (record.phase === 'published') {
        await hooks.assertPublished(record.receipt);
        await hooks.requeue(record.receipt);
        persist('completed'); return record;
      }
      return { ...record, blocked: 'Recovery already attempted; interrupted or rejected incident is not replayed blindly' };
    }
    const history = readdirSync(directory).filter(p => /^[a-f0-9]{64}\.json$/.test(p)).map(p => JSON.parse(readFileSync(join(directory, p), 'utf8')));
    if (history.filter(r => r.incident.runId === incident.runId).length >= limits.maxPerRun
      || history.filter(r => r.incident.runId === incident.runId && r.incident.taskId === incident.taskId).length >= limits.maxPerTask) return { phase: 'blocked', blocked: 'Recovery incident budget exhausted' };
    record = { key, incident, phase: 'reserved', startedAt: new Date().toISOString(), attempts: [] }; persist('reserved');
    const deadline = Date.now() + limits.wallMs;
    const timeLeft = () => { const left = deadline - Date.now(); if (left <= 0) throw new Error('Recovery wall budget exhausted'); return left; };
    persist('diagnosing');
    record.diagnosis = validateDiagnosis(await hooks.diagnose(Math.min(timeLeft(), 300000))); persist('diagnosed');
    // Unknown causes cannot authorize a speculative controller rewrite.
    if (record.diagnosis.category === 'unknown' || record.diagnosis.category === 'resource') {
      record.blocked = 'Unresolved cause or resource authority requires explicit intervention'; persist('blocked'); return record;
    }
    let scope = await hooks.authorize(record.diagnosis);
    if (!scope || !Array.isArray(scope.files) || !scope.files.length || !Array.isArray(scope.acceptance) || !scope.acceptance.length) throw new Error('No trusted repair scope and executable acceptance');
    record.scope = scope; persist('authorized');
    if (!Array.isArray(limits.workers) || limits.workers.some(p => !Number.isSafeInteger(p.attempts) || p.attempts < 1 || p.attempts > 10)) throw new Error('Invalid recovery model attempt counts');
    const profiles = limits.workers.flatMap(({ attempts, ...profile }) => Array.from({ length: attempts }, () => profile)).slice(0, limits.maxAttempts);
    if (!profiles.length || profiles.some(p => !p.model || !p.variant || p.model.includes('astra'))) throw new Error('Invalid or unauthorized recovery model ladder');
    let feedback = '', accepted = false;
    for (const profile of profiles) {
      if (limits.unavailableModels?.[profile.model]) throw new Error(`Recovery model unavailable: ${profile.model}`);
      const attempt = { number: record.attempts.length + 1, profile, startedAt: new Date().toISOString() };
      record.attempts.push(attempt); persist('repairing');
      try {
        await hooks.repair({ diagnosis: record.diagnosis, scope, profile, feedback, timeoutMs: Math.min(timeLeft(), 900000) });
        persist('validating'); await hooks.validate(scope);
        persist('verifying'); await hooks.verify(scope, Math.min(timeLeft(), 900000));
        persist('reviewing'); await hooks.review({ diagnosis: record.diagnosis, scope, profile, timeoutMs: Math.min(timeLeft(), 600000) });
        // Review and acceptance commands cannot mutate protected files behind the guard.
        await hooks.validate(scope); attempt.status = 'verified'; accepted = true; persist('verified'); break;
      } catch (error) {
        attempt.status = 'rejected'; attempt.error = feedback = error.message; persist('repair_rejected');
        if (/usage limit|quota|rate limit|authentication|unavailable/i.test(feedback)) throw error;
        if (error.code === 'RECOVERY_SCOPE_REQUIRED') {
          if (!hooks.reauthorize || (record.scopeRevisions?.length || 0) >= 2) throw new Error('Repair ownership remains unresolved; unchanged retries forbidden');
          const originalFiles=[...scope.files], originalAcceptance=JSON.stringify(scope.acceptance);
          const revised = await hooks.reauthorize({scope, request:error.scopeRequest, diagnosis:record.diagnosis});
          if (!revised || !Array.isArray(revised.files) || !revised.files.length ||
              !Array.isArray(revised.acceptance) || !revised.acceptance.length ||
              originalFiles.some(file => !revised.files.includes(file)) ||
              !revised.files.some(file => !originalFiles.includes(file)) ||
              JSON.stringify(revised.acceptance) !== originalAcceptance) {
            throw new Error('Trusted owner resolution did not expand scope while retaining acceptance');
          }
          record.scopeRevisions ??= [];
          record.scopeRevisions.push({attempt:attempt.number,request:error.scopeRequest,files:revised.files});
          scope = record.scope = revised; persist('reauthorized');
        }
      }
    }
    if (!accepted) { record.blocked = 'Bounded coordinator repair attempts exhausted'; persist('blocked'); return record; }
    timeLeft(); await hooks.assertStopped();
    persist('publishing'); record.receipt = await hooks.publish(scope, record); persist('published');
    await hooks.requeue(record.receipt); persist('completed'); return record;
  } catch (error) {
    if (record && record.phase !== 'published') { record.error = error.message; persist('blocked'); }
    throw error;
  } finally {
    const owned = JSON.parse(readFileSync(mutex, 'utf8'));
    if (owned.pid === process.pid) unlinkSync(mutex);
  }
}
