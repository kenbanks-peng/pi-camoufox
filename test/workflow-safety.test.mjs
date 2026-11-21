import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {stat,rm} from 'node:fs/promises';
import {runWorkflow} from '../runtime/workflow-run.mjs';
const flow=()=>({version:1,start:{mode:'fresh'},stepMs:20,steps:[{action:'click',target:{css:'button'}}]});
function fake({closeHang=false,event,delay=100}={}){
 const page=new EventEmitter(),context=new EventEmitter();let profile;
 page.locator=()=>({click:async()=>{if(['popup','download'].includes(event))setImmediate(()=>event==='download'?page.emit('download'):context.emit('page'));await new Promise(r=>setTimeout(r,delay));},count:async()=>1,isEnabled:async()=>{await new Promise(r=>setTimeout(r,delay));return true;}});
 context.pages=()=>[page];context.close=async()=>{if(closeHang)await new Promise(()=>{});};
 return {get profile(){return profile;},prepare:async()=>({options:{},versions:{},firefox:{launchPersistentContext:async p=>{profile=p;return context;}}})};
}
test('whole step deadline, running cancellation and unsupported events',async()=>{
 for(const mode of ['deadline','cancel','popup','download']){
 const f=fake({event:mode});const controller=new AbortController();let timer;
 if(mode==='cancel')timer=setTimeout(()=>controller.abort(),10);
 const w=flow();if(mode==='deadline')w.steps=[{action:'expect',kind:'enabled',target:{css:'button'},value:true}];
 const r=await runWorkflow(w,{prepare:f.prepare,signal:controller.signal,poison:()=>assert.fail()});
 clearTimeout(timer);assert.equal(r.category,mode==='deadline'?'timeout':mode==='cancel'?'canceled':'unsupported-behavior');
 }
});
test('cleanup timeout retains potentially owned profile and poisons instance',async()=>{
 const f=fake({closeHang:true,delay:1});let poisoned=false;
 const r=await runWorkflow(flow(),{prepare:f.prepare,poison:()=>{poisoned=true;}});
 assert.equal(r.category,'success');assert.equal(poisoned,true);assert.match(r.cleanup,/restart-required/);await stat(f.profile);
 // Fake has no process; independently confirmed safe for test cleanup.
 await rm(f.profile,{recursive:true,force:true});
});
test('launch timeout fails closed and late context is closed',async()=>{
 let closed=false,poisoned=false;
 const r=await runWorkflow(flow(),{deadline:Date.now()+10,poison:()=>poisoned=true,prepare:async()=>({options:{},firefox:{launchPersistentContext:async()=>{await new Promise(r=>setTimeout(r,30));return {close:async()=>closed=true};}}})});
 assert.equal(r.category,'timeout');assert.equal(poisoned,true);await new Promise(r=>setTimeout(r,40));assert.equal(closed,true);
});
