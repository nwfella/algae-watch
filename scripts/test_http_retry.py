#!/usr/bin/env python3
"""Unit tests for the collector's transient-failure retry policy.

No network, no repo mutation: monkeypatches urllib.request.urlopen and drives
collect.http_get() through each failure shape the federal sources actually emit.

The failure shapes are taken from real cron runs, not invented:

  2026-09-24  HTTP 503  coastwatch ERDDAP "...There was a (temporary?) problem"
  2026-09-25  HTTP 404  coastwatch ERDDAP "Currently unknown datasetID"
  2026-09-27  HTTP 404  (same, dataset reload window)
  2026-09-29  URLError  [Errno 11001] getaddrinfo failed  (Windows DNS blip)

Run:  python scripts/test_http_retry.py
"""

from __future__ import annotations

import io
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "collector"))
import collect  # noqa: E402  (main() is guarded, so importing is safe)

FAILS: list[str] = []
CALLS: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        FAILS.append(msg)


class FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def http_error(code: int, body: bytes) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        "https://coastwatch.noaa.gov/x", code, "boom", {}, io.BytesIO(body)
    )


def install(script: list) -> None:
    """Install a urlopen stand-in: each entry is an exception to raise or a body."""
    CALLS.clear()

    def fake_urlopen(req, timeout=None):  # noqa: ANN001, ANN202
        CALLS.append(getattr(req, "full_url", str(req)))
        if not script:
            raise AssertionError("urlopen called more times than the test scripted")
        item = script.pop(0)
        if isinstance(item, Exception):
            raise item
        return FakeResponse(item)

    urllib.request.urlopen = fake_urlopen  # type: ignore[assignment]


URL = "https://coastwatch.noaa.gov/erddap/griddap/noaacwNPPN20S3ASCIDINEOF2kmDaily.csv"
WQP = "https://www.waterqualitydata.us/data/Result/search"

# Keep the real delays out of the test run; the policy is what is under test.
REAL_DELAYS = collect.RETRY_DELAYS
REAL_BUDGET = collect.RETRY_BUDGET_SECONDS


def with_fast_retries() -> None:
    collect.RETRY_DELAYS = (0.001, 0.001, 0.001)
    collect.RETRY_BUDGET_SECONDS = 1.0


def main() -> int:
    print("collector http_get retry policy:")

    # --- 1. ERDDAP 503 during a dataset reload -> retried, then succeeds -----
    with_fast_retries()
    install([http_error(503, b"Service Unavailable: There was a (temporary?) problem."), b"ok"])
    try:
        out = collect.http_get(URL)
        check(out == b"ok", "HTTP 503 is retried and the next attempt's body is returned")
    except SystemExit as exc:
        check(False, f"HTTP 503 should be retried, but aborted: {exc}")
    check(len(CALLS) == 2, f"503 costs exactly 2 attempts (got {len(CALLS)})")

    # --- 2. ERDDAP 404 'unknown datasetID' -> retried --------------------------
    install([http_error(404, b'Error {code=404; message="Currently unknown datasetID=noaacwNPPN20S3ASCIDINEOF2kmDaily";}'), b"ok"])
    try:
        out = collect.http_get(URL)
        check(out == b"ok", "ERDDAP 404 'unknown datasetID' is retried (dataset reload)")
    except SystemExit as exc:
        check(False, f"a 404 dataset-reload should be retried, but aborted: {exc}")
    check(len(CALLS) == 2, f"dataset-reload 404 costs exactly 2 attempts (got {len(CALLS)})")

    # --- 3. a REAL 404 (bad constraint) must NOT be retried -------------------
    install([http_error(404, b'Error {message="Constraint ... is greater than the axis maximum";}')])
    try:
        collect.http_get(URL)
        check(False, "a real 404 (bad constraint) must fail loudly")
    except SystemExit as exc:
        check("HTTP 404" in str(exc) and "axis maximum" in str(exc),
              "a real 404 fails loudly with the server's reason")
    check(len(CALLS) == 1, f"a real 404 is not retried (got {len(CALLS)} attempt(s))")

    # --- 4. WQP 400 (empty body) must NOT be retried --------------------------
    install([http_error(400, b"")])
    try:
        collect.http_get(WQP)
        check(False, "an unknown characteristicName (HTTP 400) must fail loudly")
    except SystemExit as exc:
        check("HTTP 400" in str(exc) and "(empty response body)" in str(exc),
              "HTTP 400 with an empty body still reports both the code and the emptiness")
    check(len(CALLS) == 1, f"HTTP 400 is not retried (got {len(CALLS)} attempt(s))")

    # --- 5. Windows DNS blip -> retried --------------------------------------
    install([urllib.error.URLError("[Errno 11001] getaddrinfo failed"), b"ok"])
    try:
        out = collect.http_get(URL)
        check(out == b"ok", "a getaddrinfo/DNS failure is retried")
    except SystemExit as exc:
        check(False, f"a DNS blip should be retried, but aborted: {exc}")

    # --- 6. persistent 503 -> fails after the attempt budget ------------------
    install([http_error(503, b"temporary")] * 4)
    try:
        collect.http_get(URL)
        check(False, "a persistent 503 must eventually fail loudly")
    except SystemExit as exc:
        check("HTTP 503" in str(exc), "a persistent 503 fails loudly after the retries")
    check(len(CALLS) == 4, f"retry budget is 4 attempts (got {len(CALLS)})")

    # --- 7. 501 (not retryable) fails on the first attempt --------------------
    install([http_error(501, b"not implemented")])
    try:
        collect.http_get(URL)
        check(False, "HTTP 501 must fail loudly on the first attempt")
    except SystemExit:
        pass
    check(len(CALLS) == 1, f"HTTP 501 is not retried (got {len(CALLS)} attempt(s))")

    # --- 8. an exhausted sleep budget stops retrying --------------------------
    collect.RETRY_DELAYS = (100.0, 100.0, 100.0)
    collect.RETRY_BUDGET_SECONDS = 0.0
    install([http_error(503, b"temporary")])
    try:
        collect.http_get(URL)
        check(False, "an exhausted retry budget must fail loudly, not sleep")
    except SystemExit:
        pass
    check(len(CALLS) == 1, "a spent retry budget costs no extra attempts (no 100 s sleep)")

    # --- 9. the .gov allowlist still gates every request ----------------------
    install([b"ok"])
    try:
        collect.http_get("https://example.com/data.csv")
        check(False, "a non-.gov host must be refused")
    except ValueError as exc:
        check("allowlist violation" in str(exc), "a non-.gov host is still refused by the allowlist")
    check(len(CALLS) == 0, "a refused host never reaches the network")

    collect.RETRY_DELAYS = REAL_DELAYS
    collect.RETRY_BUDGET_SECONDS = REAL_BUDGET

    if FAILS:
        print(f"FAIL: {len(FAILS)} assertion(s) failed")
        return 1
    print("PASS: collector http_get retry policy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
