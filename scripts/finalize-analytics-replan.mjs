import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {sourceExports} from './analytics-input-contracts.mjs';
const [root]=process.argv.slice(2).map(p=>path.resolve(p));
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const write=(p,v)=>fs.writeFileSync(path.join(root,p),typeof v==='string'?v:JSON.stringify(v,null,2)+'\n');
const graph=read('docs/build/graph.json'),audit=read('docs/build/dependency-replan.json'),packets=read('docs/build/task-handoffs.json');
const additional={
 '003-scope-t011-t012': ['src/analytics/controller.ts','assessDelegatedInquiryBudgetV1','Test this controller budget/outcome entry point with injected committed facts and real 012 budget/outcome services. Do not require the later runtime or CLI to exist for these focused tests. Full stopping journeys run after runtime composition.'],
 '003-scope-t008': ['src/analytics/controller.ts','observeInquiryContextV1','Bind observed outcome material to the real 008 exposure APIs before context delivery; preserve the accepted orientation behavior.'],
 '003-scope-t009': ['src/analytics/worker.ts','buildReplacementWorkerContextV1','Consume accepted context/exposure services without invoking later runtime composition.'],
 '003-scope-t010': ['src/analytics/controller.ts','finalizeDelegatedInquiryV1','Use actual 009 storage and injected hook services; runtime composition and CLI invocation are later consumers.'],
 '003-scope-t005': ['src/analytics/cli.ts','analyticsCmd','Consume the completed runtime composition and dispatch services; do not rebuild the executor.'],
};
for(const node of graph.nodes.filter(n=>n.key!=='00')){
 const dir=node.feature||`docs/build/task-plans/${node.key}`, plan=read(`${dir}/execution.json`);
 for(const u of plan.units){const key=`${node.key}-${u.id}`, a=additional[key];if(!a)continue;
  const text=`\nExplicit handoff: export ${a[1]} from ${a[0]}. ${a[2]}`;
  if(!u.instructions.includes(text))u.instructions+=text;
  packets[key].produces=[{file:a[0],name:a[1]}];packets[key].reviewBoundary=u.instructions;
 }
 write(`${dir}/execution.json`,plan);
}
const prev=process.cwd();process.chdir(root);
const {compileTasks}=await import(pathToFileURL(path.join(root,'scripts/build/compile-tasks.mjs')));
const execution=compileTasks();process.chdir(prev);
const byKey=new Map(execution.units.map(u=>[u.key,u]));
const core={
 'src/analytics/principals.ts':['resolvePrincipal','requireGrant'],
 'src/analytics/publication.ts':['commitEvidence','commitProjectMemory','recoverProjectMemory'],
 'src/analytics/stages.ts':['executeStageV1'],
 'src/analytics/inquiry.ts':['admitProposalV1','resolveInquiryOutcomeV1'],
 'src/analytics/predictive.ts':['computeAnalytics'],
 'src/analytics/extensions.ts':['loadAnalyticsExtensionsV1'],
 'src/analytics/controller.ts':['orientInquiryV1'],
};
for(const u of execution.units){const p=packets[u.key];if(!p)continue;
 const ancestors=new Set();const visit=k=>{for(const d of byKey.get(k).deps)if(!ancestors.has(d)){ancestors.add(d);visit(d);}};visit(u.key);
 for(const [key,other] of Object.entries(packets))if(ancestors.has(key))for(const e of other.produces)p.consumes.push({owner:key,file:e.file,symbols:[e.name],level:'export-availability'});
 for(const [file,symbols] of Object.entries(core)){
  const owner=execution.units.findLast(v=>ancestors.has(v.key)&&audit.completed.includes(v.key)&&v.files.includes(file));
  if(!owner)continue;
  const names=sourceExports(file,fs.readFileSync(path.join(root,file),'utf8'));
  for(const name of symbols)if(!names.has(name))throw Error(`Accepted API differs: ${file}:${name}`);
  p.consumes.push({owner:owner.key,file,symbols,level:'export-availability'});
 }
 p.consumes=[...new Map(p.consumes.map(i=>[JSON.stringify(i),i])).values()];
 for(const c of p.consumes)if(!ancestors.has(c.owner))throw Error(`Consumer before producer: ${u.key} -> ${c.owner}`);
 p.dependencies=u.deps.map(key=>({key,role:'producer-before-consumer',contract:`Accepted ${key} with its declared outputs and boundary checks`}));
 p.reviewBoundary=u.instructions;
}
write('docs/build/task-handoffs.json',packets);
// Only coordinator planning artifacts may change existing frozen hashes.
const lock=read('docs/build/contract-lock.json'), changed=[];
for(const [file,expected] of Object.entries(lock)){
 const bytes=fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n'),actual=createHash('sha256').update(bytes).digest('hex');
 if(actual===expected)continue;
 if(!['docs/build/graph.json','docs/build/execution-graph.json','docs/build/task-to-dag.md'].includes(file)&&!file.endsWith('/execution.json'))throw Error(`Product contract/tooling changed unexpectedly: ${file}`);
 changed.push({file,previous:expected,digest:actual});lock[file]=actual;
}
for(const file of ['docs/build/dependency-replan.json','docs/build/dependency-replan.md','docs/build/task-handoffs.json'])lock[file]=createHash('sha256').update(fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n')).digest('hex');
write('docs/build/contract-lock.json',lock);
const changedFiles=spawnSync('git',['diff','--name-only'],{cwd:root,encoding:'utf8'}).stdout.trim().split(/\r?\n/);
if(changedFiles.some(f=>f.startsWith('src/')||f.endsWith('/spec.md')||f.includes('/contracts/')))throw Error('Planning touched product behavior or requirements');
const completedUnits=execution.units.filter(u=>audit.completed.includes(u.key));
if(completedUnits.length!==68||audit.decisions.length!==96)throw Error('Preservation/audit count mismatch');
console.log(JSON.stringify({units:execution.units.length,completed:completedUnits.length,audited:audit.decisions.length,handoffs:Object.keys(packets).length,consumedBindings:Object.values(packets).reduce((n,p)=>n+p.consumes.length,0),frozenPlanningUpdates:changed.map(c=>c.file),productSourceAndSpecsUntouched:true},null,2));
