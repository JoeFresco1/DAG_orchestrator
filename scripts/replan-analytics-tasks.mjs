import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { loadRun } from '../dist/store.js';
import { changes, exportsByLabel, retainedReasons } from './analytics-replan-blueprint.mjs';

const [target, control] = process.argv.slice(2).map(x => path.resolve(x));
if (!target || !control || target === control) throw Error('Use separate planning and control checkouts');
const read = p => JSON.parse(fs.readFileSync(path.join(target,p),'utf8'));
const write = (p,value) => { const f=path.join(target,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n'); };
const sha = text => createHash('sha256').update(text).digest('hex');
const run=loadRun(path.join(control,'dag.run.json'));
if(Object.values(run.tasks).some(t=>t.status==='running') || fs.existsSync(path.join(control,'dag.run.d/reliability/controller.lock'))) throw Error('Stop controller/runner first');
const original=JSON.parse(fs.readFileSync(path.join(control,'docs/build/run-manifest.json'),'utf8'));
const prior=read('docs/build/execution-graph.json'), graph=read('docs/build/graph.json');
const completed=new Set(prior.units.filter(u=>run.tasks[original.nodeIds[u.key]]?.status==='completed').map(u=>u.key));
if(completed.size!==68) throw Error('Expected reviewed 68-task baseline; review new progress before applying');
if(fs.existsSync(path.join(target,'docs/build/dependency-replan.json'))) throw Error('Already generated');
const originalTaskText={}, replacements=[], decisions=[], plannedExports={};
const prose = text => {
 const found=[...text.matchAll(/^- \[([ xX])\] (T\d+)\b/gm)];
 return new Map(found.map((m,i)=>[m[2],{checked:m[1],body:text.slice(m.index,found[i+1]?.index??text.length).split(/\n##? /)[0].trim()}]));
};
for(const node of graph.nodes.filter(n=>n.key!=='00')){
 const dir=node.feature||`docs/build/task-plans/${node.key}`;
 const plan=read(`${dir}/execution.json`), old=plan.units;
 const frozen=old.filter(u=>completed.has(`${node.key}-${u.id}`));
 if(frozen.length===old.length) continue;
 const text=fs.readFileSync(path.join(target,dir,'tasks.md'),'utf8');
 originalTaskText[node.key]=text;
 const tasks=prose(text), assigned=new Map(old.flatMap(u=>u.taskIds.map(t=>[t,u])));
 const b=changes[node.key]||{}, labels=new Map(), fileOverrides=new Map(), newIds=[], replace=new Map();
 let next=Math.max(...[...tasks.keys()].map(t=>+t.slice(1)))+1;
 const allocate=()=>`T${String(next++).padStart(3,'0')}`;
 for(const [oldId,pieces] of Object.entries(b.splits||{})){
  if(frozen.some(u=>u.taskIds.includes(oldId))) throw Error('Attempt to split accepted task');
  const ids=pieces.map((_,i)=>i?allocate():oldId), priorText=tasks.get(oldId).body;
  pieces.forEach(([label,body],i)=>{const id=ids[i];labels.set(label,id);newIds.push(id);tasks.set(id,{checked:' ',body:`- [ ] ${id} ${body}`});assigned.set(id,assigned.get(oldId));});
  replace.set(oldId,ids);replacements.push({feature:node.key,oldTask:oldId,original:priorText,replacementTasks:ids,boundaries:pieces.map(p=>p[0])});
  for(const field of ['requirementTasks','successTasks','edgeCaseTasks'])for(const ref of Object.keys(plan[field]))plan[field][ref]=[...new Set(plan[field][ref].flatMap(t=>t===oldId?ids:[t]))];
 }
 for(const [label,body,files] of b.additions||[]){
  const id=allocate();labels.set(label,id);newIds.push(id);fileOverrides.set(id,files);tasks.set(id,{checked:' ',body:`- [ ] ${id} ${body}`});
  const refs=label==='runtime-contract'?['FR-001','FR-002']:label==='worker-invocation'?['FR-001','FR-013']:label==='lifecycle-dispatch'?['FR-003','FR-010']:Object.keys(plan.requirementTasks);
  for(const ref of refs)plan.requirementTasks[ref]=[...new Set([...plan.requirementTasks[ref],id])];
  for(const ref of label==='runtime-composition'?Object.keys(plan.successTasks):['SC-006']) if(plan.successTasks[ref])plan.successTasks[ref]=[...new Set([...plan.successTasks[ref],id])];
  node.outputs.push(...files.filter(f=>!node.outputs.includes(f)));
 }
 const resolveToken=t=>labels.get(t.replace(/^@/,''))||t;
 const selections=b.order?b.order.map(v=>(Array.isArray(v)?v:[v]).map(resolveToken)):old.filter(u=>!frozen.includes(u)).map(u=>u.taskIds);
 const units=[...frozen];
 for(const ids of selections){
  if(ids.some(id=>!tasks.has(id)))throw Error(`Unknown selection ${node.key}:${ids}`);
  const oldExact=old.find(u=>u.taskIds.join()===ids.join()&&!replace.has(ids[0]));
  const label=[...labels].find(([,id])=>ids.length===1&&id===ids[0])?.[0];
  const id=oldExact?.id||label||`scope-${ids.map(x=>x.toLowerCase()).join('-')}`;
  const key=`${node.key}-${id}`, final=selections.indexOf(ids)===selections.length-1;
  const testFile=`src/analytics/acceptance/${node.key}.test.ts`;
  const files=[...new Set(ids.flatMap(t=>fileOverrides.get(t)||assigned.get(t)?.files||[]))];
  if(!files.includes(testFile))files.push(testFile);
  if(final&&!files.includes(`${dir}/verification.md`)&&node.feature)files.push(`${dir}/verification.md`);
  // New 003 runtime glue belongs only to the boundaries implementing it.
  const scope=ids.map(t=>tasks.get(t).body).join('\n\n');
  const finalCommands=old.at(-1).acceptance;
  const acceptance=final?finalCommands:[{program:'pnpm',args:['build']},{program:'node',args:['scripts/build/check-scope.mjs',key,testFile]}];
  const extra=node.key==='003'&&ids.includes('T005')?'Consume createDelegatedRuntimeV1/runDelegatedInquiryV1 from runtime.ts; the runtime now exists. Implement frozen CLI parsing and viewer routing only. Delegate other registered extension commands to dispatchAnalyticsCommandV1.':
   node.key==='015'&&ids.includes('T002')?'Only compatibility predicate tests belong here; cold/warm production orientation tests T001 execute with T003/T004 in the next unit.':
   node.key==='023'&&ids.includes('T001')?'Scaffold validation through the existing registry is the acceptance here. Timeline behavior is tested with T002/T003 after the projection is implemented.':
   node.key==='018'&&ids.includes('T004')?'Validate pre-batch request/approval/comparison inputs using existing bootstrap registry records and synthetic candidate batch inputs. Do not require the later evaluator to run before validating its setup.':
   node.key==='99'&&ids.includes('T001')?'Inventory only. Exact completed integration-path evidence is owned by T002 after the live journeys. Do not require future 99 evidence here.':'';
  const instructions=`Assigned boundary:\n${scope}\n\nRead docs/build/task-handoffs.json entry ${key} and its referenced source interfaces. ${extra}\nBuild only these IDs against their declared producers. New test cases and their implementation belong in this unit; do not add failing future tests. Existing accepted assertions remain unchanged. Use scope:${key}: test names, including awaited child cases. Scope acceptance must execute nonzero tests. ${final?'Run complete original feature acceptance, live/browser journeys when required, and record all FR/SC/edge evidence.':'Review this production boundary and declared failure cases; later integration obligations stay with their named owners.'} Preserve all frozen product requirements. If a consumed capability is absent, identify its exact producer and symbol; do not fabricate authority or repeatedly request an already authorized file. Record exact outputs in ${dir}/unit-verification/${id}.md. The coordinator alone amends the graph.`;
  units.push({id,title:label?label.replaceAll('-',' '):oldExact?.title||`${ids.join(' + ')}: ${scope.split('\n')[0].replace(/^- \[[ xX]\] T\d+\s*/,'').slice(0,105)}`,taskIds:ids,dependsOn:units.length?[units.at(-1).id]:[],files,instructions,acceptance});
  if(exportsByLabel[label])plannedExports[key]=exportsByLabel[label].map(([file,name])=>({file,name}));
 }
 const actual=units.flatMap(u=>u.taskIds);
 if(actual.length!==tasks.size || new Set(actual).size!==tasks.size)throw Error(`Incomplete/duplicate task ownership: ${node.key}`);
 plan.units=units;
 write(`${dir}/execution.json`,plan);
 write(`${dir}/tasks.md`,[`# Tasks: ${node.title||node.key}`,'', '## Execution amendment — 2026-10-09','', 'The unit order below and execution.json supersede earlier checklist ordering. Product spec.md, shared interfaces, thresholds and original final acceptance remain unchanged. Original task text and exact split mappings are retained in docs/build/dependency-replan.json. Completed tasks retain their recorded state. Every implementation unit includes its own passing positive and failure controls; fixtures for later production paths run with their producers.','',...units.flatMap(u=>[`## ${u.id}`,'',...u.taskIds.map(t=>tasks.get(t).body),'']), '## Dependencies','', '| Unit | Depends on |','| --- | --- |',...units.map(u=>`| ${u.id} | ${u.dependsOn.join(', ')||'Completed feature prerequisites'} |`),''].join('\n'));
 for(const u of old.filter(u=>!frozen.includes(u))){
  const expanded=u.taskIds.flatMap(t=>replace.get(t)||[t]);
  const nextUnits=units.filter(n=>n.taskIds.some(t=>expanded.includes(t))).map(n=>`${node.key}-${n.id}`);
  decisions.push({previousUnit:`${node.key}-${u.id}`,originalTasks:u.taskIds,decision:nextUnits.length>1?'split':nextUnits[0]===`${node.key}-${u.id}`?'retain/reorder':'regroup',newUnits:nextUnits,reason:b.rationale||retainedReasons[node.key]||'One owned production behavior with its own positive and failure controls, followed by final feature acceptance.',boundary:u.title});
 }
}
write('docs/build/graph.json',graph);
// The compiler already provides strict checklist and cross-feature ownership
// validation. Run it here on the amended manifests, then protect accepted units.
const previousCwd=process.cwd();process.chdir(target);
const {compileTasks}=await import(pathToFileURL(path.join(target,'scripts/build/compile-tasks.mjs')));
const compiled=compileTasks();process.chdir(previousCwd);
for(const unit of compiled.units.filter(u=>completed.has(u.key))){
 const before=prior.units.find(u=>u.key===unit.key);
 for(const field of ['taskIds','files','instructions','acceptance','deps'])if(JSON.stringify(unit[field])!==JSON.stringify(before[field]))throw Error(`Accepted unit changed ${unit.key}:${field}`);
}

// Export availability is an early prerequisite gate, not a replacement for
// behavioral acceptance. Report that distinction explicitly in every packet.
function exportNames(file){
 const full=path.join(target,file);if(!fs.existsSync(full)||!file.endsWith('.ts'))return [];
 const src=ts.createSourceFile(file,fs.readFileSync(full,'utf8'),ts.ScriptTarget.Latest,true);
 return src.statements.flatMap(n=>{
  if(!n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))return [];
  if(ts.isFunctionDeclaration(n)&&n.name&&n.body)return [n.name.text];
  if(ts.isVariableStatement(n))return n.declarationList.declarations.map(d=>d.name.getText(src));
  return [];
 });
}
const byKey=new Map(compiled.units.map(u=>[u.key,u]));
const packets={};
for(const unit of compiled.units){
 if(completed.has(unit.key))continue;
 const ancestors=new Set();const visit=k=>{for(const d of byKey.get(k).deps){if(!ancestors.has(d)){ancestors.add(d);visit(d);}}};visit(unit.key);
 const dependencies=unit.deps.map(key=>({key,role:'producer-before-consumer',contract:`Accepted ${key} with its declared outputs and boundary checks`}));
 const consumes=[];
 // Always carry actual, already accepted interface names from relevant producer
 // files, bounded to the named exported entry points (full source is linked).
 for(const dep of unit.deps){const u=byKey.get(dep);for(const file of u.files.filter(f=>f.endsWith('.ts')&&!f.includes('/acceptance/'))){
  const names=exportNames(file);if(names.length)consumes.push({owner:dep,file,symbols:names,level:'export-availability'});
 }}
 for(const [owner,exports] of Object.entries(plannedExports))if(ancestors.has(owner))for(const e of exports)consumes.push({owner,file:e.file,symbols:[e.name],level:'export-availability'});
 // Feature providers are optional before their feature completes. Once a
 // consumer explicitly depends on that feature, its registered facade is required.
 const providers={ '019':['catalog.ts'], '023':['ledger.ts'], '020':['retrieval.ts'], '014':['source-discovery.ts'], '015':['skill-refresh.ts'], '021':['skill-capture.ts'], '022':['skill-activation.ts'], '016':['recurrence.ts'], '017':['authorization.ts'], '006':['inferential.ts'] };
 for(const dep of unit.deps){const u=byKey.get(dep);if(u.featureKey===unit.featureKey||!u.final)continue;for(const f of providers[u.featureKey]||[])consumes.push({owner:dep,file:'src/analytics/'+f,symbols:['analyticsExtensionV1'],level:'export-availability'});}
 packets[unit.key]={version:1,behavior:unit.title,taskIds:unit.taskIds,dependencies,consumes,produces:plannedExports[unit.key]||[],ownedFiles:unit.files,acceptance:unit.acceptance,reviewBoundary:unit.instructions,worker:{model:'gpt-6-luna',reasoning:'xhigh'},laterOwners:compiled.units.filter(u=>u.featureKey===unit.featureKey&&u.deps.includes(unit.key)).map(u=>u.key),guarantee:'Prerequisite probes check source/export availability. Type checking and task behavioral acceptance remain mandatory; a probe does not certify semantic correctness.'};
}
write('docs/build/task-handoffs.json',packets);
const audit={version:1,runId:run.id,base:'34f5703ecee28b4bbd1f54123678ce126190c0fc',createdAt:new Date().toISOString(),completed:[...completed],previousUnits:prior.units.length,units:compiled.units.length,previousTasks:prior.taskMapping.length,tasks:compiled.taskMapping.length,originalTaskText,replacements,decisions,addedUnits:Object.keys(plannedExports),unchangedProductSpecifications:true,modelPolicy:'Luna xhigh x3 -> Sol 6.1 medium x3 -> Sol 6.1 xhigh x4; no Astra/Terra'};
if(decisions.length!==prior.units.length-completed.size)throw Error('Audit omitted a pending unit');
write('docs/build/dependency-replan.json',audit);
write('docs/build/dependency-replan.md',['# Dependency and task amendment — 2026-10-09','',`Reviewed all ${decisions.length} remaining units. Preserved ${completed.size} accepted units. ${prior.units.length} units become ${compiled.units.length}; all original obligations retain mapped owners.`, '', '## Critical order','', '003: runtime contract → worker transport → budget → lifecycle dispatcher → stage admission → lineage → prediction/checks → report bindings → exposure/replacement → durable finalization → runtime composition → CLI → integration fixtures → full verification.','', '015: compatibility → production reuse with cold/warm tests → drift/refresh → lifecycle → full verification.','', '023: registry scaffold → projection with timeline tests → production hooks/command → repeat orientation → full verification.','', '018: pre-batch validation → worker batch → scoring → release → complete evidence.','', '99: inventory → integrated/live journeys → quickstart → complete evidence matrix → release.','', '## Audit of every remaining unit','', '| Previous unit | Decision | New owners | Reason |','| --- | --- | --- | --- |',...decisions.map(d=>`| ${d.previousUnit} | ${d.decision} | ${d.newUnits.join(', ')} | ${d.reason} |`),'','## Execution guarantees','', 'task-handoffs.json records consumed and produced symbols, producers, ownership, acceptance and later owners. Source/export availability probes run before admission; behavioral checks remain required. Shared-file work stays serialized. Product requirements and full acceptance are unchanged. Source snapshots and mappings in dependency-replan.json preserve the exact prior obligations. Runtime tasks are amended only through the CLI; accepted task state and historical attempt counters remain intact.',''].join('\n'));
console.log(JSON.stringify({before:prior.units.length,after:compiled.units.length,completed:completed.size,pendingAudit:decisions.length,replacements:replacements.length,packets:Object.keys(packets).length}));
