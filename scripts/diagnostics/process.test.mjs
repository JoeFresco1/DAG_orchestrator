import test from 'node:test';
import assert from 'node:assert/strict';
import {runRecoveryProcess} from './process.mjs';
test('real recovery subprocess preserves output and rejects failure',async()=>{
 const out=await runRecoveryProcess(process.execPath,['-e','console.log("verified process")'],{timeoutMs:5000});assert.match(out,/verified process/);
 await assert.rejects(runRecoveryProcess(process.execPath,['-e','process.exit(3)'],{timeoutMs:5000}),/exited 3/);
});
test('silent hung recovery is killed and never accepted',async()=>{
 const started=Date.now();await assert.rejects(runRecoveryProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:150}),/timeout/);assert.ok(Date.now()-started<10000);
});
