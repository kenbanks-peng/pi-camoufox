import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { runWorkflow } from '../runtime/workflow-run.mjs';
import { validateWorkflow } from '../runtime/workflow.mjs';

test('navigation failures expose only allowlisted categories and stop the workflow', async () => {
  const cases = [
    ['NS_ERROR_UNKNOWN_HOST', 'dns-failed'],
    ['NS_ERROR_UNKNOWN_PROXY_HOST', 'dns-failed'],
    ...['NS_ERROR_CONNECTION_REFUSED', 'NS_ERROR_CONNECTION_RESET', 'NS_ERROR_NET_RESET',
      'NS_ERROR_NET_INTERRUPT', 'NS_ERROR_NET_TIMEOUT', 'NS_ERROR_OFFLINE',
      'NS_ERROR_PROXY_CONNECTION_REFUSED'].map(code => [code, 'network-failed']),
    ['NS_ERROR_UNKNOWN_HOST_SUFFIX', 'execution-failed'],
    ['NS_ERROR_FAILURE', 'execution-failed'],
  ];
  for (const [code, expected] of cases) {
    let profile, closed = false;
    const page = {
      on() {},
      goto: async () => { throw Error('page.goto: ' + code + '\nCall log:\n - https://private.invalid/?token=sentinel-secret'); },
      getByLabel: () => { assert.fail('must stop after navigation failure'); },
    };
    const context = { pages: () => [page], on() {}, close: async () => { closed = true; } };
    const report = await runWorkflow({
      version: 1, start: { mode: 'fresh' }, steps: [
        { action: 'goto', url: 'https://private.invalid/?token=sentinel-secret' },
        { action: 'fill', target: { label: 'Password' }, value: 'sentinel-secret' },
      ],
    }, {
      poison: () => assert.fail('cleanup must succeed'),
      prepare: async () => ({ options: {}, versions: {}, firefox: {
        launchPersistentContext: async p => { profile = p; return context; },
      } }),
    });
    assert.equal(report.category, expected);
    assert.deepEqual(report.outcomes.map(({ step, category }) => ({ step, category })), [{ step: 0, category: expected }]);
    assert.equal(closed, true);
    await assert.rejects(stat(profile));
    for (const privateText of ['sentinel-secret', 'private.invalid', code, 'Call log']) {
      assert.ok(!JSON.stringify(report).includes(privateText));
    }
  }
});

test('network markers outside navigation-error prefixes stay generic', async () => {
  for (const action of ['goto', 'fill', 'prepare']) {
    const message = action === 'goto'
      ? 'page.goto: other failure\nCall log: https://private.invalid/NS_ERROR_UNKNOWN_HOST'
      : 'page.goto: NS_ERROR_UNKNOWN_HOST';
    const page = { on() {}, goto: async () => { throw Error(message); },
      getByLabel: () => ({ fill: async () => { throw Error(message); } }) };
    const context = { pages: () => [page], on() {}, close: async () => {} };
    const report = await runWorkflow({
      version: 1, start: { mode: 'fresh' }, steps: [action === 'goto'
        ? { action: 'goto', url: 'https://private.invalid/' }
        : { action: 'fill', target: { label: 'Name' }, value: 'secret' }],
    }, {
      poison: () => assert.fail(),
      prepare: async () => {
        if (action === 'prepare') throw Error(message);
        return { options: {}, versions: {}, firefox: { launchPersistentContext: async () => context } };
      },
    });
    assert.equal(report.category, 'execution-failed');
    assert.ok(!JSON.stringify(report).includes(message));
  }
});

test('navigation remains HTTP(S)-only', () => {
  for (const url of ['data:text/html,<h1>Demo</h1>', 'file:///tmp/demo.html', 'javascript:alert(1)']) {
    assert.throws(() => validateWorkflow({
      version: 1, start: { mode: 'fresh' }, steps: [{ action: 'goto', url }],
    }), /invalid-workflow/);
  }
});
