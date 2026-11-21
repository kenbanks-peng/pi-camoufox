import { test } from 'node:test';
import assert from 'node:assert/strict';
import extension from '../index.ts';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function register() {
  const tools = new Map(), events = new Map();
  let active = [], command;
  extension({ registerTool: t => tools.set(t.name, t), registerCommand: (_, c) => command = c.handler,
    on: (n, f) => events.set(n, f), getActiveTools: () => active, setActiveTools: a => active = a, appendEntry() {} });
  return { tools, events, command, call: (n, p = {}) => tools.get('browser_' + n).execute('test', p) };
}
test('actual TypeScript module import and real TypeBox registration', () => {
  const h = register();
  assert.equal(h.tools.size, 8);
  for (const t of h.tools.values()) { assert.equal(t.parameters.type, 'object'); assert.equal(typeof t.execute, 'function'); }
});
test('eight tools against deterministic HTTP fixture', { skip: !process.env.PI_CAMOUFOX_EXECUTABLE }, async () => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/fixture' }); res.end(); return; }
    if (req.url === '/fail') { req.socket.destroy(); return; }
    if (req.url === '/error') { res.setHeader('content-type', 'text/html'); res.end('<script>throw new Error("fixture-pageerror")</script>'); return; }
    res.setHeader('content-type', 'text/html');
    res.setHeader('x-fixture', 'private-extra');
    res.end('<script>window.fixtureError = () => { throw Error("fixture-pageerror") }</script><input id="value"><button onclick="document.body.dataset.clicked=document.querySelector(\'#value\').value">Submit</button>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  const profile = await mkdtemp(join(tmpdir(), 'camoufox-tools-'));
  const old = process.env.PI_CAMOUFOX_PROFILE; process.env.PI_CAMOUFOX_PROFILE = profile;
  const h = register(), ctx = { sessionManager: { getEntries: () => [] }, ui: { notify() {} } };
  const evaluate = async expression => (await h.call('eval', { expression })).details.result;
  async function networkReady(filter) {
    for (let i = 0; i < 200; i++) {
      const result = await h.call('network', { urlFilter: filter, clear: false, limit: 1000 });
      if (result.details.entries.length) return result;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.fail('missing network event ' + filter);
  }
  try {
    await h.events.get('session_start')({}, ctx); await h.command('on', ctx);
    for (const waitUntil of ['commit', 'domcontentloaded', 'load', 'networkidle']) {
      const r = await h.call('goto', { url: url + '/redirect', waitUntil });
      assert.equal(r.details.status, 200); assert.equal(r.details.finalUrl, url + '/fixture');
    }
    for (const expression of ['42', '() => 42', 'function () { return 42 }', 'async () => 42', '(() => 42)()']) assert.equal(await evaluate(expression), 42);
    for (const expression of ['(() => { throw Error("fixture") })()', 'invalid @ syntax']) assert.equal((await h.call('eval', { expression })).isError, true);
    await h.call('fill', { selector: '#value', value: 'filled' }); await h.call('click', { selector: 'text=Submit' });
    assert.equal(await evaluate('document.body.dataset.clicked'), 'filled');
    assert.equal(await evaluate('document.querySelector("#value").value'), 'filled');
    await Promise.all([h.call('eval', { expression: 'async () => { await new Promise(r => setTimeout(r, 30)); window.order = [1]; }' }), h.call('eval', { expression: '() => window.order.push(2)' })]);
    assert.deepEqual(await evaluate('window.order'), [1, 2]);
    await h.call('console');
    await evaluate('() => { console.log("fixture-log"); document.querySelector("button").addEventListener("click", window.fixtureError); }');
    await h.call('goto', { url: url + '/error', waitUntil: 'load' });
    for (let i = 0; i < 100; i++) {
      const e = (await h.call('console', { clear: false })).details.entries;
      if (e.some(x => x.type === 'pageerror')) break;
      await new Promise(r => setTimeout(r, 10));
    }
    
    const errors = await h.call('console', { filter: 'fixture', clear: false });
    assert.ok(errors.details.entries.some(x => x.type === 'pageerror'));
    assert.ok(errors.details.entries.some(x => x.text === 'fixture-log'));
    await evaluate('() => { for (let i=0;i<1005;i++) console.log("bound-"+i); }');
    const logs = (await h.call('console', { limit: 2000, clear: false })).details.entries;
    assert.equal(logs.length, 1000); assert.equal(logs.at(-1).text, 'bound-1004');
    assert.equal((await h.call('console', { filter: 'bound-1004', limit: 1 })).details.entries.length, 1);
    assert.equal((await h.call('console')).details.entries.length, 0);
    await h.call('network');
    await evaluate('async () => { await (await fetch("/consumed", {headers: {authorization:"Bearer fixture", "x-fixture":"request-extra"}})).text(); return (await fetch("/unconsumed")).status; }');
    await networkReady('/unconsumed');
    await evaluate('async () => { try { await fetch("/fail") } catch {} }');
    assert.ok((await networkReady('/fail')).details.entries[0].failure);
    const terse = await h.call('network', { urlFilter: '/consumed', status: 200, clear: false });
    assert.equal(terse.details.entries.length, 1); assert.ok(!terse.content[0].text.includes('Bearer'));
    const verbose = await h.call('network', { urlFilter: '/consumed', verbose: true, clear: false });
    assert.match(verbose.content[0].text, /Bearer fixture/); assert.ok(!verbose.content[0].text.includes('private-extra'));
    const extra = await h.call('network', { urlFilter: '/consumed', includeHeaders: ['X-Fixture'], clear: false });
    assert.match(extra.content[0].text, /private-extra/);
    const unconsumed = await h.call('network', { urlFilter: '/unconsumed', clear: false });
    assert.equal(unconsumed.details.entries[0].status, 200);
    console.log('Firefox unconsumed finite local response: HTTP 200 requestfinished, no failure');
    await h.call('network', { urlFilter: 'no-match' });
    assert.equal((await h.call('network')).details.entries.length, 0);
    for (const fullPage of [false, true]) {
      const shot = await h.call('screenshot', { fullPage }); const bytes = await readFile(shot.details.path);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      await rm(join(shot.details.path, '..'), { recursive: true, force: true });
    }
    await h.call('close'); assert.equal(await evaluate('42'), 42);
  } finally {
    await h.events.get('session_shutdown')(); server.close();
    if (old === undefined) delete process.env.PI_CAMOUFOX_PROFILE; else process.env.PI_CAMOUFOX_PROFILE = old;
    await rm(profile, { recursive: true, force: true });
  }
});
