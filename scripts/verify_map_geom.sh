#!/usr/bin/env bash
# Geometry gate for the map stack. Renders the baked page in real Chrome and
# asserts that the canvas, the basemap tile layer and the .mapbox frame line up,
# and that the canvas background is see-through.
#
# This is the check that WOULD have caught the reported "large black box over
# the map": the canvas filled its whole surface with opaque #0d1420 while sitting
# on top of the tile layer, and it was also clamped narrower than the tile
# layer, which projected the basemap at the wrong scale.
#
# Usage: bash scripts/verify_map_geom.sh
set -u
cd "$(dirname "$0")/.." || exit 1
TMP="${LOCALAPPDATA:-/tmp}/Temp"
[ -d "$TMP" ] || TMP="$(mktemp -d)"

CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
if [ ! -f "$CHROME" ]; then
  echo "SKIP: Chrome not found at $CHROME (set CHROME=... to run this gate)"
  exit 0
fi

cp index.html "$TMP/aw_geom.html"
cp scripts/map_geom_probe.js "$TMP/map_geom_probe.js"
printf '%s' '<script src="map_geom_probe.js"></script>' >> "$TMP/aw_geom.html"

"$CHROME" --headless=new --disable-gpu --no-first-run --dump-dom --virtual-time-budget=15000 \
  --window-size=1280,1000 "file:///$TMP/aw_geom.html" > "$TMP/aw_geom_dom.html" 2>/dev/null

python - "$TMP/aw_geom_dom.html" <<'PY'
import json, re, statistics, sys
h = open(sys.argv[1], encoding='utf-8', errors='replace').read()
m = re.search(r'GEOPROBE (\{.*?\})</div>', h, re.S)
if not m:
    print('NO GEOPROBE OUTPUT - the page did not run')
    raise SystemExit(1)
d = json.loads(m.group(1))
print('mapbox     :', d.get('mapbox'))
print('canvas     :', d.get('canvas'))
print('tilesLayer :', d.get('tilesLayer'), 'display=', d.get('tilesDisplay'), 'opacity=', d.get('tilesOpacity'))
print('tiles      : %s placed, %s loaded, z=%s' % (d.get('tileCount'), d.get('tilesLoaded'), d.get('tileZoom')))
print('bgPixel    :', d.get('bgPixel'), '(alpha 115 = 0.45 translucent; 255 = opaque black box)')
print('zoom/pan   : zoom=%s pan=%s' % (d.get('zoomWorks'), d.get('panWorks')))
if d.get('err'):
    print('ERR        :', d['err'])

fails = []
def ok(label, cond, extra=''):
    if not cond:
        fails.append(label)
    print(('  PASS  ' if cond else '  FAIL  ') + label + (('  ' + extra) if extra else ''))

box, can, uni, lay = d.get('mapbox'), d.get('canvas'), d.get('tileUnion'), d.get('tilesLayer')
if box and can:
    ok('canvas spans the full map box horizontally', abs(can['w'] - (box['w'] - 2)) <= 2,
       'canvas %spx vs box inner %spx' % (can['w'], box['w'] - 2))
    ok('canvas is left-aligned inside the box', abs(can['x'] - (box['x'] + 1)) <= 2)
    ok('canvas fits inside the box (no overflow)', can['w'] <= box['w'] and can['h'] <= box['h'])
if lay and can:
    ok('basemap layer is exactly the size of the canvas',
       abs(lay['w'] - can['w']) <= 2 and abs(lay['h'] - can['h']) <= 2,
       'layer %sx%s vs canvas %sx%s' % (lay['w'], lay['h'], can['w'], can['h']))
if uni and can:
    ok('basemap tiles cover the canvas horizontally',
       uni['x'] <= can['x'] + 3 and (uni['x'] + uni['w']) >= (can['x'] + can['w']) - 6)
    ok('basemap tiles cover the canvas vertically',
       uni['y'] <= can['y'] + 3 and (uni['y'] + uni['h']) >= (can['y'] + can['h']) - 6)
    # A Mercator tile covers 360/2^z degrees of longitude and the canvas maps its
    # whole lon span onto its width, so the rendered tile width is pinned. Laying
    # out tiles projected for a narrower canvas is what produced stray fragments.
    z, span, tw = d.get('tileZoom'), d.get('spanBefore'), d.get('tileWidths') or []
    if z and span and tw:
        expect = can['w'] * (360.0 / (2 ** z)) / span
        got = statistics.median(tw)
        ok('basemap tiles are at the same scale as the canvas', abs(got - expect) / expect < 0.03,
           'rendered %.0fpx vs expected %.0fpx (z=%s, span=%s)' % (got, expect, z, span))
bp = d.get('bgPixel')
if bp:
    ok('canvas background is translucent (basemap visible through it)', 90 <= bp[3] <= 140, 'alpha=%s' % bp[3])
    ok('canvas tint is the dark navy wash, not black', bp[0] < 60 and bp[2] < 80, 'rgb=%s' % bp[:3])
ok('basemap layer is not hidden by the watchdog', d.get('tilesDisplay') != 'none', 'display=%s' % d.get('tilesDisplay'))
ok('tiles actually loaded', (d.get('tilesLoaded') or 0) > 0, '%s/%s' % (d.get('tilesLoaded'), d.get('tileCount')))
ok('wheel zoom still works', d.get('zoomWorks') is True)
ok('drag pan still works', d.get('panWorks') is True)

print()
if fails:
    print('MAP GEOMETRY: FAIL (%d) -> %s' % (len(fails), '; '.join(fails)))
    raise SystemExit(1)
print('MAP GEOMETRY: ALL PASS')
PY
