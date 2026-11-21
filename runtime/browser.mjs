import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, delimiter, isAbsolute } from 'node:path';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

export async function findCommand(command, path = process.env.PATH ?? '') {
  const candidates = isAbsolute(command) || command.includes('/')
    ? [command] : path.split(delimiter).filter(Boolean).map(dir => join(dir, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return await realpath(candidate); } catch {}
  }
  throw Error('Command not found: ' + command + '. Install it on PATH or set an optional PI_BROWSER override.');
}

async function defaultPython() {
  try {
    const launcher = await findCommand('camoufox');
    const first = (await readFile(launcher, 'utf8')).split('\n')[0];
    if (first.startsWith('#!/') && !first.startsWith('#!/usr/bin/env')) {
      const interpreter = first.slice(2).trim();
      await access(interpreter, constants.X_OK);
      return interpreter; // Preserve the venv path, not its symlink target.
    }
  } catch {}
  return 'python3';
}

/** Generate fresh, mode-appropriate options. Caller owns context lifecycle.
 * No stable cross-launch fingerprint is promised; persistent storage is separate.
 */
export async function prepareBrowser({
  python = process.env.PI_BROWSER_PYTHON,
  executable = process.env.PI_BROWSER_EXECUTABLE,
  headless = !process.env.PI_BROWSER_HEADED,
} = {}) {
  python ||= await defaultPython();
  if (typeof headless !== 'boolean') throw Error('Browser headless must be boolean (virtual modes unsupported).');
  try {
    if (executable) executable = await findCommand(executable);
    if (executable) await access(executable, constants.X_OK);
  } catch { throw Error(`Browser binary missing/not executable: ${executable}. Set PI_BROWSER_EXECUTABLE to an installed binary; run configured Python -m camoufox fetch only if you explicitly want a download.`); }
  let result;
  try {
    result = await run(python, [fileURLToPath(new URL('./options.py', import.meta.url)), executable || '', headless ? 'headless' : 'headful'], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw Error(`Browser setup failed: ${error.stderr?.trim() || error.message}. Verify PI_BROWSER_PYTHON; install camoufox==0.5.9 fpgen==1.3.0 playwright==1.62.0 there (no playwright browser install).`);
  }
  let config;
  try { config = JSON.parse(result.stdout); } catch { throw Error('Browser helper returned invalid JSON; verify configured Python environment.'); }
  const { driver, options, versions } = config;
  if (versions?.camoufox !== '0.5.9' || versions?.fpgen !== '1.3.0' || versions?.playwright !== '1.62.0') throw Error('Unsupported Browser helper versions; use the documented pinned environment.');
  let pkg;
  try { pkg = JSON.parse(await readFile(join(driver, 'package.json'), 'utf8')); }
  catch { throw Error('Bundled Node driver missing or damaged; reinstall Python playwright==1.62.0.'); }
  if (pkg.version !== versions.playwright) throw Error('Bundled Node/Python Playwright mismatch; reinstall Python playwright==1.62.0.');
  if ((executable && options?.executablePath !== executable) || options.headless !== headless || !options.env || !Object.keys(options.env).some(key => key.startsWith('CAMOU_CONFIG'))) throw Error('Invalid Browser options; reinstall supported Browser environment.');
  let firefox;
  try { ({ firefox } = require(driver)); }
  catch { throw Error('Bundled Node driver failed to load; reinstall Python playwright==1.62.0.'); }
  if (typeof firefox?.launchPersistentContext !== 'function') throw Error('Unsupported bundled Playwright API; reinstall Python playwright==1.62.0.');
  return { firefox, options, versions, warnings: result.stderr.trim() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { versions, options, warnings } = await prepareBrowser();
    if (warnings) console.error(warnings);
    console.log(JSON.stringify({ versions, executable: options.executablePath, headless: options.headless, downloads: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
