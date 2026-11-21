"""Options-only adapter. Explicit installed binary; never fetch or update."""
import contextlib
import json
import os
import sys
from pathlib import Path
from importlib.metadata import version


def main():
    binary = Path(sys.argv[1]).resolve(strict=True)
    headless = sys.argv[2] == 'headless'
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError('binary is not an executable file')
    metadata = next((parent / 'version.json' for parent in binary.parents
                     if (parent / 'version.json').is_file()), None)
    if metadata is None:
        raise ValueError('missing browser version.json beside installation; select a complete installed Camoufox build')
    browser = json.loads(metadata.read_text())
    if (browser.get('version'), browser.get('build'), browser.get('interface')) != ('158.0.1', 'beta.41', 1):
        raise ValueError('unsupported browser build; select installed 158.0.1-beta.41 (interface 1); do not auto-update')
    versions = {name: version(name) for name in ('camoufox', 'fpgen', 'playwright')}
    expected = {'camoufox': '0.5.9', 'fpgen': '1.3.0', 'playwright': '1.62.0'}
    if versions != expected:
        raise ValueError(f'unsupported Python packages {versions}; install camoufox==0.5.9 fpgen==1.3.0 playwright==1.62.0 in the configured environment')
    # This private API is guarded by exact package version and structural checks.
    from playwright._impl._driver import compute_driver_executable
    import playwright
    driver = Path(compute_driver_executable()[0]).resolve().parent / 'package'
    root = Path(playwright.__file__).resolve().parent
    if driver != root / 'driver' / 'package':
        raise ValueError('unsupported private Playwright driver layout; reinstall Python playwright==1.62.0')
    package = json.loads((driver / 'package.json').read_text())
    if package.get('version') != versions['playwright']:
        raise ValueError('Python/bundled Node driver version mismatch; reinstall Python playwright==1.62.0')
    from camoufox.utils import launch_options
    from camoufox.addons import DefaultAddons
    from camoufox.server import to_camel_case_dict
    # Redirect incidental package output away from the JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        options = launch_options(executable_path=str(binary), headless=headless,
                                 addons=[], exclude_addons=list(DefaultAddons), geoip=False)
    print(json.dumps(dict(options=to_camel_case_dict(options), driver=str(driver), versions=versions)))


try:
    main()
except Exception as error:
    print(f'Camoufox setup: {error}. Configure PI_CAMOUFOX_PYTHON and PI_CAMOUFOX_EXECUTABLE; no automatic downloads.', file=sys.stderr)
    sys.exit(1)
