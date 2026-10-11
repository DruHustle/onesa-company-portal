#!/usr/bin/env python3
"""Reconcile this registration in the existing shared CI VM."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
spec = spec_from_file_location('shared_setup', Path(__file__).with_name('shared-setup.py'))
module = module_from_spec(spec)
spec.loader.exec_module(module)
if __name__ == '__main__':
    module.main()
