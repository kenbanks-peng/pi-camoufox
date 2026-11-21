import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

/** Generate fresh, mode-appropriate options. Caller owns context lifecycle.
 * No stable cross-launch fingerprint is promised; persistent storage is separate.
 */
export async function prepareCamoufox({
  python = process.env.PI_CAMOUFOX_PYTHON,
  executable = process.env.PI_CAMOUFOX_EXECUTABLE,
  headless = !process.env.PI_BROWSER_HEADFUL,
} = {}) {
  if (!python || !executable) throw Error('Set PI_CAMOUFOX_PYTHON to the Camoufox environment Python and PI_CAMOUFOX_EXECUTABLE to an existing Camoufox binary. No browser is downloaded.');
  if (typeof headless !== 'boolean') throw Error('Camoufox headless must be boolean (virtual modes unsupported).');
  try {
    executable = await realpath(executable);
    await access(executable, constants.X_OK);
  } catch { throw Error(`Camoufox binary missing/not executable: ${executable}. Set PI_CAMOUFOX_EXECUTABLE to an installed binary; run configured Python -m camoufox fetch only if you explicitly want a download.`); }
  let result;
  try {
    result = await run(python, [fileURLToPath(new URL('./options.py', import.meta.url)), executable, headless ? 'headless' : 'headful'], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw Error(`Camoufox setup failed: ${error.stderr?.trim() || error.message}. Verify PI_CAMOUFOX_PYTHON; install camoufox==0.5.9 fpgen==1.3.0 playwright==1.62.0 there (no playwright browser install).`);
  }
  let config;
  try { config = JSON.parse(result.stdout); } catch { throw Error('Camoufox helper returned invalid JSON; verify configured Python environment.'); }
  const { driver, options, versions } = config;
  if (versions?.camoufox !== '0.5.9' || versions?.fpgen !== '1.3.0' || versions?.playwright !== '1.62.0') throw Error('Unsupported Camoufox helper versions; use the documented pinned environment.');
  let pkg;
  try { pkg = JSON.parse(await readFile(join(driver, 'package.json'), 'utf8')); }
  catch { throw Error('Bundled Node driver missing or damaged; reinstall Python playwright==1.62.0.'); }
  if (pkg.version !== versions.playwright) throw Error('Bundled Node/Python Playwright mismatch; reinstall Python playwright==1.62.0.');
  if (options?.executablePath !== executable || options.headless !== headless || !options.env || !Object.keys(options.env).some(key => key.startsWith('CAMOU_CONFIG'))) throw Error('Invalid Camoufox options; reinstall supported Camoufox environment.');
  let firefox;
  try { ({ firefox } = require(driver)); }
  catch { throw Error('Bundled Node driver failed to load; reinstall Python playwright==1.62.0.'); }
  if (typeof firefox?.launchPersistentContext !== 'function') throw Error('Unsupported bundled Playwright API; reinstall Python playwright==1.62.0.');
  return { firefox, options, versions, warnings: result.stderr.trim() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { versions, options, warnings } = await prepareCamoufox();
    if (warnings) console.error(warnings);
    console.log(JSON.stringify({ versions, executable: options.executablePath, headless: options.headless, downloads: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
