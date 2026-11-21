import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCamoufox } from '../runtime/camoufox.mjs';

test('requires explicit environment configuration', async () => {
  await assert.rejects(prepareCamoufox({ python: '', executable: '' }), /Set PI_CAMOUFOX_PYTHON/);
});
test('missing binary has explicit download policy', async () => {
  await assert.rejects(prepareCamoufox({ python: 'python3', executable: '/not-installed/camoufox' }), /only if you explicitly want a download/);
});
test('virtual mode rejected', async () => {
  await assert.rejects(prepareCamoufox({ python: 'python3', executable: '/x', headless: 'virtual' }), /must be boolean/);
});
test('missing interpreter is actionable', async () => {
  await assert.rejects(prepareCamoufox({ python: '/missing/python', executable: process.execPath }), /Verify PI_CAMOUFOX_PYTHON/);
});
test('non-Camoufox binary rejected before launching', async () => {
  await assert.rejects(prepareCamoufox({ python: process.env.PI_CAMOUFOX_PYTHON || 'python3', executable: process.execPath }), /missing browser version.json|unsupported browser build/);
});
test('installed runtime: mode-specific options, persistent context and cleanup', { skip: !process.env.PI_CAMOUFOX_EXECUTABLE }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'camoufox-runtime-'));
  try {
    for (const headless of [true, false]) {
      const { firefox, options, versions } = await prepareCamoufox({ headless });
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
  const dir = await mkdtemp(join(tmpdir(), 'camoufox-invalid-'));
  try {
    const executable = join(dir, 'camoufox');
    await writeFile(executable, '');
    await chmod(executable, 0o755);
    await writeFile(join(dir, 'version.json'), JSON.stringify({version: '135.0.1', build: 'beta.24', interface: 1}));
    await assert.rejects(prepareCamoufox({ python: process.env.PI_CAMOUFOX_PYTHON || 'python3', executable }), /unsupported browser build/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
