import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {sourceExports,checkInputs} from './analytics-input-contracts.mjs';
test('readiness rejects comments, types, missing bodies and missing producer values',()=>{
 const names=sourceExports('p.ts','// export function fake() {}\nexport interface Shape {}\nexport declare function absent(): void;\nexport function present() {}\nexport const provider = {};');
 assert.deepEqual([...names],['present','provider']);
 const dir=fs.mkdtempSync(path.join(tmpdir(),'dag-inputs-'));
 fs.writeFileSync(path.join(dir,'p.ts'),'export function ready() {}');
 const packet={consumes:[{owner:'producer',file:'p.ts',symbols:['ready']}]};
 assert.equal(checkInputs(dir,packet,'producer'),1);
 assert.throws(()=>checkInputs(dir,packet,'future'),/no exported/);
 packet.consumes[0].symbols=['futureFunction'];
 assert.throws(()=>checkInputs(dir,packet),/Missing producer producer/);
 packet.consumes[0].file='../outside.ts';
 assert.throws(()=>checkInputs(dir,packet),/escapes/);
});
