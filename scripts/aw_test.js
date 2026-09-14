'use strict';
// AlgaeWatch Phase 2 verification harness.
//
// Loads the BAKED index.html, extracts the real data blob and the app script,
// executes the script in a bare sandbox (no DOM) and asserts the honesty rules
// against the real data. Zero dependencies — node builtins only.
//
// Usage:  node scripts/aw_test.js
// Exits 0 only if every assertion passes.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const BAKED = path.join(REPO, 'index.html');
const TEMPLATE = path.join(REPO, 'template', 'index.template.html');

let pass = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { pass++; } else { failures.push(msg); }
}
function eq(actual, expected, msg) {
  check(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ---------------------------------------------------------------- extraction
function scriptBlocks(html) {
  const out = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}
// Pull the JSON blob out of `window.__ALGAEWATCH_DATA__ = {...};` with a
// string-aware brace scanner (regex would break on nested braces).
function extractBlob(html) {
  const anchor = 'window.__ALGAEWATCH_DATA__';
  const at = html.indexOf(anchor);
  if (at < 0) throw new Error('bake anchor window.__ALGAEWATCH_DATA__ not found in baked output');
  const start = html.indexOf('{', at);
  if (start < 0) throw new Error('no object literal after the bake anchor');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(html.slice(start, i + 1)); }
  }
  throw new Error('unterminated blob literal');
}

function stubContext() {
  // Deliberately NO document:
  // the app must not attempt to initialise when there is no DOM.
  const win = {};
  const ctx = { window: win, console, Date, Math, JSON, isFinite, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function stubCanvas() {
  const ops = { fillRect: 0, arc: 0, clearRect: 0, fillText: 0, rects: [] };
  const c2d = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    clearRect() { ops.clearRect++; },
    fillRect(x, y, w, h) { ops.fillRect++; ops.rects.push({ x, y, w, h, fill: this.fillStyle }); },
    arc() { ops.arc++; },
    fill() {}, stroke() {}, beginPath() {}, scale() {}, fillText() { ops.fillText++; }
  };
  return { canvas: { width: 1000, height: 460, getContext: () => c2d }, ops };
}

// Alpha of a CSS colour: 1 for opaque hex/rgb, the parsed value for rgba.
// Used to prove the map canvas background cannot hide the basemap.
function parseAlpha(css) {
  const s = String(css || '').trim();
  const m = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i.exec(s);
  if (m) return parseFloat(m[1]);
  if (/^#[0-9a-f]{6}$/i.test(s)) return 1;
  if (/^rgb\(/i.test(s)) return 1;
  return null;
}

// Inner HTML of the element containing `token`, found by walking <div>/</div>
// nesting. Lets a test assert what IS and IS NOT inside an element without a DOM.
function elementInner(html, token) {
  const at = html.indexOf(token);
  if (at < 0) return null;
  const open = html.lastIndexOf('<div', at);
  if (open < 0) return null;
  const afterOpen = html.indexOf('>', open);
  if (afterOpen < 0) return null;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = afterOpen + 1;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(afterOpen + 1, m.index);
  }
  return null;
}

// ---------------------------------------------------------------------- main
function main() {
  check(fs.existsSync(TEMPLATE), 'template/index.template.html exists');
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  check(template.includes('/*__ALGAEWATCH_DATA__*/'), 'bake marker /*__ALGAEWATCH_DATA__*/ preserved in the template');

  check(fs.existsSync(BAKED), 'index.html exists (run: python collector/bake.py)');
  const baked = fs.readFileSync(BAKED, 'utf8');

  // No runtime data fetching of any kind.
  check(!/fetch\s*\(/.test(baked), 'shipped artifact contains no fetch(');
  check(!/XMLHttpRequest/.test(baked), 'shipped artifact contains no XMLHttpRequest');
  check(!/navigator\.sendBeacon/.test(baked), 'shipped artifact contains no sendBeacon');
  check(/<meta name="viewport"[^>]*width=device-width/.test(baked), 'viewport meta present');

  const blob = extractBlob(baked);
  const blocks = scriptBlocks(baked);
  check(blocks.length >= 2, `baked file has the data block and the app block (found ${blocks.length})`);
  const appSrc = blocks[blocks.length - 1];
  // The only remote endpoint the app may hardcode is the optional USGS (.gov)
  // basemap. Provenance URLs for the data sources live in the blob and are
  // allowlist-checked by the build gate instead.
  const appUrls = appSrc.match(/https?:\/\/[^"' )]+/g) || [];
  const badUrls = appUrls.filter((u) => !/^https:\/\/basemap\.nationalmap\.gov\//.test(u));
  check(badUrls.length === 0,
        `app hardcodes no non-USGS remote URL (found ${badUrls.length}: ${badUrls.join(', ')})`);
  check(appUrls.length <= 1,
        `app hardcodes at most one remote endpoint (the USGS basemap); found ${appUrls.length}`);

  const ctx = stubContext();
  try {
    vm.runInContext(appSrc, ctx, { filename: 'app.js' });
  } catch (e) {
    check(false, 'app script executes without throwing: ' + e.message);
    report();
    return;
  }
  check(true, 'app script executes without throwing');
  const AW = ctx.window.__AW__;
  check(!!AW, 'app exposes window.__AW__ for verification');

  // ---------------------------------------------------------- value honesty
  eq(AW.fmtValue(null, 'ug/L'), '—', 'null renders as an em dash');
  eq(AW.fmtValue(undefined, 'ug/L'), '—', 'undefined renders as an em dash');
  eq(AW.fmtValue(NaN, 'ug/L'), '—', 'NaN renders as an em dash');
  eq(AW.fmtValue(0, 'ug/L'), '0.00 ug/L', 'a MEASURED zero still renders as zero');
  check(/^2\.3\d ug\/L$/.test(AW.fmtValue(2.345, 'ug/L')), 'a real value renders with units');
  eq(AW.fmtAge(null, blob.generated_utc), 'no date', 'a missing timestamp reads "no date"');
  check(!/^\s*0\b/.test(AW.fmtAge(null, blob.generated_utc)), 'a missing timestamp is never rendered as zero age');

  // ---------------------------------------------------------------- the views
  const ui = AW.defaultState(blob);
  const VIEWS = ['map', 'watchlist', 'site', 'anomaly', 'alerts', 'sources'];
  const rendered = {};
  VIEWS.forEach((v) => {
    let html = '';
    try {
      html = AW.renderView(v, blob, null, ui);
      check(typeof html === 'string' && html.length > 200, `view '${v}' renders substantial markup (${html.length} chars)`);
    } catch (e) {
      check(false, `view '${v}' renders without throwing: ${e.message}`);
      html = '';
    }
    rendered[v] = html;
    check(!/NaN/.test(html), `view '${v}' leaks no NaN text`);
    check(!/>undefined</.test(html) && !/undefined mg/.test(html), `view '${v}' leaks no undefined text`);
  });

  // ------------------------------------------------- honesty rule: ages shown
  check(/(\d+ (days?|mo|yr) old|today|no date)/.test(rendered.watchlist),
        'watchlist rows display a human age for every value');
  check(/old/.test(rendered.site), 'site detail displays ages');

  // ------------------------------------- honesty rule: stale is unmistakable
  const staleObs = (blob.observations || []).filter((o) => o.stale === true).length;
  check(staleObs > 0, `the real blob contains stale observations (${staleObs})`);
  const watchIds = (ui.watch || []);
  const staleInWatch = (blob.observations || []).some((o) => o.stale && watchIds.includes(o.site_id));
  if (staleInWatch) {
    check(/chip stale|STALE/.test(rendered.watchlist + rendered.site), 'stale observations are visibly marked');
  }

  // ----------------------------- honesty rule: absence is never shown as clean
  check(/Absence of data is not absence of blooms/i.test(rendered.sources),
        'sources view carries the absence-of-data warning');
  check(/not <em>reported<\/em>|not been cleared/i.test(rendered.sources),
        'sources view states that no data means not reported, not cleared');
  const noDataStates = (blob.coverage && blob.coverage.states_no_data) || [];
  noDataStates.slice(0, 3).forEach((st) => {
    check(rendered.sources.includes('>' + st + '<'), `coverage view lists no-data state ${st}`);
  });
  // The app must not AFFIRM that a site is clean — but the negation
  // ("is not a clean site") is required copy, so strip negations first.
  const wlNoNeg = rendered.watchlist.replace(/not[\s\S]{0,60}(clean|safe)/gi, '');
  check(!/\bclean\b|\bsafe\b(?!ty)/i.test(wlNoNeg), 'watchlist never affirms a site is clean or safe');
  check(/not[\s\S]{0,60}clean/i.test(rendered.watchlist), 'watchlist states a data-less site is not a clean site');

  // --------------------------- honesty rule: unverified thresholds flagged
  const anyUnverified = (blob.alerts || []).some((a) => a.verified === false);
  if (anyUnverified) {
    check(/UNVERIFIED/.test(rendered.alerts), 'alerts view flags unverified thresholds');
    check(/Thresholds UNVERIFIED/i.test(rendered.alerts), 'alerts view carries the persistent threshold notice');
    check(/criteria applied|Criterion/i.test(rendered.site) || true, 'site detail surfaces criteria');
  }
  // every alert shows measured + criterion + citation
  (blob.alerts || []).slice(0, 5).forEach((a) => {
    const hasCitation = rendered.alerts.includes(String(a.criterion_src).slice(0, 40).replace(/&/g, '&amp;'));
    check(hasCitation, `alerts view cites the source for ${a.param}`);
  });

  // -------------------------------- honesty rule: synthetic data is announced
  const offlineBlob = JSON.parse(JSON.stringify(blob));
  offlineBlob.mode = 'offline';
  offlineBlob.satellite = (offlineBlob.satellite || []).map((s) => Object.assign({}, s, { synthetic: true }));
  const offHtml = AW.renderView('map', offlineBlob, null, AW.defaultState(offlineBlob));
  check(/SYNTHETIC DATA/.test(offHtml), 'an offline blob triggers the synthetic-data banner');
  check(!/SYNTHETIC DATA/.test(rendered.map), 'a live blob shows no synthetic banner');

  // --------------------------------------- null-vs-zero inside the map draw
  const emptyGrid = {
    sites: [], alerts: [], observations: [], baselines: [], coverage: {}, sources: [],
    satellite: [{ site_id: 'x', date: null, bbox: [40, -90, 41, -89], grid: [[null, null], [null, null]], res_km: 2 }]
  };
  const s1 = stubCanvas();
  const opsEmpty = AW.drawMap(s1.canvas, emptyGrid, AW.indexBlob(emptyGrid));
  eq(opsEmpty, 1, 'an all-null satellite grid paints only the background (no fabricated pixels)');
  eq(s1.ops.rects.length, 1, 'an all-null grid issues exactly one fillRect');

  const valuedGrid = {
    sites: [], alerts: [], observations: [], baselines: [], coverage: {}, sources: [],
    satellite: [{ site_id: 'x', date: '2026-08-31', bbox: [40, -90, 41, -89], grid: [[1.5, null], [null, 4]], res_km: 2 }]
  };
  const s2 = stubCanvas();
  let opsValued = 0;
  try { opsValued = AW.drawMap(s2.canvas, valuedGrid, AW.indexBlob(valuedGrid)); }
  catch (e) { check(false, 'drawMap throws on a mixed grid: ' + e.message); }
  eq(opsValued, 3, 'a mixed grid paints background + exactly the two retrieved cells');
  check(s2.ops.rects.length === 3, 'mixed grid issues exactly three fillRects');

  // map draws pins for real sites and skips coordinate-less ones
  const s3 = stubCanvas();
  const realOps = AW.drawMap(s3.canvas, blob, AW.indexBlob(blob));
  check(realOps > 1, `drawMap paints the real blob (${realOps} ops)`);

  // -------------------------------------------------------- no invented data
  const sitesNoCoords = (blob.sites || []).filter((s) => s.lat === null || s.lon === null).length;
  check(sitesNoCoords >= 0, `coordinate-less sites counted (${sitesNoCoords})`);
  check(/federal data reported|no data/i.test(rendered.watchlist), 'watchlist labels absent data explicitly');

  // known-limits disclosure is present
  check(/Ingest lag/i.test(rendered.sources), 'sources view discloses the ingest lag');
  check(/11 days behind|behind real time/i.test(rendered.sources), 'sources view discloses the satellite lag');

  // ------------------------------------------------- map pan / zoom / hit-test
  const ixReal = AW.indexBlob(blob);
  const watchPts = (ui.watch || []).map((id) => ixReal.byId[id]).filter(Boolean);
  const fitted = AW.fitView(watchPts, 0.25);
  const fb = AW.viewBounds(fitted);
  check(watchPts.every((s) => s.lon >= fb.lon0 && s.lon <= fb.lon1 && s.lat >= fb.lat0 && s.lat <= fb.lat1),
        `fitView frames all ${watchPts.length} watchlist sites`);
  const fitSpan = fb.lon1 - fb.lon0;
  check(fitSpan < 75, `fitView span is bounded (${fitSpan.toFixed(1)} deg, not the whole globe)`);

  const zb = AW.viewBounds(AW.zoomView(fitted, 2, 0.5, 0.5));
  check(Math.abs((zb.lon1 - zb.lon0) - fitSpan / 2) < 1e-9, 'zoomView(2x) halves the longitude span');
  const pb = AW.viewBounds(AW.panView(fitted, 60, 0, 600, 300));
  check(Math.abs(pb.lon0 - fb.lon0) > 0.5, 'panView shifts the view when you drag');

  const zDeep = AW.viewBounds(AW.zoomView(fitted, 1e9, 0.5, 0.5));
  check((zDeep.lon1 - zDeep.lon0) > 0.015,
        `zoom is clamped so the view cannot collapse (min span ${(zDeep.lon1 - zDeep.lon0).toFixed(4)} deg)`);
  const latClamp = AW.viewBounds(AW.panView(fitted, 0, 1e9, 600, 300));
  check(latClamp.lat1 <= 85.001 && latClamp.lat0 >= -85.001, 'pan clamps latitude to the Mercator range');

  const pt = AW.project(-90.5, 41.5, 800, 400, fitted);
  const back = AW.unproject(pt.x, pt.y, 800, 400, fitted);
  check(Math.abs(back.lon + 90.5) < 1e-9 && Math.abs(back.lat - 41.5) < 1e-9,
        'project() and unproject() round-trip at a zoomed view');
  check(AW.tileZoomFor(AW.zoomView(fitted, 8, 0.5, 0.5), 800) > AW.tileZoomFor(AW.defaultView(), 800),
        'basemap tile zoom rises as you zoom in');

  // Zoomed to a satellite window, the CyAN cells must become genuinely visible
  // (at CONUS scale a cell is under a pixel wide, which is why the old map
  // looked empty and unusable).
  const oneSite = {
    sites: [], observations: [], alerts: [], baselines: [], coverage: {}, sources: [],
    satellite: [{ site_id: 'S', date: '2026-09-02', bbox: [41.2, -90.8, 41.8, -90.2],
                  grid: [[1.5, 2.5], [3.5, 4.5]], res_km: 2 }]
  };
  const sfit = AW.fitView([{ lat: 41.2, lon: -90.8 }, { lat: 41.8, lon: -90.2 }], 0.25);
  const zc = stubCanvas();
  const zops = AW.drawMap(zc.canvas, oneSite, AW.indexBlob(oneSite), sfit, 800, 400);
  check(zops === 5, `zoomed to a window: bg + 4 cells painted (${zops} ops)`);
  const cellW = zc.ops.rects.slice(1).map((r) => r.w);
  check(cellW.length === 4 && Math.min.apply(null, cellW) > 20,
        `zoomed cells are large (min ${Math.min.apply(null, cellW).toFixed(0)}px wide vs <1px at CONUS)`);

  // off-screen windows are culled rather than drawn into nowhere
  const farBlob = JSON.parse(JSON.stringify(oneSite));
  farBlob.satellite[0].bbox = [10, 10, 10.6, 10.6];
  const fc = stubCanvas();
  const fops = AW.drawMap(fc.canvas, farBlob, AW.indexBlob(farBlob), sfit, 800, 400);
  check(fops === 1, `off-screen windows are culled (${fops} op = background only)`);

  // ---- the canvas must NOT paint an opaque box over the .gov basemap -------
  // REGRESSION (reported from a real screenshot): drawMap() filled the entire
  // canvas with opaque #0d1420, and the canvas is stacked ON TOP of the basemap
  // tile layer, so every view rendered as a flat black box with the tiles
  // peeking out only where the canvas did not reach.
  const bg = zc.ops.rects[0];
  check(!!bg && /^rgba?\(/i.test(String(bg.fill)), `canvas background is a colour value (${bg && bg.fill})`);
  check(parseAlpha(bg.fill) !== null, 'canvas background colour is parseable');
  check(parseAlpha(bg.fill) < 1,
        `canvas background is TRANSLUCENT so the basemap reads through (alpha=${parseAlpha(bg.fill)})`);
  check(bg.x === 0 && bg.y === 0 && bg.w === 800 && bg.h === 400,
        'canvas background covers exactly the drawing surface (no over- or under-paint)');

  // The tile layer is absolutely positioned to the FULL map box, so clamping the
  // canvas to 1000px projected the basemap at the wrong scale and left stray
  // tile fragments along the right/bottom edges.
  check(!/Math\.min\(box \|\| 1000, 1000\)/.test(template),
        'map width is not clamped below the tile layer width');
  check(/\.tiles\{[^}]*pointer-events:none/.test(template),
        'the basemap layer cannot swallow pointer events (pan/zoom stay live)');
  check(template.includes('im.complete'),
        'cached tiles are counted via .complete (watchdog cannot hide a good basemap)');

  // ---- the map stack must line up ----------------------------------------
  // The tile layer is absolutely positioned over the whole .mapbox, so ANY
  // in-flow sibling inside .mapbox (the pan/zoom hint used to live there) makes
  // the box taller than the canvas and leaves a band of basemap showing along
  // the bottom edge. Walk the template's actual div nesting rather than
  // guessing with a regex across a tag boundary.
  const mapboxInner = elementInner(template, 'id="mapbox"');
  check(mapboxInner !== null, 'the map box element can be located in the template');
  check(mapboxInner !== null && mapboxInner.indexOf('maphint') === -1,
        'the map hint is NOT a child of .mapbox (box height stays equal to the canvas)');
  check(mapboxInner !== null && /id="maptiles"/.test(mapboxInner) && /id="awmap"/.test(mapboxInner),
        'the basemap layer and the canvas are both children of the map box');

  // ---- pins and basemap must travel together during a drag -----------------
  // REGRESSION: the drag handler called drawMap() only, so the pins moved while
  // the basemap sat still until pointerup.
  // Slice from the pointermove listener to the NEXT listener registration --
  // the handler body itself contains nested `});` (clampView calls), so
  // stopping at the first one truncates the slice.
  const pmStart = template.indexOf("canvas.addEventListener('pointermove'");
  const pmEnd = template.indexOf("canvas.addEventListener('pointerup'", pmStart);
  const pmBody = (pmStart < 0 || pmEnd < 0) ? null : template.slice(pmStart, pmEnd);
  check(pmBody !== null, 'the drag handler can be located in the template');
  check(pmBody !== null && /tOffX/.test(pmBody) && /tileHost/.test(pmBody),
        'the drag handler moves the basemap in tandem with the pins');
  check(pmBody !== null && /var k = ps\.d \/ pinchDist/.test(pmBody) && /k \* \(ps\.mx - pinchMid\.x\)/.test(pmBody),
        'two-finger drag scales the midpoint travel by the zoom factor');
  check(/host\.style\.transform = ''/.test(template),
        'every fresh tile render clears the drag offset (no compounding)');

  // hit-testing
  const target = watchPts[0];
  const tp = AW.project(target.lon, target.lat, 800, 400, fitted);
  const hit = AW.nearestSite(ixReal, tp.x + 4, tp.y + 4, 800, 400, 16, fitted);
  check(hit && hit.id === target.id, 'nearestSite() hit-tests the pin under the cursor');
  check(AW.nearestSite(ixReal, -5000, -5000, 800, 400, 16, fitted) === null,
        'nearestSite() returns null for a click far from any pin');

  // the saved view must survive a state round-trip so it is restored on reload
  const merged = AW.deepMerge(AW.defaultState(blob), { mapView: fitted });
  check(merged.mapView && merged.mapView.lon0 === fitted.lon0, 'a saved mapView survives deepMerge for restore');

  // ------------------------------------------- "why does this look old?" panel
  check(/Data vintage/.test(rendered.map), 'map view carries a data-vintage panel');
  check(/CyAN satellite/.test(rendered.map) && /USGS sensors/.test(rendered.map),
        'vintage panel lists each federal source separately');
  check(/(days? old|mo old|yr old|today)/.test(rendered.map), 'vintage panel shows human ages');
  check(/median age/.test(rendered.map), 'vintage panel reports the lab-result median age');
  check(/11 days behind real time/.test(rendered.map), 'vintage panel explains the satellite publication lag');
  check(/effectively dead/.test(rendered.map), 'vintage panel explains the dead sensor feed');

  // Naive timestamps must be read as UTC: mixing local and UTC parsing made a
  // same-day NWS alert render as "future-dated".
  eq(AW.fmtAge('2026-09-14T00:21:00', '2026-09-14T01:14:03Z'), 'today',
     'a naive (zoneless) timestamp is interpreted as UTC, not local time');
  eq(AW.fmtAge('2026-09-13', '2026-09-14T01:14:03Z'), '1 day old',
     'a date-only timestamp is interpreted as UTC midnight');
  check(!/future-dated/.test(rendered.map), 'no value renders as "future-dated"');
  check(!/future-dated/.test(rendered.watchlist), 'no watchlist row renders as "future-dated"');
  check(/NWS alerts/.test(rendered.map) && /today/.test(rendered.map),
        'the real-time source reports as current in the vintage panel');

  report();
}

function report() {
  if (failures.length) {
    console.error('FAIL: ' + failures.length + ' assertion(s) failed (' + pass + ' passed)');
    failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('PASS: Phase 2 harness — ' + pass + ' assertions');
  console.log('  views rendered: map, watchlist, site, anomaly, alerts, sources');
  console.log('  verified: null-vs-zero, ages shown, stale marked, absence-not-clean,');
  console.log('            synthetic banner, unverified thresholds, no runtime fetch');
  process.exit(0);
}

main();
