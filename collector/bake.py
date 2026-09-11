#!/usr/bin/env python3
"""AlgaeWatch Phase 1 baker.

Reads data/algaewatch_data.json and template/index.template.html, then writes
a self-contained index.html at the repo root with the data blob injected at the
single marker /*__ALGAEWATCH_DATA__*/.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = REPO_ROOT / "data" / "algaewatch_data.json"
TEMPLATE_PATH = REPO_ROOT / "template" / "index.template.html"
OUT_PATH = REPO_ROOT / "index.html"
MARKER = "/*__ALGAEWATCH_DATA__*/"


def escape_script(blob: str) -> str:
    """Escape sequences that could break out of an inline <script> tag."""
    return blob.replace("</script>", "<\\/script>").replace("</script", "<\\/script")


def main() -> int:
    if not DATA_PATH.exists():
        print(f"missing {DATA_PATH}; run collector/collect.py first", file=sys.stderr)
        return 1
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    if MARKER not in template:
        print(f"template is missing marker {MARKER}", file=sys.stderr)
        return 1

    blob = DATA_PATH.read_text(encoding="utf-8")
    json.loads(blob)  # never bake a non-parseable blob
    safe_blob = escape_script(blob)

    out = template.replace(MARKER, safe_blob)
    OUT_PATH.write_text(out, encoding="utf-8")
    print(f"wrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
