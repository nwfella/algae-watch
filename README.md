# AlgaeWatch

**Live: https://nwfella.github.io/algae-watch/**

A freshwater cyanobacteria (harmful algal bloom) watchlist built **exclusively
from official U.S. federal data** — NOAA, USGS, EPA and NWS. No state agencies,
no NGOs, no commercial APIs, no non-U.S. satellites. Single self-contained HTML
file, zero dependencies, zero runtime network fetches: the collector runs
server-side and bakes the data into the page.

Six views: **Map · Watchlist · Site detail · Anomaly · Alerts · Sources**.

The guiding rule of the project is that the data has to be described honestly.
Every value carries an age, stale readings are unmistakable, missing data renders
as an em dash rather than a zero, a site with no rows is never called clean, and
thresholds that have not been confirmed against the EPA source say so on the page.


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

---

# Phase 2 — the SPA

`template/index.template.html` is the whole front end: one self-contained HTML
file, vanilla JS/CSS, zero dependencies, no build step. `bake.py` injects the
blob at the `/*__ALGAEWATCH_DATA__*/` marker and writes the shippable
`index.html`. Six views: **Map · Watchlist · Site detail · Anomaly · Alerts ·
Sources**.

## Honesty rules the UI implements

These are the point of the app, not decoration:

- Every displayed value carries an **age**; `stale: true` gets a loud `STALE` chip.
- `null` / `undefined` / `NaN` render as an **em dash** — a measured `0` still
  renders as `0.00`. Missing satellite cells are never painted, never zeroed.
- A state or site with no rows reads **"no federal data reported"**, never
  "clean"/"safe", and the Absence-of-data warning is surfaced wherever a gap is.
- Synthetic builds (`mode: "offline"`) raise an unmissable **SYNTHETIC DATA**
  banner.
- Unverified thresholds carry a persistent **Thresholds UNVERIFIED** notice, and
  every alert shows measured value + criterion value + citation.
- `baselines` flagged `estimated` are labelled `ESTIMATE` in the Anomaly view.

The app hardcodes exactly one remote endpoint — the optional USGS (`.gov`)
basemap — and degrades gracefully to grid + pins when those tiles are blocked.
No data is fetched at runtime; everything comes from the baked blob.

## Verify

```bash
python collector/bake.py        # inject the blob
node scripts/verify_site.js     # Phase 1 build gate  -> exit 0
node scripts/aw_test.js         # Phase 2 harness     -> exit 0
```

`scripts/aw_test.js` loads the **baked** artifact, extracts the real blob,
executes the app script in a bare sandbox with no DOM, and asserts the honesty
rules against real data — including two precision tests that a naive
implementation would fail:

- an all-null satellite grid must issue **exactly one** `fillRect` (background
  only) — proving no fabricated pixels;
- a mixed grid must issue **exactly three** (background + the two retrieved
  cells).

## Browser verification (Chrome headless, 2026-09-11)

Rendered with `chrome --headless --dump-dom` against the baked artifact:

| Check | Result |
|---|---|
| Tabs painted / all six views render | 6 / 6, no console errors |
| View payloads (chars) | map 3,462 · watchlist 37,544 · site 1,891 · anomaly 3,944 · alerts 8,174 · sources 6,741 |
| Canvas actually paints | `canvasLitPct=3.4` (real pixels, not a blank canvas) |
| USGS basemap tiles | 8/8 loaded, with a graceful fallback path if blocked |
| Synthetic banner on live data | **not rendered** (`modeBannerVisible=false`) |
| Unverified-threshold notice | rendered |
| Page overflow @ 958px and 1258px | none (`scrollWidth == innerWidth`) |
| `STALE` chips / em-dash values in watchlist | 15 / 49 |
| EPA citations in Alerts | 20 |

**Caveat, stated plainly:** true **375px** was *not* measurable — headless
Chrome clamps its viewport to ~500px, so the narrowest verified width is ~512px.
The CSS carries a `≤640px` breakpoint and no element exceeds the viewport at the
widths tested, but the 375px claim remains unverified until it is opened on a
real device.

