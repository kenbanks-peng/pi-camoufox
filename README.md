# pi Browser extension

Eight persistent browser tools for pi: navigate, evaluate JavaScript, inspect
console/network, fill, click, screenshot, and close.

## Install and launch

Requires Node **26+** (tests use built-in TypeScript support), npm, pi 1.6.0,
and a separately configured Python/Browser installation. Verified on macOS
arm64 with Node 26.13.1 and Python 3.12.13; Linux/Windows are untested.

```sh
pi install npm:@npm-ken/pi-browser
```

Launch pi with the installed upstream CLI and its Python environment on PATH.
No environment variables are required. The runtime discovers the CLI's Python
interpreter and installed browser without downloading or updating anything.
See [runtime setup](runtime/README.md) for version pins and installation.
Run `/reload` after installing into an existing pi session.

Optional overrides:
- `PI_BROWSER_PYTHON`: Python interpreter path or command.
- `PI_BROWSER_EXECUTABLE`: installed browser executable path or command.
- `PI_BROWSER_PROFILE`: persistent profile directory.
- `PI_BROWSER_HEADED`: any nonempty value enables a visible window.

## Use

- `/browser`: show status and selected mode.
- `/browser off`: disable tools and close the browser.
- `/browser on`: enable tools using the last mode; `PI_BROWSER_HEADED`
  takes precedence unless a session override is set.
- `/browser headed` / `/browser headless`: enable tools and override the
  environment's mode for this session.

Enabling launches lazily on the next page tool call. Changing modes closes the
running browser; the next call relaunches it. Mode overrides and the enable bit
survive `/reload`, but not a new session. Modes apply to workflows too.
Tools serialize page operations. `browser_close` allows later relaunch;
shutdown closes the context without deleting storage.

Cookies, localStorage and IndexedDB persist in
`$XDG_DATA_HOME/pi-camoufox/profile` (default
`~/.local/share/pi-camoufox/profile`). Empty or relative `XDG_DATA_HOME` values
fall back to `~/.local/share`. Set `PI_BROWSER_PROFILE` to an absolute directory
to override it. The profile includes browser-managed caches. Old profiles under
`~/.pi/agent/extensions/browser/.profile` are not migrated automatically.
A fresh directory starts empty, but is not automatically deleted. Chromium profiles, migration, concurrent profile use,
and cross-browser/profile-version compatibility are unsupported.

Default: headless, 1280×800 viewport. Set `PI_BROWSER_HEADED=1` before starting
pi for a visible window; unset it for headless (any nonempty value enables it).
Fingerprints are generated per launch; storage persistence does not promise a
stable fingerprint. Canvas/WebGL readback randomization is disabled and the
OS identity matches the host: sites can fingerprint rendering rather than see
a privacy placeholder. This remains an automated browser; CAPTCHA avoidance
is not guaranteed. The active page is reused or replaced if closed.

Console/network buffers are bounded and drained by default (the whole buffer,
not just matching rows). Network headers require `verbose` or `includeHeaders`.
On tested macOS Browser, a finite unconsumed local fetch completed with HTTP
200/requestfinished, like its consumed counterpart; socket destruction produced
requestfailed. This says nothing about abandoned streaming bodies.
`browser_eval` accepts expressions, functions and IIFEs, returning serializable
values. Screenshots are PNG files in the system temporary directory.

## Develop and publish

From a source checkout:

```sh
npm ci
# Ensure the installed runtime tools are on PATH.
pi -e ./index.ts
```

The npm package includes only the extension and runtime helpers/docs (plus npm's
standard README/package metadata), not tests, spikes, profiles, or browsers.
Python and Browser must still be installed separately.

To prepare a release, update `version` in `package.json` and `package-lock.json`, then:

```sh
npm run typecheck
npm run test:fast
npm pack --dry-run
npm publish
```

Publishing targets public `@npm-ken/pi-browser` on npmjs.org and automatically
runs typechecking and fast tests. It requires an authorized npm login and any
account-required two-factor authentication. No publish occurs during setup.

## Verify

```sh
npm run check:runtime
npm run typecheck
npm run test:fast
npm run test:integration  # uses PATH discovery; serial, headless + visible
```

See [test details and limits](test/README.md). `npm test` skips installed-browser
checks by default; use test:integration for real launches.

## Workflow-first automation

Use browser_run for reviewed procedures; see [WORKFLOWS.md](WORKFLOWS.md) for the v1 contract, named login example, secret inputs, budgets and artifact consent. Primitive tools remain available for diagnostics.
