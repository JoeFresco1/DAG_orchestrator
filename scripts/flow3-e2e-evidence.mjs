// Evidence experiment, not an orchestration layer. Only planning/worker responses
// are simulated; the production CLI, FlowRunner, store, git and checks execute.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = resolve(process.argv[2] ?? '.');
const outputParent = resolve(process.argv[3] ?? '../.lightweight-dag/experiments');
const gateCatalog = process.argv.includes('--gate-catalog');
const cohortDiscount = process.argv.includes('--cohort-discount');
const declareLocalCheck = process.argv.includes('--declare-local-check');
const cycleOnly = process.argv.includes('--cycle-only');
mkdirSync(outputParent, { recursive: true });
const output = mkdtempSync(join(outputParent, 'flow3-e2e-2026-11-12-'));
const hash = x => createHash('sha256').update(x).digest('hex');
const json = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
const command = (exe, args, cwd = source) => {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
};
const git = (cwd, args) => command('git', ['-c', 'core.longpaths=true', ...args], cwd);
function must(r) { assert.equal(r.code, 0, JSON.stringify(r)); return r.stdout.trim(); }
function files(root) { return readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)]); }
function fingerprint() {
  const paths = [...files(join(source, 'src')), ...['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'scripts/run-tests.mjs'].map(p => join(source, p))].sort();
  return hash(JSON.stringify(paths.map(p => [relative(source, p).replaceAll('\\', '/'), hash(readFileSync(p))])));
}
const provenance = { head: must(git(source, ['rev-parse', 'HEAD'])), dirty: must(git(source, ['status', '--short'])), sourceFingerprint: fingerprint(), node: process.version, platform: process.platform, cohortDiscount, declareLocalCheck, cycleOnly, diagnosticTiming:gateCatalog?'producer unfinished at basket diagnosis':'producer integrated before basket diagnosis; stale basket worktree', startedAt: new Date().toISOString() };
json(join(output, 'provenance.json'), provenance);
console.log(JSON.stringify({ output, provenance }));

const specs = [
  { id: 'R1', title: 'Catalog', requirement: 'Normalize SKU lookup case; return integer nonnegative cents; reject invalid prices and unknown SKUs.' },
  { id: 'R2', title: 'Inventory', requirement: 'Reserve a positive integer quantity without mutating input; reject insufficient stock.' },
  { id: 'R3', title: 'Discount', requirement: 'Apply a ten percent discount to all units on a line, rounded to integer cents; reject invalid quantities.' },
  { id: 'R4', title: 'Basket', requirement: 'Use catalog prices to calculate line and basket subtotals; reject empty baskets and unknown SKUs.' },
  { id: 'R5', title: 'Checkout', requirement: 'Combine basket, discounts, inventory and audit into an order with correct subtotal, discount, total and remaining stock.' },
  { id: 'R6', title: 'Receipt', requirement: 'Render the accepted order id and total in cents; reject negative totals.' },
  { id: 'R7', title: 'CLI', requirement: 'Read one JSON request from stdin, execute checkout and emit JSON containing receipt and sales CSV; report invalid orders with nonzero exit.' },
  { id: 'R8', title: 'Sales reporting', requirement: 'Provide two interoperable sales reporting operations: select sales and aggregate the selected records into daily CSV. Selection accepts an array of records with id, date, status and total fields. Only paid records are selected by default, while an explicitly supplied status is matched exactly. Date strings must be valid UTC calendar dates in YYYY-MM-DD format; invalid dates and inverted ranges are rejected. Start and end dates are inclusive. Filtering must preserve input order and must not mutate the source records or array. Aggregation groups selected records by their date and counts orders and sums integer cents, without floating-point currency conversion. Every total must be a nonnegative safe integer; negative totals are rejected. Duplicate order ids in an aggregation are rejected to avoid overstating sales. The CSV header must be date,orders,total and records must sort by ascending date, regardless of input order. Use newline separators and terminate the CSV with one newline. An empty selection returns only the header and newline. A purchase on the start boundary and a purchase on the end boundary must both be represented. Refunded orders outside the selected status must not appear. The CLI uses these same reporting operations rather than a separate implementation.' },
  { id: 'R9', title: 'Audit', requirement: 'Produce an order-created audit event linked to the order id, without mutating supplied data; reject a missing order id.' },
];

const code = {
  catalog: `export function price(sku, prices) { const key=String(sku).toLowerCase(); const p=prices[key]; if(!Number.isSafeInteger(p)||p<0) throw Error('invalid or unknown SKU'); return p; }\n`,
  inventory: `export function reserve(stock,sku,qty) { if(!Number.isInteger(qty)||qty<=0) throw Error('quantity'); if((stock[sku]??0)<qty) throw Error('stock'); return {...stock,[sku]:stock[sku]-qty}; }\n`,
  discount: `export function discount(cents,qty) { if(!Number.isInteger(qty)||qty<=0) throw Error('quantity'); return Math.round(cents*qty*0.1); }\n`,
  basket: `import {price} from './catalog.mjs'; export function basket(items,prices) { if(!items.length) throw Error('empty'); return items.reduce((sum,x)=>sum+price(x.sku,prices)*x.qty,0); }\n`,
  audit: `export function audit(id) { if(!id) throw Error('id'); return {kind:'order-created',id}; }\n`,
  checkout: `import {basket} from './basket.mjs'; import {price} from './catalog.mjs'; import {reserve} from './inventory.mjs'; import {discount} from './discount.mjs'; import {audit} from './audit.mjs'; export function checkout({id,items,prices,stock}) { const subtotal=basket(items,prices); let savings=0, remaining={...stock}; for(const x of items){remaining=reserve(remaining,x.sku,x.qty); savings+=discount(price(x.sku,prices),x.qty);} return {id,subtotal,discount:savings,total:subtotal-savings,remaining,audit:audit(id)}; }\n`,
  receipt: `export function receipt(order) { if(order.total<0) throw Error('total'); return order.id+':'+order.total; }\n`,
  'report-filter': `function date(s){if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(s)||Number.isNaN(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw Error('date');return s;} export function select(rows,{from='0001-01-01',to='9999-12-31',status='paid'}={}){date(from);date(to);if(from>to)throw Error('range');return rows.filter(r=>{date(r.date);return r.status===status&&r.date>=from&&r.date<=to;});}\n`,
  reporting: `import {select} from './report-filter.mjs'; export function csv(rows,options){const days=new Map(),ids=new Set(); for(const r of select(rows,options)){if(ids.has(r.id))throw Error('duplicate');ids.add(r.id);if(!Number.isSafeInteger(r.total)||r.total<0)throw Error('total');const x=days.get(r.date)??[0,0];x[0]++;x[1]+=r.total;days.set(r.date,x);} return 'date,orders,total\\n'+[...days].sort(([a],[b])=>a.localeCompare(b)).map(([d,[n,t]])=>d+','+n+','+t+'\\n').join('');}\n`,
  cli: `import {readFileSync} from 'node:fs'; import {fileURLToPath} from 'node:url'; import {checkout} from './checkout.mjs'; import {receipt} from './receipt.mjs'; import {csv} from './reporting.mjs'; export function run(x){return {receipt:receipt(checkout(x)),csv:csv(x.sales??[])};} if(process.argv[1]===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(run(JSON.parse(readFileSync(0,'utf8')))));}catch(e){console.error(e.message);process.exitCode=1;}}\n`,
};
const flawedDiscount = code.discount.replace('cents*qty*0.1', 'cents*0.1');

// These checks are immutable fixture inputs and execute in real child processes.
const checks = String.raw`
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const name=process.argv[2], load=async file=>{if(!existsSync(file))throw Error("ENOENT: missing file '"+file+"'");return import('./'+file);};
const input=()=>({id:'order-1',items:[{sku:'a',qty:3}],prices:{a:100},stock:{a:5}});
let groups=0;
async function check(id){
 if(id==='catalog'){const {price}=await load('catalog.mjs');assert.equal(price('A',{a:100}),100);assert.throws(()=>price('b',{a:100}));assert.throws(()=>price('a',{a:-1}));}
 else if(id==='inventory'){const {reserve}=await load('inventory.mjs');const s={a:5};assert.deepEqual(reserve(s,'a',3),{a:2});assert.deepEqual(s,{a:5});assert.throws(()=>reserve(s,'a',6));assert.throws(()=>reserve(s,'a',0));}
 else if(id==='discount'){const {discount}=await load('discount.mjs');assert.equal(discount(100,1),10);assert.throws(()=>discount(100,0));}
 else if(id==='basket'){await load('catalog.mjs');const {basket}=await load('basket.mjs');assert.equal(basket(input().items,input().prices),300);assert.throws(()=>basket([],{a:100}));assert.throws(()=>basket([{sku:'b',qty:1}],{a:100}));}
 else if(id==='audit'){const {audit}=await load('audit.mjs');assert.deepEqual(audit('order-1'),{kind:'order-created',id:'order-1'});assert.throws(()=>audit(''));}
 else if(id==='integration-pricing'){await check('basket');const {discount}=await load('discount.mjs');assert.equal(discount(100,3),30,'discount.mjs must discount every unit');}
 else if(id==='checkout-local'){const {checkout}=await load('checkout.mjs');const x={...input(),items:[{sku:'a',qty:1}]},o=checkout(x);assert.equal(o.subtotal,100);assert.equal(o.discount,10);assert.equal(o.total,90);assert.equal(o.remaining.a,4);assert.deepEqual(o.audit,{kind:'order-created',id:'order-1'});assert.equal(x.stock.a,5);assert.throws(()=>checkout({...input(),stock:{a:1}}));}
 else if(id==='checkout-composed'){await check('checkout-local');const {receipt}=await load('receipt.mjs');const {checkout}=await load('checkout.mjs');assert.equal(receipt(checkout({...input(),items:[{sku:'a',qty:1}]})),'order-1:90');}
 else if(id==='receipt'){const {receipt}=await load('receipt.mjs');assert.equal(receipt({id:'order-1',total:270}),'order-1:270');assert.throws(()=>receipt({id:'x',total:-1}));}
 else if(id==='report-filter'){const {select}=await load('report-filter.mjs');const rows=[{id:'1',date:'2026-01-01',status:'paid',total:100},{id:'2',date:'2026-01-02',status:'refunded',total:50},{id:'3',date:'2026-01-03',status:'paid',total:200}];const saved=JSON.stringify(rows);assert.deepEqual(select(rows,{from:'2026-01-01',to:'2026-01-03'}).map(r=>r.id),['1','3']);assert.deepEqual(select(rows,{status:'refunded'}).map(r=>r.id),['2']);assert.equal(JSON.stringify(rows),saved);assert.throws(()=>select(rows,{from:'2026-02-31'}));assert.throws(()=>select(rows,{from:'2026-02-01',to:'2026-01-01'}));}
 else if(id==='reporting'){await check('report-filter');const {csv}=await load('reporting.mjs');const rows=[{id:'3',date:'2026-01-03',status:'paid',total:200},{id:'1',date:'2026-01-01',status:'paid',total:100},{id:'2',date:'2026-01-01',status:'paid',total:50},{id:'4',date:'2026-01-02',status:'refunded',total:90}];assert.equal(csv(rows),'date,orders,total\n2026-01-01,2,150\n2026-01-03,1,200\n');assert.equal(csv([]),'date,orders,total\n');assert.throws(()=>csv([{id:'x',date:'2026-01-01',status:'paid',total:-1}]));assert.throws(()=>csv([rows[0],rows[0]]));}
 else if(id==='cli'){await check('checkout-composed');await check('reporting');const r=spawnSync(process.execPath,['cli.mjs'],{input:JSON.stringify(input()),encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{receipt:'order-1:270',csv:'date,orders,total\n'});const bad=spawnSync(process.execPath,['cli.mjs'],{input:JSON.stringify({...input(),stock:{a:0}}),encoding:'utf8',windowsHide:true});assert.equal(bad.status,1);}
 else throw Error('unknown check '+id);
 groups++;
}
if(name==='acceptance'){const specs=JSON.parse(readFileSync('specifications.json','utf8'));assert.equal(specs.length,9);for(const id of ['catalog','inventory','discount','basket','checkout-local','integration-pricing','receipt','cli','reporting','audit'])await check(id);const {checkout}=await load('checkout.mjs');assert.equal(checkout(input()).total,270);console.log('REQUIREMENTS_PASSED: '+specs.map(s=>s.id).join(','));}
else await check(name);
console.log('DAG_CHECK_OUTCOME: passed; executed '+groups+' behavioral groups');
`;

function plannerResponse(corrected) {
  const n = (id, deps = [], file = id, verifier = id) => ({ id, goal: specs.find(s => ({ catalog:'R1',inventory:'R2',discount:'R3',basket:'R4',checkout:'R5',receipt:'R6',cli:'R7',reporting:'R8',audit:'R9','report-filter':'R8' })[id]===s.id)?.requirement ?? id,
    depends_on: deps, touches: [file+'.mjs'], creates: [file+'.mjs'], relies_on: [], verify: 'node checks.mjs '+verifier });
  const nodes = [n('basket'), n('catalog'), n('inventory'), n('discount'), n('audit'),
    n('checkout',['basket','catalog','inventory','discount','audit'],'checkout',corrected?'checkout-local':'checkout-composed'),
    n('receipt',['checkout']), n('reporting',corrected?['report-filter']:[]), n('cli',['checkout','receipt','reporting'])];
  // A valid alternative plan: discount is authored against catalog's unit-price
  // contract, so it shares the consuming wave. This isolates scope attribution.
  if(cohortDiscount)nodes.find(n=>n.id==='discount').depends_on=['catalog'];
  if(declareLocalCheck)nodes.find(n=>n.id==='checkout').local_check={id:'checkout-local-behavior',behavior:'checkout local behavior',
    program:process.execPath,args:['--test','--test-reporter=tap','checkout.integrity.test.mjs'],files:['checkout.integrity.test.mjs','checks.mjs'],
    timeoutMs:10000,kind:'test',selectedTests:{pattern:'^# tests (\\d+)\\s*$'}};
  if (corrected) {
    nodes.find(n=>n.id==='reporting').goal='Aggregate selected paid sales into sorted daily integer-cent CSV; reject invalid totals and duplicate order ids.';
    const filter=n('report-filter'); filter.goal='Select valid dated sales by inclusive date range and status without input mutation; reject invalid dates and reversed ranges.'; nodes.splice(7,0,filter);
  }
  if(cycleOnly){
    for(let i=nodes.length-1;i>=0;i--)if(!['checkout','receipt'].includes(nodes[i].id))nodes.splice(i,1);
    nodes.find(n=>n.id==='checkout').depends_on=[];
    return {version:3,title:'Original Checkout → Receipt cycle with stable implemented prerequisites',cmd:'simulated-implementation',nodes,
      settings:{waveChecks:['node checks.mjs integration-pricing'],finalChecks:['node checks.mjs acceptance'],
        checkPrerequisites:{'node checks.mjs checkout-composed':['checkout','receipt']},repairRounds:0,nodeRepairRounds:0,
        repairProtectedPaths:['specifications.json','checks.mjs'],acceptanceInputs:['specifications.json']}};
  }
  return { version:3,title:'Nine-spec order processing application',cmd:'simulated-implementation',nodes,settings:{
    waveChecks:['node checks.mjs integration-pricing'],finalChecks:['node checks.mjs checkout-composed','node checks.mjs acceptance'],
    checkPrerequisites:{'node checks.mjs integration-pricing':['basket','catalog','discount'],'node checks.mjs checkout-composed':['checkout','receipt']},
    repairCommand:'simulated-repair',repairRounds:2,nodeRepairRounds:1,repairProtectedPaths:['specifications.json','checks.mjs'],acceptanceInputs:['specifications.json'],environmentIdentity:'deterministic-worker-fixture-v1',
  }};
}

async function runtime(path) {
  const load = file => import(pathToFileURL(join(path,'dist',file)).href);
  return { ...(await load('runner.js')), ...(await load('store.js')), ...(await load('flow3/graph.js')) };
}

async function experiment(runtimePath, label, corrected) {
  const R=await runtime(runtimePath), repo=join(output,label);mkdirSync(repo);
  must(git(repo,['init','-q']));must(git(repo,['config','core.autocrlf','false']));
  writeFileSync(join(repo,'.gitignore'),'dag.run*\nplanner-output.json\n');
  writeFileSync(join(repo,'checks.mjs'),checks);json(join(repo,'specifications.json'),specs);
  if(cycleOnly)for(const [id,body]of Object.entries(code))if(!['checkout','receipt'].includes(id))writeFileSync(join(repo,id+'.mjs'),body);
  if(declareLocalCheck)writeFileSync(join(repo,'checkout.integrity.test.mjs'),`import test from 'node:test';import {execFileSync} from 'node:child_process';test('checkout local behavior',()=>{execFileSync(process.execPath,['checks.mjs','checkout-local'],{stdio:'inherit',windowsHide:true});});\n`);
  must(git(repo,['add','.']));must(git(repo,['-c','user.name=Flow3 Experiment','-c','user.email=fixture@localhost','commit','-qm','frozen requirements and real behavioral checks']));
  const plan=plannerResponse(corrected), planFile=join(repo,'planner-output.json'),file=join(repo,'dag.run.json');json(planFile,plan);
  const cli=join(runtimePath,'dist/cli.js');
  const validation=command(process.execPath,[cli,'plan','validate','--plan',planFile,'--file',file,'--json'],repo);json(join(output,label+'-validation.json'),validation);must(validation);
  const compilation=command(process.execPath,[cli,'plan','compile','--plan',planFile,'--file',file,'--json'],repo);json(join(output,label+'-compilation.json'),compilation);must(compilation);
  let run=R.loadRun(file); run.settings.concurrency=3;run.settings.maxWallClockMs=180000;run.settings.finalReview='off';
  if(run.tasks.inventory)run.tasks.inventory.harnessChain=[{harness:'opencode'},{harness:'codex'}];
  R.saveRun(run,file);
  const events=[],calls=[],real=R.shellExecutor(repo);let active=0,peak=0;
  let releaseCatalog=()=>{};const catalogGate=new Promise(resolve=>releaseCatalog=resolve);
  let catalogIntegrated=()=>{};const integratedGate=new Promise(resolve=>catalogIntegrated=resolve);
  const executor=async(task,ctx,cmd)=>{
    const phase=ctx.env?.DAG_PHASE, start=Date.now();active++;peak=Math.max(peak,active);
    const record={task:task.id,phase,cmd,attempt:task.attempts,harness:task.harness,at:new Date(start).toISOString(),completedAtStart:Object.values(run.tasks).filter(t=>t.status==='completed').map(t=>t.id)};calls.push(record);
    const simulated=outcome=>{Object.assign(record,{simulated:true,...outcome});return outcome;};
    try {
      if(phase==='advisory') return simulated({exitCode:0,output:'SIMULATED advisory: split reporting and separate checkout local integrity from downstream receipt acceptance. Advisory cannot mutate the graph.'});
      if(phase==='work'&&!task.node?.repair_of){
        const count=calls.filter(c=>c.task===task.id&&c.phase==='work').length;
        const path=join(ctx.cwd,task.id+'.mjs');
        if(task.id==='catalog'&&gateCatalog){
          record.controlledLatency='Await basket missing-producer diagnosis';
          let timer;try{await Promise.race([catalogGate,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Fixture catalog gate timed out')),15000))]);}finally{clearTimeout(timer);}
        }
        if(task.id==='inventory'&&count===1){writeFileSync(path,'// partial inventory source preserved across transient failure\n');return simulated({exitCode:1,output:'HTTP 503 provider temporarily unavailable'});}
        if(task.id==='inventory'&&count===2)assert.match(readFileSync(path,'utf8'),/partial inventory/);
        if(task.id==='reporting'&&!corrected){writeFileSync(path,'export const unfinishedReport = true;\n');return simulated({exitCode:1,output:'maximum context length exceeded: split report selection and CSV aggregation'});}
        if(task.id==='basket'&&count>1)assert.match(readFileSync(path,'utf8'),/export function basket/);
        writeFileSync(path,task.id==='discount'?flawedDiscount:code[task.id]);
        return simulated({exitCode:0,output:'SIMULATED worker wrote '+task.id+' source; no acceptance claim'});
      }
      if(phase==='repair'){
        if(!task.node.touches.includes('discount.mjs'))return simulated({exitCode:1,output:'Repair policy violation: diagnosed discount.mjs defect is outside authorized scope '+JSON.stringify(task.node.touches)});
        assert.match(task.spec,/discount.mjs/);record.failedCheck=task.nodeState?.repairContext?.failedChecks;
        writeFileSync(join(ctx.cwd,'discount.mjs'),code.discount);
        return simulated({exitCode:0,output:'SIMULATED bounded repair changed only discount.mjs'});
      }
      assert.ok(cmd==='git diff --check'||cmd.startsWith('node checks.mjs ')||declareLocalCheck&&cmd.includes('check-command.js'),'Fixture refuses unsimulated worker/provider command: '+cmd);
      if(!gateCatalog&&phase==='verify'&&task.id==='basket'&&task.attempts===1){
        record.controlledLatency='Producer integrates before real verification executes against the stale basket worktree';
        let timer;try{await Promise.race([integratedGate,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Fixture integration gate timed out')),15000))]);}finally{clearTimeout(timer);}
      }
      const result=await real(task,ctx,cmd);record.exitCode=result.exitCode;record.output=result.output;return result;
    }finally{active--;record.elapsedMs=Date.now()-start;}
  };
  const make=()=>new R.DagRunner(run,{cwd:repo,file,executor,persist:r=>R.saveRun(r,file),onEvent:e=>{events.push(e);if(e.taskId==='basket'&&(e.type==='task-fail'||/Deferred unverified implementation/.test(e.message)))releaseCatalog();if(e.taskId==='catalog'&&e.type==='task-done')catalogIntegrated();}});
  const started=Date.now(), runner=make();await runner.start();const elapsedMs=Date.now()-started;
  const initialTasks=Object.fromEntries(Object.entries(run.tasks).map(([id,t])=>[id,{status:t.status,attempts:t.attempts,deps:t.deps,commit:t.commit,branch:t.branch,result:t.result,decision:t.nodeState?.decision}]));
  const beforeResume={calls:calls.length,attempts:Object.fromEntries(Object.values(run.tasks).map(t=>[t.id,t.attempts])),repairRound:run.flowState?.repairRound};
  let resumeProbe;
  if(!runner.result?.flow3?.passed){
    run=R.loadRun(file);const at=Date.now(),resumed=make();await resumed.start();
    resumeProbe={elapsedMs:Date.now()-at,additionalExecutorCalls:calls.length-beforeResume.calls,attemptsUnchanged:JSON.stringify(beforeResume.attempts)===JSON.stringify(Object.fromEntries(Object.values(run.tasks).map(t=>[t.id,t.attempts]))),repairRoundsBefore:beforeResume.repairRound,repairRoundsAfter:run.flowState?.repairRound,passed:resumed.result?.flow3?.passed};
  }
  // Read-only diagnostic of saved unaccepted checkout code. Does not alter task state.
  let localCheckoutProbe;
  const checkout=run.tasks.checkout;
  if(checkout.status==='failed'&&checkout.commit){
    const probe=join(output,label+'-checkout-probe');must(git(repo,['worktree','add','--detach',probe,checkout.commit]));
    localCheckoutProbe={local:command(process.execPath,['checks.mjs','checkout-local'],probe),composed:command(process.execPath,['checks.mjs','checkout-composed'],probe)};
  }
  const original=plan.nodes.map(n=>run.tasks[n.id]);
  const checksRun=run.flowState?.checkpoints.flatMap(c=>c.results.map(r=>({checkpoint:c.id,kind:c.kind,...r})))??[];
  const recoveries=events.filter(e=>e.type==='task-retry'||e.type==='task-repair'||/Deferred unverified implementation|Added producer dependency|Reopened producer scope|Transient provider failure/.test(e.message));
  const repairCalls=calls.filter(c=>c.phase==='repair');
  const result={label,repo,correctedPlannerResponse:corrected,originalSpecifications:specs.length,authoredTasks:plan.nodes.length,
    planner:{simulated:true,invokedByFlowRunner:false,decomposedByFlowRunner:0,externallySplitReporting:corrected,externallySeparatedLocalAcceptance:corrected},
    initialTasks,summary:runner.result,elapsedMs,peakExecutorConcurrency:peak,
    metrics:{completedOriginalTasks:original.filter(t=>t.status==='completed').length,failedOriginalTasks:original.filter(t=>t.status==='failed').length,pendingOriginalTasks:original.filter(t=>t.status==='pending').length,generatedRepairTasks:Object.values(run.tasks).filter(t=>t.node?.repair_of).length,completedRepairTasks:Object.values(run.tasks).filter(t=>t.node?.repair_of&&t.status==='completed').length,implementationDispatches:calls.filter(c=>c.phase==='work'&&!run.tasks[c.task]?.node?.repair_of).length,repeatImplementationDispatches:plan.nodes.reduce((sum,n)=>sum+Math.max(0,calls.filter(c=>c.task===n.id&&c.phase==='work').length-1),0),codingRepairDispatches:repairCalls.length,repairRounds:run.flowState?.repairRound,humanInterventionsDuringExecution:0,externalPlanTransformationsSupplied:corrected?2:0,deferredCheckpointObservations:checksRun.filter(r=>r.outcome==='deferred').length,finalCheckpoints:run.flowState?.checkpoints.filter(c=>c.kind==='final').length},
    recoveries,resumeProbe,localCheckoutProbe,repairCalls,checksRun,calls,events,
    unresolvedRequiredTasks:original.filter(t=>t.status!=='completed').map(t=>t.id),
    finalAcceptanceRequired:plan.settings.finalChecks,finalAcceptancePassed:run.flowState?.checkpoints.some(c=>c.kind==='final'&&c.passed)??false,
    integrationHead:must(git(repo,['rev-parse','dag/'+run.id])),protectedInputsUnchanged:must(git(repo,['show','dag/'+run.id+':checks.mjs']))===checks.trim(),
  };
  json(join(output,label+'-evidence.json'),result);json(join(output,label+'-events.json'),events);
  console.log(JSON.stringify({label,elapsedMs,metrics:result.metrics,passed:result.summary.flow3?.passed,unresolved:result.unresolvedRequiredTasks}));
  return result;
}

const R=await runtime(source);
let rawSpecProbe;try{R.compileFlowPlan({version:3,title:'Raw product requirements',specifications:specs});rawSpecProbe={accepted:true};}catch(e){rawSpecProbe={accepted:false,error:e.message};}
const explicitCycle=plannerResponse(false);explicitCycle.nodes.find(n=>n.id==='checkout').verify_requires=['receipt'];
let explicitCycleProbe;try{R.compileFlowPlan(explicitCycle);explicitCycleProbe={accepted:true};}catch(e){explicitCycleProbe={accepted:false,error:e.message};}
json(join(output,'admission-probes.json'),{rawSpecProbe,explicitCycleProbe});

const baseline=join(output,'baseline-head');mkdirSync(baseline);
must(git(source,['archive','--format=tar','-o',join(output,'baseline-head.tar'),provenance.head]));
must(command('tar',['-xf',join(output,'baseline-head.tar'),'-C',baseline]));
symlinkSync(join(source,'node_modules'),join(baseline,'node_modules'),process.platform==='win32'?'junction':'dir');
execFileSync(process.execPath,[join(source,'node_modules/typescript/bin/tsc'),'-p',join(baseline,'tsconfig.json')],{cwd:baseline,windowsHide:true,timeout:180000,stdio:'pipe'});

const results=[];
const matrix=cycleOnly?[[baseline,'baseline-flawed',false],[source,'current-flawed',false]]:[[baseline,'baseline-flawed',false],[source,'current-flawed',false],[baseline,'baseline-corrected-plan',true],[source,'current-corrected-plan',true]];
for(const [runtimePath,label,corrected] of matrix)results.push(await experiment(runtimePath,label,corrected));
assert.equal(fingerprint(),provenance.sourceFingerprint,'Production source changed while evidence was collected');
json(join(output,'results.json'),{provenance,endedAt:new Date().toISOString(),rawSpecProbe,explicitCycleProbe,results:results.map(({calls,events,checksRun,...r})=>r)});
console.log('EVIDENCE_DIRECTORY: '+output);
