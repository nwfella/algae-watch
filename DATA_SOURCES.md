# AlgaeWatch — Data Sources (verified)

**Hard rule:** every data source must be an **official U.S. government** source. No state agencies, no NGOs, no commercial APIs, no ESA/foreign satellites.
**All endpoints below were probed live on 2026-09-11.** Status = observed, not assumed.

## Allowlist (by domain)

| Domain | Owner | Allowed |
|---|---|---|
| `api.waterdata.usgs.gov` | USGS | ✅ |
| `www.waterqualitydata.us` | USGS + EPA (+ NGWMN) joint | ✅ |
| `coastwatch.noaa.gov` | NOAA | ✅ |
| `coastwatch.glerl.noaa.gov` | NOAA GLERL | ✅ |
| `api.tidesandcurrents.noaa.gov` | NOAA | ✅ |
| `api.weather.gov` | NOAA / NWS | ✅ |
| `www.ncei.noaa.gov` | NOAA NCEI | ✅ |
| `basemap.nationalmap.gov` | USGS | ✅ |
| `watersgeo.epa.gov` | EPA BEACON2 | ✅ (export endpoint unverified) |
| `www.epa.gov` | EPA (documents/criteria) | ⚠️ **WAF-blocked from this environment** — returns a 6,518-byte challenge page; the 2019 recreational-criteria factsheet PDF returns `403`. Retrieve manually in a browser. Note `watersgeo.epa.gov` worked while `www.epa.gov` did not — per-host, not blanket |
| anything not `*.gov` | — | ❌ |

Rule of thumb for the verifier: if the request host doesn't end in `.gov` (exception: `waterqualitydata.us`, operated jointly by USGS/EPA — documented here deliberately), the collector must refuse it.

---

## 1. NOAA CoastWatch ERDDAP — CyAN cyanobacteria index ⭐ primary layer

- **Dataset ID:** `noaacwNPPN20S3ASCIDINEOF2kmDaily`
- **Endpoint:** `https://coastwatch.noaa.gov/erddap/griddap/noaacwNPPN20S3ASCIDINEOF2kmDaily.csv`
- **Status:** ✅ live — real pixel data pulled
- **What:** VIIRS (SNPP) cyanobacteria / chlorophyll index. **2 km, global, daily.**
- **Coverage:** `2018-01-01T12:00:00Z` → `2026-08-31T12:00:00Z`, **3,148 timesteps**; grid 8640 lat × 17280 lon. Variable: `chlor_a` (mg m⁻³).
- **Query shape:** `chlor_a[(YYYY-MM-DD)][(0.0)][(latLo):1:(latHi)][(lonLo):1:(lonHi)]`
- **Quirks (both will bite you):**
  1. **The size-1 `altitude` dimension must be passed explicitly.** Omit it and the next constraint is consumed as altitude → `404 "axis#1=altitude ... greater than the axis maximum"`.
  2. **No `Access-Control-Allow-Origin` header** → a browser page **cannot** fetch this. Server-side collection only.
- **Verified pull:**
  ```
  curl "https://coastwatch.noaa.gov/erddap/griddap/noaacwNPPN20S3ASCIDINEOF2kmDaily.csv?chlor_a%5B(2026-08-30)%5D%5B(0.0)%5D%5B(41.4):1:(42.2)%5D%5B(-83.5):1:(-82.0)%5D"
  ```
  → returns a real grid; `NaN` = no satellite retrieval (cloud/land) — **`NaN` is not "zero algae", do not coerce to 0.**
- **Great Lakes sibling:** `https://coastwatch.glerl.noaa.gov/erddap/` (✅ reachable) — higher-res regional products, worth using for GL detail.

## 2. Water Quality Portal (USGS + EPA) — lab cyanotoxins ⭐ primary evidence layer

- **Endpoints:** `https://www.waterqualitydata.us/data/Result/search` · `/data/Station/search`
- **Status:** ✅ live, **CSV only**
- **Quirks:**
  1. **`mimeType=json` returns `406 Not Acceptable`.** Use `mimeType=csv&zip=no`. (Not a UA problem — a real WQP behaviour.)
  2. **Repeating a query param breaks it** (e.g. two `characteristicName=` values → 0 bytes). **One characteristic per request.**
  3. Send a browser User-Agent.
  4. `StateCode` column is **empty in the Result export** — join `MonitoringLocationIdentifier` against `/data/Station/search`, or map the numeric FIPS / `OrganizationIdentifier` prefix.
- **CORS:** `Access-Control-Allow-Origin: *` ✅ (live-fetchable, though the bake path is still default)
- **Measured density, 2024 national cyanotoxin results — 12,100 rows across ~1,367 distinct sites** (2024-01-04 → 2024-12-27):

  | Characteristic | 2024 rows |
  |---|---|
  | Microcystin | 5,377 |
  | Cylindrospermopsin | 4,143 |
  | Saxitoxin | 2,580 |
  | Anatoxin-a | **0** |

- **Honest coverage picture:** data is **not evenly national** — it is dominated by states running active programs (2024 result counts): Missouri 2,461 · Oregon 2,405 · Nebraska 1,169 · Iowa 1,048 · Indiana 831 · Florida 806 · South Carolina 504 · North Carolina 196 · California 141 · Minnesota 43. ~17 states represented. **"All 50 states" is the scope, not the data reality.** The UI must show coverage gaps rather than imply blank = clean.

## 3. USGS Water Data OGC API — site index + context ⚠️ thin for algae

- **Base:** `https://api.waterdata.usgs.gov/ogcapi/v0/collections/`
- **Status:** ✅ live, `ACAO: *`
- **Collections:** `latest-continuous`, `continuous`, `latest-daily`, `daily`, `monitoring-locations`, `parameter-codes`, `time-series-metadata`, …
- **Algae-relevant parameter codes (verified in the official dictionary):**

  | Code | Meaning |
  |---|---|
  | `32266` | Chlorophyll a, blue-green algae |
  | `32267` | Phycocyanin |
  | `32211` | Chlorophyll a, phytoplankton, spectrophotometric |
  | `31884` / `31885` | fChl, PC / PE algae, in situ |
  | `32241` / `32242` | Chlorophyll a, periphyton, fluorometric |

- **⚠️ CRITICAL REALITY CHECK:** querying `latest-continuous` for `32266` and `32267` returns **3 sites nationally**, with latest readings in **January 2025** (~20 months stale). `latest-daily` returns **0** for these params (they are continuous-class, not daily-value).
  → **Treat USGS as site metadata + supporting chemistry context, NOT as a live algae feed.** Any site with a reading older than the freshness window must be rendered as **stale**, never as current.
- Site metadata: `…/collections/monitoring-locations/items?f=json`

## 4. NOAA Tides & Currents

- **Metadata:** `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels` ✅ `ACAO: *`
- **Data:** `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?…` ✅
- **Use:** coastal site context (water level/temp). The HAB-specific routes under `tidesandcurrents.noaa.gov/hab/` are **404 — gone**.

## 5. NWS alerts (api.weather.gov)

- **Status:** ✅ live, `ACAO: *`. 111 event types.
- **Relevant event types (verified):** `Beach Hazards Statement`, `Marine Weather Statement`, `Special Marine Warning`.
- **⚠️ There is no HAB-specific NWS event type** — HAB advisories are issued by *states*, which the .gov-only rule excludes. Federal alerts catch the weather/beach-hazard edge, not the bloom itself.
- Rejects unknown params: `?limit=` on `/alerts/active` → `400`. Use the event filter form.
- **Live sample (2026-09-11):** 3 active `Beach Hazards Statement`s — Kewaunee/Manitowoc, Door, Southern Schoolcraft (WI/MI).

## 6. USGS National Map — basemap tiles

- `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}` ✅ 200, `image/jpeg`, `ACAO: *`
- `…/USGSTopo/MapServer/tile/{z}/{y}/{x}` ✅ 200
- **This solves the map-tile problem *without* breaking the .gov-only rule** (the obvious alternatives — Esri/Mapbox/OSM — are commercial or non-US).

## 7. NOAA NCEI bulk / EPA BEACON2

- `https://www.ncei.noaa.gov/data/` ✅ — bulk archive fallback.
- `https://watersgeo.epa.gov/beacon2/` ✅ page loads; **data export endpoint NOT yet verified — Phase 1 task.** If no export exists, BEACON is dropped and beach advisories come from NWS only.

---

## Dead ends — do NOT spec these

| Attempted | Result |
|---|---|
| **HABSOS** `habsos.noaa.gov` (the canonical US marine HAB observation DB) | Landing page is a Drupal shell; `/api` 404. Its ArcGIS backend `https://gis.ncdc.noaa.gov/arcgis/rest/services/habsos/habsos_vector/MapServer` reports **`layers: []`** → layer queries `404 "Layer not found"`. **Not machine-readable. Excluded.** |
| `tidesandcurrents.noaa.gov/hab/` | 404 (Gulf HAB forecast page retired) |
| `coastalscience.noaa.gov/.../gulf-of-mexico-hab-forecast/` | 404 |
| `cyan.epa.gov` | 404 |
| `upwell.pfeg.noaa.gov/erddap` | Dead — use `coastwatch.noaa.gov` |
| `data.epa.gov/efservice` | 404 |
| `data.cdc.gov` catalog | **Zero algal/cyanobacteria datasets** (OHHABS is not open data) |
| `catalog.data.gov` CKAN API | 404/blocked from this environment |

**Consequence:** the Gulf/marine red-tide path has no working official API. National **freshwater** is the defensible v1 — which matches the chosen scope.

---

## Ready-to-run collector recipes

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

# CyAN satellite slice (server-side only — no CORS)
curl -s "https://coastwatch.noaa.gov/erddap/griddap/noaacwNPPN20S3ASCIDINEOF2kmDaily.csv?chlor_a%5B(${D})%5D%5B(0.0)%5D%5B(${LATLO}):1:(${LATHI})%5D%5B(${LONLO}):1:(${LONHI})%5D"

# Cyanotoxin lab results — ONE characteristic per call, CSV only
for c in Microcystin Cylindrospermopsin Saxitoxin; do
  curl -s -A "$UA" "https://www.waterqualitydata.us/data/Result/search?characteristicName=$c&mimeType=csv&zip=no&startDateLo=01-01-2024&startDateHi=12-31-2024" -o "$c.csv"
done

# Site index for the join (Result export leaves StateCode blank)
curl -s -A "$UA" "https://www.waterqualitydata.us/data/Station/search?characteristicName=Microcystin&mimeType=csv&zip=no" -o stations.csv

# Live NWS advisories
curl -s -A "(algaewatch/1.0)" "https://api.weather.gov/alerts/active?event=Beach%20Hazards%20Statement"

# USGS algae sensors (expect ~3 sites, stale — freshness-gate these)
curl -s "https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?f=json&parameter_code=32266&limit=2000"
```

**Probe evidence files:** `_probe/cy_Microcystin.csv`, `cy_Cylindrospermopsin.csv`, `cy_Saxitoxin.csv`, `habsites.csv` (2024 national pulls, from the 2026-09-11 verification).

---

# Post-build findings (live run, 2026-09-11)

These were discovered by running the collector against the real endpoints. Every one
of them would have shipped as a silent wrong answer. **Read this before trusting any
endpoint above.**

## T5. CyAN LAGS real time by ~11 days — never request "yesterday"

On 2026-09-11 the dataset's time axis ended **2026-08-31**. A query for the previous
day therefore fails:

```
HTTP 404  chlor_a[(2026-09-10)]...
  "Constraint ... is greater than the axis maximum=2026-08-31T12:00:00Z"
```

**Fix:** read the real extent first and clamp to it —
`https://coastwatch.noaa.gov/erddap/info/noaacwNPPN20S3ASCIDINEOF2kmDaily/index.csv`
→ parse `time_coverage_end`, then request `min(yesterday, time_coverage_end)`.
On the clamped date the data is real (123 non-NaN cells for one Missouri bbox).

**Consequence for freshness:** the recorded `date` must be the newest day that
*actually returned a value*. Labelling the slice with the requested date (as a first
implementation did) claims 11 days of freshness that was never received.

## T6. ERDDAP returns the literal string `NaN` — and `float("NaN")` parses fine

A no-retrieval pixel arrives as the text `NaN`. Python's `float("NaN")` happily
returns a float nan, so an unguarded parser stores nan where it means `null`, and the
failure only surfaces much later as
`ValueError: Out of range float values are not JSON compliant: nan`.
**Fix:** reject non-finite values at the parse boundary (`num != num` or inf).
Keep `allow_nan=False` as the backstop — it is what surfaced the bug.

## T7. WQP `characteristicName` is CASE-SENSITIVE and 400s with an EMPTY body

`Anatoxin-a` → **HTTP 400, empty body** (indistinguishable from a transient fault).
The valid name is **`Anatoxin-A`**. Authoritative list (6,736 names):

```
https://www.waterqualitydata.us/Codes/characteristicname?mimeType=json
```

Related names that DO exist: `Anatoxin`, `Anatoxin a`, `Anatoxin-A`,
`Anatoxin-a gene anaC`, `Microcystins` variants, `Cylindrospermopsins`, `Saxitoxins`.
**Always validate a name against this list before adding one to a collector.**

## T8. WQP recent months are UNDER-REPORTED (ingest lag) — absence ≠ clean

Monthly cyanotoxin result counts in the rolling window ending 2026-09-11:

| 2025-09 | 2025-10 | 2025-11 | 2025-12 | 2026-01 | 2026-02 | 2026-03 | 2026-04 | 2026-05 | 2026-06 | 2026-07 | 2026-08 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 340 | 490 | **19** | **31** | **5** | **10** | **6** | **9** | 497 | 696 | 618 | 316 |

A near-total hole from Nov 2025 → Apr 2026. This is **not** ecology: a control analyte
(Missouri `pH`, same window) collapses in the same way (33, 94, 39, 43, 46, 59, then
**1 per month** from 2026-03 onward). The portal simply has not ingested recent state
submissions yet.

**Consequences that must reach the UI:**
- "No recent lab data" is **not** "no blooms". A watchlist defaulting to a 30-day
  window would render most of the country as falsely quiet.
- The app needs a **per-state data-recency indicator**, and headline metrics must not
  silently read through an ingest gap.
- Compare like windows: a rolling 12 months ending 2026-09-11 yields **3,037** rows,
  versus **12,100** for calendar-2024 — a difference driven mostly by ingestion, not
  by monitoring effort.

## T9. Satellite coverage truncation must be loud

An early request cap silently produced slices for only **6 of 13** watchlist sites.
Any cap that truncates the watchlist must emit a warning naming the uncovered sites;
the default cap is now watchlist-size × window.

