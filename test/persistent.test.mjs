import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

test('extension persistent storage, modes, page reuse and single listeners', { skip: !process.env.PI_BROWSER_TEST_INTEGRATION }, async () => {
  // Exercise the actual extension, stubbing only pi registration/schema metadata.
  let source = stripTypeScriptTypes(await readFile(new URL('../index.ts', import.meta.url), 'utf8'));
  source = source.replace('from "./runtime/browser.mjs"', 'from ' + JSON.stringify(new URL('../runtime/browser.mjs', import.meta.url).href));
  source = source.replaceAll(/from "(\.\/runtime\/[^"]+)"/g, (_m, path) => 'from ' + JSON.stringify(new URL('../' + path.slice(2), import.meta.url).href));
  source = source.replace('import { Type } from "typebox";', 'const Type = new Proxy({}, { get: () => (...args) => args });');
  source = source.replace('const observedPages =', 'pi.testPage = ensurePage; const observedPages =');
  const { default: extension } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const profile = await mkdtemp(join(tmpdir(), 'browser-persistent-'));
  const saved = { profile: process.env.PI_BROWSER_PROFILE, headful: process.env.PI_BROWSER_HEADED };
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Persistence fixture</title><input id="input"><button>OK</button>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const db = async (write) => {
    const database = await new Promise((resolve, reject) => {
      const r = indexedDB.open('fixture', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('values');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = database.transaction('values', write ? 'readwrite' : 'readonly');
        const r = write ? tx.objectStore('values').put('durable', 'key') : tx.objectStore('values').get('key');
        tx.oncomplete = () => resolve(r.result); tx.onerror = () => reject(tx.error);
      });
    } finally { database.close(); }
  };
  let tools;
  try {
    process.env.PI_BROWSER_PROFILE = profile;
    for (const [index, headful] of [false, true, false].entries()) {
      if (headful) process.env.PI_BROWSER_HEADED = '1'; else delete process.env.PI_BROWSER_HEADED;
      tools = new Map();
      const pi = { registerTool: t => tools.set(t.name, t), on() {}, registerCommand() {} };
      extension(pi);
      const call = (name, args = {}) => tools.get('browser_' + name).execute('test', args);
      await call('goto', { url });
      const page = await pi.testPage();
      assert.equal(await pi.testPage(), page);
      assert.deepEqual(page.viewportSize(), { width: 1280, height: 800 });
      if (index === 0) {
        await page.context().addCookies([{ name: 'durable', value: 'yes', url, expires: Math.floor(Date.now()/1000) + 3600 }]);
        await call('eval', { expression: "() => localStorage.setItem('durable', 'yes')" });
        await page.evaluate(db, true);
      } else {
        assert.equal((await page.context().cookies(url)).find(c => c.name === 'durable')?.value, 'yes');
        assert.equal((await call('eval', { expression: "localStorage.getItem('durable')" })).details.result, 'yes');
        assert.equal(await page.evaluate(db, false), 'durable');
      }
      const spare = await page.context().newPage();
      await page.close();
      assert.equal(await pi.testPage(), spare);
      for (let i = 0; i < 3; i++) assert.equal(await pi.testPage(), spare);
      for (const event of ['console', 'pageerror', 'requestfinished', 'requestfailed']) assert.equal(spare.listenerCount(event), 1);
      await call('goto', { url });
      await call('console');
      await call('eval', { expression: "() => console.log('single event')" });
      assert.equal((await call('console')).details.entries.filter(e => e.text === 'single event').length, 1);
      await spare.close();
      const replacement = await pi.testPage();
      assert.notEqual(replacement, spare);
      assert.equal(await pi.testPage(), replacement);
      await call('goto', { url });
      await call('fill', { selector: '#input', value: 'Browser' });
      await call('click', { selector: 'button' });
      assert.equal((await call('eval', { expression: "document.querySelector('#input').value" })).details.result, 'Browser');
      await call('close');
    }
  } finally {
    await tools?.get('browser_close')?.execute('cleanup', {});
    server.close();
    for (const [key, value] of [['PI_BROWSER_PROFILE', saved.profile], ['PI_BROWSER_HEADED', saved.headful]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(profile, { recursive: true, force: true });
  }
});
