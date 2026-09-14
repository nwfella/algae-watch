#!/usr/bin/env python3
"""Unit tests for the AlgaeWatch quiet-watchdog report.

No network, no repo mutation: exercises build_report() directly against a
synthetic blob plus the real baked blob. Run:  python scripts/test_refresh_report.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily_refresh as dr  # noqa: E402  (guarded by __main__, so importing is safe)

FAILS: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        FAILS.append(msg)


SYN = {
    "generated_utc": "2026-09-14T00:00:00Z",
    "sites": [{"id": "S1", "name": "Test Lake"}],
    "observations": [{"stale": True}, {"stale": False}],
    "alerts": [
        {"site_id": "S1", "param": "microcystin", "level": "exceedance",
         "value": 12.5, "criterion": 8.0, "verified": False},
        {"site_id": "S2", "param": "beach_hazards_statement", "level": "advisory"},
    ],
}


def main() -> int:
    print("quiet-watchdog report:")

    msg = dr.build_report(SYN, [("S1", "microcystin", "exceedance")])
    check(msg != "", "a new threshold breach produces a message")
    check("Test Lake" in msg, "the message names the site")
    check("12.5" in msg and "criteria" not in msg, "the message shows the measured value")
    check("8" in msg, "the message shows the criterion value")
    check("UNVERIFIED" in msg, "the message carries the unverified-threshold note")
    check(dr.LIVE_URL in msg, "the message links to the live site")

    check(dr.build_report(SYN, [("S2", "beach_hazards_statement", "advisory")]) == "",
          "an NWS advisory alone does NOT alert (not a criterion breach)")
    check(dr.build_report(SYN, []) == "", "nothing new -> silent")
    check(dr.build_report(SYN, [("S1", "microcystin", "approaching")]) != "",
          "an 'approaching' status does alert")

    blob_path = dr.REPO / "data" / "algaewatch_data.json"
    if blob_path.exists():
        blob = json.loads(blob_path.read_text(encoding="utf-8"))
        check(dr.build_report(blob, []) == "", "real blob with nothing new -> silent")
        all_alerts = [
            (a.get("site_id"), a.get("param"), a.get("level")) for a in blob.get("alerts", [])
        ]
        real = dr.build_report(blob, all_alerts)
        breaches = [a for a in blob.get("alerts", []) if a.get("level") in ("exceedance", "approaching")]
        check((real != "") == (len(breaches) > 0),
              f"real blob alerts iff a breach exists ({len(breaches)} present)")
    else:
        check(False, "real blob is missing (run the collector first)")

    if FAILS:
        print(f"FAIL: {len(FAILS)} assertion(s) failed")
        return 1
    print("PASS: quiet-watchdog report")
    return 0


if __name__ == "__main__":
    sys.exit(main())
