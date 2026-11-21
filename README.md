# pi Camoufox extension

Eight persistent browser tools for pi: navigate, evaluate JavaScript, inspect
console/network, fill, click, screenshot, and close.

## Install and launch

Requires Node **26+** (tests use built-in TypeScript support), npm, pi 1.6.0,
and a separately configured Python/Camoufox installation. Verified on macOS
arm64 with Node 26.13.1 and Python 3.12.13; Linux/Windows are untested.

```sh
pi install npm:@npm-ken/pi-camoufox
```

Configure the runtime before launching pi:

```sh
# Configure an existing pinned installation; see runtime/README.md first.
export PI_CAMOUFOX_PYTHON=/absolute/path/to/environment/bin/python
export PI_CAMOUFOX_EXECUTABLE=/absolute/path/to/Camoufox.app/Contents/MacOS/camoufox
pi
```

Run `/reload` if pi is already running after installation.
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

## Develop and publish

From a source checkout:

```sh
npm ci
# Set the runtime variables above before launching.
pi -e ./index.ts
```

The npm package includes only the extension and runtime helpers/docs (plus npm's
standard README/package metadata), not tests, spikes, profiles, or browsers.
Python and Camoufox must still be installed separately.

To prepare a release, update `version` in `package.json` and `package-lock.json`, then:

```sh
npm run typecheck
npm run test:fast
npm pack --dry-run
npm publish
```

Publishing targets public `@npm-ken/pi-camoufox` on npmjs.org and automatically
runs typechecking and fast tests. It requires an authorized npm login and any
account-required two-factor authentication. No publish occurs during setup.

## Verify

```sh
npm run check:runtime
npm run typecheck
npm run test:fast
npm run test:integration  # requires both runtime paths; serial, headless + visible
```

See [test details and limits](test/README.md). `npm test` skips installed-browser
checks when paths are absent; it is not a substitute for configured integration.

## Workflow-first automation

Use browser_run for reviewed procedures; see [WORKFLOWS.md](WORKFLOWS.md) for the v1 contract, named login example, secret inputs, budgets and artifact consent. Primitive tools remain available for diagnostics.
