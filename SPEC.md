# AlgaeWatch — SPEC v0.1

**Status:** Phase 0 draft · **Date:** 2026-09-11 · **Scope decision:** national freshwater, all 50 states, watchlist-driven
**Pipeline:** Hermes specifications → cmdc build → Hermes verification/ship

---

## 1. What it is

A single-file, zero-dependency freshwater algae monitoring and tracking webapp. Tracks cyanobacteria (harmful algal bloom) conditions at U.S. lakes, reservoirs and rivers, using **exclusively official U.S. federal data sources**, and surfaces threshold breaches through a watchlist rather than a firehose.

## 2. Non-goals

- Marine / red-tide coverage (no working official API after HABSOS rot — see `DATA_SOURCES.md`)
- State-agency advisories (excluded by the .gov-only rule) — the UI must say so
- Real-time sensor telemetry (the federal live-sensor leg is 3 stale sites; not a viable feed)
- Any non-government data, including NGO/volunteer monitoring and foreign satellite products
- User accounts, server-side storage, paid tiers

## 3. Hard constraint — .gov-only allowlist

Every runtime and build-time data input must match the domain allowlist in `DATA_SOURCES.md`. The collector enforces it in code (host must end `.gov`, plus the one documented joint exception `waterqualitydata.us`); a request to any other host is a hard failure, not a warning. The built app ships a **Sources view** naming each dataset, its agency, its exact endpoint, and its last-updated timestamp.

## 4. Reality check — what the data can and cannot support

Measured on 2026-09-11, not assumed:

| Layer | Real density | Verdict |
|---|---|---|
| Satellite cyanobacteria index (CyAN, NOAA) | 2 km daily, 2018-01-01 → 2026-08-31, 3,148 timesteps — **but ~11 days behind real time** | **Strong.** The backbone. Must clamp requests to the dataset's actual axis max. |
| Lab cyanotoxin results (WQP) | **12,100 results / ~1,367 sites in 2024**; **3,037** in the 12 months to 2026-09-11 | **Strong but regionally clustered AND lagged.** Recent months are under-ingested — see §4.1. |
| Lake/reservoir site index (USGS) | 17k+ locations nationwide | **Good for geography, not for values.** |
| Live algae sensors (USGS continuous) | **3 sites, last readings Jan 2025** | **Effectively dead.** Context only. |
| Federal advisories (NWS) | 111 event types; `Beach Hazards Statement` active on WI/MI beaches | **Weak proxy** — no HAB event type exists federally. |

Two design consequences that follow directly:

1. **The app is satellite-plus-lab, not live-sensor.** Marketing it as "real-time algae tracking" would be false.
2. **Coverage is uneven by geography.** Missouri, Oregon, Nebraska, Iowa, Indiana, Florida and South Carolina generate most lab data; many states generate none. Blank must render as "no federal data reported", never as "clean water".

### 4.1 Recency is not trustworthiness — the ingest-lag finding

Measured on the live build (2026-09-11), monthly cyanotoxin counts collapse from
Nov 2025 → Apr 2026 (19, 31, 5, 10, 6, 9) against 340–696 in the populated months.
A control analyte (Missouri pH) collapses identically, so this is **portal ingest
lag, not ecology**.

Therefore, as hard requirements:
- A short default window (e.g. 30 days) is **forbidden as a headline metric** — it
  would render most of the country falsely quiet.
- Every state surface needs a **data-recency indicator**.
- `coverage.note` ("Absence of data is not absence of blooms.") is load-bearing copy,
  not decoration — it must be visible wherever a state appears empty.

## 5. Architecture

**Bake-first.** A scheduled collector runs server-side, pulls the federal sources, and writes a single data blob **into** the HTML. The deployed page makes zero network requests.

```
cron collector (Python, stdlib only)
   ├── CyAN griddap         (must be server-side — no CORS header)
   ├── WQP CSV cyanotoxins  (one characteristic per request)
   ├── WQP station index    (join to recover state)
   ├── USGS sites + sensors (freshness-gated)
   ├── NWS alerts
   └── BEACON advisories    (if an export endpoint exists — Phase 1 check)
        ↓
   bake → algae-watch.html (self-contained)  →  GitHub Pages
        ↓
   verify_site.js gate (non-zero exit blocks deploy)
```

**Why bake, not live-fetch:** four of the sources are CORS-open and *could* be fetched directly, but (a) ERDDAP cannot be fetched from a browser at all, (b) mixing baked and live creates two freshness semantics for the same screen, and (c) the target IT environment blocks fetch on `nwfella.github.io` anyway. Proven pattern from `breach-watch` and `foodsafe-central`.

**Two tiers:**
- **Baked** (default, shipped): zero fetch, works anywhere, IT-safe.
- **Live** (dev/local convenience only): direct calls to the four CORS-open gov endpoints (`api.waterdata.usgs.gov`, `waterqualitydata.us`, `api.tidesandcurrents.noaa.gov`, `api.weather.gov`). Explicitly labelled a dev tool; never the shipped artifact. Optional — cut it if it adds friction.

**Framework reuse:** port the state/view shell from `~/remote-session-booking/index.html` — `defaultState()` / `loadState()` / `deepMerge()` / `saveState()`, view switching, CSS-grid layout, dark-theme tokens — unchanged. Two new layers this framework does not have:
- a **zero-dep canvas chart renderer** (sparkline + series chart with threshold band)
- a **lat/lon → canvas projector** to draw the CyAN raster directly, no mapping library

## 6. Baked data model

```jsonc
{
  "generated_utc": "2026-09-11T18:00:00Z",
  "freshness": { "cyan": "2026-08-31", "wqp": "2026-09-01", "usgs": "2025-01-14", "nws": "2026-09-11T17:00:00Z" },
  "sites": [{
    "id": "USGS-04193500", "name": "Maumee River at Waterville OH",
    "lat": 41.40, "lon": -83.87, "state": "OH", "type": "River",
    "agency": "USGS", "watch": true
  }],
  "observations": [{
    "site_id": "USGS-04193500", "param": "microcystin",
    "value": 2.4, "unit": "ug/L", "ts": "2026-08-14",
    "source_id": "wqp", "method": "lab", "stale": false
  }],
  "satellite": [{ "date": "2026-08-31", "bbox": [41.4,-83.5,42.2,-82.0], "grid": [[0.1,null,3.2]], "res_km": 2 }],
  "alerts": [{ "site_id": "…", "param": "microcystin", "value": 9.1, "criterion": 8.0,
               "criterion_src": "EPA 2019 recreational (VERIFY)", "level": "exceedance", "ts": "2026-08-20" }],
  "baselines": [{ "site_id": "…", "doy": 240, "mean": 1.8, "p90": 2.4, "years": 8, "source": "cyan" }],
  "coverage": { "states_with_data": ["MO","OR","NE","IA","IN","FL","SC","NC","CA","MN"],
                "states_no_data": ["…"], "note": "Absence of data is not absence of blooms." },
  "sources": [{ "id": "cyan", "name": "NOAA CoastWatch CyAN", "url": "…", "agency": "NOAA", "last_updated": "…" }]
}
```

Rules the collector must honour:
- `null` = no retrieval / no data. **Never fabricate a `0`** — a `NaN` satellite pixel and an absent lab result are not zero algae.
- `stale: true` whenever an observation's age exceeds its source's freshness budget.
- Every observation carries `source_id`; no orphan values.

## 7. Views

| # | View | Requirements |
|---|---|---|
| 1 | **Map** | CyAN raster rendered to canvas over USGS National Map tiles; watchlist site pins colour-coded by latest exceedance; coverage-gap states visibly distinguished from "clean" |
| 2 | **Watchlist** | Site rows: name, state, latest param + value + age, trend arrow, alert badge. Add/remove/pin sites. localStorage-persisted. **Ages always visible** |
| 3 | **Site detail** | Trend chart (canvas) with threshold band; observation table with lab method + source per row; satellite mini-seriest; explicit "last federal data" date |
| 4 | **Anomaly** | Current vs day-of-year baseline from 2018→present CyAN history; ranked by deviation |
| 5 | **Alerts** | Threshold exceedances with criterion value, citation, and measured value side by side |
| 6 | **Sources** | Every dataset: agency, endpoint, licence/public-domain note, last-updated, and the .gov-only policy statement |

Threshold UI must **not** hide that state advisories (excluded) may lead federal notices — a short, permanent note in Alerts and Sources.

## 8. Alert engine & thresholds

Mechanism is settled; **numbers are not** — and this is a genuine blocker, not laziness: **`www.epa.gov` is WAF-blocked from this environment.** Both criteria pages return an identical 6,518-byte challenge page (no real content) and the 2019 factsheet PDF returns `403`. Note the asymmetry: `watersgeo.epa.gov` answered `200` while `www.epa.gov` did not — so the collector must never depend on `www.epa.gov` HTML.

**Resolution required:** you confirm the values in a normal browser (30 seconds), or the numbers get hard-coded with a citation to a document we can actually retrieve. Do **not** ship guessed thresholds.

Target pair (widely cited, **unverified here** — confirm before shipping):
- EPA 2019 recommended human-health **recreational** ambient water quality criteria — microcystins ≈ 8 µg/L, cylindrospermopsin ≈ 15 µg/L
- EPA 2015 **drinking-water** health advisories for cyanotoxins — microcystin-LR ≈ 0.3 µg/L, cylindrospermopsin ≈ 0.7 µg/L

Rules: alerts fire only on a cited criterion; the criterion value and its EPA source are displayed with the measurement; no invented severity ladders ("sell 25%" energy). Tiering: `exceedance` / `approaching` (within 25% of criterion) / `no-data`.

## 9. Freshness policy

Because a legitimate federal source can return 20-month-old values, the collector **fails loudly rather than baking stale data silently**:
- Per-source freshness budget (e.g. CyAN ≤ 3 days, WQP ≤ 45 days, USGS sensors ≤ 7 days for "current").
- Exceeded budget → observation marked `stale`, site badge changes, and the build emits a warning.
- If a source returns 0 rows when it should return thousands → **build fails**, it does not ship an empty app.

## 10. Phase plan

| Phase | Owner | Deliverable | Gate (enforced by Hermes) |
|---|---|---|---|
| **0 — Spec** | Hermes | `SPEC.md` + `DATA_SOURCES.md` + verified threshold table | **Awaiting sign-off** |
| **1 — Collector** | cmdc ($1-plan) | stdlib Python collector + baker + `verify_site.js` | Hermes re-runs the collector and **reconciles row counts against the source totals**; freshness assertions fire on a seeded stale fixture; allowlist rejects a non-.gov host |
| **2 — SPA** | cmdc | 6 views over the baked blob, framework shell reused | Render selftests with `?v=N` cache-bust; verify null-vs-zero rendering, coverage-gap states, alert citation display |
| **3 — Ship** | Hermes | `verify_site.js` gate → GitHub Pages | Non-zero exit blocks deploy |
| **4 — Watchdog** | Hermes | Cron: refresh + threshold alerts | ✅ **Done.** Daily 08:00 `no_agent` cron running `scripts/daily_refresh.py`. Asserts `generated_utc` advances, refuses to build from a dirty source tree, and deploys only if **both** gates pass. Silent when the data is unchanged; stdout is the delivered notification; a non-zero exit raises an alert. |

## 11. Decisions — LOCKED 2026-09-11

| Decision | Locked value | Rationale |
|---|---|---|
| **Scope** | National freshwater, all 50 states, watchlist-driven | User selection |
| **Threshold policy** | **Both, labelled by exposure route.** Recreational criteria = primary (banner + alert engine); drinking-water advisories = secondary marker on intake-adjacent sites | Two legitimate exposure scenarios; labelling avoids implying one universal safe level |
| **Live mode** | **CUT from v1** | One freshness semantic; ERDDAP can't be fetched from a browser anyway; target IT environment blocks fetch on `nwfella.github.io` |
| **Watchlist seed** | Top-reporting states **MO, OR, NE, IA, IN, FL, SC, NC, CA, MN** + Great Lakes sites (Maumee/Toledo on Lake Erie; WI/MI beach sites seen in live NWS data) | Seed from where federal data actually exists — an empty default watchlist would make the app look broken |
| **CyAN slice strategy** | **Per-watchlist-site padded bbox slices** (daily, rolling window) **+ a weekly composite** for the anomaly view | Full CONUS daily 2 km is far too heavy for a baked artifact |
| **EPA criteria handling** | Values live in `criteria.json` with **`"verified": false`** and citation URLs; the UI must visibly flag them as pending source confirmation | `www.epa.gov` is WAF-blocked from this environment; **guessed thresholds must never ship silently**. Flag, don't fabricate |
| **BEACON2** | **Deferred** — stubbed behind a flag, disabled by default | Export endpoint unverified; NWS covers advisories for v1 |

## 12. Remaining open items

- [ ] **EPA criteria verification** — user confirms the 8 / 15 / 0.3 / 0.7 µg/L values in a browser, then flip `criteria.json` → `"verified": true`. **Does not block Phase 1.**
- [ ] **BEACON2 export endpoint** — verify in a later phase; not Phase 1
- [ ] Watchlist `stale` badge copy — needs UX wording that reads honestly without alarming

