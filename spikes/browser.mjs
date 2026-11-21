// Usage: node spikes/browser.mjs /path/to/browser/python /installed/.../browser
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const [python, binary] = process.argv.slice(2);
if (!python || !binary) throw Error('Provide Browser Python and installed executable paths');
const config = JSON.parse(execFileSync(python, [new URL('./browser-options.py', import.meta.url).pathname, binary], {encoding:'utf8', timeout:60000}));
const require = createRequire(import.meta.url);
const driver = require(config.driver);
const local = require('playwright-core');
console.log(JSON.stringify({python:config.versions, node:process.version, localPlaywright:require('playwright-core/package.json').version, bundledPlaywright:require(join(config.driver,'package.json')).version, binary}));
const profile = await mkdtemp(join(tmpdir(), 'browser-spike-'));
const http = createServer((req,res) => res.end('<title>Browser spike</title><h1>local fixture</h1>'));
await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
const url = 'http://127.0.0.1:' + http.address().port;
try {
  for (const headless of [true, false, true]) {
    const context = await driver.firefox.launchPersistentContext(profile, {...config.options, headless});
    try {
      const page = await context.newPage();
      await page.goto(url);
      assert.equal(await page.title(), 'Browser spike');
      const stored = await page.evaluate(() => localStorage.getItem('spike'));
      if (headless === false || stored) assert.equal(stored,'persisted');
      await page.evaluate(() => localStorage.setItem('spike','persisted'));
      await context.addCookies([{name:'spike',value:'persisted',url}]);
      console.log(JSON.stringify({persistent:true,headless,stored, cookies:await context.cookies(), evaluation:await page.evaluate(()=>6*7)}));
    } finally { await context.close(); }
  }
  const server = await driver.firefox.launchServer(config.options);
  try {
    console.log('server pid',server.process().pid);
    for (const [name, client] of [['repository',local],['bundled',driver]]) {
      try {
        const browser = await client.firefox.connect(server.wsEndpoint(), {timeout:10000});
        try {
          const page = await browser.newPage();
          await page.goto(url);
          assert.equal(await page.evaluate(()=>6*7),42);
          console.log(name + ' WebSocket PASS');
        } finally { await browser.close(); }
      } catch(error) { console.log(name + ' WebSocket FAIL: ' + error.message); }
    }
  } finally { await server.close(); console.log('server exit',server.process().exitCode); }
} finally {
  await new Promise(resolve=>http.close(resolve));
  await rm(profile,{recursive:true,force:true});
}
