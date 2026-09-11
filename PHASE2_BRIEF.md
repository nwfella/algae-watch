# Phase 2 Build Brief — the SPA (6 views)

**Read `SPEC.md` first** (especially §4, §4.1, §6, §7), then `PHASE1_BRIEF.md` for the hard constraints that still apply, then **actually open `data/algaewatch_data.json`** — that file is the contract. Do not invent fields; inspect the real shape before writing code.

**Phase 1 is done and verified. Do not modify the collector, the bake step, or the gate.** Your whole job is the front end.

---

## Deliverable

Replace `template/index.template.html` with the complete single-file SPA, then re-bake.

**The bake contract is sacred.** `collector/bake.py` replaces the marker `/*__ALGAEWATCH_DATA__*/` in the template with the JSON blob. The template MUST retain exactly this shape:

```html
<script>
  window.__ALGAEWATCH_DATA__ = /*__ALGAEWATCH_DATA__*/;
</script>
```

If you break that line, the pipeline breaks. After editing, prove it: `python collector/bake.py && node scripts/verify_site.js` must still exit 0. That gate is the acceptance test — a UI that passes visually but fails the gate is a failed build.

## Hard constraints

1. **Single file. Zero dependencies. No build step.** Opens correctly from `file://` and from GitHub Pages. No npm, no CDN, no external fonts, no chart library, no mapping library.
2. **Vanilla JS/CSS**, porting the shell conventions from `~/remote-session-booking/index.html` — `defaultState()` / `loadState()` / `deepMerge()` / `saveState()`, `switchMode`-style view switching with `hidden` toggling, CSS-grid layout, dark-theme CSS custom properties. Read that file and match its voice.
3. **Responsive down to 375px.** No horizontal scroll, no clipped controls.
4. **Zero runtime data fetching.** All data is in `window.__ALGAEWATCH_DATA__`. No `fetch`/`XHR`/`XMLHttpRequest` for data. USGS National Map basemap tiles (`https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`) may be used as `<img>` tiles, but **must degrade gracefully** — if tiles are blocked (this is expected on the target network) the map must still render the CyAN raster and site pins on a plain background.
5. **Charts are hand-rolled** with canvas or inline SVG. Threshold bands drawn as chart elements.
6. **`localStorage` key: `algaewatch_state`.** Wrap every read in try/catch and `deepMerge` against defaults so schema drift cannot crash the app.

## Data contract (verify against the real file)

| Key | Notes |
|---|---|
| `mode` | `"live"` or `"offline"`. If `offline`, show a **persistent, unmissable banner** that the satellite layer is synthetic. |
| `generated_utc` | Bake time. Show it. |
| `freshness` | Per-source last-updated. `cyan` is ~11 days behind real time **by design** (dataset lag). |
| `sites[]` | id, name, lat, lon, state, type, agency. The site index. |
| `observations[]` | `site_id, param, value, unit, ts, source_id, method, stale`. `value` may be `null`. |
| `satellite[]` | `site_id, date, bbox [latLo,lonLo,latHi,lonHi], grid, res_km, days_with_data, window_days`. `grid` is 2-D: **rows are latitude high→low, columns longitude low→high**; cells are numbers or `null`. `date` may be `null` when the whole window was cloud-obscured. |
| `alerts[]` | `site_id, param, value, criterion, criterion_src, level` (`exceedance` / `approaching`). |
| `baselines[]` | `doy, mean, p90, years, estimated` — **`estimated: true` means it is NOT a multi-year climatology.** |
| `coverage` | `states_with_data[]`, `states_no_data[]`, `note`. |
| `sources[]` | id, name, agency, url, last_updated. |

The current blob is small on purpose: **13 satellite slices, 3,063 observations, ~350 sites, 17 alerts.** Design for a sparse dataset — do not assume thousands of map points.

## The honesty requirements (these are the point of the app)

The blob you are rendering is **deliberately mostly-stale**: ~2,657 of 3,063 observations are marked `stale: true` because WQP has an ingest lag (§4.1). Your UI must handle that **without looking broken and without implying currency**:

1. **Ages are always visible** on any value. `stale: true` gets an unmistakable visual treatment (not a subtle tint).
2. **`null` is never rendered as `0`.** Show an em-dash or "no data". A missing satellite pixel, an absent lab result, and a measured zero are three different things.
3. **Absence ≠ clean.** States in `coverage.states_no_data` must be visually distinct from states with data, and must never render as "clear", "safe", or "no algae". `coverage.note` ("Absence of data is not absence of blooms.") must be visible wherever a state appears empty.
4. **Data recency per state** — a visible indicator of how recently each state reported, because a state can be quiet purely from ingest lag.
5. **Thresholds are unverified.** The EPA criteria carry `verified: false` (see `collector/criteria.json` and the "(VERIFY)" suffix in `criterion_src`). Alerts must display **measured value + criterion value + citation text**. Until verified, a **persistent visible notice** must state the thresholds are pending EPA source confirmation. Never present an unverified threshold as settled.
6. **No invented numbers, ever.** If you need a figure you do not have, render "no data". Do not synthesize, extrapolate, or interpolate a display value that is not in the blob. Do not "improve" the data by filtering out stale records.

## The six views

### 1. Map
Canvas. Renders the CyAN raster for each of the 13 satellite sites by projecting `bbox` + `grid` to screen coordinates (no mapping library). Colour scale for the index with a legend showing units (`mg m^-3`). Site pins coloured by latest alert level; pins for sites with no data styled distinctly from pins that are merely quiet. USGS basemap tiles optional with graceful fallback. Tapping a pin navigates to Site detail.

### 2. Watchlist
Rows: site name, state, latest param + value + **age**, trend arrow, alert badge, stale marker. Add/remove/pin sites, persisted in `localStorage`. A short-window filter is permitted **only** if the UI states that recent data may be missing due to reporting lag — a bare "last 30 days" default is forbidden (§4.1).

### 3. Site detail
Trend chart (hand-rolled) with threshold band drawn from `criteria.json` values; observation table with **per-row source + method + age**; the site's satellite slice if present (with `days_with_data`/`window_days`); an explicit "last federal data" date; and a per-source breakdown of where the numbers came from.

### 4. Anomaly
Current vs `baselines`. Because every baseline is `estimated: true`, this view must **say so** and must not present the comparison as a multi-year climatology. Rank sites by deviation; show the sample size (`years`).

### 5. Alerts
Threshold exceedances. Each row shows measured value, criterion value, citation, level, and a link to Site detail. Include the unverified-thresholds notice (honesty item 5) and the note that state advisories — excluded by the .gov-only rule — may lead federal notices.

### 6. Sources
Every dataset with agency, endpoint URL, last-updated, and the .gov-only policy statement. Also carry `coverage.note` and the ingest-lag explanation with its evidence, so a user can understand why the map may look quiet.

## Acceptance criteria

- [ ] Opens from `file://` with **zero console errors**
- [ ] All six views render against the real baked blob
- [ ] `python collector/bake.py` succeeds and `node scripts/verify_site.js` **exits 0** after your change
- [ ] No runtime data fetch (grep your own output for `fetch(`, `XMLHttpRequest`, `axios`)
- [ ] Responsive at 375px — verified, not assumed
- [ ] Stale observations are visually unmistakable; every displayed value shows an age
- [ ] `null` never renders as `0`; empty states read "no federal data reported"
- [ ] Coverage-gap states are visually distinct from states without data
- [ ] Alerts show criterion + citation, and unverified thresholds are flagged
- [ ] Map renders the CyAN raster with basemap tiles blocked
- [ ] `mode: "offline"` triggers a synthetic-data banner
- [ ] Charts are hand-rolled; no external library
- [ ] No fabricated values anywhere

## Out of scope — do NOT do these

- Modifying `collector/collect.py`, `collector/bake.py`, `scripts/verify_site.js`, or any fixture
- Adding or changing data sources; adding any client-side/live fetching
- Changing `criteria.json` values or marking them verified
- Adding accounts, backend, analytics, or telemetry
- Committing or pushing anything
- Embellishing the data — a sparse, mostly-stale dataset that says so honestly is the correct output
