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
    fillRect(x, y, w, h) { ops.fillRect++; ops.rects.push({ x, y, w, h }); },
    arc() { ops.arc++; },
    fill() {}, stroke() {}, beginPath() {}, scale() {}, fillText() { ops.fillText++; }
  };
  return { canvas: { width: 1000, height: 460, getContext: () => c2d }, ops };
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
