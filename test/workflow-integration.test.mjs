import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extension from '../index.ts';
import { prepareCamoufox } from '../runtime/camoufox.mjs';
import { executeStep } from '../runtime/workflow.mjs';
import { runWorkflow } from '../runtime/workflow-run.mjs';
export const fixture='<label>User<input id="user"></label><label>Password<input type="password"></label><button onclick="localStorage.setItem(\'login\',\'yes\');document.querySelector(\'h1\').textContent=\'Verified\';console.error(\'private-password\')">Sign in</button><h1>Login</h1>';
test('local inline and named login, safe failure, artifacts and fresh isolation',{skip:!process.env.PI_CAMOUFOX_EXECUTABLE},async()=>{
 const server=createServer((_q,res)=>{res.setHeader('content-type','text/html');res.end(fixture);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;
 const w={version:1,start:{mode:'fresh'},stepMs:1000,steps:[{action:'goto',url},{action:'fill',target:{label:'User'},value:'private-user'},{action:'fill',target:{label:'Password'},value:'private-password'},{action:'click',target:{role:'button',name:'Sign in'}},{action:'expect',kind:'text',target:{css:'h1'},value:'Verified'}]};
 const root=await mkdtemp(join(tmpdir(),'workflow-local-'));
 try{
 let r=await runWorkflow(w,{poison:()=>assert.fail()});assert.equal(r.category,'success');
 const tools=new Map(),events=new Map();let command;
 extension({registerTool:t=>tools.set(t.name,t),on:(n,f)=>events.set(n,f),registerCommand:(_n,c)=>command=c.handler,getActiveTools:()=>[],setActiveTools(){},appendEntry(){}});
 const ctx={cwd:root,sessionManager:{getEntries:()=>[]},ui:{notify(){}}};await events.get('session_start')({},ctx);await command('on',ctx);
 const dir=join(root,'.pi/browser-workflows');await mkdir(dir,{recursive:true});
 const named={version:1,parameters:[{name:'password',type:'string',secret:true}],workflow:structuredClone(w)};named.workflow.steps[2].value={$param:'password'};await writeFile(join(dir,'login.json'),JSON.stringify(named));
 process.env.PI_WORKFLOW_TEST_PASSWORD='private-password';
 r=(await tools.get('browser_run').execute('test',{name:'login',parameters:{password:{env:'PI_WORKFLOW_TEST_PASSWORD'}}},undefined,undefined,ctx)).details;assert.equal(r.category,'success');
 const bad=structuredClone(w);bad.steps.push({action:'expect',kind:'text',target:{css:'h1'},value:'Wrong'});bad.artifacts={screenshot:true,trace:true};
 r=await runWorkflow(bad,{poison:()=>assert.fail()});assert.equal(r.category,'timeout');assert.equal(r.step,5);assert.ok(!JSON.stringify(r).includes('private-password'));assert.deepEqual((await readdir(r.artifacts)).sort(),['failure.png','trace.zip']);await rm(r.artifacts,{recursive:true});
 for(let i=0;i<2;i++){r=await runWorkflow({version:1,start:{mode:'fresh'},steps:[{action:'goto',url},{action:'expect',kind:'text',target:{css:'h1'},value:'Login'}]},{poison:()=>assert.fail()});assert.equal(r.category,'success');}
 await events.get('session_shutdown')();
 }finally{delete process.env.PI_WORKFLOW_TEST_PASSWORD;await rm(root,{recursive:true,force:true});await new Promise(r=>server.close(r));}
});

test('real semantic assertions and persistent ownership',{skip:!process.env.PI_CAMOUFOX_EXECUTABLE},async()=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-persistent-'));
 const profile=join(root,'selected');await mkdir(profile);
 const diagnostic=join(root,'diagnostic');await mkdir(diagnostic);
 const {firefox,options}=await prepareCamoufox();
 const context=await firefox.launchPersistentContext(profile,{...options,timeout:30000});
 try{
 const page=context.pages()[0];
 await page.setContent('<label>User<input></label><button>Save.*</button><button>Save.* extra</button><p> A   B </p><input type="checkbox" checked><button disabled>Off</button>');
 await executeStep(page,{action:'click',target:{role:'button',name:'Save.*'}},500);
 await assert.rejects(executeStep(page,{action:'click',target:{role:'button',name:'save.*'}},100));
 await executeStep(page,{action:'expect',kind:'text',target:{css:'p'},value:'A B'},500);
 await assert.rejects(executeStep(page,{action:'expect',kind:'text',target:{css:'p'},value:'A'},80));
 await executeStep(page,{action:'expect',kind:'checked',target:{css:'input[type=checkbox]'},value:true},500);
 await executeStep(page,{action:'expect',kind:'enabled',target:{role:'button',name:'Off'},value:false},500);
 await page.setContent('<button>Duplicate</button><button>Duplicate</button>');
 await assert.rejects(executeStep(page,{action:'click',target:{role:'button',name:'Duplicate'}},500));
 await page.setContent('<script>setTimeout(()=>{document.body.innerHTML="<label>Delayed<input></label>"},30)</script>');
 await executeStep(page,{action:'fill',target:{label:'Delayed'},value:'ok'},1000);
 await context.addCookies([{name:'retained',value:'yes',domain:'127.0.0.1',path:'/',expires:Math.floor(Date.now()/1000)+3600}]);
 const conflict=await runWorkflow({version:1,start:{mode:'persistent',profile},steps:[{action:'goto',url:'http://127.0.0.1/'}]},{diagnosticProfile:diagnostic,poison:()=>{}});
 assert.notEqual(conflict.category,'success');
 }finally{await context.close();}
 const reopened=await firefox.launchPersistentContext(profile,{...options,timeout:30000});
 try{assert.equal((await reopened.cookies()).find(c=>c.name==='retained')?.value,'yes');}finally{await reopened.close();}
 await rm(root,{recursive:true,force:true});
});
