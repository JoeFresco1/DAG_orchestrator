import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DagRunner, shellExecutor, type Executor } from '../runner.js';
import { gitRepo } from '../test-helpers.js';
import { git } from '../git-worktree.js';
import { loadRun, saveRun } from '../store.js';
import { compileFlowPlan } from './graph.js';
import type { FlowNode } from './contracts.js';

const composed = 'node composed.mjs';
const checkout = `export function checkout(qty,stock){if(!Number.isInteger(qty)||qty<1)throw Error('quantity');if(qty>stock)throw Error('stock');return {total:qty*90,remaining:stock-qty};}\n`;
const receipt = `import {checkout} from './checkout.mjs';export function receipt(qty,stock){return 'total:'+checkout(qty,stock).total;}\n`;
const localTest = `import test from 'node:test';import assert from 'node:assert/strict';import {checkout} from './checkout.mjs';
test('checkout calculates total and remaining stock',()=>assert.deepEqual(checkout(2,3),{total:180,remaining:1}));
test('checkout rejects invalid quantities and insufficient stock',()=>{assert.throws(()=>checkout(0,3),/quantity/);assert.throws(()=>checkout(4,3),/stock/);});\n`;
const node = (id: string, deps: string[] = []): FlowNode => ({ id, goal: `Implement ${id} behavior`, depends_on: deps,
  touches: [id+'.mjs'], creates: [id+'.mjs'], relies_on: [], verify: id === 'checkout' ? composed : `node ${id}-check.mjs`, cmd: 'work' });
function fixture(options: { authority?: boolean; declared?: boolean; composedFails?: boolean; missingTests?: boolean; mixed?: boolean; emptyTests?: boolean; skipBehavior?: boolean; prematurePass?: boolean } = {}) {
  const repo = gitRepo(), file = join(repo,'dag.run.json');
  writeFileSync(join(repo,'.gitignore'),'dag.run*\nworker-calls.log\n');
  writeFileSync(join(repo,'checkout.local.test.mjs'),options.emptyTests ? `import 'node:test';\n` : options.skipBehavior ? localTest.replace("test('checkout calculates", "test.skip('checkout calculates") : localTest);
  writeFileSync(join(repo,'composed.mjs'), options.prematurePass
    ? `import {existsSync} from 'node:fs';if(!existsSync('receipt.mjs')){console.log('premature exit zero');process.exit(0);}const {receipt}=await import('./receipt.mjs');if(receipt(2,3)!=='total:180')throw Error('AssertionError: receipt behavior');console.log('composed behavior passed');\n`
    : options.mixed
    ? `throw Error("ENOENT: missing file 'receipt.mjs' and missing file 'setup.mjs'");\n`
    : `import assert from 'node:assert/strict';import {checkout} from './checkout.mjs';import {receipt} from './receipt.mjs';assert.equal(checkout(2,3).total,180);assert.equal(receipt(2,3),'total:${options.composedFails ? 181 : 180}');console.log('composed behavior passed');\n`);
  writeFileSync(join(repo,'receipt-check.mjs'),`import assert from 'node:assert/strict';import {receipt} from './receipt.mjs';assert.equal(receipt(1,3),'total:90');console.log('receipt behavior passed');\n`);
  writeFileSync(join(repo,'side-check.mjs'),`import assert from 'node:assert/strict';import {side} from './side.mjs';assert.equal(side(2),4);console.log('side behavior passed');\n`);
  writeFileSync(join(repo,'final.mjs'),`import assert from 'node:assert/strict';import {checkout} from './checkout.mjs';assert.equal(checkout(2,3).remaining,1);console.log('final behavior passed');\n`);
  assert.equal(git(repo,['add','.']).code,0);
  assert.equal(git(repo,['-c','user.name=t','-c','user.email=t@t','commit','-qm','frozen behavioral tests']).code,0);
  const producer = node('checkout');
  if(options.authority !== false) producer.local_check = { id:'checkout-local', behavior:'checkout calculates total and remaining stock',
    program:process.execPath,args:['--test','--test-reporter=tap','checkout.local.test.mjs'],files:[options.missingTests ? 'absent.test.mjs' : 'checkout.local.test.mjs'],
    timeoutMs:10000,kind:'test',selectedTests:{pattern:'^# tests (\\d+)\\s*$'} };
  if(options.declared) producer.verify_requires = ['receipt'];
  const nodes = [producer,node('receipt',['checkout']),node('side')];
  if(options.mixed) nodes.push(node('setup'));
  const {run,report} = compileFlowPlan({version:3,title:'Original flawed Checkout → Receipt verification plan',nodes,
    settings:{waveChecks:['node --check checkout.mjs'],finalChecks:['node final.mjs'],repairRounds:0,nodeRepairRounds:0}});
  if(options.mixed) run.tasks.setup.gate={question:'Unavailable setup authority',approved:null,options:[]};
  return {repo,file,run,report};
}
function runner(f: ReturnType<typeof fixture>, change?: (id:string,path:string)=>void) {
  const calls: {id:string;phase?:string;command?:string}[] = [], real=shellExecutor(f.repo);
  const executor: Executor = async(t,c,cmd)=>{
    calls.push({id:t.id,phase:c.env?.DAG_PHASE,command:cmd});
    if(c.env?.DAG_PHASE==='work') {
      writeFileSync(join(c.cwd!,t.id+'.mjs'),t.id==='checkout'?checkout:t.id==='receipt'?receipt:'export const side=x=>x*2;\n');
      change?.(t.id,c.cwd!);
      return {exitCode:0,output:'simulated implementation; actual verifiers execute'};
    }
    return real(t,{...c,env:{...c.env,NODE_TEST_CONTEXT:undefined}},cmd);
  };
  return {calls,r:new DagRunner(f.run,{cwd:f.repo,file:f.file,executor,persist:r=>saveRun(r,f.file)})};
}

test('flawed Checkout → Receipt verifier is autonomously staged; original check passes on frozen final source',async()=>{
  const f=fixture(),{r,calls}=runner(f), original=JSON.stringify(f.run.tasks.checkout.node);
  await r.start();
  assert.equal(r.result?.flow3?.passed,true,JSON.stringify(r.result));
  assert.equal(r.result?.flow3?.productComplete,true);
  assert.equal(JSON.stringify(f.run.tasks.checkout.node),original,'no external or authored plan rewrite');
  assert.deepEqual(f.run.tasks.checkout.deps,[]);assert.deepEqual(f.run.tasks.receipt.deps,['checkout']);
  assert.equal(f.run.tasks.checkout.attempts,1);assert.equal(f.run.tasks.receipt.attempts,1);
  assert.equal(calls.filter(c=>c.id==='checkout'&&c.phase==='work').length,1);
  const saved=loadRun(f.file), correction=saved.tasks.checkout.nodeState!.verificationCorrection!;
  assert.ok(correction);assert.equal(correction.original,composed);assert.deepEqual(correction.requires,['checkout','receipt']);
  assert.equal(saved.tasks.checkout.nodeState!.latestFailedChecks![0].passed,false);
  assert.equal(saved.tasks.checkout.nodeState!.repairAttempts,0);assert.equal(saved.flowState!.repairRound,0);
  assert.ok(calls.some(c=>c.id==='checkout'&&c.phase==='verify'&&c.command?.includes('check-command.js')));
  const final=saved.flowState!.checkpoints.find(c=>c.kind==='final')!;
  assert.ok(final.results.some(c=>c.command===composed&&c.passed&&c.identity===final.identity!.digest));
  assert.ok(final.results.some(c=>c.command===correction.local&&c.passed));
  assert.equal(git(f.repo,['show',`dag/${saved.id}:checkout.local.test.mjs`]).stdout,localTest.trim());
});

test('declared verify_requires consumer stays an acceptance prerequisite rather than a cyclic implementation edge',async()=>{
  const f=fixture({declared:true});
  assert.ok(f.report.warnings.some(w=>w.includes('downstream verification producer')));
  assert.deepEqual(f.run.tasks.checkout.deps,[]);
  const {r}=runner(f);await r.start();assert.equal(r.result?.flow3?.passed,true,JSON.stringify(r.result));
  assert.deepEqual(f.run.tasks.checkout.node!.verify_requires,['receipt']);
});

test('declared downstream readiness defers even a misleading zero-exit verifier until the consumer exists',async()=>{
  const f=fixture({declared:true,prematurePass:true}),{r,calls}=runner(f);await r.start();
  assert.equal(r.result?.flow3?.passed,true,JSON.stringify(r.result));
  assert.equal(calls.filter(c=>c.id==='checkout'&&c.phase==='verify'&&c.command===composed).length,0);
  assert.equal(f.run.tasks.checkout.nodeState!.latestFailedChecks![0].outcome,'deferred');
  assert.equal(f.run.tasks.checkout.nodeState!.latestFailedChecks![0].passed,false);
  assert.ok(calls.some(c=>c.id==='checkout'&&c.command?.includes('check-command.js')));
  const final=f.run.flowState!.checkpoints.find(c=>c.kind==='final')!;
  assert.ok(final.results.some(c=>c.command===composed&&c.passed&&c.output.includes('composed behavior passed')));
});

test('a scoped correction reopens its consumer and preserves the original final obligation',async()=>{
  const f=fixture(),{r}=runner(f);await r.start(new Set(['checkout']));
  assert.equal(r.result?.flow3?.passed,true,JSON.stringify(r.result));
  assert.equal(f.run.tasks.receipt.status,'completed');assert.equal(f.run.tasks.side.attempts,0);
  assert.deepEqual(f.run.flowState!.completion!.required,['checkout','receipt']);
  assert.equal(f.run.flowState!.productComplete,false,'scoped success is not product completion');
  assert.ok(f.run.flowState!.checkpoints.some(c=>c.kind==='final'&&c.results.some(r=>r.command===composed&&r.passed)));
});

test('empty local test execution and changed correction authority cannot inherit success',async()=>{
  for(const options of [{emptyTests:true},{skipBehavior:true}]){
    const empty=fixture(options),first=runner(empty);await first.r.start();
    assert.equal(first.r.result?.flow3?.passed,false);assert.equal(empty.run.tasks.receipt.attempts,0);
    assert.match(empty.run.tasks.checkout.nodeState!.latestFailedChecks![0].output,/Missing required evidence: passing named local behavior/);
  }
  const f=fixture(),{r}=runner(f);await r.start();assert.equal(r.result?.flow3?.passed,true);
  f.run.tasks.checkout.node!.local_check!.behavior+=' changed contract';saveRun(f.run,f.file);
  const second=runner(f);await second.r.start();
  assert.equal(second.calls.length,0);assert.equal(second.r.result?.flow3?.passed,false);
  assert.ok(second.r.result?.flow3?.issues.some(s=>s.includes('correction authority changed')));
  assert.equal(f.run.tasks.checkout.nodeState!.verificationCorrection!.original,composed);
});

test('an original composed check failure cannot become a pass after local staging',async()=>{
  const f=fixture({composedFails:true}),{r}=runner(f);await r.start();
  assert.equal(f.run.tasks.checkout.status,'completed');assert.equal(f.run.tasks.receipt.status,'completed');
  assert.equal(r.result?.flow3?.implementationComplete,true);assert.equal(r.result?.flow3?.passed,false);
  const final=f.run.flowState!.checkpoints.find(c=>c.kind==='final')!;
  assert.ok(final.results.some(c=>c.command===composed&&!c.passed));
  assert.equal(f.run.flowState!.productComplete,false);
});

test('local behavioral defects remain blocking and cannot be restaged a second time',async()=>{
  const f=fixture(),{r}=runner(f,(id,path)=>{if(id==='checkout')writeFileSync(join(path,'checkout.mjs'),checkout.replace('qty*90','qty*80'));});
  await r.start();assert.equal(f.run.tasks.checkout.status,'failed');assert.equal(f.run.tasks.receipt.attempts,0);
  assert.equal(f.run.tasks.side.status,'completed');assert.equal(r.result?.flow3?.passed,false);
  assert.equal(f.run.tasks.checkout.nodeState!.decision!.category,'policy'); // zero node repair allowance
  assert.match(f.run.tasks.checkout.nodeState!.latestFailedChecks![0].output,/AssertionError/);
});

test('ambiguous or unavailable local-check authority refuses without guessing',async()=>{
  for(const options of [{authority:false},{missingTests:true},{mixed:true}]){
    const f=fixture(options),{r}=runner(f);await r.start();
    assert.equal(f.run.tasks.checkout.status,'failed');assert.equal(f.run.tasks.receipt.attempts,0);
    assert.equal(f.run.tasks.checkout.nodeState?.verificationCorrection,undefined);
    assert.match(f.run.tasks.checkout.nodeState!.decision!.reason,/missing local_check authority|protected test file|mixed or ambiguous/);
    assert.deepEqual(f.run.tasks.checkout.deps,[]);assert.equal(r.result?.flow3?.passed,false);
  }
});

test('protected local tests changed by an implementation worker cannot authorize staging',async()=>{
  for(const file of ['checkout.local.test.mjs','composed.mjs']){
    const f=fixture(),original=readFileSync(join(f.repo,file),'utf8'),{r}=runner(f,(id,path)=>{if(id==='checkout')appendFileSync(join(path,file),'// unauthorized test replacement\n');});
    await r.start();assert.equal(r.result?.flow3?.passed,false);
    assert.equal(f.run.tasks.checkout.nodeState?.verificationCorrection,undefined);
    assert.match(f.run.tasks.checkout.nodeState!.decision!.reason,/protected verification sources differ/);
    assert.equal(git(f.repo,['show',`dag/${f.run.id}:${file}`]).stdout,original.trim());
  }
});

test('file-existence commands, empty test policy and real implementation cycles are not correction authority',()=>{
  const f=fixture(), base=f.run.tasks.checkout.node!.local_check!;
  for(const local_check of [{...base,behavior:''},{...base,kind:'command'},{...base,selectedTests:{pattern:'(\\d+)',allowEmpty:true}},
    {...base,program:'node',args:['-e','console.log("files exist")']},{...base,files:[]}]){
    assert.throws(()=>compileFlowPlan({version:3,title:'unsafe authority',nodes:[{...node('checkout'),local_check}]}),/local_check/);
  }
  assert.throws(()=>compileFlowPlan({version:3,title:'implementation cycle',nodes:[{...node('checkout',['receipt']),local_check:base},node('receipt',['checkout'])]}),/cycle/);
});

test('process death preserves staging, original obligations and spent budgets without another implementation dispatch',async()=>{
  for(const boundary of ['intent','local-check','candidate']){
    const f=fixture();
    f.run.settings.concurrency=1; // crash only this chain, not an unrelated live verifier
    f.run.flowState={version:3,repairRound:1,checkpoints:[],issues:[],nodeRepairs:{checkout:{used:1,failures:[],history:[]}}};
    f.run.settings.flow3!.repairRounds=1;f.run.settings.flow3!.nodeRepairRounds=1;saveRun(f.run,f.file);
    const runnerUrl=new URL('../runner.js',import.meta.url).href,storeUrl=new URL('../store.js',import.meta.url).href;
    const script=`
      import {DagRunner,shellExecutor} from ${JSON.stringify(runnerUrl)};
      import {loadRun,saveRun} from ${JSON.stringify(storeUrl)};
      import {writeFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';
      const [file,repo]=process.argv.slice(1),run=loadRun(file),real=shellExecutor(repo);
      await new DagRunner(run,{cwd:repo,file,persist:r=>{saveRun(r,file);const s=r.tasks.checkout.nodeState;
        if(${JSON.stringify(boundary)}==='intent'&&s?.verificationCorrection&&!s.candidate)process.exit(71);
        if(${JSON.stringify(boundary)}==='candidate'&&s?.verificationCorrection&&s.candidate)process.exit(71);},
        executor:async(t,c,cmd)=>{
          if(c.env.DAG_PHASE==='work'){appendFileSync(join(repo,'worker-calls.log'),t.id+'\\n');writeFileSync(join(c.cwd,t.id+'.mjs'),t.id==='checkout'?${JSON.stringify(checkout)}:t.id==='receipt'?${JSON.stringify(receipt)}:'export const side=x=>x*2;\\n');return {exitCode:0,output:'simulated worker'};}
          const result=await real(t,{...c,env:{...c.env,NODE_TEST_CONTEXT:undefined}},cmd);
          if(${JSON.stringify(boundary)}==='local-check'&&t.id==='checkout'&&cmd.includes('check-command.js')&&result.exitCode===0)process.exit(71);
          return result;
        }}).start();
    `;
    const died=spawnSync(process.execPath,['--input-type=module','-e',script,f.file,f.repo],{encoding:'utf8',windowsHide:true,timeout:90000});
    assert.equal(died.status,71,died.stderr);
    f.run=loadRun(f.file);const correction=structuredClone(f.run.tasks.checkout.nodeState!.verificationCorrection!);
    assert.ok(correction);assert.equal(correction.original,composed);
    const {r,calls}=runner(f);await r.start();
    assert.equal(r.result?.flow3?.passed,true,JSON.stringify({boundary,result:r.result}));
    assert.equal(calls.filter(c=>c.id==='checkout'&&c.phase==='work').length,0);
    assert.equal(f.run.tasks.checkout.attempts,1);assert.equal(f.run.flowState!.repairRound,1);
    assert.equal(f.run.flowState!.nodeRepairs!.checkout.used,1);
    assert.deepEqual(f.run.tasks.checkout.nodeState!.verificationCorrection,correction);
    assert.equal(readFileSync(join(f.repo,'worker-calls.log'),'utf8').split('\n').filter(x=>x==='checkout').length,1);
    assert.equal(f.run.flowState!.checkpoints.filter(c=>c.kind==='final'&&c.passed).length,1);
    assert.ok(f.run.flowState!.checkpoints.some(c=>c.kind==='final'&&c.results.some(r=>r.command===composed&&r.passed)));
  }
});
