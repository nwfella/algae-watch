(function () {
  // Measures the REAL rendered geometry of the map stack: the .mapbox frame,
  // the canvas, and the basemap tile layer.
  //
  // Two classes of defect are covered:
  //  1. the canvas painted an opaque box over the tiles, and was clamped
  //     narrower than the tile layer (scale/offset mismatch);
  //  2. during a drag the pins moved but the basemap did not -- the tile layer
  //     was only re-rendered on pointerup.
  function rect(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function union(els) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
    els.forEach(function (e) {
      var r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      n++;
      x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
    });
    return n ? { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), n: n } : null;
  }
  function matrixXY(css) {
    if (!css || css === 'none') return null;
    var m = /matrix\(([^)]+)\)/.exec(css);
    if (!m) return null;
    var p = m[1].split(',').map(function (s) { return Number(s.trim()); });
    return { x: Math.round(p[4] * 10) / 10, y: Math.round(p[5] * 10) / 10 };
  }
  var cw = 0, ch = 0, canvasEl = null;

  // Does the basemap share ONE coordinate system with the canvas? Take a tile's
  // western boundary longitude, project it with the app's own projection, and
  // compare against where that tile edge is actually painted. Only meaningful
  // while the layer is untransformed.
  function tileAlign() {
    var imgs = document.querySelectorAll('#maptiles img');
    if (!imgs.length || !canvasEl) return null;
    var m = /\/tile\/(\d+)\/(\d+)\/(\d+)/.exec(imgs[0].getAttribute('src'));
    if (!m) return null;
    var z = Number(m[1]), tx = Number(m[3]), n = Math.pow(2, z);
    var lon = tx / n * 360 - 180;
    var v = window.__AW__.getMapView();
    var exp = window.__AW__.project(lon, 40, cw, ch, v).x;
    var act = imgs[0].getBoundingClientRect().left - canvasEl.getBoundingClientRect().left;
    return { expected: Math.round(exp * 10) / 10, actual: Math.round(act * 10) / 10,
             diff: Math.round((act - exp) * 10) / 10 };
  }
  function span() {
    var AW = window.__AW__;
    if (!AW || !AW.getMapView) return null;
    var v = AW.getMapView();
    if (!v) return null;
    var b = AW.viewBounds(v);
    return Math.round((b.lon1 - b.lon0) * 100) / 100;
  }
  function publish(o) {
    var d = document.createElement('div');
    d.id = 'geoprobe';
    d.textContent = 'GEOPROBE ' + JSON.stringify(o);
    document.body.appendChild(d);
  }
  window.addEventListener('load', function () {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('data-view') === 'map') tabs[i].click();
    }
    setTimeout(function () {
      var res = {};
      try {
        var box = document.getElementById('mapbox');
        canvasEl = document.getElementById('awmap');
        var host = document.getElementById('maptiles');
        var imgs = Array.prototype.slice.call(document.querySelectorAll('#maptiles img'));
        cw = rect(canvasEl).w; ch = rect(canvasEl).h;
        res.mapbox = rect(box);
        res.canvas = rect(canvasEl);
        res.tilesLayer = rect(host);
        res.tilesDisplay = host ? getComputedStyle(host).display : 'null';
        res.tilesOpacity = host ? getComputedStyle(host).opacity : 'null';
        res.tileCount = imgs.length;
        res.tilesLoaded = imgs.filter(function (im) { return im.complete && im.naturalWidth > 0; }).length;
        res.tileUnion = union(imgs);
        res.tileWidths = imgs.slice(0, 8).map(function (im) { return Math.round(im.getBoundingClientRect().width); });
        var zm = /\/tile\/(\d+)\//.exec(imgs.length ? imgs[0].getAttribute('src') : '');
        res.tileZoom = zm ? Number(zm[1]) : null;
        res.canvasCss = canvasEl ? canvasEl.style.width + ' x ' + canvasEl.style.height : null;
        res.canvasBacking = canvasEl ? canvasEl.width + ' x ' + canvasEl.height : null;
        res.dpr = window.devicePixelRatio;

        // Composite alpha of the canvas background. 0.45 * 255 = 115; an opaque
        // #0d1420 background would read 255, and that WAS the black box.
        try {
          var d2 = canvasEl.getContext('2d').getImageData(2, 2, 1, 1).data;
          res.bgPixel = [d2[0], d2[1], d2[2], d2[3]];
        } catch (e) { res.bgPixelErr = e.message; }

        res.spanBefore = span();
        res.tileAlignBefore = tileAlign();

        // ---- wheel zoom ----------------------------------------------------
        var s0 = span();
        canvasEl.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
          clientX: 200, clientY: 150, deltaY: -120, deltaMode: 0 }));
        res.spanAfterWheel = span();
        res.zoomWorks = !!(s0 && res.spanAfterWheel && res.spanAfterWheel < s0);
        // back to the start so the drag below is measured from a known view
        canvasEl.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
          clientX: 200, clientY: 150, deltaY: 120, deltaMode: 0 }));
        res.spanAfterWheelBack = span();

        // ---- tandem drag ---------------------------------------------------
        // The killer detail: sample the tile layer WHILE the button is still
        // down. Before the fix the pins moved and the tiles sat still until
        // pointerup, which is exactly what was reported.
        var vDrag = window.__AW__.getMapView();
        var lon0Before = vDrag.lon0, spanDrag = vDrag.lon1 - vDrag.lon0;
        function pt(type, x, y) {
          canvasEl.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
            clientX: x, clientY: y, pointerId: 1 }));
        }
        pt('pointerdown', 400, 300);
        pt('pointermove', 460, 312);
        pt('pointermove', 520, 324);
        var vMid = window.__AW__.getMapView();
        res.midDragTransform = host ? getComputedStyle(host).transform : null;
        res.midDragOffset = matrixXY(res.midDragTransform);
        // the pixel shift the view actually took (the thing the tiles must match)
        res.midDragViewShiftPx = Math.round((lon0Before - vMid.lon0) / (vMid.lon1 - vMid.lon0) * cw * 10) / 10;
        res.midDragViewMoved = Math.abs(vMid.lon0 - lon0Before) > 1e-9;
        res.midDragTilesMoved = !!(res.midDragOffset && Math.abs(res.midDragOffset.x) > 1);
        res.midDragDelta = res.midDragOffset
          ? Math.round((res.midDragOffset.x - res.midDragViewShiftPx) * 10) / 10 : null;
        pt('pointerup', 520, 324);
        res.postDragTransform = host ? getComputedStyle(host).transform : null;
        res.postDragOffsetCleared = !matrixXY(res.postDragTransform);
        res.tileAlignAfter = tileAlign();
        res.tileUnionAfter = union(Array.prototype.slice.call(document.querySelectorAll('#maptiles img')));
        res.spanAfterDrag = span();

        res.ctlButtons = document.querySelectorAll('[data-map]').length;

        // ---- two-finger pinch -------------------------------------------------
        // The hint advertises pinch-to-zoom, so verify it actually zooms, and
        // that the geography under the fingers follows them: spreading two
        // fingers 450->500 midpoint must leave the pinned point under the new
        // midpoint, not sliding away from it.
        function pt2(type, px, py, id) {
          canvasEl.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
            clientX: px, clientY: py, pointerId: id }));
        }
        var vBeforePinch = window.__AW__.getMapView();
        var spanPrePinch = span();
        var rp = canvasEl.getBoundingClientRect();
        var midY = 300, oldMidX = 450, newMidX = 500;
        var anchorBefore = window.__AW__.unproject(oldMidX - rp.left, midY - rp.top, cw, ch, vBeforePinch);
        pt2('pointerdown', 400, midY, 11);
        pt2('pointerdown', 500, midY, 12);     // two fingers, 100px apart, midpoint 450
        pt2('pointermove', 600, midY, 12);     // spread to 200px, midpoint now 500
        res.pinchSpanBefore = spanPrePinch;
        res.pinchSpanAfter = span();
        res.pinchWorks = !!(spanPrePinch && res.pinchSpanAfter && res.pinchSpanAfter < spanPrePinch);
        res.pinchFactor = (spanPrePinch && res.pinchSpanAfter)
          ? Math.round(spanPrePinch / res.pinchSpanAfter * 100) / 100 : null;
        var vAfterPinch = window.__AW__.getMapView();
        var anchorAfter = window.__AW__.project(anchorBefore.lon, anchorBefore.lat, cw, ch, vAfterPinch);
        res.pinchAnchorExpectedX = Math.round((newMidX - rp.left) * 10) / 10;
        res.pinchAnchorActualX = Math.round(anchorAfter.x * 10) / 10;
        res.pinchAnchorActualY = Math.round(anchorAfter.y * 10) / 10;
        res.pinchAnchorDeltaX = Math.round((anchorAfter.x - (newMidX - rp.left)) * 10) / 10;
        res.pinchAnchorDeltaY = Math.round((anchorAfter.y - (midY - rp.top)) * 10) / 10;
        res.pinchAnchored = Math.abs(res.pinchAnchorDeltaX) <= 2.5 && Math.abs(res.pinchAnchorDeltaY) <= 2.5;
        pt2('pointerup', 600, midY, 12);
        pt2('pointerup', 400, midY, 11);

        // ---- satellite layer switcher -----------------------------------------
        // The two layers must be independently selectable, and each must report
        // its OWN retrieval date -- never a shared or borrowed freshness.
        function statusText() {
          var st = document.getElementById('mapstatus');
          return st ? String(st.textContent) : '';
        }
        var btns = Array.prototype.slice.call(document.querySelectorAll('[data-layer]'));
        res.layerButtons = btns.length;
        res.layerIds = btns.map(function (b) { return b.getAttribute('data-layer'); });
        res.statusBefore = statusText();
        res.pressedBefore = (function () {
          var b = document.querySelector('[data-layer][aria-pressed="true"]');
          return b ? b.getAttribute('data-layer') : null;
        })();
        var nrtBtn = btns.filter(function (b) { return b.getAttribute('data-layer') === 'nrt9km'; })[0];
        if (nrtBtn) {
          nrtBtn.click();
          res.statusAfter = statusText();
          res.pressedAfter = (function () {
            var b = document.querySelector('[data-layer][aria-pressed="true"]');
            return b ? b.getAttribute('data-layer') : null;
          })();
          res.canvasAfterSwitch = rect(document.getElementById('awmap'));
          res.tilesLayerAfterSwitch = rect(document.getElementById('maptiles'));
          res.tilesAfterSwitch = document.querySelectorAll('#maptiles img').length;
          try {
            var d3 = document.getElementById('awmap').getContext('2d').getImageData(2, 2, 1, 1).data;
            res.bgPixelAfterSwitch = [d3[0], d3[1], d3[2], d3[3]];
          } catch (e) { res.bgPixelAfterSwitch = null; }
        }
      } catch (e) { res.err = e.message; }
      publish(res);
    }, 2500);
  });
})();
