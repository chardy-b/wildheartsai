"""Build-time adaptation of a pinned Iggy checkout for an independent daemon.

Different Docker labels prevent either daemon's startup sweep deleting the other's runs.
This never edits the running production chat daemon or its configuration.
"""
from pathlib import Path
import subprocess
import sys

PIN = "73384230ce3f623c9a6e20c4d2bf280d8cae7e12"

def prepare(root):
    revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if revision != PIN: raise SystemExit("Unexpected Iggy revision")
    for path in root.rglob("*.go"):
        text = path.read_text()
        text = text.replace('"iggy.run"', '"whdoc.run"').replace('"iggy.role"', '"whdoc.role"').replace('"iggy-health-', '"whdoc-health-')
        if path.name == "profile.go":
            for old, new in [("MemoryMB:         512", "MemoryMB:         1024"), ("CPUQuota:         0.5", "CPUQuota:         1.0"), ("285 * time.Second", "1800 * time.Second"), ("PidsLimit:        64", "PidsLimit:        128"), ("TmpfsSizeMB:      64", "TmpfsSizeMB:      192")]:
                if old not in text: raise SystemExit("Iggy policy changed")
                text = text.replace(old, new)
        if path.name == "profile_test.go": text = text.replace("285*time.Second", "1800*time.Second").replace("want 4m45s", "want 30m")
        path.write_text(text)

if __name__ == "__main__": prepare(Path(sys.argv[1]))
