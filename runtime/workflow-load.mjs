import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fields, validateWorkflow, LIMITS } from './workflow.mjs';
export async function loadWorkflow(root,name,inputs={},env=process.env) {
  if(typeof name!=='string'||! /^[a-zA-Z0-9_-]{1,64}$/.test(name))throw Error('invalid-workflow');
  const directory=await realpath(join(root,'.pi/browser-workflows'));
  const file=await realpath(join(directory,name+'.json'));
  if(!file.startsWith(directory+sep))throw Error('invalid-workflow');
  const handle=await open(file,constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes;
  try {
    if (!(await handle.stat()).isFile()) throw Error('invalid-workflow');
    const buffer=Buffer.alloc(LIMITS.bytes+1);
    const result=await handle.read(buffer,0,buffer.length,0);
    bytes=buffer.subarray(0,result.bytesRead);
  } finally { await handle.close(); }
  if(bytes.length>LIMITS.bytes)throw Error('invalid-workflow');
  const source=JSON.parse(bytes.toString());
  fields(source,['version','parameters','workflow']);
  if(source.version!==1||!Array.isArray(source.parameters))throw Error('invalid-workflow');
  if (!inputs || typeof inputs!=='object' || Array.isArray(inputs)) throw Error('invalid-workflow');
  const values=new Map(), secrets=new Set();
  for(const p of source.parameters){
    fields(p,['name','type'],['secret']);
    if(typeof p.name!=='string'||values.has(p.name)||!['string','number','boolean'].includes(p.type)||('secret'in p&&typeof p.secret!=='boolean'))throw Error('invalid-workflow');
    if (!Object.hasOwn(inputs,p.name)) throw Error('invalid-workflow');
    let v=inputs[p.name];
    if(p.secret) {
      if(p.type!=='string')throw Error('invalid-workflow');
      fields(v,['env']);
      if(typeof v.env!=='string'||!Object.hasOwn(env,v.env))throw Error('invalid-workflow');
      v=env[v.env]; secrets.add(p.name);
    }
    if(typeof v!==p.type||p.type==='number'&&!Number.isFinite(v))throw Error('invalid-workflow');
    values.set(p.name,v);
  }
  if(Object.keys(inputs).some(k=>!values.has(k)))throw Error('invalid-workflow');
  function resolve(v,path=[]){
    if(v&&typeof v==='object'&&!Array.isArray(v)&&'$param'in v){
      fields(v,['$param']);
      if(!values.has(v.$param))throw Error('invalid-workflow');
      if(secrets.has(v.$param)&&!(path.length===3&&path[0]==='steps'&&path[2]==='value'&&source.workflow.steps[path[1]].action==='fill'))throw Error('invalid-workflow');
      return values.get(v.$param);
    }
    if(Array.isArray(v))return v.map((x,i)=>resolve(x,[...path,i]));
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x,[...path,k])]));
    return v;
  }
  return validateWorkflow(resolve(source.workflow));
}
