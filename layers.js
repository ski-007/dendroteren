'use strict';
/* DendroTeren — własne warstwy na mapie: wektory (GeoJSON, KML/KMZ, GPX, SHP w ZIP),
   rastry (GeoTIFF, obraz + plik world) i zwykłe obrazy dopasowywane ręcznie.
   Wszystko zapisywane w telefonie (IndexedDB), działa bez internetu. */

const Layers = (() => {
  const COLORS = ['#00e5ff', '#ff3df2', '#ffe600', '#7cff4f', '#ff8a00', '#ffffff'];
  const MAX_PX = 4096;
  let map = null;
  const live = new Map(); // id -> Leaflet layer
  let records = [];
  let editing = null; // { rec, handles: [] }

  /* ---------- leniwe ładowanie bibliotek ---------- */
  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Nie udało się wczytać ' + src));
      document.head.append(s);
    });
    return loaded[src];
  }
  async function needProj() {
    await loadScript('lib/proj4.js');
    const tm = (lon0, k, x0, y0) => `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=${k} +x_0=${x0} +y_0=${y0} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
    proj4.defs('EPSG:2180', tm(19, 0.9993, 500000, -5300000));
    proj4.defs('EPSG:2176', tm(15, 0.999923, 5500000, 0));
    proj4.defs('EPSG:2177', tm(18, 0.999923, 6500000, 0));
    proj4.defs('EPSG:2178', tm(21, 0.999923, 7500000, 0));
    proj4.defs('EPSG:2179', tm(24, 0.999923, 8500000, 0));
    proj4.defs('EPSG:32633', '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs');
    proj4.defs('EPSG:32634', '+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs');
  }

  /* ---------- układy współrzędnych ---------- */
  const epsgFromText = (s) => { const m = String(s || '').match(/EPSG(?:::|:|\D{0,12})(\d{4,5})/i); return m ? +m[1] : null; };
  function guessEpsg(x, y) {
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return 4326;
    if (x > 5e6 && x < 9e6) return 2171 + Math.floor(x / 1e6); // PUWG 2000: strefa z pierwszej cyfry
    if (x > 1e5 && x < 9e5 && y > 1e5 && y < 9e5) return 2180;
    if (Math.abs(x) > 1e6 && Math.abs(y) > 1e6) return 3857;
    return 2180;
  }
  function toWgs(epsg) {
    if (epsg === 4326 || epsg === 4258 || epsg === 4979) return (c) => c;
    const code = 'EPSG:' + epsg;
    if (!proj4.defs(code)) throw new Error(`Nieobsługiwany układ EPSG:${epsg}. Przelicz warstwę w QGIS do EPSG:2180.`);
    const f = proj4(code, 'EPSG:4326');
    return (c) => { const r = f.forward([c[0], c[1]]); return c.length > 2 ? [r[0], r[1], c[2]] : r; };
  }
  function firstCoord(gj) {
    let found = null;
    const walk = (c) => { if (found) return; if (typeof c[0] === 'number') found = c; else c.forEach(walk); };
    const geoms = gj.type === 'FeatureCollection' ? gj.features.map((f) => f.geometry) : gj.type === 'Feature' ? [gj.geometry] : [gj];
    for (const g of geoms) { if (!g) continue; if (g.type === 'GeometryCollection') g.geometries.forEach((x) => walk(x.coordinates)); else walk(g.coordinates); if (found) break; }
    return found;
  }
  function reproject(gj, fn) {
    const walk = (c) => (typeof c[0] === 'number' ? fn(c) : c.map(walk));
    const doGeom = (g) => { if (!g) return g; if (g.type === 'GeometryCollection') return { ...g, geometries: g.geometries.map(doGeom) }; return { ...g, coordinates: walk(g.coordinates) }; };
    if (gj.type === 'FeatureCollection') return { ...gj, features: gj.features.map((f) => ({ ...f, geometry: doGeom(f.geometry) })) };
    if (gj.type === 'Feature') return { ...gj, geometry: doGeom(gj.geometry) };
    return doGeom(gj);
  }
  async function normalizeGeoJSON(gj, hintEpsg) {
    if (Array.isArray(gj)) gj = { type: 'FeatureCollection', features: gj.flatMap((x) => x.features || []) };
    delete gj.crs;
    const fc = firstCoord(gj);
    if (!fc) throw new Error('Warstwa nie zawiera geometrii.');
    const epsg = hintEpsg || guessEpsg(fc[0], fc[1]);
    if (epsg === 4326) return { gj, epsg };
    await needProj();
    return { gj: reproject(gj, toWgs(epsg)), epsg };
  }

  /* ---------- odczyt plików ---------- */
  const ext = (n) => (n.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  const baseName = (n) => n.replace(/\.[^.]+$/, '');
  const readText = (f) => f.text();

  async function importFiles(fileList) {
    const files = Array.from(fileList);
    const byBase = new Map();
    for (const f of files) { const b = baseName(f.name).toLowerCase(); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(f); }
    const used = new Set();
    let n = 0;
    for (const f of files) {
      if (used.has(f)) continue;
      const e = ext(f.name);
      const siblings = byBase.get(baseName(f.name).toLowerCase()) || [];
      try {
        toast(`Wczytuję ${f.name}…`, 8000);
        let rec = null;
        if (['geojson', 'json'].includes(e)) rec = await fromGeoJSON(f);
        else if (e === 'kml') rec = await fromKml(await readText(f), f.name);
        else if (e === 'kmz') rec = await fromKmz(f);
        else if (e === 'gpx') rec = await fromGpx(f);
        else if (e === 'zip') rec = await fromZip(f);
        else if (['tif', 'tiff'].includes(e)) rec = await fromGeoTiff(f);
        else if (['jpg', 'jpeg', 'png', 'webp'].includes(e)) {
          const wf = siblings.find((s) => /^(jgw|jpgw|pgw|pngw|wld|tfw)$/.test(ext(s.name)));
          const prj = siblings.find((s) => ext(s.name) === 'prj');
          if (wf) used.add(wf); if (prj) used.add(prj);
          rec = await fromImage(f, wf, prj);
        } else if (/^(jgw|jpgw|pgw|pngw|wld|tfw|prj|aux|xml|qmd|cpg|dbf|shx|shp)$/.test(e)) {
          if (e === 'shp') toast('Shapefile wgraj jako ZIP (razem .shp, .shx, .dbf, .prj).', 5000);
          continue;
        } else { toast(`Nieobsługiwany format: ${f.name}`, 4000); continue; }
        used.add(f);
        if (!rec) continue;
        rec.id = uid(); rec.projectId = project.id; rec.created = Date.now(); rec.visible = true;
        rec.color = COLORS[records.length % COLORS.length];
        await DB.put('layers', rec);
        records.push(rec);
        show(rec);
        n++;
        if (rec.kind === 'image' && rec.needsPlacement) startPlacement(rec);
        else zoomTo(rec);
      } catch (err) {
        console.error(err);
        toast(`${f.name}: ${err.message || 'nie udało się wczytać'}`, 6000);
      }
    }
    renderPanel();
    if (n) toast(n === 1 ? 'Dodano warstwę' : `Dodano ${n} warstwy`);
  }

  async function fromGeoJSON(f) {
    const gj = JSON.parse(await readText(f));
    const { gj: out, epsg } = await normalizeGeoJSON(gj, epsgFromText(gj.crs?.properties?.name));
    return { kind: 'vector', name: f.name, geojson: out, srcEpsg: epsg };
  }
  async function fromKml(text, name) {
    await loadScript('lib/togeojson.js');
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    return { kind: 'vector', name, geojson: toGeoJSON.kml(dom), srcEpsg: 4326 };
  }
  async function fromKmz(f) {
    const zip = await JSZip.loadAsync(f);
    const k = Object.keys(zip.files).find((p) => p.toLowerCase().endsWith('.kml'));
    if (!k) throw new Error('W pliku KMZ nie ma KML.');
    return fromKml(await zip.file(k).async('string'), f.name);
  }
  async function fromGpx(f) {
    await loadScript('lib/togeojson.js');
    const dom = new DOMParser().parseFromString(await readText(f), 'text/xml');
    return { kind: 'vector', name: f.name, geojson: toGeoJSON.gpx(dom), srcEpsg: 4326 };
  }
  async function fromZip(f) {
    const buf = await f.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    if (names.some((p) => p.toLowerCase().endsWith('.shp'))) {
      await loadScript('lib/shp.js');
      const prjName = names.find((p) => p.toLowerCase().endsWith('.prj'));
      const prjText = prjName ? await zip.file(prjName).async('string') : '';
      let gj = await shp(buf);
      // shpjs przelicza sam, gdy zna .prj; w razie wątpliwości rozpoznajemy po współrzędnych
      const { gj: out, epsg } = await normalizeGeoJSON(gj, null);
      return { kind: 'vector', name: f.name, geojson: out, srcEpsg: prjText ? 'prj' : epsg };
    }
    const k = names.find((p) => p.toLowerCase().endsWith('.kml'));
    if (k) return fromKml(await zip.file(k).async('string'), f.name);
    const g = names.find((p) => /\.(geo)?json$/i.test(p));
    if (g) { const gj = JSON.parse(await zip.file(g).async('string')); const r = await normalizeGeoJSON(gj, epsgFromText(gj.crs?.properties?.name)); return { kind: 'vector', name: f.name, geojson: r.gj, srcEpsg: r.epsg }; }
    throw new Error('W ZIP nie znaleziono SHP, KML ani GeoJSON.');
  }

  async function canvasToBlob(c, type = 'image/png', q = 0.9) { return new Promise((res) => c.toBlob(res, type, q)); }

  async function fromGeoTiff(f) {
    await loadScript('lib/geotiff.js');
    await needProj();
    const tiff = await GeoTIFF.fromArrayBuffer(await f.arrayBuffer());
    const img = await tiff.getImage();
    const W = img.getWidth(), H = img.getHeight();
    let bbox;
    try { bbox = img.getBoundingBox(); } catch { throw new Error('GeoTIFF bez georeferencji. Zapisz go w QGIS jako GeoTIFF w EPSG:2180.'); }
    const keys = img.getGeoKeys() || {};
    let epsg = keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey || null;
    if (!epsg || epsg === 32767) epsg = guessEpsg(bbox[0], bbox[1]);
    const s = Math.min(1, MAX_PX / Math.max(W, H));
    const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const id = ctx.createImageData(w, h);
    const nodata = img.getGDALNoData();
    const spp = img.getSamplesPerPixel();
    let ok = false;
    try {
      const rgb = await img.readRGB({ width: w, height: h, interleave: true, enableAlpha: spp === 4 });
      const ch = rgb.length / (w * h);
      if (ch >= 3) {
        for (let i = 0, j = 0; i < w * h; i++, j += ch) {
          id.data[i * 4] = rgb[j]; id.data[i * 4 + 1] = rgb[j + 1]; id.data[i * 4 + 2] = rgb[j + 2];
          id.data[i * 4 + 3] = ch === 4 ? rgb[j + 3] : (rgb[j] === 0 && rgb[j + 1] === 0 && rgb[j + 2] === 0 && nodata === 0 ? 0 : 255);
        }
        ok = true;
      }
    } catch { /* np. raster jednopasmowy float – niżej skala szarości */ }
    if (!ok) {
      const [band] = await img.readRasters({ width: w, height: h, samples: [0] });
      let mn = Infinity, mx = -Infinity;
      for (const v of band) if (v !== nodata && Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
      const r = mx > mn ? 255 / (mx - mn) : 1;
      for (let i = 0; i < band.length; i++) {
        const v = band[i], valid = v !== nodata && Number.isFinite(v), g = valid ? Math.round((v - mn) * r) : 0;
        id.data[i * 4] = g; id.data[i * 4 + 1] = g; id.data[i * 4 + 2] = g; id.data[i * 4 + 3] = valid ? 255 : 0;
      }
    }
    ctx.putImageData(id, 0, 0);
    const blob = await canvasToBlob(c, 'image/png');
    const t = toWgs(epsg);
    const ll = (x, y) => { const p = t([x, y]); return [p[1], p[0]]; };
    const [x0, y0, x1, y1] = bbox;
    return {
      kind: 'image', name: f.name, srcEpsg: epsg, type: blob.type, data: await blob.arrayBuffer(), opacity: 0.85,
      corners: { tl: ll(x0, y1), tr: ll(x1, y1), bl: ll(x0, y0) },
    };
  }

  async function loadImageEl(blob) {
    const url = URL.createObjectURL(blob);
    const im = new Image(); im.src = url; await im.decode();
    return { im, url };
  }
  async function fromImage(f, worldFile, prjFile) {
    let { im, url } = await loadImageEl(f);
    const W = im.naturalWidth, H = im.naturalHeight;
    let blob = f, type = f.type || 'image/jpeg';
    if (Math.max(W, H) > MAX_PX) {
      const s = MAX_PX / Math.max(W, H);
      const c = document.createElement('canvas'); c.width = Math.round(W * s); c.height = Math.round(H * s);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      type = type === 'image/png' ? 'image/png' : 'image/jpeg';
      blob = await canvasToBlob(c, type, 0.88);
    }
    URL.revokeObjectURL(url);
    const rec = { kind: 'image', name: f.name, type, data: await blob.arrayBuffer(), opacity: 0.7 };
    if (worldFile) {
      const v = (await readText(worldFile)).trim().split(/\s+/).map(Number);
      if (v.length < 6 || v.some((x) => !Number.isFinite(x))) throw new Error('Nieprawidłowy plik world.');
      const [A, D, B, E, C, F] = v;
      const X = (col, row) => [A * col + B * row + C, D * col + E * row + F];
      const tlS = X(-0.5, -0.5), trS = X(W - 0.5, -0.5), blS = X(-0.5, H - 0.5);
      let epsg = prjFile ? epsgFromText(await readText(prjFile)) : null;
      await needProj();
      if (!epsg && prjFile) { try { const wkt = await readText(prjFile); proj4.defs('PRJ:custom', wkt); const f2 = proj4('PRJ:custom', 'EPSG:4326'); const ll = (p) => { const r = f2.forward(p); return [r[1], r[0]]; }; rec.corners = { tl: ll(tlS), tr: ll(trS), bl: ll(blS) }; rec.srcEpsg = 'prj'; return rec; } catch { /* zgadujemy niżej */ } }
      epsg = epsg || guessEpsg(tlS[0], tlS[1]);
      const t = toWgs(epsg);
      const ll = (p) => { const r = t(p); return [r[1], r[0]]; };
      rec.corners = { tl: ll(tlS), tr: ll(trS), bl: ll(blS) };
      rec.srcEpsg = epsg;
    } else {
      // obraz bez georeferencji: wstaw w bieżący widok i dopasuj ręcznie
      const b = map.getBounds(), cpt = map.getCenter();
      const viewW = b.getEast() - b.getWest(), viewH = b.getNorth() - b.getSouth();
      const k = Math.cos(cpt.lat * Math.PI / 180);
      let wDeg = viewW * 0.7, hDeg = wDeg * k * (H / W);
      if (hDeg > viewH * 0.7) { hDeg = viewH * 0.7; wDeg = hDeg / k * (W / H); }
      rec.corners = { tl: [cpt.lat + hDeg / 2, cpt.lng - wDeg / 2], tr: [cpt.lat + hDeg / 2, cpt.lng + wDeg / 2], bl: [cpt.lat - hDeg / 2, cpt.lng - wDeg / 2] };
      rec.srcEpsg = null; rec.needsPlacement = true;
    }
    return rec;
  }

  /* ---------- obraz z 3 narożnikami (obrót, skala, przesunięcie) ---------- */
  const CornerImage = L.Layer.extend({
    options: { pane: 'userImage' },
    initialize(url, c, opacity) { this._url = url; this.setCorners(c); this._opacity = opacity; },
    setCorners(c) { this._tl = L.latLng(c.tl); this._tr = L.latLng(c.tr); this._bl = L.latLng(c.bl); if (this._map) this._reset(); },
    setOpacity(o) { this._opacity = o; if (this._img) this._img.style.opacity = o; },
    getBounds() { const br = L.latLng(this._tr.lat + this._bl.lat - this._tl.lat, this._tr.lng + this._bl.lng - this._tl.lng); return L.latLngBounds([this._tl, this._tr, this._bl, br]); },
    onAdd(m) {
      const img = this._img = L.DomUtil.create('img', 'leaflet-image-layer leaflet-zoom-hide corner-img');
      img.style.opacity = this._opacity; img.alt = '';
      img.onload = () => this._reset();
      img.src = this._url;
      this.getPane().appendChild(img);
      m.on('zoomend viewreset', this._reset, this);
      if (img.complete) this._reset();
    },
    onRemove(m) { L.DomUtil.remove(this._img); m.off('zoomend viewreset', this._reset, this); },
    _reset() {
      const img = this._img, m = this._map;
      if (!img || !m || !img.naturalWidth) return;
      const a = m.latLngToLayerPoint(this._tl), b = m.latLngToLayerPoint(this._tr), c = m.latLngToLayerPoint(this._bl);
      const w = img.naturalWidth, h = img.naturalHeight;
      img.style.width = w + 'px'; img.style.height = h + 'px';
      img.style.transformOrigin = '0 0';
      img.style.transform = `matrix(${(b.x - a.x) / w},${(b.y - a.y) / w},${(c.x - a.x) / h},${(c.y - a.y) / h},${a.x},${a.y})`;
    },
  });

  /* ---------- wyświetlanie ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function show(rec) {
    hide(rec.id);
    if (!rec.visible || !map) return;
    let lyr;
    if (rec.kind === 'vector') {
      lyr = L.geoJSON(rec.geojson, {
        pane: 'userVector',
        style: () => ({ color: rec.color, weight: 2.5, opacity: 0.95, fillColor: rec.color, fillOpacity: 0.08 }),
        pointToLayer: (_, ll) => L.circleMarker(ll, { radius: 5, color: '#000', weight: 1, fillColor: rec.color, fillOpacity: 1, pane: 'userVector' }),
        onEachFeature: (f, l) => {
          const p = f.properties || {};
          const rows = Object.entries(p).filter(([, v]) => v != null && v !== '' && typeof v !== 'object').slice(0, 14);
          if (rows.length) l.bindPopup(`<div class="attr"><b>${esc(rec.name)}</b><table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table></div>`, { maxWidth: 280 });
        },
      });
    } else {
      const url = URL.createObjectURL(new Blob([rec.data], { type: rec.type }));
      lyr = new CornerImage(url, rec.corners, rec.opacity ?? 0.7);
      lyr._blobUrl = url;
    }
    lyr.addTo(map);
    live.set(rec.id, lyr);
  }
  function hide(id) {
    const l = live.get(id);
    if (!l) return;
    if (l._blobUrl) URL.revokeObjectURL(l._blobUrl);
    l.remove();
    live.delete(id);
  }
  function zoomTo(rec) {
    const l = live.get(rec.id);
    try { const b = l?.getBounds(); if (b && b.isValid()) map.fitBounds(b, { maxZoom: 19, padding: [20, 20] }); } catch { /* pusta warstwa */ }
  }

  /* ---------- dopasowanie obrazu ---------- */
  function startPlacement(rec) {
    stopPlacement(false);
    const lyr = live.get(rec.id);
    if (!lyr) return;
    const c = { tl: L.latLng(rec.corners.tl), tr: L.latLng(rec.corners.tr), bl: L.latLng(rec.corners.bl) };
    const icon = (cls, txt) => L.divIcon({ className: '', html: `<div class="hdl ${cls}">${txt}</div>`, iconSize: [0, 0] });
    const center = () => L.latLng((c.tr.lat + c.bl.lat) / 2, (c.tr.lng + c.bl.lng) / 2);
    const mk = {
      tl: L.marker(c.tl, { draggable: true, icon: icon('', '1') }),
      tr: L.marker(c.tr, { draggable: true, icon: icon('', '2') }),
      bl: L.marker(c.bl, { draggable: true, icon: icon('', '3') }),
      mv: L.marker(center(), { draggable: true, icon: icon('hdl-move', '✥') }),
    };
    const apply = () => { lyr.setCorners(c); };
    for (const k of ['tl', 'tr', 'bl']) mk[k].on('drag', (e) => { c[k] = e.target.getLatLng(); apply(); mk.mv.setLatLng(center()); });
    let last = null;
    mk.mv.on('dragstart', (e) => { last = e.target.getLatLng(); });
    mk.mv.on('drag', (e) => {
      const p = e.target.getLatLng(), dLat = p.lat - last.lat, dLng = p.lng - last.lng; last = p;
      for (const k of ['tl', 'tr', 'bl']) { c[k] = L.latLng(c[k].lat + dLat, c[k].lng + dLng); mk[k].setLatLng(c[k]); }
      apply();
    });
    Object.values(mk).forEach((m) => m.addTo(map));
    editing = { rec, mk, c };
    $('#placeBar').hidden = false;
    $('#placeName').textContent = rec.name;
    $('#placeOpacity').value = rec.opacity ?? 0.7;
    window.fillSliders?.($('#placeBar'));
    $('#layersPanel').hidden = true;
  }
  async function stopPlacement(save) {
    if (!editing) return;
    const { rec, mk, c } = editing;
    Object.values(mk).forEach((m) => m.remove());
    if (save) {
      rec.corners = { tl: [c.tl.lat, c.tl.lng], tr: [c.tr.lat, c.tr.lng], bl: [c.bl.lat, c.bl.lng] };
      delete rec.needsPlacement;
      await DB.put('layers', rec);
      toast('Położenie obrazu zapisane');
    } else live.get(rec.id)?.setCorners(rec.corners);
    editing = null;
    $('#placeBar').hidden = true;
  }

  /* ---------- panel ---------- */
  function renderPanel() {
    const box = $('#layersList');
    box.textContent = '';
    $('#layersEmpty').hidden = records.length > 0;
    for (const rec of records) {
      const row = document.createElement('div'); row.className = 'lyr';
      const top = document.createElement('div'); top.className = 'lyr-top';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = rec.visible; cb.setAttribute('aria-label', 'Pokaż warstwę ' + rec.name);
      cb.addEventListener('change', async () => { rec.visible = cb.checked; await DB.put('layers', rec); rec.visible ? show(rec) : hide(rec.id); });
      const sw = document.createElement('span'); sw.className = 'lyr-sw'; sw.style.background = rec.kind === 'vector' ? rec.color : 'linear-gradient(135deg,#6b8f5e,#c9b98a)';
      const nm = document.createElement('button'); nm.type = 'button'; nm.className = 'lyr-name'; nm.textContent = rec.name;
      nm.title = 'Przybliż do warstwy';
      nm.addEventListener('click', () => { if (!rec.visible) { rec.visible = true; cb.checked = true; show(rec); DB.put('layers', rec); } zoomTo(rec); $('#layersPanel').hidden = true; });
      const info = document.createElement('small');
      info.textContent = (rec.kind === 'vector' ? `${rec.geojson.features?.length ?? 1} obiektów` : 'raster') + (rec.srcEpsg ? ` · ${rec.srcEpsg === 'prj' ? '.prj' : 'EPSG:' + rec.srcEpsg}` : rec.kind === 'image' ? ' · dopasowany ręcznie' : '');
      const del = document.createElement('button'); del.type = 'button'; del.className = 'rm'; del.textContent = '×'; del.setAttribute('aria-label', 'Usuń warstwę');
      del.addEventListener('click', async () => {
        if (!confirm(`Usunąć warstwę „${rec.name}” z telefonu?`)) return;
        hide(rec.id); await DB.del('layers', rec.id); records = records.filter((r) => r !== rec); renderPanel();
      });
      const nmBox = document.createElement('div'); nmBox.className = 'lyr-nm'; nmBox.append(nm, info);
      top.append(cb, sw, nmBox, del);
      row.append(top);
      if (rec.kind === 'image') {
        const ctl = document.createElement('div'); ctl.className = 'lyr-ctl';
        const op = document.createElement('input'); op.type = 'range'; op.className = 'slider always'; op.min = '0.1'; op.max = '1'; op.step = '0.05'; op.value = rec.opacity ?? 0.7;
        op.setAttribute('aria-label', 'Przezroczystość');
        op.addEventListener('input', () => { rec.opacity = +op.value; live.get(rec.id)?.setOpacity(rec.opacity); });
        op.addEventListener('change', () => DB.put('layers', rec));
        const fit = document.createElement('button'); fit.type = 'button'; fit.className = 'btn'; fit.textContent = 'Dopasuj';
        fit.addEventListener('click', () => { if (!rec.visible) { rec.visible = true; show(rec); } startPlacement(rec); });
        const lab = document.createElement('span'); lab.className = 'lyr-op'; lab.textContent = 'krycie';
        ctl.append(lab, op, fit);
        row.append(ctl);
      }
      box.append(row);
    }
    window.fillSliders?.(box);
  }

  /* ---------- API ---------- */
  async function load() {
    for (const id of [...live.keys()]) hide(id);
    records = project ? (await DB.byIndex('layers', 'projectId', project.id)).sort((a, b) => a.created - b.created) : [];
    if (map) records.forEach(show);
    renderPanel();
  }
  function attach(m) {
    map = m;
    map.createPane('userImage').style.zIndex = 250;
    map.createPane('userVector').style.zIndex = 420;
    records.forEach(show);
  }
  function bind() {
    $('#mapLayersBtn').addEventListener('click', () => { const p = $('#layersPanel'); p.hidden = !p.hidden; if (!p.hidden) renderPanel(); });
    $('#layersClose').addEventListener('click', () => { $('#layersPanel').hidden = true; });
    $('#layerFile').addEventListener('change', async (e) => { const fs = e.target.files; await importFiles(fs); e.target.value = ''; });
    $('#placeOk').addEventListener('click', () => stopPlacement(true));
    $('#placeCancel').addEventListener('click', () => stopPlacement(false));
    $('#placeOpacity').addEventListener('input', (e) => { if (editing) { editing.rec.opacity = +e.target.value; live.get(editing.rec.id)?.setOpacity(editing.rec.opacity); } });
  }
  return { attach, load, bind, stopPlacement };
})();
