# Checks

Requires Node 26+ (native TypeScript imports), installed npm dependencies:
`npm ci`.

- `npm run typecheck`: strict extension typecheck against the installed pi API.
- `npm run test:fast`: isolated lifecycle/buffer tests and actual extension import/TypeBox registration; four installed-browser tests intentionally skipped.
- `PI_CAMOUFOX_PYTHON=/absolute/python PI_CAMOUFOX_EXECUTABLE=/absolute/camoufox npm run test:integration`: all tests, no downloads. Missing configuration fails. See runtime/README.md for supported installed versions.
- `npm test`: same suite, installed-browser tests skip without executable configuration.

Tests use temporary profiles and loopback HTTP only. Browser test files run serially: parallel macOS launches produced an intermittent Juggler startup timeout. Persistence checks include headful launches; Linux/Windows are unverified. Crash recovery emits the registered crash event, not an OS process crash. Registration imports unmodified index.ts and real TypeBox; it does not launch a pi TUI. Isolated lifecycle tests inject fake launchers.

Observed on supported macOS Camoufox: an unconsumed finite local fetch response completed with HTTP 200/requestfinished, as did the consumed response. Socket destruction produced requestfailed. No general claim about abandoned streaming bodies or Chromium ERR_ABORTED applies. Request/response allHeaders are awaited; stale callbacks are discarded immediately before buffer insertion.

Page errors are exercised by a document script throwing on navigation. An error scheduled from Playwright evaluation did not emit pageerror in this environment.

Workflow coverage: workflow.test.mjs (contract, identity, semantic resolution, owned lifecycle, named loading); workflow-integration.test.mjs (local inline/named login, safe failures, artifacts and fresh runs). Run npm run test:integration with the documented existing runtime; skips are not integration passes. Installed-package smoke: node test/package-smoke.mjs.
