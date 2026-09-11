# Phase 1 Build Brief — Collector & Bake Pipeline

**Read `SPEC.md` and `DATA_SOURCES.md` at the repo root FIRST.** They contain the verified endpoints, the four endpoint traps, and the locked decisions. Do not re-derive any of it, and do not invent endpoints.

**Phase 1 is BACKEND ONLY. There is no UI in this phase.**

---

## Deliverables — create exactly these files

| Path | Purpose |
|---|---|
| `collector/collect.py` | The collector. Stdlib only. |
| `collector/bake.py` | Injects the baked blob into the HTML template |
| `collector/criteria.json` | Threshold table (see below) |
| `collector/watchlist.json` | Seed watchlist sites |
| `scripts/verify_site.js` | Build gate (Node, no dependencies) |
| `template/index.template.html` | Minimal shell containing the injection marker |
| `tests/fixtures/` | `stale_records.json`, `fresh_records.json`, `bad_host.json` |
| `README.md` | How to run collect → bake → verify |

## Hard constraints (violating any of these fails review)

1. **Python standard library only** — `urllib.request`, `json`, `csv`, `gzip`, `re`, `datetime`, `argparse`, `pathlib`. **No `requests`, no `pandas`, no pip installs, no venv assumptions.** Target Python 3.11.
2. **`scripts/verify_site.js` uses Node builtins only** (`fs`, `path`, `assert`). No npm packages, no `package.json`.
3. **No writes outside the repo directory.**
4. **ABSOLUTE — the .gov allowlist.** Every outbound HTTP request must have a host ending in `.gov`, with exactly one documented exception: `www.waterqualitydata.us`. This is enforced **in code** as a guard function that **raises** on violation — not a comment, not a warning. `tests/fixtures/bad_host.json` proves it raises.
5. **Never convert missing data into `0`.** A `NaN` satellite pixel and an absent lab result are both `null`. Zero means a measured zero.
6. **Deterministic output** — `data/algaewatch_data.json` with `sort_keys=True`; same inputs produce byte-identical output.

## The four traps — already verified, do not rediscover

1. **WQP: `mimeType=json` returns `406 Not Acceptable`.** You MUST use `mimeType=csv&zip=no` and a browser User-Agent. Also: **repeating a query parameter silently returns 0 bytes** — send **ONE `characteristicName` per request**.
2. **ERDDAP CyAN: the size-1 `altitude` dimension must be passed explicitly** or the query 404s with *"axis#1=altitude ... greater than the axis maximum"*. Correct shape: `chlor_a[(YYYY-MM-DD)][(0.0)][(latLo):1:(latHi)][(lonLo):1:(lonHi)]`.
3. **ERDDAP sends no CORS header** — irrelevant to this collector (server-side), but never move it into the browser.
4. **`www.epa.gov` is WAF-blocked** (returns a 6,518-byte challenge page). **Never fetch it.** Thresholds come from `criteria.json` only.

## `collector/criteria.json`

Both exposure routes, explicitly **unverified**:

```json
{
  "verified": false,
  "verified_note": "Values pending confirmation against the EPA source (www.epa.gov is WAF-blocked from the build environment). Do NOT present these as confirmed.",
  "routes": {
    "recreational": {
      "label": "Recreational water contact",
      "criteria": [
        {"param": "microcystin", "value": 8.0, "unit": "ug/L", "citation": "EPA 2019 recommended human health recreational ambient water quality criteria"},
        {"param": "cylindrospermopsin", "value": 15.0, "unit": "ug/L", "citation": "EPA 2019 recommended human health recreational ambient water quality criteria"}
      ]
    },
    "drinking_water": {
      "label": "Drinking water intake",
      "criteria": [
        {"param": "microcystin", "value": 0.3, "unit": "ug/L", "citation": "EPA 2015 drinking water health advisory (microcystin-LR)"},
        {"param": "cylindrospermopsin", "value": 0.7, "unit": "ug/L", "citation": "EPA 2015 drinking water health advisory (cylindrospermopsin)"}
      ]
    }
  }
}
```

## Collector behaviour — numbered requirements

1. **Allowlist guard** runs before every request; raises `ValueError` naming the offending host.
2. **CyAN (satellite):** for each watchlist site, request a padded bbox slice (default ±0.3°, configurable) for the rolling window. Aggregate a **weekly composite** (mean of non-`NaN` values, `null` where no retrieval) for the anomaly view. Cap total requests; make the window and pad CLI-configurable.
3. **WQP (lab cyanotoxins):** three separate requests — `Microcystin`, `Cylindrospermopsin`, `Saxitoxin` — covering a rolling 12 months. Send the browser UA. **CSV only.**
4. **WQP stations:** fetch the station index and **join on `MonitoringLocationIdentifier`** to recover state — the Result export leaves `StateCode` blank. Map numeric FIPS codes to state abbreviations.
5. **USGS:** `latest-continuous` for parameter codes **32266** (chlorophyll-a blue-green) and **32267** (phycocyanin), plus `monitoring-locations` metadata for site names/coords. **Expect ~3 sites with readings ~20 months old — this is correct behaviour, not a bug.** These MUST be marked `stale: true`.
6. **NWS:** `/alerts/active` for `Beach Hazards Statement` and `Marine Weather Statement`. Do not send an unsupported `limit` param (it 400s).
7. **Freshness gating** — budgets: CyAN ≤ 3 days, WQP ≤ 45 days, USGS sensors ≤ 7 days, NWS ≤ 24 h. Any observation older than its budget gets `stale: true` and the site badge changes.
8. **Fail loudly, never silently.** If a source expected to return thousands of rows returns **0**, exit non-zero with a clear message — do not bake an empty app. A source legitimately returning 0 (e.g. Anatoxin-a) is declared in config as `expect_zero: true` and passes.
9. **Emit `data/algaewatch_data.json`** matching the **SPEC.md §6 schema exactly** — including `generated_utc`, `freshness`, `sites`, `observations`, `satellite`, `alerts`, `baselines`, `coverage`, `sources`.
10. **Coverage honesty:** compute `states_with_data` / `states_no_data` and carry the note *"Absence of data is not absence of blooms."*
11. **Alerts:** fire only on a criterion from `criteria.json`; each alert carries `value`, `criterion`, `criterion_src`, and `level` (`exceedance` / `approaching` within 25% / none). Where `verified: false`, propagate that flag onto the alert object.
12. **`collect --offline`** mode: read from `_probe/*.csv` + cached fixtures instead of the network, so the pipeline is testable without network access.
13. **Bake:** inject the JSON blob into `template/index.template.html`, replacing a single marker `/*__ALGAEWATCH_DATA__*/`, producing `index.html` at the repo root. Escape `</script>` sequences in string values so the blob cannot break out of the script tag.

## `scripts/verify_site.js` — the build gate (must exit non-zero on failure)

Assert all of:
1. `index.html` exists and contains a parseable data blob (**actually parse it**, don't just grep).
2. The blob's JSON round-trips and has every top-level key from SPEC §6.
3. `generated_utc` parses as a date and is within 48 h (unless `--allow-stale`).
4. Every `observation` has a `source_id` present in `sources[]` — no orphan values.
5. No observation has `value === 0` where the source is satellite/`NaN`-capable and no retrieval occurred (guards the null-vs-zero rule).
6. Every observation older than its source's freshness budget has `stale === true`.
7. `coverage.states_no_data` is non-empty or explicitly justified.
8. Each `sources[].url` host passes the same `.gov` allowlist as the collector.
9. Print a human-readable summary (counts per source, stale counts, alert counts) and exit `0`.

**Seeded-failure proof:** run the gate against `tests/fixtures/stale_records.json` and confirm it exits non-zero.

## Acceptance criteria

- [ ] `python collector/collect.py --offline` completes and writes `data/algaewatch_data.json` with **no network access**
- [ ] Live run reconciles **~12,100 cyanotoxin rows** for a full prior year (see `DATA_SOURCES.md` for the 2024 baseline) — report the actual count
- [ ] `python collector/bake.py` produces `index.html` containing the blob
- [ ] `node scripts/verify_site.js` exits `0` on good data; **exits non-zero** on `tests/fixtures/stale_records.json`
- [ ] The allowlist guard **raises** on `tests/fixtures/bad_host.json`
- [ ] USGS sensor records are marked `stale: true` (they are ~20 months old — a build that reports them as current fails)
- [ ] No `0` substituting for missing satellite retrievals
- [ ] Running collect twice with identical inputs yields byte-identical JSON (determinism)

## Out of scope — do NOT build these

- Any real UI beyond `template/index.template.html` containing the marker and a placeholder. **Charts, maps, and views are Phase 2.**
- Client-side/live fetching of any kind (Live mode is cut)
- BEACON2 integration (deferred — a disabled stub is fine)
- Anything touching a non-`.gov` host
- Inventing or "correcting" threshold values — `criteria.json` is used exactly as written
