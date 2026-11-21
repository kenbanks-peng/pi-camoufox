import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBrowser, findCommand } from '../runtime/browser.mjs';

test('commands are discovered on PATH without configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-path-'));
  try {
    const executable = join(dir, 'browser');
    await writeFile(executable, ''); await chmod(executable, 0o755);
    assert.equal(await findCommand('browser', dir), await realpath(executable));
    await assert.rejects(findCommand('absent-browser', dir), /Command not found/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('missing binary has explicit download policy', async () => {
  await assert.rejects(prepareBrowser({ python: 'python3', executable: '/not-installed/browser' }), /only if you explicitly want a download/);
});
test('virtual mode rejected', async () => {
  await assert.rejects(prepareBrowser({ python: 'python3', executable: '/x', headless: 'virtual' }), /must be boolean/);
});
test('missing interpreter is actionable', async () => {
  await assert.rejects(prepareBrowser({ python: '/missing/python', executable: process.execPath }), /Verify PI_BROWSER_PYTHON/);
});
test('non-Browser binary rejected before launching', async () => {
  await assert.rejects(prepareBrowser({ python: process.env.PI_BROWSER_PYTHON || 'python3', executable: process.execPath }), /missing browser version.json|unsupported browser build/);
});
test('installed runtime: mode-specific options, persistent context and cleanup', { skip: !process.env.PI_BROWSER_TEST_INTEGRATION }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'browser-runtime-'));
  try {
    for (const headless of [true, false]) {
      const { firefox, options, versions } = await prepareBrowser({ headless });
      assert.equal(options.headless, headless);
      assert.equal(versions.playwright, '1.62.0');
      const context = await firefox.launchPersistentContext(profile, options);
      try {
        const page = await context.newPage();
        await page.goto('data:text/html,<title>Runtime check</title>');
        assert.equal(await page.title(), 'Runtime check');
        assert.equal(await page.evaluate(() => 6 * 7), 42);
      } finally { await context.close(); }
    }
  } finally { await rm(profile, { recursive: true, force: true }); }
});

test('unsupported installed browser rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-invalid-'));
  try {
    const executable = join(dir, 'browser');
    await writeFile(executable, '');
    await chmod(executable, 0o755);
    await writeFile(join(dir, 'version.json'), JSON.stringify({version: '135.0.1', build: 'beta.24', interface: 1}));
    await assert.rejects(prepareBrowser({ python: process.env.PI_BROWSER_PYTHON || 'python3', executable }), /unsupported browser build/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
