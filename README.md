# AlgaeWatch — Phase 1 (Collector & Bake Pipeline)

Backend-only build pipeline for the AlgaeWatch freshwater cyanobacteria
watchlist. It collects exclusively official U.S. federal sources, bakes the
result into a single self-contained `index.html`, and gates the result with a
dependency-free Node script. No UI ships in this phase.

## Requirements

- Python 3.11+ (standard library only — no `requests`, no `pandas`)
- Node (builtins only — no npm packages, no `package.json`)

## Run

```bash
# 1. COLLECT (live — this is the shippable path).
python collector/collect.py

# 2. Bake the JSON blob into template/index.template.html -> index.html.
python collector/bake.py

# 3. Gate. Exits 0 only when every assertion passes.
node scripts/verify_site.js
```

For pipeline work without network access, `--offline` reads `_probe/*.csv` plus
cached fixtures — but be aware of what that means (see **Provenance** below).

```bash
python collector/collect.py --offline
```

The collector writes `data/algaewatch_data.json` (deterministic, `sort_keys=True`).
Use `--now <ISO-8601 UTC>` for a byte-identical reproducible build:

```bash
python collector/collect.py --offline --now 2026-09-11T18:00:00Z
```

## Provenance — offline output is NOT shippable

The offline collector has no network access to NOAA CoastWatch, so it
substitutes a **synthetic** CyAN satellite grid for the real one. Every synthetic
artifact is tagged:

- the blob carries `"mode": "offline"` (live runs write `"mode": "live"`)
- each satellite slice carries `"synthetic": true`
- each derived observation carries `"synthetic": true`

`verify_site.js` **refuses by default** to pass an offline blob, so measured
data can never be presented as federal data:

```bash
node scripts/verify_site.js --file data/algaewatch_data.json   # exit 1 on an offline blob
node scripts/verify_site.js --allow-synthetic                  # dev escape hatch only
```

The live fetch path has **no** synthetic fallback — a network or HTTP failure
aborts the build. That is deliberate: a failed NOAA fetch must never silently
produce plausible-looking data.

## The .gov allowlist

Every outbound request host must end in `.gov`, with one documented joint
exception: `www.waterqualitydata.us`. The guard is enforced in code and raises
`ValueError` on a violation — it is never a warning. Prove it:

```bash
python collector/collect.py --allowlist-check tests/fixtures/bad_host.json
# exits non-zero: ValueError: allowlist violation: host 'example.com' ...

node scripts/verify_site.js --file tests/fixtures/bad_host.json --allow-stale
# exits non-zero: allowlist violation
```

## Seeded-failure proof

`tests/fixtures/stale_records.json` contains an observation older than its
source's freshness budget but marked `stale: false`. The gate must reject it:

```bash
node scripts/verify_site.js --file tests/fixtures/stale_records.json --allow-stale
# exits non-zero
```

## Row reconciliation

Offline mode reconciles **12,100** WQP cyanotoxin result rows for the prior
year (Microcystin 5,377 + Cylindrospermopsin 4,143 + Saxitoxin 2,580). The
collector prints `WQP cyanotoxin rows reconciled: <n>` and fails loudly if a
characteristic expected to return rows comes back empty.

> **WQP names are case-sensitive.** An unknown `characteristicName` returns a bare
> **HTTP 400 with an empty body**. The valid spelling is `Anatoxin-A` — *not*
> `Anatoxin-a`. Verify any new name against
> `https://www.waterqualitydata.us/Codes/characteristicname?mimeType=json`.
> `Anatoxin-A` is declared `expect_zero: true` because it legitimately has no
> results; the other three must return rows or the build aborts.

## Freshness

| Source | Budget |
|---|---|
| CyAN satellite | ≤ 3 days |
| WQP lab cyanotoxins | ≤ 45 days |
| USGS continuous sensors | ≤ 7 days |
| NWS active alerts | ≤ 24 h |

Observations older than their budget are emitted with `stale: true`. The USGS
algae sensors are ~20 months old, so they are correctly marked stale — never
presented as current.

A satellite slice also reports `days_with_data` / `window_days`, and its `date`
is the **newest day that actually returned a value** — never the requested date,
which would claim freshness that was never received. If the whole window is
cloud-obscured, `date` is `null`.

## Known Phase 1 limitations

- `baselines` are single-window stand-ins flagged `"estimated": true`; they are
  **not** the 2018→present day-of-year climatology the spec calls for.
- The EPA threshold values in `collector/criteria.json` carry
  `"verified": false` and must be confirmed against the EPA source before the
  alert engine is presented as authoritative. `www.epa.gov` is WAF-blocked from
  this build environment, so the values could not be verified automatically.
