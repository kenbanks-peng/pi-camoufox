# Browser architecture spike

Run against an **already installed** Browser binary and its Python environment:

```sh
node spikes/browser.mjs /path/to/environment/bin/python /path/to/installed/browser
```

Requires repository dependencies already installed. No browser/addon fetch or update.
Creates a temporary profile and loopback HTTP fixture, exercises persistent
headless/headful/headless contexts, then compares repository and bundled
Playwright WebSocket clients. Contexts, server, fixture and profile close in
finally blocks. WebSocket failures are reported rather than fatal so mismatched
clients can be compared.

## Decision

Use Python Browser `launch_options` for fingerprint generation, validation,
environment and Firefox preferences; translate top-level option names using
Browser's own converter. Node owns `firefox.launchPersistentContext` and browser
cleanup. The spike loads the Playwright Node package bundled with the Python
driver to demonstrate an exact driver match without installing anything.

A production adapter must make driver discovery/version checks explicit; the
Python driver path API is private. An independently supported Node fingerprint
launcher was not validated. A raw executable-path swap omits Browser's identity
configuration and is not the selected approach.

Browser's supported Python `launch_server` uses Node `launchServer` and
Playwright WebSocket transport (not Chromium CDP). Its source explicitly rejects
persistent contexts/user-data directories. It can support ephemeral contexts,
but cannot preserve the extension's disk profile semantics. A persistent
Python-owned alternative would require a custom RPC bridge, not that server.

## Verified on macOS

macOS 27.2.1 (26B131), arm64; Node 26.13.1; Browser Python 0.5.9,
fpgen 1.3.0, Python/bundled Node Playwright 1.62.0; installed browser
158.0.1-beta.41. Repository Playwright 1.60.0 fails WebSocket handshake
against 1.62 with HTTP 428; bundled 1.62 passes. Navigation and JS evaluation
return 42; localStorage survives headless → headful → headless reopening.
Server exits 0. No spike browser processes remained after completion.

Python options are generated once and reused across modes to preserve identity;
a production adapter must generate mode-appropriate options and persist identity
separately if stable fingerprints across sessions are required. Default generation
warned about randomized canvas/WebGL readback; this spike does not claim stealth
quality. GeoIP is disabled and default addons excluded to avoid downloads.

Important: default `camoufox path/version` resolves Library/Caches on this host,
reports the active browser missing, and also contains legacy 135.0.1-beta.24.
The tested 158 binary lives under the upstream browser cache.
Always supply the explicit installed binary; do not auto-fetch to fix discovery.
