#!/usr/bin/env python3
"""AlgaeWatch Phase 4 — daily refresh.

collect -> compare -> bake -> gate -> harness -> push (only when the data moved).

Designed to run from a Hermes cron job with no_agent=True:
  * NO stdout  = nothing changed, stay silent (watchdog pattern)
  * stdout     = a human-readable report, delivered verbatim as the message
  * non-zero   = the scheduler raises an error alert

Nothing is ever deployed unless BOTH gates pass. A failed collect or a failed
gate leaves the live site on its previous, known-good build.

Stdlib only.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
STATE = REPO / ".refresh_state.json"
BLOB = REPO / "data" / "algaewatch_data.json"
INDEX = REPO / "index.html"
BRANCH = "master"
LIVE_URL = "https://nwfella.github.io/algae-watch/"
COLLECT_TIMEOUT = 1200  # live collection takes ~4 min; allow plenty
GATE_TIMEOUT = 300


def die(msg: str) -> "None":
    """Fail loudly. The cron scheduler turns a non-zero exit into an alert."""
    print("AlgaeWatch refresh FAILED: " + msg)
    sys.exit(1)


def env() -> dict:
    e = dict(os.environ)
    # The Hermes environment exports PYTHONPATH pointing at its own agent venv
    # (pydantic_lite/requests shadowing), which has broken external Python runs
    # before. The collector is stdlib-only, so hand it a clean interpreter.
    e.pop("PYTHONPATH", None)
    e.pop("PYTHONHOME", None)
    # Fail fast instead of hanging the cron run on a credential prompt.
    e["GIT_TERMINAL_PROMPT"] = "0"
    # The scheduler may run with a bare PATH; make sure node and git resolve.
    extra = [
        r"C:\Program Files\nodejs",
        os.path.expanduser(r"~\AppData\Local\hermes\node"),
        r"C:\Program Files\Git\cmd",
    ]
    e["PATH"] = os.pathsep.join([p for p in extra if os.path.isdir(p)] + [e.get("PATH", "")])
    return e


def run(cmd: list[str], timeout: int = GATE_TIMEOUT) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, cwd=str(REPO), env=env(), capture_output=True, text=True,
        timeout=timeout, errors="replace",
    )


def tool(name: str) -> str:
    """Resolve a tool, so a cron run with a minimal PATH still works."""
    found = shutil.which(name)
    if found:
        return found
    for cand in (
        rf"C:\Program Files\nodejs\{name}.exe",
        os.path.expanduser(rf"~\AppData\Local\hermes\node\{name}"),
    ):
        if os.path.exists(cand):
            return cand
    die(f"required tool not found on PATH: {name}")


def tail(text: str, n: int = 900) -> str:
    text = (text or "").strip()
    return text[-n:]


def data_signature(blob: dict) -> str:
    """Hash the DATA, ignoring the bake timestamp.

    generated_utc changes every run, so hashing the whole blob would make every
    day look like a change and produce a commit a day of pure noise.
    """
    clone = json.loads(json.dumps(blob))
    clone.pop("generated_utc", None)
    return hashlib.sha256(
        json.dumps(clone, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def build_report(blob: dict, new_alerts: list) -> str:
    """Quiet-watchdog message: '' unless a NEW threshold breach appeared.

    Routine refreshes say nothing at all. NWS advisories are deliberately kept
    out of the alerting path - a beach-hazards statement is not a criterion
    breach, and waking the user for one would be a false alarm.
    """
    alerts = blob.get("alerts", [])
    breaches = [a for a in new_alerts if a[2] in ("exceedance", "approaching")]
    if not breaches:
        return ""

    names = {s["id"]: (s.get("name") or s["id"]) for s in blob.get("sites", [])}
    by_key = {(a.get("site_id"), a.get("param"), a.get("level")): a for a in alerts}
    advisories = [a for a in new_alerts if a[2] not in ("exceedance", "approaching")]
    stale = sum(1 for o in blob.get("observations", []) if o.get("stale"))

    out = [f"AlgaeWatch: {len(breaches)} new threshold breach(es) - {blob.get('generated_utc')}"]
    for sid, param, level in breaches[:10]:
        a = by_key.get((sid, param, level), {})
        val, crit = a.get("value"), a.get("criterion")
        detail = ""
        if isinstance(val, (int, float)) and isinstance(crit, (int, float)):
            detail = f" (measured {val:g} vs criterion {crit:g} ug/L)"
        out.append(f"  - {names.get(sid, sid)} :: {param} :: {level}{detail}")
    if len(breaches) > 10:
        out.append(f"  ...and {len(breaches) - 10} more")
    out.append(f"  live: {LIVE_URL}")
    out.append(f"  context: {len(alerts)} alerts, {stale} stale observations")
    if advisories:
        out.append(f"  ({len(advisories)} new NWS advisories also present - not breaches)")
    if any(a.get("verified") is False for a in alerts):
        out.append("  note: thresholds are still UNVERIFIED against the EPA source")
    return "\n".join(out)


def main() -> int:
    for required in (REPO / "collector" / "collect.py", REPO / "collector" / "bake.py"):
        if not required.exists():
            die(f"missing {required}")

    # --- 0. the source tree must be clean -----------------------------------
    # If something (a stray agent, a manual edit) has modified the source, stop
    # rather than baking and shipping an unexpected artifact.
    dirty = run(["git", "status", "--porcelain", "--", "collector", "scripts", "template"]).stdout.strip()
    if dirty:
        die("source tree is dirty - refusing to build from a modified tree:\n" + dirty)

    # --- 1. collect ---------------------------------------------------------
    r = run([sys.executable, "collector/collect.py"], timeout=COLLECT_TIMEOUT)
    if r.returncode != 0:
        die(f"collector exited {r.returncode}\n{tail(r.stdout + r.stderr)}")
    if not BLOB.exists():
        die("collector produced no blob")

    try:
        blob = json.loads(BLOB.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        die(f"blob is not valid JSON: {exc}")

    if blob.get("mode") != "live":
        die(f"blob mode is {blob.get('mode')!r}, expected 'live' (synthetic builds must never ship)")
    gen = blob.get("generated_utc")
    if not gen:
        die("blob has no generated_utc")

    prev: dict = {}
    if STATE.exists():
        try:
            prev = json.loads(STATE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            prev = {}

    prev_gen = prev.get("generated_utc")
    if prev_gen and gen <= prev_gen:
        die(f"generated_utc did not advance ({prev_gen} -> {gen}) - collector may have served a cache")

    sig = data_signature(blob)

    # --- 2. nothing moved? stay silent --------------------------------------
    if prev.get("signature") == sig:
        STATE.write_text(json.dumps({
            "generated_utc": gen,
            "signature": sig,
            "checked_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }, indent=1), encoding="utf-8")
        return 0  # no stdout -> the cron scheduler sends nothing

    # --- 3. bake ------------------------------------------------------------
    r = run([sys.executable, "collector/bake.py"])
    if r.returncode != 0:
        die(f"bake exited {r.returncode}\n{tail(r.stdout + r.stderr)}")

    # --- 4. gates: nothing ships unless both pass ---------------------------
    node = tool("node")
    for gate in ("scripts/verify_site.js", "scripts/aw_test.js"):
        r = run([node, gate])
        if r.returncode != 0:
            die(f"{gate} exited {r.returncode} - REFUSING TO DEPLOY\n{tail(r.stdout + r.stderr)}")

    # --- 5. what changed, for the report ------------------------------------
    alerts = blob.get("alerts", [])
    sigs = sorted({(a.get("site_id"), a.get("param"), a.get("level")) for a in alerts})
    prev_sigs = {tuple(x) for x in prev.get("alerts", [])}
    new_alerts = [s for s in sigs if s not in prev_sigs]

    names = {s["id"]: (s.get("name") or s["id"]) for s in blob.get("sites", [])}
    per_source: dict[str, int] = {}
    for o in blob.get("observations", []):
        per_source[o.get("source_id", "?")] = per_source.get(o.get("source_id", "?"), 0) + 1

    # --- 6. deploy ----------------------------------------------------------
    r = run(["git", "add", "--", "index.html", "data/algaewatch_data.json"])
    if r.returncode != 0:
        die("git add failed\n" + tail(r.stdout + r.stderr))
    r = run(["git", "commit", "-m", f"data: daily refresh {gen}"])
    if r.returncode != 0:
        die("git commit failed\n" + tail(r.stdout + r.stderr))
    r = run(["git", "push", "origin", f"HEAD:{BRANCH}"], timeout=600)
    if r.returncode != 0:
        die("git push failed - the live site is unchanged\n" + tail(r.stdout + r.stderr))

    STATE.write_text(json.dumps({
        "generated_utc": gen,
        "signature": sig,
        "alerts": [list(s) for s in sigs],
        "checked_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }, indent=1), encoding="utf-8")

    # --- 7. report: quiet watchdog ------------------------------------------
    # Silent on a routine refresh; stdout only when something needs attention.
    msg = build_report(blob, new_alerts)
    if msg:
        print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
