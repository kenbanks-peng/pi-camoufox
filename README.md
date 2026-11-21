# pi Camoufox extension

Eight persistent browser tools for pi: navigate, evaluate JavaScript, inspect
console/network, fill, click, screenshot, and close.

## Install and launch

Requires Node **26+** (tests use built-in TypeScript support), npm, pi 1.6.0,
and a separately configured Python/Camoufox installation. Verified on macOS
arm64 with Node 26.13.1 and Python 3.12.13; Linux/Windows are untested.

```sh
npm ci
# Configure an existing pinned installation; see runtime/README.md first.
export PI_CAMOUFOX_PYTHON=/absolute/path/to/environment/bin/python
export PI_CAMOUFOX_EXECUTABLE=/absolute/path/to/Camoufox.app/Contents/MacOS/camoufox
npm run check:runtime
pi -e ./index.ts
```

For permanent loading, place this checkout under `~/.pi/agent/extensions/`
(or `.pi/extensions/` in a project), install its dependencies there, and `/reload`.
Runtime variables must be set in pi's environment before launch.
[Runtime setup](runtime/README.md) specifies exact Python/browser/driver pins
and intentional installation commands. No implicit downloads, updates, cache
discovery or Chromium fallback. GeoIP is not required or enabled.

## Use

`/browser on` enables the eight `browser_*` tools; `/browser` shows status;
`/browser off` disables tools and closes the context. Enabling does not launch
the browser until a page tool runs. Tools serialize page operations; the enable
bit persists within the session. `browser_close` allows later relaunch;
shutdown closes the context without deleting storage.

Cookies, localStorage and IndexedDB persist in
`~/.pi/agent/extensions/camoufox/.profile`. Set `PI_CAMOUFOX_PROFILE` to an
absolute directory to override it. A fresh directory starts empty, but is not
automatically deleted. Chromium profiles, migration, concurrent profile use,
and cross-browser/profile-version compatibility are unsupported.
`PI_BROWSER_PROFILE` is ignored.

Default: headless, 1280×800 viewport. Set `PI_BROWSER_HEADFUL=1` before starting
pi for a visible window; unset it for headless (any nonempty value enables it).
Fingerprints are generated per launch; storage persistence does not promise a
stable fingerprint. The active page is reused or replaced if closed.

Console/network buffers are bounded and drained by default (the whole buffer,
not just matching rows). Network headers require `verbose` or `includeHeaders`.
On tested macOS Camoufox, a finite unconsumed local fetch completed with HTTP
200/requestfinished, like its consumed counterpart; socket destruction produced
requestfailed. This says nothing about abandoned streaming bodies.
`browser_eval` accepts expressions, functions and IIFEs, returning serializable
values. Screenshots are PNG files in the system temporary directory.

## Verify

```sh
npm run check:runtime
npm run typecheck
npm run test:fast
npm run test:integration  # requires both runtime paths; serial, headless + visible
```

See [test details and limits](test/README.md). `npm test` skips installed-browser
checks when paths are absent; it is not a substitute for configured integration.
