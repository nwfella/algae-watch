(function () {
  // Measures the REAL rendered geometry of the map stack: the .mapbox frame,
  // the canvas, and the basemap tile layer. The bug reported from a screenshot
  // was an opaque canvas stacked over the tiles, plus a scale mismatch between
  // the two. Both are checked numerically here.
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
        var c = document.getElementById('awmap');
        var host = document.getElementById('maptiles');
        var imgs = Array.prototype.slice.call(document.querySelectorAll('#maptiles img'));
        res.mapbox = rect(box);
        res.canvas = rect(c);
        res.tilesLayer = rect(host);
        res.tilesDisplay = host ? getComputedStyle(host).display : 'null';
        res.tilesOpacity = host ? getComputedStyle(host).opacity : 'null';
        res.tileCount = imgs.length;
        res.tilesLoaded = imgs.filter(function (im) { return im.complete && im.naturalWidth > 0; }).length;
        res.tileUnion = union(imgs);
        res.tileWidths = imgs.slice(0, 8).map(function (im) { return Math.round(im.getBoundingClientRect().width); });
        var zm = /\/tile\/(\d+)\//.exec(imgs.length ? imgs[0].getAttribute('src') : '');
        res.tileZoom = zm ? Number(zm[1]) : null;
        res.canvasCss = c ? c.style.width + ' x ' + c.style.height : null;
        res.canvasBacking = c ? c.width + ' x ' + c.height : null;
        res.dpr = window.devicePixelRatio;

        // Composite alpha of the canvas background. 0.45 * 255 = 115; an opaque
        // #0d1420 background would read 255 here, and that WAS the black box.
        try {
          var d2 = c.getContext('2d').getImageData(2, 2, 1, 1).data;
          res.bgPixel = [d2[0], d2[1], d2[2], d2[3]];
        } catch (e) { res.bgPixelErr = e.message; }

        // Interaction must still work after the CSS and pointer-events changes.
        var s0 = span();
        res.spanBefore = s0;
        c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
          clientX: 200, clientY: 150, deltaY: -120, deltaMode: 0 }));
        res.spanAfterWheel = span();
        res.zoomWorks = !!(s0 && res.spanAfterWheel && res.spanAfterWheel < s0);
        var lonBefore = (function () {
          var AW = window.__AW__; if (!AW || !AW.getMapView) return null;
          var v = AW.getMapView(); return v ? Math.round(v.lon0 * 1000) / 1000 : null;
        })();
        c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 200, clientY: 150, pointerId: 1 }));
        c.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 260, clientY: 160, pointerId: 1 }));
        c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: 260, clientY: 160, pointerId: 1 }));
        var lonAfter = (function () {
          var AW = window.__AW__; if (!AW || !AW.getMapView) return null;
          var v = AW.getMapView(); return v ? Math.round(v.lon0 * 1000) / 1000 : null;
        })();
        res.panWorks = (lonBefore !== null && lonAfter !== null && lonBefore !== lonAfter);
        res.ctlButtons = document.querySelectorAll('[data-map]').length;
      } catch (e) { res.err = e.message; }
      publish(res);
    }, 2500);
  });
})();
