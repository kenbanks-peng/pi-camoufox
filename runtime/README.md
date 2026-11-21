# Camoufox runtime

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
export PI_CAMOUFOX_PYTHON=/absolute/path/to/environment/bin/python
export PI_CAMOUFOX_EXECUTABLE=/absolute/path/to/Camoufox.app/Contents/MacOS/camoufox
npm run check:runtime
```

Both paths are mandatory; no PATH/cache discovery. This host's default Python
cache lookup selects a different, missing installation. `check:runtime` prints
versions, resolved executable, mode and `downloads:false`; it prepares options
but does not launch a browser. Integration tests perform real launches.

Missing executables, browser metadata, unsupported pins and damaged bundled
drivers fail with remediation. Canvas/WebGL privacy warnings are surfaced;
no stealth/anti-bot success is claimed. Do not log generated options: they
contain environment values. Fingerprints are mode-specific and fresh per launch.

See the root README for profile, visible-mode and pi loading configuration,
and test/README.md for reproducible local-browser checks and platform limits.
