"""Generate options only for an explicit installed binary; never fetch browsers/addons."""
import json
import sys
from pathlib import Path
from importlib.metadata import version
from playwright._impl._driver import compute_driver_executable
from camoufox.utils import launch_options
from camoufox.server import to_camel_case_dict

binary = Path(sys.argv[1]).resolve()
if not binary.is_file():
    raise SystemExit(f"Missing installed binary: {binary}")
options = launch_options(executable_path=str(binary), headless=True,
                         addons=[], exclude_addons=list(__import__('camoufox.addons', fromlist=['DefaultAddons']).DefaultAddons),
                         geoip=False)
print(json.dumps(dict(options=to_camel_case_dict(options),
    driver=str(Path(compute_driver_executable()[0]).parent / "package"),
    versions={name: version(name) for name in ("camoufox", "fpgen", "playwright")})))
