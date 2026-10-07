import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverIncident, recoveryTrigger } from './recovery.mjs';
import { diagnoseBeforeWork } from './core.mjs';
const diagnosis = { category:'contract_or_ownership',cause:'cwd is not the controller output boundary',evidence:['production staging uses separate cwd/outputRoot'],action:'hold',repair:'Pass independently validated output authority',verification:['existing stage and calculator controls'] };
function fixture() {
  const calls=[]; const f={directory:mkdtempSync(join(tmpdir(),'dag-recovery-')),incident:{runId:'run_test',taskId:'task_test',contractRevision:'v1',trigger:{reason:'controller_hold',terminalFailure:{attempt:4,kind:'exit',result:'BUILD_DIAGNOSTIC_HOLD'}}},policy:{workers:[{harness:'codex',model:'gpt-6-luna',variant:'xhigh',attempts:3},{harness:'codex',model:'gpt-6.1-sol',variant:'medium',attempts:3},{harness:'codex',model:'gpt-6.1-sol',variant:'xhigh',attempts:4}]},hooks:{}};
  for(const name of ['assertStopped','validate','verify','review','assertPublished','requeue'])f.hooks[name]=async()=>{calls.push(name);};
  f.hooks.diagnose=async()=>{calls.push('diagnose');return diagnosis;};
  f.hooks.authorize=async()=>{calls.push('authorize');return {files:['src/stages.ts'],acceptance:[{program:'node',args:['stage.test.js']}]};};
  f.hooks.repair=async()=>{calls.push('repair');};
  f.hooks.publish=async()=>{calls.push('publish');return {commit:'verified_commit'};};
  return {f,calls};
}
test('first timeout/stall/spawn triggers diagnosis; quota, user stop and unfailed tasks do not',()=>{
  for(const failureKind of ['timeout','stalled','spawn'])assert.equal(recoveryTrigger({status:'failed',attempts:1,failureKind,result:'worker failure'},[],'task_test').reason,'infrastructure');
  for(const failureKind of ['killed','interrupted','exit'])assert.equal(recoveryTrigger({status:'failed',attempts:1,failureKind,result:'worker failure'},[],'task_test'),null);
  assert.equal(recoveryTrigger({status:'failed',attempts:1,failureKind:'timeout',result:'usage limit'},[],'task_test'),null);
  assert.equal(recoveryTrigger({status:'completed',attempts:1,failureKind:'timeout'},[],'task_test'),null);
  assert.equal(recoveryTrigger({status:'failed',attempts:4,failureKind:'exit',result:'BUILD_DIAGNOSTIC_HOLD'},[],'task_test').reason,'controller_hold');
});
test('terminal diagnostic bypasses three semantic rejections and returns a hold only to the controller',async()=>{
  const {f}=fixture(); let launches=0;
  const input={controllerRoot:f.directory,cwd:process.cwd(),recordRoot:join(f.directory,'diagnosis'),runId:'run_test',taskId:'task_test',unit:{files:['src/a.ts']},events:[],rejectedAttempts:[],contractRevision:'v1',terminalFailure:{attempt:1,kind:'timeout',result:'review timeout'},policy:{diagnostics:{enabled:true}},launch:async()=>{launches++;return diagnosis;}};
  await assert.rejects(diagnoseBeforeWork(input),/DIAGNOSTIC_HOLD/);
  assert.equal((await diagnoseBeforeWork({...input,allowHold:true})).diagnosis.category,'contract_or_ownership'); assert.equal(launches,1);
});
test('a controller hold repairs, checks, independently reviews, publishes and requeues exactly once',async()=>{
  const {f,calls}=fixture();const result=await recoverIncident(f); assert.equal(result.phase,'completed');
  assert.deepEqual(calls,['assertStopped','diagnose','authorize','repair','validate','verify','review','validate','assertStopped','publish','requeue']);
  await recoverIncident(f);assert.equal(calls.filter(c=>c==='repair').length,1);assert.equal(calls.filter(c=>c==='requeue').length,1);
});
test('out-of-scope edits cannot publish even with green checks and model claims',async()=>{
  const {f,calls}=fixture(); f.policy.maxAttempts=2;f.hooks.validate=async()=>{throw new Error('immutable acceptance changed');};
  const result=await recoverIncident(f);assert.equal(result.phase,'blocked');assert.equal(result.attempts.length,2);assert.ok(!calls.includes('publish'));assert.ok(!calls.includes('requeue'));assert.ok(!calls.includes('verify'));
  await recoverIncident(f);assert.equal(calls.filter(c=>c==='repair').length,2);
});
test('failed verifier or reviewer consumes bounded attempts without publication',async()=>{
  for(const hook of ['verify','review']){const {f,calls}=fixture();f.policy.maxAttempts=2;f.hooks[hook]=async()=>{throw new Error('actual acceptance rejected');};const r=await recoverIncident(f);assert.equal(r.phase,'blocked');assert.equal(r.attempts.length,2);assert.ok(!calls.includes('publish'));}
});
test('recovery follows three Luna attempts before Sol medium; quota stops without escalation',async()=>{
  const {f}=fixture(); const profiles=[];f.hooks.repair=async({profile})=>{profiles.push(profile.model);if(profiles.length<=3)throw new Error('implementation still wrong');};
  assert.equal((await recoverIncident(f)).phase,'completed');assert.deepEqual(profiles,['gpt-6-luna','gpt-6-luna','gpt-6-luna','gpt-6.1-sol']);
  const other=fixture();other.f.hooks.repair=async()=>{throw new Error('usage limit');};await assert.rejects(recoverIncident(other.f),/usage limit/);assert.ok(!other.calls.includes('publish'));
});
test('interrupted published recovery resumes requeue without rerunning diagnosis or repair',async()=>{
  const {f,calls}=fixture();let fail=true;f.hooks.requeue=async()=>{calls.push('requeue');if(fail)throw new Error('temporary CLI lock');};
  await assert.rejects(recoverIncident(f),/temporary CLI lock/);const file=readdirSync(f.directory).find(p=>p.endsWith('.json'));assert.equal(JSON.parse(readFileSync(join(f.directory,file))).phase,'published');
  fail=false;assert.equal((await recoverIncident(f)).phase,'completed');assert.equal(calls.filter(c=>c==='repair').length,1);assert.equal(calls.filter(c=>c==='publish').length,1);assert.ok(calls.includes('assertPublished'));
});
test('live runner refusal and unknown cause never mutate or requeue',async()=>{
  const {f,calls}=fixture();f.hooks.assertStopped=async()=>{throw new Error('live runner');};await assert.rejects(recoverIncident(f),/live runner/);assert.ok(!calls.includes('repair'));
  const other=fixture();other.f.hooks.diagnose=async()=>({...diagnosis,category:'unknown'});assert.equal((await recoverIncident(other.f)).phase,'blocked');assert.ok(!other.calls.includes('repair'));
});
test('changed failure identities are capped per task across controller restarts',async()=>{
  const {f,calls}=fixture();f.policy.maxPerTask=1;await recoverIncident(f);f.incident={...f.incident,contractRevision:'v2'};assert.equal((await recoverIncident(f)).phase,'blocked');assert.equal(calls.filter(c=>c==='repair').length,1);
});

test('crash between publication and recorded receipt recovers only a controller-verified receipt',async()=>{
 const {f,calls}=fixture();const original=f.hooks.publish;let receipt;
 f.hooks.publish=async(...args)=>{receipt=await original(...args);throw new Error('publication interrupted');};
 await assert.rejects(recoverIncident(f),/publication interrupted/);
 // Simulate abrupt process death before catch could persist a blocked outcome.
 const path=join(f.directory,readdirSync(f.directory).find(p=>p.endsWith('.json')));
 const record=JSON.parse(readFileSync(path));record.phase='publishing';writeFileSync(path,JSON.stringify(record));
 f.hooks.recoverPublication=async()=>receipt;
 assert.equal((await recoverIncident(f)).phase,'completed');assert.equal(calls.filter(c=>c==='publish').length,1);assert.equal(calls.filter(c=>c==='repair').length,1);
});
