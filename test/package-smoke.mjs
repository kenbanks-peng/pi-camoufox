import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root=await mkdtemp(join(tmpdir(),'pi-camoufox-consumer-'));
try {
 const packed=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',root],{encoding:'utf8'}))[0];
 for(const file of ['index.ts','runtime/workflow.mjs','runtime/workflow-run.mjs','runtime/workflow-load.mjs','runtime/options.py','WORKFLOWS.md'])if(!packed.files.some(f=>f.path===file))throw Error('Missing '+file);
 await writeFile(join(root,'package.json'),JSON.stringify({type:'module',private:true}));
 execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund',join(root,packed.filename)],{cwd:root,stdio:'inherit'});
 const fs=await import('node:fs/promises');
 const installed=join(root,'node_modules/@npm-ken/pi-camoufox');
 const {stripTypeScriptTypes}=await import('node:module');
 await writeFile(join(installed,'smoke-extension.mjs'),stripTypeScriptTypes(await fs.readFile(join(installed,'index.ts'),'utf8')));
 // Reuse feature integration suite against installed modules, outside checkout.
 let source=await (await import('node:fs/promises')).readFile(new URL('./workflow-integration.test.mjs',import.meta.url),'utf8');
 source=source.replaceAll('../runtime/camoufox.mjs','./node_modules/@npm-ken/pi-camoufox/runtime/camoufox.mjs').replaceAll('../runtime/workflow.mjs','./node_modules/@npm-ken/pi-camoufox/runtime/workflow.mjs');
 source=source.replaceAll('../index.ts','./node_modules/@npm-ken/pi-camoufox/smoke-extension.mjs').replaceAll('../runtime/workflow-run.mjs','./node_modules/@npm-ken/pi-camoufox/runtime/workflow-run.mjs');
 await writeFile(join(root,'smoke.mjs'),source);
 execFileSync(process.execPath,['--test',join(root,'smoke.mjs')],{cwd:root,stdio:'inherit'});
 console.log('Installed package contents/loading verified; browser smoke runs only when runtime configured.');
}finally{await rm(root,{recursive:true,force:true});}
