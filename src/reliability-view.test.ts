import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {newRun,saveRun,runPaths} from './store.js';
import {reliabilityView} from './server-view.js';

test('viewer shows controller evidence and inactive state without claiming a live process',()=>{
 const directory=mkdtempSync(join(tmpdir(),'dag-controller-view-')),file=join(directory,'custom.json');const run=newRun('viewer');saveRun(run,file);
 const sidecar=join(runPaths(file).dir,'reliability');mkdirSync(sidecar,{recursive:true});
 writeFileSync(join(sidecar,'controller.json'),JSON.stringify({deadline:Date.now()+10000,active:{stage:'review',taskId:'task_one'},suspended:{task_two:{reason:'quota'}},attempts:{},incidents:{}}));
 const view=reliabilityView(file);assert.equal(view?.running,false);assert.equal(view?.stage,'review');assert.equal(view?.taskId,'task_one');
});

test('ordinary CLI dispatch cannot bypass a live controller lease with force',()=>{
 const directory=mkdtempSync(join(tmpdir(),'dag-controller-lock-')),file=join(directory,'custom.json');saveRun(newRun('lock'),file);
 const sidecar=join(runPaths(file).dir,'reliability');mkdirSync(sidecar,{recursive:true});
 writeFileSync(join(sidecar,'controller.lock'),JSON.stringify({token:'fixture-token',owner:{pid:process.pid}}));
 const result=spawnSync(process.execPath,['dist/cli.js','run','--file',file,'--force'],{encoding:'utf8',windowsHide:true});
 assert.notEqual(result.status,0);assert.match(result.stderr,/owns dispatch/);
});
