import { mkdtemp, rm, realpath, mkdir, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCamoufox } from './camoufox.mjs';
import { validateWorkflow, identity, executeStep, LIMITS } from './workflow.mjs';

export function bounded(p, ms, signal) {
  return new Promise((resolve,reject) => {
    const abort = () => finish(reject,Error('canceled'));
    const timer = setTimeout(() => finish(reject,Error('timeout')),Math.max(1,ms));
    function finish(fn,v) { clearTimeout(timer); signal?.removeEventListener('abort',abort); fn(v); }
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();
    Promise.resolve(p).then(v=>finish(resolve,v),e=>finish(reject,e));
  });
}
const methods = new Set(['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS']);
const resources = new Set(['document','stylesheet','image','media','font','script','xhr','fetch','websocket','other']);
/** @param {any} w @param {any} options */
export async function runWorkflow(w,{signal,deadline,poison,diagnosticProfile,prepare=prepareCamoufox} = {}) {
  validateWorkflow(w);
  const began=Date.now();
  deadline ??= began+(w.overallMs??LIMITS.overallMs);
  const report={version:1,identity:identity(w),configuration:{mode:w.start.mode,headless:!process.env.PI_BROWSER_HEADFUL,stepMs:w.stepMs??LIMITS.stepMs,overallMs:w.overallMs??LIMITS.overallMs},versions:{node:process.versions.node},outcomes:[],category:'success',evidence:{console:{},network:[]}};
  let context, profile, temporary=false, unsupported=false, page, artifacts;
  const remaining=()=>Math.max(1,deadline-Date.now());
  const phase=p=>bounded(p,remaining(),signal);
  const fail=e => e?.message==='canceled'?'canceled':e?.message==='unsupported-behavior'?'unsupported-behavior':e?.message==='ambiguity'||e?.message?.includes('strict mode violation')?'ambiguity':e?.message==='timeout'||e?.name==='TimeoutError'||e?.message==='assertion-timeout'?'timeout':'execution-failed';
  try {
    if (signal?.aborted) throw Error('canceled');
    if (Date.now()>=deadline) throw Error('timeout');
    const prepared=await phase(prepare({headless:report.configuration.headless}));
    report.versions={...report.versions,...prepared.versions};
    if (w.start.mode==='fresh') { profile=await mkdtemp(join(tmpdir(),'pi-workflow-')); temporary=true; }
    else {
      profile=await realpath(w.start.profile);
      const diagnostic=await realpath(diagnosticProfile).catch(()=>diagnosticProfile);
      if (profile===diagnostic) throw Error('profile-conflict');
    }
    // A late launch remains owned: its completion closes the context, and poisons
    // the instance if termination could not be confirmed within cleanup budget.
    const launch=prepared.firefox.launchPersistentContext(profile,{...prepared.options,timeout:remaining(),viewport:{width:1280,height:800}});
    let abandoned=false;
    launch.then(async c=>{ if (abandoned) { try { await c.close(); } catch {} } },()=>{});
    try { context=await phase(launch); } catch(e) { abandoned=true; poison(); report.cleanup='termination-unconfirmed; restart-required'; throw e; }
    page=context.pages()[0]??await phase(context.newPage());
    context.on('page',()=>{unsupported=true;});
    page.on('download',()=>{unsupported=true;});
    page.on('console',msg=>{
      const severity=['log','info','warning','error','debug'].includes(msg.type())?msg.type():'other';
      report.evidence.console[severity]=Math.min(1000,(report.evidence.console[severity]??0)+1);
    });
    page.on('response',res=>{
      if(report.evidence.network.length>=32)return;
      const req=res.request(), method=req.method(), resourceType=req.resourceType(), status=res.status();
      report.evidence.network.push({method:methods.has(method)?method:'OTHER',resourceType:resources.has(resourceType)?resourceType:'other',status:Number.isInteger(status)&&status>=100&&status<=599?status:0});
    });
    if(w.artifacts?.trace||w.artifacts?.screenshot) artifacts=await mkdtemp(join(tmpdir(),'pi-workflow-artifacts-'));
    if(w.artifacts?.trace) await phase(context.tracing.start({screenshots:true,snapshots:true}));
    for(let i=0;i<w.steps.length;i++){
      const start=Date.now();
      report.step=i;
      try {
        if(unsupported)throw Error('unsupported-behavior');
        await phase(executeStep(page,w.steps[i],Math.min(w.stepMs??LIMITS.stepMs,remaining())));
        if(unsupported)throw Error('unsupported-behavior');
        report.outcomes.push({step:i,category:'success',durationMs:Date.now()-start});
      } catch(e) { report.outcomes.push({step:i,category:fail(e),durationMs:Date.now()-start}); throw e; }
    }
  } catch(e) { report.category=fail(e); }
  finally {
    const evidenceEnd=Date.now()+LIMITS.cleanupMs;
    try {
      if(artifacts && report.category!=='success') {
        if(w.artifacts?.screenshot) await bounded(page.screenshot({path:join(artifacts,'failure.png'),timeout:LIMITS.cleanupMs}),LIMITS.cleanupMs);
        if(w.artifacts?.trace) await bounded(context.tracing.stop({path:join(artifacts,'trace.zip')}),Math.max(1,evidenceEnd-Date.now()));
        for(const file of ['failure.png','trace.zip']) {
          const path=join(artifacts,file);
          const info=await stat(path).catch(()=>null);
          if(info && info.size>16*1024*1024) {await rm(path);report.capture='size-limit';}
          else if(info) await chmod(path,0o600);
        }
        report.artifacts=artifacts;
      } else if(artifacts) { if(w.artifacts?.trace)await bounded(context.tracing.stop(),LIMITS.cleanupMs); await rm(artifacts,{recursive:true,force:true}); }
    }catch{report.capture='capture-failed';}
    if(context) {
      try { await bounded(context.close(),LIMITS.cleanupMs); }
      catch { poison(); report.cleanup='termination-unconfirmed; restart-required'; }
    }
    if(temporary && !report.cleanup) await rm(profile,{recursive:true,force:true}).catch(()=>{report.cleanup='profile-cleanup-failed';});
  }
  report.durationMs=Date.now()-began;
  return report;
}
