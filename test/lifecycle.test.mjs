import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

async function harness(prepare, entries = [], launchTimeout, workflowRun) {
  let source = stripTypeScriptTypes(await readFile(new URL('../index.ts', import.meta.url), 'utf8'));
  source = source.replace('import { prepareBrowser } from "./runtime/browser.mjs";',
    prepare ? 'const prepareBrowser = globalThis.lifecyclePrepare;' : 'import { prepareBrowser } from ' + JSON.stringify(new URL('../runtime/browser.mjs', import.meta.url).href) + ';');
  source = source.replaceAll(/from "(\.\/runtime\/[^"]+)"/g, (_m, path) => 'from ' + JSON.stringify(new URL('../' + path.slice(2), import.meta.url).href));
  source = source.replace('import { Type } from "typebox";', 'const Type = new Proxy({}, { get: () => (...args) => args });');
  source = source.replace('const observedPages =', 'pi.testPage = ensurePage; const observedPages =');
  if (launchTimeout) source = source.replace("timeout: 30_000,", "timeout: " + launchTimeout + ",");
  if (workflowRun) source = source.replace(/import \{ runWorkflow, bounded \} from [^;]+;/, 'import { bounded } from ' + JSON.stringify(new URL('../runtime/workflow-run.mjs', import.meta.url).href) + '; const runWorkflow = globalThis.lifecycleWorkflowRun;');
  globalThis.lifecycleWorkflowRun = workflowRun;
  globalThis.lifecyclePrepare = prepare;
  const { default: extension } = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + Math.random()).toString('base64'));
  const tools = new Map(), events = new Map();
  let active = ['other', 'browser_goto'], command;
  const pi = {
    registerTool: t => tools.set(t.name, t), on: (n, f) => events.set(n, f),
    registerCommand: (_n, c) => command = c.handler,
    getActiveTools: () => active, setActiveTools: a => active = a,
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  };
  extension(pi);
  const notifications = [];
  const ctx = { sessionManager: { getEntries: () => entries }, ui: { notify: message => notifications.push(message) } };
  await events.get('session_start')({}, ctx);
  return { pi, entries, notifications, active: () => active, call: (n, p = {}, signal) => tools.get('browser_' + n).execute('test', p, signal, undefined, {cwd:process.cwd()}),
    command: s => command(s, ctx), shutdown: () => events.get('session_shutdown')() };
}

function fake() {
  const contexts = [];
  let fail = '', pending;
  const prepare = async () => {
    if (fail === 'prepare') { fail = ''; throw Error('setup failed'); }
    return { options: {}, firefox: { launchPersistentContext: async (_profile, options) => {
      assert.equal(options.timeout, 30000);
      const pageFailure = fail === 'page setup';
      if (pageFailure) fail = '';
      if (fail) { const message = fail; fail = ''; throw Error(message); }
      const browser = new EventEmitter();
      browser.connected = true;
      browser.isConnected = () => browser.connected;
      browser.close = async () => { browser.connected = false; browser.emit('disconnected'); };
      const page = new EventEmitter();
      page.closed = false; page.isClosed = () => page.closed;
      page.url = () => 'about:blank';
      page.evaluate = async () => pending ? pending.promise : 42;
      const context = new EventEmitter();
      context.browser = () => browser;
      context.pages = () => { if (pageFailure) throw Error('page setup failed'); return [page]; }; context.newPage = async () => page;
      context.close = async () => { context.closes++; page.closed = true; context.emit('close'); await browser.close(); };
      context.closes = 0; context.page = page;
      contexts.push(context);
      return context;
    } } };
  };
  return { prepare, contexts, fail: s => fail = s, hold: () => {
    let resolve; const promise = new Promise(r => resolve = r); pending = { promise };
    return () => { pending = null; resolve(42); };
  } };
}

test('headed environment, session overrides, reload, status and lazy mode switches', async () => {
  const saved = process.env.PI_BROWSER_HEADED;
  const instances = [];
  try {
    delete process.env.PI_BROWSER_HEADED;
    const f = fake(), modes = [], workflowModes = [];
    const prepare = async ({ headless }) => { modes.push(headless); return f.prepare(); };
    const workflowRun = async (_w, { headless }) => { workflowModes.push(headless); return { category: 'success' }; };
    const h = await harness(prepare, [], undefined, workflowRun); instances.push(h);
    await h.command('');
    assert.match(h.notifications.at(-1), /disabled.*headless/);
    process.env.PI_BROWSER_HEADED = '0'; // Any nonempty value means headed.
    await h.command('on');
    assert.equal(f.contexts.length, 0);
    await h.call('eval', { expression: '42' });
    assert.deepEqual(modes, [false]);
    await h.command('headed'); // Same mode sets override without closing.
    assert.equal(f.contexts[0].closes, 0);
    const release = f.hold();
    const running = h.call('eval', { expression: '42' });
    await new Promise(r => setImmediate(r));
    const switchMode = h.command('headless');
    const next = h.call('eval', { expression: '42' });
    assert.equal(f.contexts[0].closes, 0);
    release(); await running; await switchMode; await next;
    assert.equal(f.contexts[0].closes, 1);
    assert.deepEqual(modes, [false, true]);
    await h.command('off'); await h.command('on');
    await h.call('eval', { expression: '42' });
    assert.equal(modes.at(-1), true); // Override beats environment.
    await h.call('run', { workflow: { version: 1, start: { mode: 'fresh' },
      steps: [{ action: 'goto', url: 'http://localhost/' }] } });
    assert.deepEqual(workflowModes, [true]);
    await h.command(''); assert.match(h.notifications.at(-1), /enabled, headless/);
    const restored = await harness(prepare, [...h.entries]); instances.push(restored);
    await restored.call('eval', { expression: '42' }); assert.equal(modes.at(-1), true);
    await restored.command('headed'); await restored.command('off');
    delete process.env.PI_BROWSER_HEADED;
    const offRestored = await harness(prepare, [...restored.entries]); instances.push(offRestored);
    await offRestored.command(''); assert.match(offRestored.notifications.at(-1), /disabled.*headed/);
    await offRestored.command('on'); await offRestored.call('eval', { expression: '42' });
    assert.equal(modes.at(-1), false);
    const fresh = await harness(prepare); instances.push(fresh);
    await fresh.command('on'); await fresh.call('eval', { expression: '42' });
    assert.equal(modes.at(-1), true); // New session discards overrides.
  } finally {
    for (const h of instances) await h.shutdown();
    if (saved === undefined) delete process.env.PI_BROWSER_HEADED; else process.env.PI_BROWSER_HEADED = saved;
  }
});

test('persistent profile uses XDG data home with an explicit override', async () => {
  const keys = ['PI_BROWSER_PROFILE', 'XDG_DATA_HOME'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const fallback = join(homedir(), '.local', 'share', 'pi-camoufox', 'profile');
  try {
    for (const [xdg, override, expected] of [
      [undefined, undefined, fallback],
      ['', undefined, fallback],
      ['relative/data', undefined, fallback],
      ['/tmp/pi-xdg-data', undefined, '/tmp/pi-xdg-data/pi-camoufox/profile'],
      ['/tmp/pi-xdg-data', '/tmp/pi-explicit-profile', '/tmp/pi-explicit-profile'],
    ]) {
      for (const [key, value] of [['XDG_DATA_HOME', xdg], ['PI_BROWSER_PROFILE', override]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      const f = fake();
      let actual;
      const h = await harness(async () => {
        const prepared = await f.prepare();
        const launch = prepared.firefox.launchPersistentContext;
        prepared.firefox.launchPersistentContext = (profile, options) => {
          actual = profile;
          return launch(profile, options);
        };
        return prepared;
      });
      try {
        await h.command('on');
        await h.call('eval', { expression: '42' });
        assert.equal(actual, expected);
      } finally {
        await h.shutdown();
      }
    }
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('default-off, restore latest bit, aliases, close and shutdown serialize with queued tools', async () => {
  const f = fake(), h = await harness(f.prepare);
  assert.deepEqual(h.active(), ['other']);
  await assert.rejects(h.call('eval', { expression: '42' }), /disabled/);
  await h.command('on');
  const release = f.hold();
  const first = h.call('eval', { expression: '42' });
  // Let the queued operation reach its held evaluation.
  while (!f.contexts.length) await new Promise(r => setImmediate(r));
  const off = h.command('off');
  const later = h.call('eval', { expression: '42' });
  const rejected = assert.rejects(later, /disabled/);
  assert.equal(f.contexts[0].closes, 0);
  release(); await first; await off; await rejected;
  assert.equal(f.contexts[0].closes, 1);
  for (const alias of ['disable', 'close', 'kill']) {
    await h.command('on'); await h.call('eval', { expression: '42' }); await h.command(alias);
    assert.equal(f.contexts.at(-1).closes, 1);
  }
  await h.command('on'); await h.call('eval', { expression: '42' });
  await Promise.all([h.call('close'), h.call('eval', { expression: '42' })]);
  assert.equal(f.contexts.at(-2).closes, 1);
  // An on queued behind off must not be skipped based on the old enabled bit.
  await Promise.all([h.command('off'), h.command('on')]);
  assert.ok(h.active().includes('browser_eval'));
  const releaseShutdown = f.hold();
  const inFlight = h.call('eval', { expression: '42' });
  await new Promise(r => setImmediate(r));
  const shutdown = h.shutdown();
  const afterShutdown = assert.rejects(h.call('eval', { expression: '42' }), /shut down/);
  releaseShutdown(); await inFlight; await shutdown; await afterShutdown;
  assert.equal(f.contexts.at(-1).closes, 1);
  await assert.rejects(h.call('eval', { expression: '42' }), /shut down/);
  const restored = await harness(fake().prepare, h.entries);
  assert.ok(restored.active().includes('browser_eval'));
  await restored.command('off');
  const offRestored = await harness(fake().prepare, restored.entries);
  assert.deepEqual(offRestored.active(), ['other']);
});

test('setup/launch/timeout failures retry; crash and disconnect replace stale handles', async () => {
  const f = fake(), h = await harness(f.prepare);
  await h.command('on');
  for (const failure of ['prepare', 'launch failed', 'Timeout 30000ms exceeded', 'page setup']) {
    f.fail(failure);
    await assert.rejects(h.call('eval', { expression: '42' }));
    if (failure === 'page setup') assert.equal(f.contexts.at(-1).closes, 1);
    assert.equal((await h.call('eval', { expression: '42' })).details.result, 42);
    await h.call('close');
  }
  await h.call('eval', { expression: '42' });
  const crashed = f.contexts.at(-1);
  crashed.page.emit('crash');
  await h.call('eval', { expression: '42' });
  assert.equal(crashed.closes, 1);
  const disconnected = f.contexts.at(-1);
  await disconnected.browser().close();
  await h.call('eval', { expression: '42' });
  assert.notEqual(f.contexts.at(-1), disconnected);
  // Delayed old close must not invalidate current owner.
  const current = f.contexts.at(-1);
  disconnected.emit('close');
  await h.call('eval', { expression: '42' });
  assert.equal(f.contexts.at(-1), current);
  const unrelated = await harness(fake().prepare);
  await unrelated.command('on');
  await unrelated.call('eval', { expression: '42' });
  await h.shutdown();
  assert.equal((await unrelated.call('eval', { expression: '42' })).details.result, 42);
  await unrelated.shutdown();
});

test('installed macOS browser lifecycle: races, external context close, page crash recovery, shutdown', { skip: !process.env.PI_BROWSER_TEST_INTEGRATION }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'browser-lifecycle-'));
  const saved = process.env.PI_BROWSER_PROFILE;
  process.env.PI_BROWSER_PROFILE = profile;
  let h;
  try {
    const timed = await harness(undefined, [], 1);
    await timed.command('on');
    await assert.rejects(timed.call('eval', { expression: '42' }), /Timeout/);
    await timed.shutdown();
    // Same profile must immediately reopen: no escaped late launch/profile lock.
    h = await harness();
    await h.command('on');
    await Promise.all([h.call('eval', { expression: 'async () => { await new Promise(r => setTimeout(r, 150)); return 42; }' }), h.call('close'), h.call('eval', { expression: '42' })]);
    const page = await h.pi.testPage();
    const browser = page.context().browser();
    await page.context().close();
    assert.equal(browser.isConnected(), false);
    assert.equal((await h.call('eval', { expression: '42' })).details.result, 42);
    // Exercise the registered crash recovery path without killing any process.
    const crashed = await h.pi.testPage();
    crashed.emit('crash');
    assert.equal((await h.call('eval', { expression: '42' })).details.result, 42);
    assert.equal(crashed.isClosed(), true);
    const off = h.command('off');
    const denied = assert.rejects(h.call('eval', { expression: '42' }), /disabled/);
    await off; await denied;
    await h.command('on');
    await h.call('eval', { expression: '42' });
    const owned = (await h.pi.testPage()).context().browser();
    await h.shutdown();
    assert.equal(owned.isConnected(), false);
  } finally {
    await h?.shutdown();
    if (saved === undefined) delete process.env.PI_BROWSER_PROFILE; else process.env.PI_BROWSER_PROFILE = saved;
    await rm(profile, { recursive: true, force: true });
  }
});

test('late async header completion cannot repopulate closed or disabled buffers', async () => {
  for (const end of ['close', 'off']) {
    const f = fake(), h = await harness(f.prepare);
    await h.command('on'); await h.call('eval', { expression: '42' });
    let release;
    const headers = new Promise(r => release = r);
    const req = { response: async () => ({ status: () => 200, statusText: () => 'OK', allHeaders: () => headers }),
      method: () => 'GET', url: () => 'http://fixture/late', resourceType: () => 'fetch', allHeaders: async () => ({}) };
    const callback = f.contexts[0].page.listeners('requestfinished')[0];
    const pending = callback(req);
    await new Promise(r => setImmediate(r));
    if (end === 'close') await h.call('close'); else await h.command('off');
    release({ 'content-type': 'text/plain' }); await pending;
    if (end === 'off') await h.command('on');
    assert.deepEqual((await h.call('network')).details.entries, []);
    await h.shutdown();
  }
});

test('network bounds, oldest-first tail, filters and whole-buffer drain', async () => {
  const f = fake(), h = await harness(f.prepare);
  await h.command('on'); await h.call('eval', { expression: '42' });
  const callback = f.contexts[0].page.listeners('requestfinished')[0];
  for (let i = 0; i < 1005; i++) await callback({
    response: async () => ({ status: () => i % 2 ? 201 : 200, statusText: () => 'OK', allHeaders: async () => ({}) }),
    method: () => 'GET', url: () => 'http://fixture/' + i, resourceType: () => 'fetch', allHeaders: async () => ({}) });
  const rows = (await h.call('network', { limit: 2000, clear: false })).details.entries;
  assert.equal(rows.length, 1000); assert.equal(rows[0].url, 'http://fixture/5');
  assert.equal(rows.at(-1).url, 'http://fixture/1004');
  assert.equal((await h.call('network', { limit: 0, clear: false })).details.entries.length, 0);
  assert.equal((await h.call('network', { urlFilter: '/100', status: 201, limit: 2 })).details.entries.length, 2);
  assert.equal((await h.call('network')).details.entries.length, 0);
  await h.shutdown();
});

test('workflow queued cancellation and expiry return behind blocked primitive and never launch',async()=>{
 const f=fake(),h=await harness(f.prepare);await h.command('on');
 const release=f.hold();const primitive=h.call('eval',{expression:'42'});
 await new Promise(r=>setImmediate(r));
 const controller=new AbortController();
 const workflow={version:1,start:{mode:'fresh'},overallMs:30,steps:[{action:'goto',url:'http://localhost/'}]};
 const canceled=h.call('run',{workflow},controller.signal);controller.abort();
 assert.equal((await canceled).details.category,'canceled');
 assert.equal((await h.call('run',{workflow})).details.category,'timeout');
 release();await primitive;await h.call('console');assert.equal(f.contexts.length,1);await h.shutdown();
});

test('unconfirmed workflow cleanup rejects all subsequent browser operations until fresh instance',async()=>{
 const h=await harness(fake().prepare,[],undefined,async (_w,{poison})=>{poison();return {category:'timeout',cleanup:'termination-unconfirmed; restart-required'};});
 await h.command('on');
 const w={version:1,start:{mode:'fresh'},steps:[{action:'goto',url:'http://localhost/'}]};
 assert.equal((await h.call('run',{workflow:w})).details.category,'timeout');
 assert.equal((await h.call('run',{workflow:w})).details.category,'restart-required');
 await assert.rejects(h.call('eval',{expression:'42'}),/fresh extension instance/);
 await assert.rejects(h.call('close'),/fresh extension instance/);
});
