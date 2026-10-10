import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadRun} from '../dist/store.js';
import {loadConfig,preflight,graphIdentity} from './reliability/contracts.mjs';

const [control,planning,mode]=process.argv.slice(2);
if(!control||!planning||!['validate','apply'].includes(mode))throw Error('Expected control planning validate|apply');
const engine=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=path.join(engine,'dist/cli.js');
const read=(root,p)=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const put=(root,p,data)=>{const f=path.join(root,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof data==='string'?data:JSON.stringify(data,null,2)+'\n');};
const runFile=path.join(control,'dag.run.json'), initial=loadRun(runFile);
const original=read(control,'docs/build/run-manifest.json'), execution=read(planning,'docs/build/execution-graph.json');
const audit=read(planning,'docs/build/dependency-replan.json'), graph=read(planning,'docs/build/graph.json'), packets=read(planning,'docs/build/task-handoffs.json');
const byKey=new Map(execution.units.map(u=>[u.key,u])), completed=Object.values(initial.tasks).filter(t=>t.status==='completed');
const baseline=new Map(completed.map(t=>[t.id,JSON.stringify(t)]));
const git=(root,args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});if(r.status!==0)throw Error(r.stderr||r.stdout);return r.stdout.trim();};
if(initial.id!==audit.runId||completed.length!==68)throw Error('Run baseline changed');
if(Object.values(initial.tasks).some(t=>t.status==='running')||fs.existsSync(path.join(control,'dag.run.d/reliability/controller.lock')))throw Error('Controller/runner must be stopped');
const resolved=new Set();
const visit=(key,seen=new Set())=>{if(seen.has(key))throw Error(`Cycle ${key}`);if(resolved.has(key))return;const u=byKey.get(key);if(!u)throw Error(`Unknown dependency ${key}`);seen.add(key);for(const d of u.deps)visit(d,new Set(seen));resolved.add(key);};
for(const u of execution.units)visit(u.key);
for(const key of audit.completed){if(!byKey.has(key)||initial.tasks[original.nodeIds[key]]?.status!=='completed')throw Error('Accepted task removed');}
for(const [key,id] of Object.entries(original.nodeIds))if(!byKey.has(key)&&initial.tasks[id]?.attempts)throw Error(`Cannot remove attempted task ${key}`);
if(audit.decisions.length!==96||Object.keys(packets).length!==117)throw Error('Incomplete pending audit');
const predecessor=(producer,consumer)=>{const seen=new Set();const walk=k=>{for(const d of byKey.get(k).deps)if(!seen.has(d)){seen.add(d);walk(d);}};walk(consumer);return seen.has(producer);};
for(const [key,p] of Object.entries(packets))for(const input of p.consumes)if(!predecessor(input.owner,key))throw Error(`Future input ${input.owner} -> ${key}`);
for(const [a,b] of [['003-runtime-composition','003-scope-t005'],['003-scope-t005','003-cli-comparison-integration'],['015-scope-t002','015-scope-t001-t003-t004'],['023-scope-t002-t003','023-scope-t004'],['018-scope-t004','018-scope-t001'],['99-scope-t004','99-scope-t002']])if(!predecessor(a,b))throw Error(`Missing required semantic edge ${a} -> ${b}`);
if(mode==='validate'){console.log(JSON.stringify({units:execution.units.length,completedPreserved:68,pendingReviewed:96,acyclic:true,consumedExportsHaveEarlierOwners:true,criticalSemanticEdges:true}));process.exit(0);}
const backup='.dag-build/dependency-replan-before-20261009';
if(fs.existsSync(path.join(control,backup,'applied.json')))throw Error('Already applied');
const changed=git(planning,['diff','--name-only',audit.base,'HEAD']).split(/\r?\n/).filter(Boolean);
if(!changed.length||git(planning,['status','--porcelain']))throw Error('Commit validated planning checkout before apply');
if(changed.some(p=>p.startsWith('src/')||p.endsWith('/spec.md')||p.includes('/contracts/')))throw Error('Unexpected product changes');
for(const p of [...changed,'docs/build/run-manifest.json','docs/build/reliability.json','dag.run.json','dag.run.d/state.json','dag.run.d/events.jsonl','dag.run.d/reliability/controller.json','scripts/build/reliability-adapter.mjs']){
 const src=path.join(control,p),dst=path.join(control,backup,p);if(fs.existsSync(src)&&!fs.existsSync(dst)){fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);}
}
put(control,`${backup}/completed.json`,Object.fromEntries(baseline));
put(control,`${backup}/ledger-budget.json`,read(control,'dag.run.d/reliability/controller.json'));
// Advance only the accepted integration branch and only from the reviewed base.
const current=git(control,['rev-parse',`dag/${initial.id}`]),head=git(planning,['rev-parse','HEAD']);
if(current!==audit.base&&current!==head)throw Error('Integration progressed during planning');
if(current!==head){
 const entries=git(control,['worktree','list','--porcelain']).split(/\r?\n\r?\n/);
 const entry=entries.find(e=>e.includes(`branch refs/heads/dag/${initial.id}`));
 if(entry){const tree=entry.split(/\r?\n/)[0].slice(9);if(git(tree,['status','--porcelain']))throw Error('Integration is dirty');git(tree,['merge','--ff-only',head]);}
 else git(control,['update-ref',`refs/heads/dag/${initial.id}`,head,current]);
}
for(const p of changed){const src=path.join(planning,p);if(!fs.existsSync(src))throw Error('Planning deleted a file');const dst=path.join(control,p);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);}
function dag(args){const r=spawnSync(process.execPath,[cli,...args,'--file',runFile,'--json'],{cwd:control,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});if(r.status!==0)throw Error(`${args[0]}: ${r.stderr||r.stdout}`);const s=r.stdout.trim();return s.startsWith('{')||s.startsWith('[')?JSON.parse(s):null;}
const progressPath=`${backup}/progress.json`, ids=fs.existsSync(path.join(control,progressPath))?read(control,progressPath):{};
for(const u of execution.units){
 const oldId=ids[u.key]||original.nodeIds[u.key];
 if(oldId&&initial.tasks[oldId]?.status==='completed'){ids[u.key]=oldId;continue;}
 const deps=u.deps.map(k=>{if(!ids[k])throw Error(`Unregistered producer ${k}`);return ids[k];});
 const spec=`Inputs: docs/build/task-handoffs.json entry ${u.key}; accepted producer interfaces and assigned feature spec. Outputs: ${u.files.join(', ')}. ${u.instructions}`;
 const args=['--title',`${u.featureKey}: ${u.title}`,'--spec',spec,'--cmd',`node scripts/build/agent.mjs ${u.key} unit-work "{depsFile}" "{lastRejection}"`,'--review-cmd',`node scripts/build/agent.mjs ${u.key} unit-review "{depsFile}" "{lastRejection}"`,'--review-rounds','9','--retries','2','--timeout','7200','--silence','600',...(deps.length?['--deps',deps.join(',')]:['--clear-deps'])];
 const id=oldId?(dag(['edit','--id',oldId,...args]),oldId):dag(['add',...args]).id;
 ids[u.key]=id;put(control,progressPath,ids);
 for(const reviewer of loadRun(runFile).tasks[id].reviewers||[])dag(['reviewer','rm','--id',id,'--name',reviewer.name]);
 dag(['reviewer','add','--id',id,'--name','unit-contract-and-tests','--cmd',`node "${path.join(control,'scripts/build/check-unit.mjs').replaceAll('\\','/')}" ${u.key}`,'--when','always','--verdict','exit-code']);
}
for(const [key,id] of Object.entries(original.nodeIds).reverse())if(!byKey.has(key)&&loadRun(runFile).tasks[id])dag(['rm','--id',id]);
put(control,'docs/build/run-manifest.json',{...original,nodeIds:ids,executableNodes:execution.units.length,checklistTasks:execution.taskMapping.length,dependencyAmendedAt:new Date().toISOString(),dependencyAmendment:'docs/build/dependency-replan.json',acceptedPlanningCommit:head});
const cfg=read(control,'docs/build/reliability.json'),previousCfg=structuredClone(cfg),lock=read(control,'docs/build/contract-lock.json');
const frozen=new Map(Object.keys(lock).map(file=>[file,{path:file,role:'frozen',digest:createHash('sha256').update(fs.readFileSync(path.join(planning,file))).digest('hex')}]));
const tasks={};
const adapter=path.join(control,'scripts/build/reliability-adapter.mjs');
for(const u of execution.units){
 const id=ids[u.key];
 if(initial.tasks[id]?.status==='completed'){
  tasks[id]=structuredClone(previousCfg.tasks[id]);
  tasks[id].files=tasks[id].files.map(f=>f.role==='frozen'?frozen.get(f.path)||f:f);continue;
 }
 const node=graph.nodes.find(n=>n.key===u.featureKey),dir=node.feature||`docs/build/task-plans/${node.key}`,plan=read(planning,`${dir}/execution.json`);
 const refs=[...Object.entries(plan.requirementTasks),...Object.entries(plan.successTasks),...Object.entries(plan.edgeCaseTasks)].filter(([,ids])=>ids.some(t=>u.taskIds.includes(t))).map(([r])=>r);
 const files=[...new Set([...u.files,`${dir}/tasks.md`,`${dir}/unit-verification/${u.id}.md`,...(u.final?[`${dir}/verification.md`]:[])])].map(p=>frozen.get(p)||{path:p,role:/\.test\.[cm]?[jt]s$|\/test_[^/]+\.py$/.test(p)?'test':p.endsWith('.md')?'generated':'implementation'});
 tasks[id]={entryPoint:files.find(f=>f.role!=='frozen').path,reviewBoundary:u.instructions,requirements:[...new Set([...u.taskIds,...refs])],files,checks:[{program:process.execPath,args:[adapter,'check',id],timeoutMs:3600000}],inputs:[...new Set(packets[u.key].consumes.map(c=>c.owner))].map(owner=>({owner:ids[owner],contract:`Consumed source exports from ${owner}; behavior separately verified`,check:{program:process.execPath,args:[path.join(engine,'scripts/analytics-input-contracts.mjs'),u.key,owner],timeoutMs:60000}})),resources:{acceptance:1}};
}
const registered=new Set(Object.values(tasks).flatMap(t=>t.files.map(f=>f.path)));
for(const f of frozen.values())if(!registered.has(f.path))Object.values(tasks)[0].files.push(f);
cfg.tasks=tasks;put(control,'docs/build/reliability.json',cfg);
// Prompt handoff fixes: explicit workspace, concise interfaces, exact skill path,
// typed environment refusal, and no generic whole-feature setup loop per unit.
let source=fs.readFileSync(adapter,'utf8');
// approve-for-me already selects workspace-write and conflicts with --sandbox.
source=source.replace("'--ignore-user-config', '--approve-for-me', '-m'","'--ignore-user-config', '--approve-for-me', '--cd', cwd, '-m'");
source=source.replace('Read the relevant Spec Kit implement skill and apply within this boundary.', 'Spec Kit planning is already complete and this registered unit is authorized. The repository skill is .agents/skills/speckit-implement/SKILL.md; its whole-feature planning, setup-file edits and interactive checklist gate are handled by the coordinator. Execute only this unit with its frozen requirements and passing scope tests. Before implementation, prove write access through your actual shell by creating and removing an ignored .dag-build scratch file; if that operation is denied, return a typed DAG_FAILURE environment packet with the actual error. Do not infer read-only access from an assumption.');
source=source.replace('const cwd = process.cwd();',"const handoffPath = join(control, 'docs/build/task-handoffs.json');\nconst handoff = existsSync(handoffPath) ? JSON.parse(readFileSync(handoffPath, 'utf8'))[key] : null;\nconst cwd = process.cwd();");
source=source.replace('Accepted review boundary: ${config.tasks[taskId].reviewBoundary}.', 'Producer/consumer handoff: ${JSON.stringify(handoff ? { consumes: handoff.consumes, produces: handoff.produces, laterOwners: handoff.laterOwners } : null)}. Accepted review boundary: ${config.tasks[taskId].reviewBoundary}.');
source=source.replace("line.startsWith('DAG_SCOPE_REQUEST: ')","line.startsWith('DAG_SCOPE_REQUEST: ') || line.startsWith('DAG_FAILURE: ')");
source=source.replace('If a further ancestor implementation file is necessary, DO NOT edit it:', 'Files already listed in the scope are authorized; do not request them again. File permission does not authorize future task behavior. If a necessary API is owned by a future task, identify that task and missing API in a typed DAG_FAILURE ownership packet with evidence rather than re-requesting files. If a further ancestor implementation file is necessary, DO NOT edit it:');
fs.writeFileSync(adapter,source);
const parsed=spawnSync(process.execPath,['--check',adapter],{encoding:'utf8'});if(parsed.status!==0)throw Error(parsed.stderr);
const after=loadRun(runFile);
for(const [id,before] of baseline)if(JSON.stringify(after.tasks[id])!==before)throw Error(`Accepted runtime state changed: ${id}`);
if(Object.keys(after.tasks).length!==execution.units.length)throw Error('Runtime count mismatch');
for(const u of execution.units)if(after.tasks[ids[u.key]].deps.slice().sort().join()!==u.deps.map(k=>ids[k]).sort().join())throw Error(`Runtime dependency mismatch ${u.key}`);
const context=loadConfig(path.join(control,'docs/build/reliability.json'));preflight(context.cfg,after);
dag(['reliable','amend','--config',context.path,'--reason','User-authorized full pending dependency audit; preserve 68 accepted tasks, fix consumer/provider ordering and test-first units; retain all product requirements and budgets.','--release','task_426aeb0f']);
if(after.tasks.task_426aeb0f.status==='failed')dag(['retry','--id','task_426aeb0f']);
const ledger=read(control,'dag.run.d/reliability/controller.json'),oldLedger=read(control,`${backup}/ledger-budget.json`);
for(const field of ['deadline','semanticCounts','infrastructureCounts'])if(JSON.stringify(ledger[field])!==JSON.stringify(oldLedger[field]))throw Error(`Budget/history changed ${field}`);
const result={runId:initial.id,units:execution.units.length,completedPreserved:68,pending:execution.units.length-68,planningCommit:head,graphRevision:graphIdentity(loadRun(runFile)),modelPolicy:cfg.policy.workers,budgetsPreserved:true,appliedAt:new Date().toISOString()};
put(control,`${backup}/applied.json`,result);console.log(JSON.stringify(result,null,2));
