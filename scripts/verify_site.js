#!/usr/bin/env node
'use strict';

// AlgaeWatch Phase 1 build gate. Node builtins only (fs, path).
// Exits 0 only when the baked blob passes every assertion; non-zero otherwise.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(REPO_ROOT, 'index.html');

const REQUIRED_KEYS = [
  'generated_utc',
  'freshness',
  'sites',
  'observations',
  'satellite',
  'alerts',
  'baselines',
  'coverage',
  'sources',
];

// Freshness budgets in hours, mirroring the collector (SPEC.md §9).
const DEFAULT_BUDGETS = { cyan: 72, wqp: 1080, usgs: 168, nws: 24 };
const GOV_EXCEPTION = 'www.waterqualitydata.us';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { file: null, allowStale: false, allowSynthetic: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') {
      out.file = args[++i];
    } else if (args[i] === '--allow-stale') {
      out.allowStale = true;
    } else if (args[i] === '--allow-synthetic') {
      out.allowSynthetic = true;
    }
  }
  return out;
}

function allowlistGuard(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    throw new Error(`source url is not parseable: ${url}`);
  }
  if (host === GOV_EXCEPTION) return;
  if (host.endsWith('.gov')) return;
  throw new Error(`allowlist violation: host '${host}' is not a .gov host`);
}

function parseDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  // Normalise a trailing Z and a date-only string to a parseable instant.
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : new Date(t);
}

function sourceBudget(blob, sourceId) {
  const src = (blob.sources || []).find((s) => s.id === sourceId);
  if (src && Number.isFinite(src.freshness_budget_hours)) {
    return src.freshness_budget_hours;
  }
  return DEFAULT_BUDGETS[sourceId];
}

function readBlob(args) {
  let text;
  if (args.file) {
    text = fs.readFileSync(args.file, 'utf8');
  } else {
    if (!fs.existsSync(INDEX_PATH)) {
      throw new Error(`index.html not found at ${INDEX_PATH}`);
    }
    text = fs.readFileSync(INDEX_PATH, 'utf8');
    if (!text.includes('__ALGAEWATCH_DATA__')) {
      throw new Error(`index.html is missing the baked data assignment`);
    }
  }

  // The baked file contains `window.__ALGAEWATCH_DATA__ = <JSON>;`.
  let jsonText;
  if (text.trim().startsWith('{')) {
    jsonText = text;
  } else {
    const match = text.match(/__ALGAEWATCH_DATA__\s*=\s*([\s\S]*?);\s*$/m);
    if (!match) {
      throw new Error('could not locate the baked data blob');
    }
    jsonText = match[1];
  }

  let blob;
  try {
    blob = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`data blob is not valid JSON: ${e.message}`);
  }
  return blob;
}

function main() {
  const args = parseArgs();
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };

  let blob;
  try {
    blob = readBlob(args);
  } catch (e) {
    console.error('FAIL: ' + e.message);
    process.exit(1);
  }

  for (const key of REQUIRED_KEYS) {
    check(Object.prototype.hasOwnProperty.call(blob, key), `missing top-level key: ${key}`);
  }

  const generated = parseDate(blob.generated_utc);
  check(!!generated, 'generated_utc does not parse as a date');
  if (generated) {
    const ageHours = (Date.now() - generated.getTime()) / 3600000;
    if (!args.allowStale) {
      check(ageHours >= 0 && ageHours <= 48, `generated_utc is ${ageHours.toFixed(1)}h old (must be <= 48h)`);
    }
  }

  const sourceIds = new Set((blob.sources || []).map((s) => s.id));
  const obs = blob.observations || [];
  for (const o of obs) {
    check(sourceIds.has(o.source_id), `observation ${JSON.stringify(o)} references missing source_id '${o.source_id}'`);
    // Null-vs-zero rule: a satellite pixel with no retrieval must stay null,
    // never be coerced to a measured 0.
    if (o.source_id === 'cyan' && o.value === 0) {
      check(false, `satellite observation fabricated a 0 for no retrieval: ${JSON.stringify(o)}`);
    }
  }

  const budgets = {};
  for (const id of sourceIds) budgets[id] = sourceBudget(blob, id);

  let staleCount = 0;
  for (const o of obs) {
    if (o.stale === true) staleCount++;
    const budget = budgets[o.source_id];
    if (budget == null) continue;
    const ts = parseDate(o.ts);
    if (!ts) continue;
    const ageHours = (generated ? generated.getTime() : Date.now()) - ts.getTime();
    if (ageHours > budget * 3600000) {
      check(o.stale === true, `observation older than its freshness budget is not marked stale: ${JSON.stringify(o)}`);
    }
  }

  check(
    Array.isArray(blob.coverage && blob.coverage.states_no_data) &&
      (blob.coverage.states_no_data.length > 0 || (blob.coverage.note || '').length > 0),
    'coverage.states_no_data is empty and no note justifies the gap'
  );

  for (const s of blob.sources || []) {
    try {
      allowlistGuard(s.url);
    } catch (e) {
      check(false, e.message);
    }
  }

  // Provenance guard: synthetic / fixture data must NEVER be shipped as
  // federal data. The offline collector's satellite layer is generated, so an
  // offline blob is a test artifact, not a deliverable.
  if (!args.allowSynthetic) {
    check(
      blob.mode !== 'offline',
      'blob was produced by the OFFLINE collector (blob.mode="offline") — its satellite layer is synthetic; run the live collector before shipping'
    );
    const syntheticSats = (blob.satellite || []).filter((s) => s && s.synthetic === true);
    check(
      syntheticSats.length === 0,
      `${syntheticSats.length} satellite slice(s) are marked synthetic — refusing to ship generated data as NOAA CyAN`
    );
    const syntheticObs = obs.filter((o) => o && o.synthetic === true);
    check(
      syntheticObs.length === 0,
      `${syntheticObs.length} observation(s) are marked synthetic — refusing to ship generated data`
    );
  }

  if (failures.length > 0) {
    console.error('FAIL: build gate rejected the baked blob');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }

  const perSource = {};
  for (const o of obs) {
    perSource[o.source_id] = (perSource[o.source_id] || 0) + 1;
  }
  console.log('PASS: build gate');
  console.log('  observations: ' + obs.length);
  for (const id of Object.keys(perSource).sort()) {
    console.log(`    ${id}: ${perSource[id]}`);
  }
  console.log('  stale observations: ' + staleCount);
  console.log('  alerts: ' + (blob.alerts || []).length);
  console.log('  sources: ' + (blob.sources || []).length);
  console.log('  states_with_data: ' + ((blob.coverage && blob.coverage.states_with_data) || []).length);
  process.exit(0);
}

main();
