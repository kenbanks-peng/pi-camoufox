# Browser runtime

Python generates fresh fingerprint/launch options, then exits. Node owns a
persistent Firefox/Juggler context using that Python installation's bundled
Node Playwright driver. No CDP, live Python server or Chromium fallback.

## Pinned installation

Validated on macOS arm64, Python 3.12.13:

- Python packages: `camoufox==0.5.9 fpgen==1.3.0 playwright==1.62.0`.
- Browser: **158.0.1-beta.41**, interface **1**, with its `version.json` intact
  in the installation ancestry.
- Runtime Node driver: Python Playwright's bundled **1.62.0**. The npm
  `playwright-core` **1.60.0** package is a type-only development dependency,
  never the runtime driver. Version/layout mismatches fail before launch.

For a new Python environment, deliberately install the pinned packages:

```sh
python3.12 -m venv /absolute/path/to/environment
/absolute/path/to/environment/bin/python -m pip install camoufox==0.5.9 fpgen==1.3.0 playwright==1.62.0
```

Use an existing pinned browser when available. If absent, the explicit download
command is `/absolute/path/to/environment/bin/python -m camoufox fetch`.
It may select a different build: verify the installed build before configuring
it; only the pin above is accepted. Do not run `playwright install`, implicitly
fetch, or update an existing browser to repair discovery. `latest=false` and
`last-sync=Never` do not trigger refresh. New browser/package versions require
separate validation and pin changes, not an automatic update path.

GeoIP is optional upstream, absent in the verified installation and disabled
here. Default addons are excluded; setup does not download them.

## Configure and diagnose

```sh
npm run check:runtime
```

All environment variables are optional. Put the upstream `camoufox` CLI on PATH;
its launcher selects the Python environment. Without that launcher, `python3`
on PATH is used. The Python package locates an existing browser with downloads
disabled. No automatic installation or update is performed.

Optional `PI_BROWSER_PYTHON` and `PI_BROWSER_EXECUTABLE` overrides accept paths
or command names. `PI_BROWSER_PROFILE` overrides storage and
`PI_BROWSER_HEADED` enables a visible window when nonempty. `/browser headed`
and `/browser headless` override it for the session (including `/reload`).
`check:runtime` prepares options without launching; integration tests launch.

Missing executables, browser metadata, unsupported pins and damaged bundled
drivers fail with remediation. Canvas/WebGL readback randomization is explicitly
disabled (`canvas_noise=False`), WebGL is enabled, and the generated OS identity
matches the host. Sites can fingerprint rendering instead of seeing the privacy
placeholder that can trigger bot warnings. Other setup warnings remain surfaced.
This is still automated Camoufox with generated fingerprints, not stock Firefox;
no stealth/anti-bot or CAPTCHA avoidance is guaranteed. Do not log generated
options: they contain environment values. Fingerprints are mode-specific and
fresh per launch.

See the root README for profile, visible-mode and pi loading configuration,
and test/README.md for reproducible local-browser checks and platform limits.
