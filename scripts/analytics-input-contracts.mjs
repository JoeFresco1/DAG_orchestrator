import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export function sourceExports(file, text) {
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  if(source.parseDiagnostics.length)throw Error(`Invalid producer source: ${file}`);
  const values=new Set();
  for(const node of source.statements){
    if(!node.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))continue;
    if(ts.isFunctionDeclaration(node)&&node.name&&node.body)values.add(node.name.text);
    if(ts.isClassDeclaration(node)&&node.name)values.add(node.name.text);
    if(ts.isVariableStatement(node))for(const d of node.declarationList.declarations)if(d.initializer&&ts.isIdentifier(d.name))values.add(d.name.text);
  }
  return values;
}
export function checkInputs(root, packet, owner) {
  let checked=0;
  for(const input of packet.consumes.filter(i=>!owner||i.owner===owner)){
    const full=path.resolve(root,input.file),rel=path.relative(root,full);
    if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Input path escapes checkout');
    if(!fs.existsSync(full))throw Error(`Missing producer ${input.owner}: ${input.file}`);
    const names=sourceExports(input.file,fs.readFileSync(full,'utf8'));
    for(const name of input.symbols){if(!names.has(name))throw Error(`Missing producer ${input.owner}: ${input.file} export ${name}`);checked++;}
  }
  if(!checked)throw Error('Prerequisite probe selected no exported values');
  return checked;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [key,owner]=process.argv.slice(2);
  try {
    const packets=JSON.parse(fs.readFileSync('docs/build/task-handoffs.json','utf8'));
    if(!packets[key])throw Error('Unknown task handoff');
    console.log(`INPUT_EXPORTS PASS ${key}: ${checkInputs(process.cwd(),packets[key],owner)} exported values; behavioral acceptance remains required`);
  } catch(error){
    console.log('DAG_FAILURE: '+JSON.stringify({version:1,code:'ownership',stage:'preflight',owner,evidence:[error.message]}));
    process.exitCode=1;
  }
}
