import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateWorkflow, identity, executeStep, locator } from '../runtime/workflow.mjs';
import { runWorkflow } from '../runtime/workflow-run.mjs';
import { loadWorkflow } from '../runtime/workflow-load.mjs';
const flow=()=>({version:1,start:{mode:'fresh'},steps:[{action:'fill',target:{label:'Password'},value:'sentinel-secret'}]});
test('strict contract and fill-independent identity',()=>{
 const w=flow(); validateWorkflow(w);
 assert.equal(identity(w),identity({...w,steps:[{...w.steps[0],value:'different-secret'}]}));
 assert.notEqual(identity(w),identity({...w,start:{mode:'persistent',profile:'/tmp/selected'}}));
 for(const mutate of [w=>w.version=2,w=>w.extra=true,w=>w.steps[0].target.css='x',w=>w.steps[0].frame='x',w=>w.steps=Array(101).fill(w.steps[0]),w=>w.stepMs=0,w=>w.start.mode='implicit']) {
   const v=flow();mutate(v);assert.throws(()=>validateWorkflow(v));
 }
});
test('semantic exact locator construction and assertion cardinality',async()=>{
 const calls=[];
 const page={getByRole:(...x)=>calls.push(x),getByLabel:(...x)=>calls.push(x),getByTestId:(...x)=>calls.push(x)};
 locator(page,{role:'button',name:'Save.*'});locator(page,{label:'User'});locator(page,{testId:'x'});
 assert.deepEqual(calls,[['button',{name:'Save.*',exact:true}],['User',{exact:true}],['x']]);
 await assert.rejects(executeStep({locator:()=>({count:async()=>2})},{action:'expect',kind:'visible',target:{css:'x'},value:true},20),/ambiguity/);
 await executeStep({locator:()=>({count:async()=>0})},{action:'expect',kind:'visible',target:{css:'x'},value:false},20);
});
function fake({fillError=false,closeHang=false}={}) {
 let profile,closed=false;
 const page={on(){},getByLabel:()=>({fill:async()=>{if(fillError)throw Error('sentinel-secret');}})};
 const context={pages:()=>[page],on(){},close:async()=>{if(closeHang)await new Promise(()=>{});closed=true;}};
 return {prepare:async()=>({firefox:{launchPersistentContext:async p=>{profile=p;return context;}},options:{},versions:{playwright:'test'}}),get profile(){return profile;},get closed(){return closed;}};
}
test('run owns fresh profile and safe ordered failure reports',async()=>{
 for(const fillError of [false,true]){
 const f=fake({fillError});
 const report=await runWorkflow(flow(),{prepare:f.prepare,poison:()=>assert.fail()});
 assert.equal(report.category,fillError?'execution-failed':'success');assert.equal(report.outcomes.length,1);
 assert.ok(!JSON.stringify(report).includes('sentinel-secret'));assert.equal(f.closed,true);
 await assert.rejects(import('node:fs/promises').then(fs=>fs.stat(f.profile)));
 }
});
test('preparation deadline is bounded',async()=>{
 const report=await runWorkflow(flow(),{deadline:Date.now()+20,prepare:()=>new Promise(()=>{}),poison:()=>assert.fail()});
 assert.equal(report.category,'timeout');
});
test('named snapshot, typed env secrets, escape and placements',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-test-'));const dir=join(root,'.pi/browser-workflows');await mkdir(dir,{recursive:true});
 const source={version:1,parameters:[{name:'password',type:'string',secret:true}],workflow:flow()};source.workflow.steps[0].value={$param:'password'};
 try{
 await writeFile(join(dir,'login.json'),JSON.stringify(source));
 const w=await loadWorkflow(root,'login',{password:{env:'TEST_SECRET'}},{TEST_SECRET:'private'});
 await writeFile(join(dir,'login.json'),'{}');assert.equal(w.steps[0].value,'private');
 for(const path of ['url','target','profile','assertion']) {
 const bad=structuredClone(source);
 if(path==='url')bad.workflow.steps=[{action:'goto',url:{$param:'password'}}];
 if(path==='target')bad.workflow.steps[0].target={label:{$param:'password'}};
 if(path==='profile')bad.workflow.start={mode:'persistent',profile:{$param:'password'}};
 if(path==='assertion')bad.workflow.steps=[{action:'expect',kind:'text',target:{css:'h1'},value:{$param:'password'}}];
 await writeFile(join(dir,'bad.json'),JSON.stringify(bad));
 await assert.rejects(loadWorkflow(root,'bad',{password:{env:'TEST_SECRET'}},{TEST_SECRET:'private'}));
 }
 await assert.rejects(loadWorkflow(root,'../login',{}));
 await writeFile(join(root,'outside.json'),JSON.stringify(source));await symlink(join(root,'outside.json'),join(dir,'escape.json'));await assert.rejects(loadWorkflow(root,'escape',{}));
 }finally{await rm(root,{recursive:true,force:true});}
});
