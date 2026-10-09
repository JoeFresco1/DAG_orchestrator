import {flagRequired,flag,parseList} from '../cli-args.js';
export async function reliableCmd(argv:string[]):Promise<void> {
 // @ts-expect-error Packaged controller is maintained as an executable JS module.
 const {reliable}=await import('../../scripts/reliability/controller.mjs');
 const action=argv[0]||'status';
 const hours=flag(argv,'hours');
 const result=await reliable(action,flagRequired(argv,'config'),{reason:flag(argv,'reason'),release:parseList(flag(argv,'release')),wallMs:hours===undefined?undefined:Number(hours)*3600000});
 console.log(JSON.stringify(result,null,2));
 if(['run','resume'].includes(action)&&(Object.keys(result.suspended||{}).length||result.unfinished))process.exitCode=1;
}
