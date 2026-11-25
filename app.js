'use strict';
/* DendroTeren — inwentaryzacja drzew w terenie (PWA, iOS + Android). */
const APP_VERSION = '1.2.0';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const num = (v) => { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const fmt = (n, d = 1) => (n == null ? '' : round(n, d).toLocaleString('pl-PL', { maximumFractionDigits: d }));
const collator = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
const DEG = Math.PI / 180;

let toastTimer = null;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ============================ ustawienia ============================ */
const SKEY = 'dendroteren.settings';
const settings = Object.assign({
  currentProject: null, sliders: true, eye: 1.6, wake: false, stickyStan: false,
  layer: 'orto', parcels: false, recent: [], hintClosed: false, draft: null, stash: null,
}, (() => { try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; } })());
function saveSettings() { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch { /* brak pamięci lokalnej */ } }

/* ============================ IndexedDB ============================ */
const idb = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const DB = {
  db: null,
  async open() {
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('dendroteren', 2);
      r.onupgradeneeded = () => {
        const d = r.result, has = (n) => d.objectStoreNames.contains(n);
        if (!has('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!has('trees')) d.createObjectStore('trees', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        if (!has('photos')) d.createObjectStore('photos', { keyPath: 'id' }).createIndex('treeId', 'treeId');
        if (!has('layers')) d.createObjectStore('layers', { keyPath: 'id' }).createIndex('projectId', 'projectId');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  st(name, mode = 'readonly') { return this.db.transaction(name, mode).objectStore(name); },
  get(s, k) { return idb(this.st(s).get(k)); },
  put(s, v) { return idb(this.st(s, 'readwrite').put(v)); },
  del(s, k) { return idb(this.st(s, 'readwrite').delete(k)); },
  all(s) { return idb(this.st(s).getAll()); },
  byIndex(s, i, k) { return idb(this.st(s).index(i).getAll(k)); },
};

/* ============================ PUWG 1992 (EPSG:2180) ============================ */
function toPUWG92(lat, lon) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9993, lon0 = 19 * DEG, FE = 500000, FN = -5300000;
  const n = f / (2 - f), e = Math.sqrt(f * (2 - f));
  const A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
  const al = [0, n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240];
  const phi = lat * DEG, lam = lon * DEG - lon0;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam));
  const eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  for (let j = 1; j <= 3; j++) {
    E += al[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    N += al[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return { x: FN + k0 * A * N, y: FE + k0 * A * E }; // x = północ, y = wschód (konwencja geodezyjna)
}

/* ============================ stan ============================ */
let project = null;          // bieżący projekt
let trees = [];              // drzewa bieżącego projektu
let cur = null;              // formularz
let editing = false;         // edycja istniejącego wpisu
let editReturn = 'list';
let gps = null;              // ostatni odczyt {lat, lon, acc, t}
const photoUrls = new Map();

function blankTree(prev) {
  const keep = settings.stickyStan && prev;
  return {
    id: uid(), projectId: project.id, nr: nextNrString(),
    typ: prev?.typ || 'drzewo', sp: prev?.sp || '', spLat: prev?.spLat || '', p: prev?.p ?? null,
    c130: [], c5: [], h: null, crown: null, area: null,
    stan: keep ? prev.stan : '', cechy: [], decyzja: keep ? prev.decyzja : '', uwagi: '',
    loc: gps ? { lat: gps.lat, lon: gps.lon, acc: gps.acc, src: 'gps' } : null,
    locMode: 'live', photos: [], created: null, updated: null,
  };
}
const trailingInt = (s) => { const m = String(s || '').match(/(\d+)(?!.*\d)/); return m ? parseInt(m[1], 10) : null; };
function nextNrString() { return project.numMode === 'manual' ? '' : (project.prefix || '') + project.nextNr; }
const hasContent = (t) => !!(t.c130.some((v) => v != null) || t.c5.some((v) => v != null) || t.h != null || t.crown != null || t.area != null || t.stan || t.cechy.length || t.decyzja || t.uwagi || t.photos.length);

let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (editing) { /* szkic nowego drzewa leży w settings.stash */ } else { settings.draft = cur; }
    saveSettings();
  }, 300);
}

/* ============================ progi z art. 83f uoop ============================ */
function thresholdInfo(t) {
  if (t.typ === 'drzewo') {
    const v = (t.c5 || []).filter((x) => x != null);
    if (!v.length) return null;
    const limit = t.p || 50, max = Math.max(...v);
    return { kind: 'c5', limit, over: max > limit, max };
  }
  if (t.area == null) return null;
  return { kind: 'area', limit: 25, over: t.area > 25, max: t.area };
}

/* ============================ widoki ============================ */
let currentView = 'form';
function showView(name) {
  currentView = name;
  for (const v of ['form', 'map', 'list', 'more']) $('#view-' + v).hidden = v !== name;
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  if (name === 'map') { initMap(); setTimeout(() => { map.invalidateSize(); refreshMarkers(); }, 30); }
  if (name === 'list') renderList();
  if (name === 'more') renderMore();
}

/* ============================ formularz ============================ */
function setSeg(sel, val) { $$(sel + ' button').forEach((b) => b.classList.toggle('on', b.dataset.v === val)); }
function setChips(sel, vals) { $$(sel + ' button').forEach((b) => b.classList.toggle('on', vals.includes(b.dataset.v))); }
function setDim(id, v) { $('#' + id).value = v ?? ''; $('#' + id + 'r').value = v ?? 0; }

function renderForm() {
  $('#fNr').value = cur.nr || '';
  checkDup();
  setSeg('#fTyp', cur.typ);
  $('#fSpecies').value = cur.sp || '';
  $('#speciesLat').textContent = cur.spLat || '';
  $('.species-box').classList.toggle('has', !!cur.sp);
  $$('#recentSpecies .rchip').forEach((c) => c.classList.toggle('on', c.firstChild.textContent === cur.sp));
  $('#stickyPill').hidden = !cur.sp || editing;
  const isTree = cur.typ === 'drzewo';
  $('#cardTree').hidden = !isTree;
  $('#dimArea').hidden = isTree;
  $('#dimCrown').hidden = cur.typ === 'skupina';
  renderStems('c130'); renderStems('c5');
  setDim('fH', cur.h); setDim('fCrown', cur.crown); setDim('fArea', cur.area);
  setChips('#fStan', [cur.stan]); setChips('#fCechy', cur.cechy); setChips('#fDecyzja', [cur.decyzja]);
  $('#fUwagi').value = cur.uwagi || '';
  $('#editBanner').hidden = !editing;
  $('#editNr').textContent = cur.nr || '(bez nr)';
  $('#btnDelete').hidden = !editing;
  $('#btnClear').hidden = editing;
  $('#btnSave').textContent = editing ? 'Zapisz zmiany' : 'Zapisz i następne';
  renderLoc(); renderPhotos(); renderCalc();
  fillSliders();
}

/* wypełnienie toru suwaka do położenia gałki */
function fillSlider(el) {
  const min = +el.min || 0, max = +el.max || 100, v = +el.value;
  el.style.setProperty('--p', (max > min ? Math.max(0, Math.min(100, (v - min) / (max - min) * 100)) : 0) + '%');
}
function fillSliders(root = document) { root.querySelectorAll('input[type="range"]').forEach(fillSlider); }
window.fillSliders = fillSliders;
document.addEventListener('input', (e) => { if (e.target.type === 'range') fillSlider(e.target); }, true);

function checkDup() {
  const v = $('#fNr').value.trim();
  $('#nrWarn').hidden = !v || !trees.some((t) => t.nr === v && t.id !== cur.id);
}

function renderStems(key) {
  const box = $('#' + key);
  box.textContent = '';
  const arr = cur[key].length ? cur[key] : [null];
  arr.forEach((v, i) => {
    const row = document.createElement('div'); row.className = 'stem';
    if (arr.length > 1) { const n = document.createElement('div'); n.className = 'stem-n'; n.textContent = 'Pień ' + (i + 1); row.append(n); }
    const inp = document.createElement('input');
    Object.assign(inp, { type: 'number', inputMode: 'decimal', step: '1', min: '0', id: `${key}_${i}`, value: v ?? '', placeholder: 'cm' });
    inp.setAttribute('aria-label', `Obwód ${key === 'c130' ? 'na 130 cm' : 'na 5 cm'}, pień ${i + 1}`);
    const rm = document.createElement('button');
    Object.assign(rm, { type: 'button', className: 'rm', textContent: '×' });
    rm.setAttribute('aria-label', 'Usuń pień'); rm.hidden = arr.length < 2;
    const sl = document.createElement('input');
    Object.assign(sl, { type: 'range', className: 'slider', min: '0', max: '500', step: '1', value: v ?? 0 });
    sl.setAttribute('aria-label', 'Obwód – suwak');
    const setVal = (val) => { if (!cur[key].length) cur[key] = [null]; cur[key][i] = val; renderCalc(); saveDraft(); };
    inp.addEventListener('input', () => { const val = num(inp.value); sl.value = val ?? 0; fillSlider(sl); setVal(val); });
    sl.addEventListener('input', () => { inp.value = sl.value; setVal(+sl.value); });
    rm.addEventListener('click', () => { cur[key].splice(i, 1); renderStems(key); renderCalc(); saveDraft(); });
    row.append(inp, rm, sl);
    box.append(row);
  });
}

function renderCalc() {
  const st = cur.c130.filter((v) => v != null);
  $('#dbhOut').textContent = st.length ? (st.length > 1 ? 'pierśnice ' : 'pierśnica ') + st.map((c) => fmt(c / Math.PI, 0)).join(' / ') + ' cm' : '';
  const th = thresholdInfo(cur);
  const el = cur.typ === 'drzewo' ? $('#thrOut') : $('#areaThr');
  $('#thrOut').hidden = true; $('#areaThr').hidden = true;
  if (th) {
    el.hidden = false;
    el.className = 'thr ' + (th.over ? 'over' : 'under');
    el.textContent = th.kind === 'c5'
      ? (th.over ? `powyżej progu ${th.limit} cm` : `poniżej progu ${th.limit} cm`)
      : (th.over ? 'powyżej 25 m²' : 'do 25 m²');
    el.title = 'Orientacyjnie wg art. 83f ust. 1 ustawy o ochronie przyrody';
  }
}

/* ---------- gatunek ---------- */
let spHl = -1, spItems = [];
function searchSpecies(q) {
  const n = norm(q).trim();
  if (!n) return [];
  const scored = [];
  for (const s of window.SPECIES) {
    const a = norm(s.pl), b = norm(s.lat);
    let sc = -1;
    if (a.startsWith(n) || b.startsWith(n)) sc = 0;
    else if (a.split(/\s+/).some((w) => w.startsWith(n)) || b.split(/\s+/).some((w) => w.startsWith(n))) sc = 1;
    else if (a.includes(n) || b.includes(n)) sc = 2;
    if (sc >= 0) scored.push([sc, s]);
  }
  scored.sort((x, y) => x[0] - y[0] || collator.compare(x[1].pl, y[1].pl));
  return scored.map((x) => x[1]);
}
/* pełna lista gatunków alfabetycznie (przeglądanie bez wpisywania) */
function allSpecies() { return [...window.SPECIES].sort((a, b) => collator.compare(a.pl, b.pl)); }
function hideSpeciesList() { $('#speciesList').hidden = true; $('#speciesBrowse').setAttribute('aria-expanded', 'false'); }
function showSpeciesList(q) {
  const browse = !norm(q || '').trim();
  spItems = browse ? allSpecies() : searchSpecies(q);
  const ul = $('#speciesList');
  ul.textContent = '';
  const selIdx = spItems.findIndex((s) => s.pl === cur.sp);
  spHl = browse ? selIdx : (spItems.length ? 0 : -1);
  if (spItems.length) {
    const head = document.createElement('li'); head.className = 'sp-head';
    head.textContent = (browse ? `Wszystkie gatunki (${spItems.length})` : `Pasuje: ${spItems.length}`) + (spItems.length > 4 ? ' · przesuń palcem' : '');
    ul.append(head);
  }
  spItems.forEach((s, i) => {
    const li = document.createElement('li');
    li.dataset.i = i;
    if (s.pl === cur.sp) li.classList.add('sel');
    if (i === spHl) li.classList.add('hl');
    const b = document.createElement('b'); b.textContent = s.pl;
    const it = document.createElement('i'); it.textContent = s.lat;
    li.append(b, it);
    ul.append(li);
  });
  ul.hidden = !spItems.length;
  $('#speciesBrowse').setAttribute('aria-expanded', String(!ul.hidden));
  const sel = ul.querySelector('li.sel') || ul.querySelector('li.hl');
  ul.scrollTop = 0;
  if (sel && browse) ul.scrollTop = Math.max(0, sel.offsetTop - ul.clientHeight / 2 + sel.offsetHeight / 2);
}
function pickSpecies(s) {
  cur.sp = s.pl; cur.spLat = s.lat; cur.p = s.p;
  if (s.k && cur.typ === 'drzewo' && !hasContent(cur)) cur.typ = 'krzew';
  hideSpeciesList();
  $('#fSpecies').blur();
  settings.recent = [s, ...settings.recent.filter((r) => r.pl !== s.pl)].slice(0, 8);
  renderRecent(); renderForm(); saveDraft();
}
function commitTypedSpecies() {
  const v = $('#fSpecies').value.trim();
  if (v === (cur.sp || '')) return;
  if (!v) { cur.sp = ''; cur.spLat = ''; cur.p = null; renderForm(); saveDraft(); return; }
  const exact = window.SPECIES.find((s) => norm(s.pl) === norm(v) || norm(s.lat) === norm(v));
  if (exact) return pickSpecies(exact);
  cur.sp = v; cur.spLat = ''; cur.p = 50; // gatunek spoza listy: próg ogólny
  settings.recent = [{ pl: v, lat: '', p: 50 }, ...settings.recent.filter((r) => r.pl !== v)].slice(0, 8);
  renderRecent(); renderForm(); saveDraft();
}
function renderRecent() {
  const box = $('#recentSpecies');
  box.textContent = '';
  settings.recent.slice(0, 8).forEach((r) => {
    const chip = document.createElement('span');
    chip.className = 'rchip' + (r.pl === cur.sp ? ' on' : '');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'rc-pick'; b.textContent = r.pl;
    b.addEventListener('click', () => pickSpecies(r));
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'rc-x'; x.textContent = '×';
    x.setAttribute('aria-label', `Usuń „${r.pl}” z ostatnio używanych`);
    x.addEventListener('click', () => {
      settings.recent = settings.recent.filter((q) => q.pl !== r.pl);
      saveSettings(); renderRecent();
      toast(`Usunięto „${r.pl}” z listy`);
    });
    chip.append(b, x);
    box.append(chip);
  });
}

/* ---------- lokalizacja ---------- */
const LOC_LABEL = { live: 'na żywo', fixed: 'zatwierdzona', avg: 'uśredniona', manual: 'poprawiona ręcznie', none: 'brak' };
function renderLoc() {
  const l = cur.loc;
  const mode = l ? (cur.locMode === 'live' ? 'live' : l.src === 'manual' ? 'manual' : l.src === 'avg' ? 'avg' : 'fixed') : (cur.locMode === 'live' ? 'live' : 'none');
  const pill = $('#locState');
  pill.dataset.s = l ? mode : 'none';
  pill.textContent = l ? LOC_LABEL[mode] + (l.src === 'avg' && l.n ? ` (${l.n})` : '') : (cur.locMode === 'live' ? 'czekam na GPS' : 'brak');
  if (l) {
    const p = toPUWG92(l.lat, l.lon);
    $('#locLL').textContent = `${l.lat.toFixed(6)}, ${l.lon.toFixed(6)}`;
    $('#loc92').textContent = `X ${p.x.toFixed(2)}  Y ${p.y.toFixed(2)}`;
    $('#locAcc').textContent = l.acc != null ? `±${Math.round(l.acc)} m` : 'ręcznie';
  } else {
    $('#locLL').textContent = '—'; $('#loc92').textContent = '—'; $('#locAcc').textContent = '—';
  }
  $('#locLive').hidden = cur.locMode === 'live';
  $('#locFix').disabled = !gps;
  $('#locAvg').disabled = !gps || avgRunning;
}

function startGPS() {
  if (!('geolocation' in navigator)) { setBadge(null, 'brak GPS'); return; }
  navigator.geolocation.watchPosition((pos) => {
    gps = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, t: pos.timestamp };
    setBadge(gps.acc);
    if (avgRunning) avgSamples.push(gps);
    if (cur && cur.locMode === 'live') { cur.loc = { lat: gps.lat, lon: gps.lon, acc: gps.acc, src: 'gps' }; }
    if (currentView === 'form') renderLoc();
    updateMe();
  }, (err) => {
    setBadge(null, err.code === 1 ? 'GPS zablok.' : 'brak GPS');
    if (err.code === 1) toast('Brak zgody na lokalizację. Włącz ją w ustawieniach przeglądarki dla tej strony.', 5000);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
function setBadge(acc, txt) {
  const b = $('#gpsBadge');
  b.dataset.q = acc == null ? 'none' : acc <= 5 ? 'good' : acc <= 15 ? 'mid' : 'bad';
  $('#gpsBadgeTxt').textContent = txt || `±${Math.round(acc)} m`;
}

let avgRunning = false, avgSamples = [];
async function averageGPS() {
  if (avgRunning) return;
  avgRunning = true; avgSamples = gps ? [gps] : [];
  const btn = $('#locAvg');
  for (let s = 10; s > 0; s--) { btn.textContent = `Uśredniam… ${s}`; renderLocBtnState(); await new Promise((r) => setTimeout(r, 1000)); }
  avgRunning = false; btn.textContent = 'Uśrednij 10 s';
  if (!avgSamples.length) { toast('Brak odczytów GPS'); renderLoc(); return; }
  let sw = 0, la = 0, lo = 0, ac = 0;
  for (const s of avgSamples) { const w = 1 / Math.max(s.acc, 1) ** 2; sw += w; la += s.lat * w; lo += s.lon * w; ac += s.acc; }
  cur.loc = { lat: la / sw, lon: lo / sw, acc: ac / avgSamples.length, src: 'avg', n: avgSamples.length };
  cur.locMode = 'fixed';
  renderLoc(); saveDraft();
  toast(`Uśredniono ${avgSamples.length} odczytów`);
}
function renderLocBtnState() { $('#locAvg').disabled = true; }

/* ---------- zdjęcia ---------- */
async function resizeImage(file, max = 2048, q = 0.85) {
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', q));
  } catch { return file; }
}
async function addPhotos(files) {
  if (!files || !files.length) return;
  toast('Zapisuję zdjęcie…', 1200);
  for (const f of files) {
    const blob = await resizeImage(f);
    const ph = { id: uid(), treeId: cur.id, type: blob.type || 'image/jpeg', data: await blob.arrayBuffer(), created: Date.now() };
    await DB.put('photos', ph);
    cur.photos.push(ph.id);
  }
  renderPhotos(); saveDraft();
}
async function photoUrl(id) {
  if (photoUrls.has(id)) return photoUrls.get(id);
  const ph = await DB.get('photos', id);
  if (!ph) return null;
  const u = URL.createObjectURL(new Blob([ph.data], { type: ph.type }));
  photoUrls.set(id, u);
  return u;
}
async function renderPhotos() {
  const box = $('#photos');
  box.textContent = '';
  for (const id of cur.photos) {
    const u = await photoUrl(id);
    if (!u) continue;
    const d = document.createElement('div'); d.className = 'ph';
    const img = document.createElement('img'); img.src = u; img.alt = 'Zdjęcie';
    img.addEventListener('click', () => { $('#viewerImg').src = u; $('#viewer').hidden = false; });
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Usuń zdjęcie');
    x.addEventListener('click', () => {
      if (!confirm('Usunąć to zdjęcie?')) return;
      cur.photos = cur.photos.filter((p) => p !== id);
      if (!editing) DB.del('photos', id); // przy edycji usuwamy dopiero po zapisie
      renderPhotos(); saveDraft();
    });
    d.append(img, x);
    box.append(d);
  }
}

/* ---------- zapis ---------- */
function cleanTree(t) {
  const c = JSON.parse(JSON.stringify(t));
  c.c130 = c.c130.filter((v) => v != null);
  c.c5 = c.c5.filter((v) => v != null);
  if (c.typ === 'drzewo') c.area = null; else { c.c130 = []; c.c5 = []; }
  if (c.typ === 'skupina') c.crown = null;
  return c;
}
async function saveTree() {
  commitTypedSpecies();
  cur.nr = $('#fNr').value.trim();
  if (!cur.nr && !confirm('Pomiar nie ma numeru. Zapisać bez numeru?')) return;
  if (cur.nr && trees.some((t) => t.nr === cur.nr && t.id !== cur.id) && !confirm(`Numer ${cur.nr} już jest w projekcie. Zapisać mimo to?`)) return;
  if (cur.locMode === 'live' && gps) cur.loc = { lat: gps.lat, lon: gps.lon, acc: gps.acc, src: 'gps' };
  const now = Date.now();
  const t = cleanTree(cur);
  t.created = t.created || now; t.updated = now;
  if (t.locMode === 'live') t.locMode = 'fixed';
  if (editing) {
    const orig = trees.find((x) => x.id === t.id);
    if (orig) for (const pid of orig.photos) if (!t.photos.includes(pid)) DB.del('photos', pid);
  }
  await DB.put('trees', t);
  const i = trees.findIndex((x) => x.id === t.id);
  if (i >= 0) trees[i] = t; else trees.push(t);
  navigator.vibrate?.(40);

  if (editing) {
    editing = false;
    cur = settings.stash || blankTree(t);
    settings.stash = null;
    toast(`Zapisano zmiany: ${t.nr || '(bez nr)'}`);
    showView(editReturn);
  } else {
    const n = trailingInt(t.nr);
    if (n != null && project.numMode !== 'manual') { project.nextNr = n + 1; await DB.put('projects', project); }
    cur = blankTree(t);
    toast(`Zapisano ${t.nr || '(bez nr)'}${t.loc ? '' : ' – bez lokalizacji!'}`);
    $('#view-form').scrollTop = 0;
  }
  settings.draft = editing ? settings.draft : cur;
  saveSettings();
  renderForm(); renderRecent(); updateCount();
  if (map) refreshMarkers();
}

function editTree(id, ret) {
  const t = trees.find((x) => x.id === id);
  if (!t) return;
  if (!editing) { settings.stash = cur; saveSettings(); }
  editing = true; editReturn = ret;
  cur = JSON.parse(JSON.stringify(t));
  cur.locMode = 'fixed';
  showView('form');
  renderForm();
  $('#view-form').scrollTop = 0;
}
async function cancelEdit() {
  // zdjęcia dodane podczas anulowanej edycji
  const orig = trees.find((x) => x.id === cur.id);
  if (orig) for (const pid of cur.photos) if (!orig.photos.includes(pid)) DB.del('photos', pid);
  editing = false;
  cur = settings.stash || blankTree(null);
  settings.stash = null; saveSettings();
  renderForm();
  showView(editReturn);
}
async function deleteTree() {
  if (!confirm(`Usunąć pomiar ${cur.nr || '(bez nr)'} wraz ze zdjęciami? Tego nie da się cofnąć.`)) return;
  const orig = trees.find((x) => x.id === cur.id);
  const ids = new Set([...(orig?.photos || []), ...cur.photos]);
  for (const pid of ids) await DB.del('photos', pid);
  await DB.del('trees', cur.id);
  trees = trees.filter((x) => x.id !== cur.id);
  editing = false;
  cur = settings.stash || blankTree(null);
  settings.stash = null; saveSettings();
  toast('Usunięto');
  renderForm(); updateCount();
  if (map) refreshMarkers();
  showView(editReturn);
}
async function clearForm() {
  if (hasContent(cur) && !confirm('Wyczyścić formularz? Wpisane dane i zdjęcia tego pomiaru zostaną usunięte.')) return;
  for (const pid of cur.photos) await DB.del('photos', pid);
  const keep = { typ: cur.typ, sp: cur.sp, spLat: cur.spLat, p: cur.p };
  const nr = cur.nr;
  cur = blankTree(keep);
  cur.nr = nr;
  renderForm(); saveDraft();
}

function stepNr(d) {
  const inp = $('#fNr');
  const v = inp.value.trim();
  const n = trailingInt(v);
  if (n == null) inp.value = (project.prefix || '') + Math.max(1, project.nextNr + (d < 0 ? -1 : 0));
  else inp.value = v.replace(/(\d+)(?!.*\d)/, String(Math.max(0, n + d)));
  cur.nr = inp.value; checkDup(); saveDraft();
}

/* ============================ mapa ============================ */
let map = null, baseLayers = {}, parcelsLayer = null, treeLayer = null, meMarker = null, meAcc = null, pickMarker = null, picking = false;
const DEC_COLORS = { 'do wycinki': '#b3261e', 'do zachowania': '#2e7d4f', 'do przesadzenia': '#2a62a8', 'do weryfikacji': '#a8690f' };

function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: true, maxZoom: 21 });
  baseLayers.osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 21, maxNativeZoom: 19, crossOrigin: true, attribution: '© OpenStreetMap',
  });
  // WMTS (gotowe kafle EPSG:3857) – znacznie szybszy niż WMS
  baseLayers.orto = L.tileLayer('https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default&FORMAT=image/jpeg&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}', {
    maxZoom: 21, maxNativeZoom: 19, crossOrigin: true, attribution: 'Ortofotomapa © GUGiK',
  });
  parcelsLayer = L.tileLayer.wms('https://integracja.gugik.gov.pl/cgi-bin/KrajowaIntegracjaEwidencjiGruntow', {
    layers: 'dzialki,numery_dzialek', format: 'image/png', transparent: true, tileSize: 512, maxZoom: 21, minZoom: 14, crossOrigin: true, attribution: 'Działki © GUGiK',
  });
  (baseLayers[settings.layer] || baseLayers.orto).addTo(map);
  Layers.attach(map);
  if (settings.parcels) parcelsLayer.addTo(map);
  updateLayerBtns();
  treeLayer = L.layerGroup().addTo(map);
  map.on('zoomend', () => map.getContainer().classList.toggle('no-lbl', map.getZoom() < 17));
  map.on('click', (e) => { if (picking && pickMarker) pickMarker.setLatLng(e.latlng); });
  map.getContainer().addEventListener('click', (e) => {
    const b = e.target.closest('.pop-edit');
    if (b) { map.closePopup(); editTree(b.dataset.id, 'map'); }
  });
  const pts = trees.filter((t) => t.loc).map((t) => [t.loc.lat, t.loc.lon]);
  if (pts.length) map.fitBounds(pts, { maxZoom: 18, padding: [30, 30] });
  else if (gps) map.setView([gps.lat, gps.lon], 18);
  else map.setView([52.1, 19.4], 6);
  map.getContainer().classList.toggle('no-lbl', map.getZoom() < 17);
  updateMe();
}
function updateLayerBtns() {
  $('#mapLayerBtn').textContent = settings.layer === 'orto' ? 'Mapa OSM' : 'Ortofoto';
  $('#mapParcelsBtn').classList.toggle('on', settings.parcels);
}
function refreshMarkers() {
  if (!treeLayer) return;
  treeLayer.clearLayers();
  for (const t of trees) {
    if (!t.loc) continue;
    if (editing && t.id === cur.id && picking) continue;
    const m = L.circleMarker([t.loc.lat, t.loc.lon], {
      radius: t.typ === 'drzewo' ? 7 : 6, color: '#fff', weight: 2, fillOpacity: 1,
      fillColor: DEC_COLORS[t.decyzja] || '#ff6a13',
    });
    m.bindTooltip(t.nr || '?', { permanent: true, direction: 'right', offset: [6, 0], className: 'tree-lbl' });
    const pop = document.createElement('div');
    const h = document.createElement('b'); h.textContent = `${t.nr || '(bez nr)'} · ${t.sp || 'gatunek?'}`;
    const s = document.createElement('div');
    const c = t.c130.length ? t.c130.join(' + ') + ' cm' : '';
    s.textContent = [c, t.h != null ? fmt(t.h) + ' m' : '', t.decyzja].filter(Boolean).join(' · ');
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn pop-edit'; btn.dataset.id = t.id; btn.textContent = 'Edytuj';
    pop.append(h, s, btn);
    m.bindPopup(pop);
    m.addTo(treeLayer);
  }
}
function updateMe() {
  if (!map || !gps) return;
  const ll = [gps.lat, gps.lon];
  if (!meMarker) {
    meAcc = L.circle(ll, { radius: gps.acc, color: '#2a62a8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, keyboard: false }).addTo(map);
  } else { meMarker.setLatLng(ll); meAcc.setLatLng(ll).setRadius(gps.acc); }
}
function enterPick() {
  showView('map');
  picking = true;
  $('#pickBar').hidden = false;
  $('#pickNr').textContent = cur.nr || '';
  const ll = cur.loc ? [cur.loc.lat, cur.loc.lon] : gps ? [gps.lat, gps.lon] : map.getCenter();
  pickMarker = L.marker(ll, { draggable: true, autoPan: true, icon: L.divIcon({ className: '', html: '<div class="pick-pin"></div>', iconSize: [0, 0] }) }).addTo(map);
  map.setView(ll, Math.max(map.getZoom(), 19));
  refreshMarkers();
}
function exitPick(ok) {
  if (ok && pickMarker) {
    const p = pickMarker.getLatLng();
    cur.loc = { lat: p.lat, lon: p.lng, acc: null, src: 'manual' };
    cur.locMode = 'fixed';
    saveDraft();
    toast('Położenie poprawione');
  }
  if (pickMarker) { pickMarker.remove(); pickMarker = null; }
  picking = false;
  $('#pickBar').hidden = true;
  refreshMarkers();
  showView('form');
  renderLoc();
}

/* ============================ lista ============================ */
function renderList() {
  const q = norm($('#listSearch').value);
  const rows = trees
    .filter((t) => !q || norm([t.nr, t.sp, t.spLat, t.uwagi, t.decyzja].join(' ')).includes(q))
    .sort((a, b) => collator.compare(a.nr || '', b.nr || ''));
  const body = $('#listBody');
  body.textContent = '';
  const tagCls = { 'do wycinki': 'd-wyc', 'do zachowania': 'd-zach', 'do przesadzenia': 'd-prz', 'do weryfikacji': 'd-wer' };
  for (const t of rows) {
    const tr = document.createElement('tr');
    const td = (cls, txt) => { const c = document.createElement('td'); if (cls) c.className = cls; if (txt != null) c.textContent = txt; tr.append(c); return c; };
    td('nr', t.nr || '—');
    const sp = td('sp', t.sp || '—');
    const i = document.createElement('i'); i.textContent = t.typ !== 'drzewo' ? (t.typ === 'krzew' ? 'krzew' : 'skupina krzewów') + (t.area != null ? `, ${fmt(t.area, 0)} m²` : '') : (t.spLat || '');
    sp.append(i);
    td('n', t.c130.length ? t.c130.join('+') : '');
    td('n', t.h != null ? fmt(t.h) : '');
    const st = td('', t.stan || '');
    if (t.decyzja) { const g = document.createElement('span'); g.className = 'tag ' + (tagCls[t.decyzja] || ''); g.textContent = { 'do wycinki': 'wycinka', 'do zachowania': 'zachować', 'do przesadzenia': 'przesadzić', 'do weryfikacji': 'sprawdzić' }[t.decyzja] || t.decyzja; st.append(document.createElement('br'), g); }
    tr.addEventListener('click', () => editTree(t.id, 'list'));
    body.append(tr);
  }
  $('#listEmpty').hidden = trees.length > 0;
  const nT = trees.filter((t) => t.typ === 'drzewo').length;
  const nK = trees.length - nT;
  const nW = trees.filter((t) => t.decyzja === 'do wycinki').length;
  const nL = trees.filter((t) => !t.loc).length;
  const nP = trees.reduce((a, t) => a + t.photos.length, 0);
  const sum = $('#summary');
  sum.textContent = '';
  [[`drzewa: ${nT}`], [`krzewy: ${nK}`], [`do wycinki: ${nW}`], [`zdjęcia: ${nP}`], nL ? [`bez lokalizacji: ${nL}`] : null]
    .filter(Boolean).forEach(([s]) => { const e = document.createElement('span'); e.textContent = s; sum.append(e); });
}
function updateCount() { $('#listCount').textContent = trees.length || ''; }

/* ============================ projekty i ustawienia ============================ */
async function renderMore() {
  const projects = (await DB.all('projects')).sort((a, b) => b.created - a.created);
  const all = await DB.all('trees');
  const box = $('#projList');
  box.textContent = '';
  for (const p of projects) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'proj-item' + (p.id === project.id ? ' on' : '');
    const n = document.createElement('span'); n.textContent = p.name;
    const c = document.createElement('small'); c.textContent = `${all.filter((t) => t.projectId === p.id).length} poz.`;
    b.append(n, c);
    b.addEventListener('click', () => switchProject(p.id));
    box.append(b);
  }
  setSeg('#setNumMode', project.numMode || 'auto');
  $('#setPrefix').value = project.prefix || '';
  $('#setNext').value = project.nextNr;
  $('#setSliders').checked = settings.sliders;
  $('#setStickyStan').checked = settings.stickyStan;
  $('#setWake').checked = settings.wake;
  $('#setEye').value = settings.eye;
  try {
    const est = await navigator.storage?.estimate?.();
    const pers = await navigator.storage?.persisted?.();
    $('#storageInfo').textContent = est ? `Zajęte: ${(est.usage / 1048576).toFixed(1)} MB. ${pers ? 'Pamięć trwała włączona.' : 'Przeglądarka może usunąć dane przy braku miejsca. Zainstaluj aplikację na ekranie głównym.'}` : '';
  } catch { /* brak API */ }
}
async function switchProject(id) {
  if (id === project.id) return;
  if (editing) { toast('Najpierw zapisz albo anuluj edycję'); return; }
  if (hasContent(cur) && !confirm('Niezapisany pomiar w formularzu zostanie odrzucony. Przełączyć projekt?')) return;
  for (const pid of cur.photos) await DB.del('photos', pid);
  project = await DB.get('projects', id);
  settings.currentProject = id;
  trees = await DB.byIndex('trees', 'projectId', id);
  cur = blankTree({ typ: 'drzewo' });
  settings.draft = cur; saveSettings();
  $('#projName').textContent = project.name;
  renderForm(); updateCount(); renderMore(); Layers.load();
  if (map) { refreshMarkers(); const pts = trees.filter((t) => t.loc).map((t) => [t.loc.lat, t.loc.lon]); if (pts.length) map.fitBounds(pts, { maxZoom: 18 }); }
  toast(`Projekt: ${project.name}`);
}
async function newProject() {
  const name = prompt('Nazwa nowego projektu (np. FW Wielkie Pole – zieleń przy drodze):', '');
  if (!name || !name.trim()) return;
  const p = { id: uid(), name: name.trim(), prefix: project?.prefix || '', nextNr: 1, numMode: project?.numMode || 'auto', created: Date.now() };
  await DB.put('projects', p);
  await switchProject(p.id);
}
async function renameProject() {
  const name = prompt('Nowa nazwa projektu:', project.name);
  if (!name || !name.trim()) return;
  project.name = name.trim();
  await DB.put('projects', project);
  $('#projName').textContent = project.name;
  renderMore();
}
async function deleteProject() {
  if (!confirm(`Usunąć projekt „${project.name}” razem z ${trees.length} pomiarami i zdjęciami? Tego nie da się cofnąć. Zrób wcześniej eksport ZIP.`)) return;
  for (const t of trees) for (const pid of t.photos) await DB.del('photos', pid);
  for (const pid of cur.photos) await DB.del('photos', pid);
  for (const t of trees) await DB.del('trees', t.id);
  for (const l of await DB.byIndex('layers', 'projectId', project.id)) await DB.del('layers', l.id);
  await DB.del('projects', project.id);
  let projects = await DB.all('projects');
  if (!projects.length) {
    const p = { id: uid(), name: 'Projekt 1', prefix: '', nextNr: 1, numMode: 'auto', created: Date.now() };
    await DB.put('projects', p); projects = [p];
  }
  project = { id: '__deleted__' };
  cur = blankTree(null); cur.photos = [];
  await switchProject(projects.sort((a, b) => b.created - a.created)[0].id);
}

/* ============================ eksport ============================ */
const safeName = (s) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'projekt';
const today = () => new Date().toISOString().slice(0, 10);
const plNum = (n, d = 2) => (n == null ? '' : String(round(n, d)).replace('.', ','));
const sortedTrees = () => [...trees].sort((a, b) => collator.compare(a.nr || '', b.nr || ''));
const TYP_LABEL = { drzewo: 'drzewo', krzew: 'krzew', skupina: 'skupina krzewów' };

function photoNames(t) { const base = safeName(t.nr || t.id.slice(0, 6)); return t.photos.map((_, i) => `${base}_${i + 1}.jpg`); }

function treeRecord(t) {
  const th = thresholdInfo(t);
  const p92 = t.loc ? toPUWG92(t.loc.lat, t.loc.lon) : null;
  return {
    nr: t.nr || '', typ: TYP_LABEL[t.typ] || t.typ, gatunek: t.sp || '', gatunek_lac: t.spLat || '',
    obw130: t.c130.join(' + '), piersn: t.c130.map((c) => Math.round(c / Math.PI)).join(' + '),
    obw5: t.c5.join(' + '), prog83f: th ? (th.kind === 'c5' ? `${th.limit} cm` : '25 m²') : '',
    ponad_prog: th ? (th.over ? 'tak' : 'nie') : '',
    wys_m: t.h, korona_m: t.crown, pow_m2: t.area, stan: t.stan || '', cechy: t.cechy.join(', '),
    przezn: t.decyzja || '', uwagi: t.uwagi || '',
    x2180: p92 ? round(p92.x, 2) : null, y2180: p92 ? round(p92.y, 2) : null,
    dokl_m: t.loc?.acc != null ? Math.round(t.loc.acc) : null,
    zrodlo: t.loc ? ({ gps: 'GPS', avg: `GPS uśredniony (${t.loc.n || '?'})`, manual: 'ręcznie na mapie' }[t.loc.src] || t.loc.src) : '',
    zdjecia: photoNames(t).join(', '),
    foto1: t.photos.length ? 'zdjecia/' + photoNames(t)[0] : '',
    data: new Date(t.created).toLocaleString('pl-PL'),
    lat: t.loc ? round(t.loc.lat, 7) : null, lon: t.loc ? round(t.loc.lon, 7) : null,
  };
}
const CSV_COLS = [
  ['nr', 'Nr'], ['typ', 'Typ'], ['gatunek', 'Gatunek'], ['gatunek_lac', 'Gatunek (łac.)'],
  ['obw130', 'Obwód na 130 cm [cm]'], ['piersn', 'Pierśnica [cm]'], ['obw5', 'Obwód na 5 cm [cm]'],
  ['prog83f', 'Próg art. 83f'], ['ponad_prog', 'Powyżej progu'], ['wys_m', 'Wysokość [m]'],
  ['korona_m', 'Średnica korony [m]'], ['pow_m2', 'Pow. krzewów [m²]'], ['stan', 'Stan'], ['cechy', 'Cechy'],
  ['przezn', 'Przeznaczenie'], ['uwagi', 'Uwagi'],
  ['x2180', 'X EPSG:2180 (północ) [m]'], ['y2180', 'Y EPSG:2180 (wschód) [m]'], ['dokl_m', 'Dokładność [m]'], ['zrodlo', 'Źródło położenia'],
  ['zdjecia', 'Zdjęcia'], ['data', 'Data pomiaru'], ['lat', 'Szer. WGS84 (pomocniczo)'], ['lon', 'Dł. WGS84 (pomocniczo)'],
];
function buildCSV() {
  const cell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? plNum(v, 7) : String(v);
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [CSV_COLS.map((c) => c[1]).join(';')];
  for (const t of sortedTrees()) { const r = treeRecord(t); lines.push(CSV_COLS.map(([k]) => cell(r[k])).join(';')); }
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}
// GeoJSON w PUWG 1992 (EPSG:2180) – QGIS odczytuje układ z pola "crs".
// Geometria w kolejności GIS: [wschód (Y geod.), północ (X geod.)].
function buildGeoJSON() {
  const fc = {
    type: 'FeatureCollection', name: safeName(project.name),
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::2180' } },
    features: sortedTrees().map((t) => {
      const props = treeRecord(t);
      delete props.lat; delete props.lon;
      return {
        type: 'Feature',
        geometry: props.x2180 != null ? { type: 'Point', coordinates: [props.y2180, props.x2180] } : null,
        properties: props,
      };
    }),
  };
  return new Blob([JSON.stringify(fc, null, 1)], { type: 'application/geo+json' });
}
async function buildZip() {
  const zip = new JSZip();
  const base = safeName(project.name);
  zip.file(`${base}.csv`, buildCSV());
  zip.file(`${base}.geojson`, buildGeoJSON());
  const backup = { format: 'dendroteren-backup', version: 1, app: APP_VERSION, exported: new Date().toISOString(), project, trees: sortedTrees(), photos: [] };
  for (const t of sortedTrees()) {
    const names = photoNames(t);
    for (let i = 0; i < t.photos.length; i++) {
      const ph = await DB.get('photos', t.photos[i]);
      if (!ph) continue;
      zip.file(`zdjecia/${names[i]}`, ph.data);
      backup.photos.push({ id: ph.id, treeId: t.id, file: `zdjecia/${names[i]}` });
    }
  }
  zip.file('kopia_dendroteren.json', JSON.stringify(backup));
  return zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' });
}
let readyFile = null;
async function exportAs(kind) {
  if (!trees.length) { toast('Projekt nie ma jeszcze pomiarów'); return; }
  toast('Przygotowuję plik…', 4000);
  const base = `${safeName(project.name)}_${today()}`;
  const blob = kind === 'zip' ? await buildZip() : kind === 'csv' ? buildCSV() : buildGeoJSON();
  const name = `${base}.${kind === 'geo' ? 'geojson' : kind}`;
  readyFile = new File([blob], name, { type: blob.type });
  $('#expReadyName').textContent = `${name} (${(blob.size / 1048576).toFixed(1)} MB)`;
  $('#expReady').hidden = false;
  $('#expShare').hidden = !(navigator.canShare && navigator.canShare({ files: [readyFile] }));
  $('#toast').hidden = true;
  $('#expReady').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function shareReady() {
  if (!readyFile) return;
  try { await navigator.share({ files: [readyFile], title: readyFile.name }); }
  catch (e) { if (e.name !== 'AbortError') toast('Nie udało się udostępnić. Użyj „Zapisz plik”.'); }
}
function downloadReady() {
  if (!readyFile) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(readyFile); a.download = readyFile.name;
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}
async function importZip(file) {
  try {
    const zip = await JSZip.loadAsync(file);
    const f = zip.file('kopia_dendroteren.json');
    if (!f) { toast('To nie jest kopia z DendroTeren (brak pliku kopia_dendroteren.json)', 4000); return; }
    const bk = JSON.parse(await f.async('string'));
    const projects = await DB.all('projects');
    const p = { ...bk.project, id: uid(), created: Date.now() };
    if (projects.some((x) => x.name === p.name)) p.name += ' (wczytany)';
    await DB.put('projects', p);
    const idMap = new Map();
    for (const t of bk.trees) idMap.set(t.id, uid());
    const phMap = new Map();
    for (const ph of bk.photos) {
      const zf = zip.file(ph.file);
      if (!zf) continue;
      const nid = uid();
      phMap.set(ph.id, nid);
      await DB.put('photos', { id: nid, treeId: idMap.get(ph.treeId), type: 'image/jpeg', data: await zf.async('arraybuffer'), created: Date.now() });
    }
    for (const t of bk.trees) {
      await DB.put('trees', { ...t, id: idMap.get(t.id), projectId: p.id, photos: t.photos.map((x) => phMap.get(x)).filter(Boolean) });
    }
    toast(`Wczytano ${bk.trees.length} pomiarów`);
    await switchProject(p.id);
  } catch (e) {
    console.error(e);
    toast('Nie udało się wczytać pliku ZIP', 4000);
  }
}

/* ============================ klinometr (wysokość) ============================ */
const clino = { active: false, stream: null, buf: [], angle: null, base: null, top: null, mode: 'dist', gotEvent: false, raf: 0 };
function onOrientation(e) {
  if (e.beta == null) return;
  if (!clino.gotEvent) { clino.gotEvent = true; $('#clinoStart').hidden = true; renderClino(); }
  // kąt osi aparatu (tył telefonu) nad horyzontem: asin(−cosβ·cosγ)
  const v = -Math.cos(e.beta * DEG) * Math.cos((e.gamma || 0) * DEG);
  const a = Math.asin(Math.max(-1, Math.min(1, v))) / DEG;
  clino.buf.push(a);
  if (clino.buf.length > 12) clino.buf.shift();
  clino.angle = clino.buf.reduce((s, x) => s + x, 0) / clino.buf.length;
  if (!clino.raf) clino.raf = requestAnimationFrame(() => { clino.raf = 0; $('#clinoAngle').textContent = fmt(clino.angle, 1); });
}
async function openClino() {
  if (cur.locMode === 'live' && gps) {
    cur.loc = { lat: gps.lat, lon: gps.lon, acc: gps.acc, src: 'gps' };
    cur.locMode = 'fixed'; renderLoc(); saveDraft();
    toast('Położenie drzewa zatwierdzone przed odejściem na pomiar');
  }
  clino.base = null; clino.top = null; clino.buf = []; clino.angle = null; clino.gotEvent = false;
  $('#clino').hidden = false;
  $('#clinoEyeVal').textContent = fmt(settings.eye, 2);
  if (!$('#clinoDist').value) { $('#clinoDist').value = 15; $('#clinoDistR').value = 15; }
  fillSliders($('#clino'));
  renderClino();
  await startClinoSensors();
}
async function startClinoSensors() {
  // iOS: zgoda na czujnik musi być wywołana bezpośrednio z dotknięcia
  let denied = false;
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { denied = (await DeviceOrientationEvent.requestPermission()) !== 'granted'; } catch { denied = true; }
  }
  // nasłuchujemy zawsze – część przeglądarek podaje odczyty mimo braku jawnej zgody
  window.removeEventListener('deviceorientation', onOrientation);
  window.addEventListener('deviceorientation', onOrientation);
  clino.active = true;
  $('#clinoStart').hidden = true;
  setTimeout(() => {
    if (!clino.active || clino.gotEvent) return;
    if (denied) { $('#clinoRes').textContent = 'Brak zgody na czujnik ruchu. Stuknij przycisk poniżej i wybierz „Zezwól”.'; $('#clinoStart').hidden = false; }
    else $('#clinoRes').textContent = 'To urządzenie nie podaje nachylenia. Wpisz wysokość ręcznie.';
  }, 1500);
  try {
    clino.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    $('#clinoVideo').srcObject = clino.stream;
  } catch { /* bez podglądu: celuje się krawędzią telefonu */ }
}
function closeClino() {
  window.removeEventListener('deviceorientation', onOrientation);
  clino.active = false;
  clino.stream?.getTracks().forEach((t) => t.stop());
  clino.stream = null;
  $('#clinoVideo').srcObject = null;
  $('#clino').hidden = true;
}
function clinoResult() {
  const { base, top } = clino;
  if (base == null || top == null) return null;
  if (top <= base) return { err: 'Wierzchołek musi być wyżej niż podstawa. Zmierz ponownie.' };
  if (clino.mode === 'dist') {
    const D = num($('#clinoDist').value);
    if (!D) return { err: 'Podaj odległość od pnia.' };
    return { h: D * (Math.tan(top * DEG) - Math.tan(base * DEG)), d: D };
  }
  if (base > -1) return { err: 'W trybie „z wysokości oczu” podstawa musi być poniżej poziomu oczu.' };
  const D = settings.eye / Math.tan(-base * DEG);
  return { h: D * (Math.tan(top * DEG) - Math.tan(base * DEG)), d: D };
}
function renderClino() {
  setSeg('#clinoMode', clino.mode);
  $('#clinoDistRow').hidden = clino.mode !== 'dist';
  $('#clinoEyeRow').hidden = clino.mode !== 'eye';
  $('#clinoBaseV').textContent = clino.base == null ? '—' : fmt(clino.base, 1) + '°';
  $('#clinoTopV').textContent = clino.top == null ? '—' : fmt(clino.top, 1) + '°';
  $('#clinoBase').classList.toggle('set', clino.base != null);
  $('#clinoTop').classList.toggle('set', clino.top != null);
  const r = clinoResult();
  const box = $('#clinoRes');
  $('#clinoUse').disabled = !(r && r.h > 0);
  if (!r) {
    box.textContent = clino.base == null && clino.top == null
      ? (clino.gotEvent || !clino.active ? 'Wyceluj krzyżykiem w podstawę pnia i stuknij 1, potem w wierzchołek i stuknij 2.' : box.textContent)
      : clino.base == null ? 'Teraz wyceluj w podstawę i stuknij 1.' : 'Teraz wyceluj w wierzchołek i stuknij 2.';
    return;
  }
  if (r.err) { box.textContent = r.err; return; }
  box.textContent = '';
  const b = document.createElement('b'); b.textContent = `${fmt(r.h, 1)} m`;
  box.append('Wysokość ', b, clino.mode === 'eye' ? ` · odległość ≈ ${fmt(r.d, 1)} m` : '');
}
function captureAngle(which) {
  if (clino.angle == null) { toast('Brak odczytu z czujnika'); return; }
  clino[which] = clino.angle;
  navigator.vibrate?.(30);
  renderClino();
}

/* ============================ wake lock, instalacja, SW ============================ */
let wakeLock = null;
async function applyWake() {
  try {
    if (settings.wake && document.visibilityState === 'visible' && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!settings.wake && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* brak zgody */ }
}
let deferredInstall = null;
function setupInstallHint() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || settings.hintClosed) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) {
    $('#installHintTxt').textContent = 'Zainstaluj: przycisk Udostępnij → „Do ekranu początkowego”. Wtedy aplikacja działa bez internetu i nie traci danych.';
    $('#installHint').hidden = false;
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredInstall = e;
    $('#installHintTxt').textContent = 'Zainstaluj aplikację na telefonie, aby działała bez internetu.';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-primary'; b.textContent = 'Zainstaluj';
    b.addEventListener('click', async () => { deferredInstall.prompt(); await deferredInstall.userChoice; $('#installHint').hidden = true; });
    $('#installHintTxt').after(b);
    $('#installHint').hidden = false;
  });
}
function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Jest nowa wersja aplikacji. Zamknij ją i otwórz ponownie.', 6000);
      });
    });
  }).catch(() => { /* bez trybu offline */ });
}
async function gcPhotos() {
  try {
    const all = await DB.all('trees');
    const ref = new Set(all.flatMap((t) => t.photos));
    for (const id of [...(cur?.photos || []), ...(settings.stash?.photos || []), ...(settings.draft?.photos || [])]) ref.add(id);
    const tx = DB.st('photos');
    const keys = await idb(tx.getAllKeys());
    const hourAgo = Date.now() - 3600e3;
    for (const k of keys) {
      if (ref.has(k)) continue;
      const ph = await DB.get('photos', k);
      if (ph && ph.created < hourAgo) await DB.del('photos', k);
    }
  } catch { /* nieistotne */ }
}

/* ============================ zdarzenia ============================ */
function bindUI() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => { if (picking) exitPick(false); Layers.stopPlacement(false); showView(b.dataset.view); }));
  $('#projBtn').addEventListener('click', () => showView('more'));
  Layers.bind();

  // numer
  $('#fNr').addEventListener('input', () => { cur.nr = $('#fNr').value; checkDup(); saveDraft(); });
  $('#fNr').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#nrPlus').addEventListener('click', () => stepNr(1));
  $('#nrMinus').addEventListener('click', () => stepNr(-1));

  // typ
  $$('#fTyp button').forEach((b) => b.addEventListener('click', () => { cur.typ = b.dataset.v; renderForm(); saveDraft(); }));

  // gatunek
  const sp = $('#fSpecies');
  const spl = $('#speciesList');
  sp.addEventListener('input', () => showSpeciesList(sp.value));
  sp.addEventListener('focus', () => { sp.select(); showSpeciesList(sp.value === cur.sp ? '' : sp.value); });
  // lista zostaje otwarta przy przewijaniu; zamyka ją wybór, stuknięcie obok albo Esc
  sp.addEventListener('blur', () => { setTimeout(() => commitTypedSpecies(), 120); });
  // mousedown pojawia się tylko przy stuknięciu (nie przy przewijaniu) – nie zabieraj fokusu polu
  spl.addEventListener('mousedown', (e) => e.preventDefault());
  spl.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const s = spItems[+li.dataset.i];
    $$('#speciesList li.sel').forEach((l) => l.classList.remove('sel'));
    li.classList.add('sel');
    setTimeout(() => pickSpecies(s), 140); // krótkie podświetlenie wybranego gatunku
  });
  document.addEventListener('pointerdown', (e) => {
    if (!spl.hidden && !e.target.closest('.species')) hideSpeciesList();
  });
  $('#speciesBrowse').addEventListener('click', () => {
    if (!spl.hidden) { hideSpeciesList(); return; }
    showSpeciesList('');
  });
  sp.addEventListener('keydown', (e) => {
    const lis = $$('#speciesList li[data-i]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      spHl = Math.max(0, Math.min(lis.length - 1, spHl + (e.key === 'ArrowDown' ? 1 : -1)));
      lis.forEach((l, i) => l.classList.toggle('hl', i === spHl));
      lis[spHl]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (spHl >= 0 && spItems[spHl] && !spl.hidden) pickSpecies(spItems[spHl]); else { hideSpeciesList(); sp.blur(); }
    } else if (e.key === 'Escape') { hideSpeciesList(); }
  });
  $('#speciesClear').addEventListener('click', () => { sp.value = ''; cur.sp = ''; cur.spLat = ''; cur.p = null; renderForm(); sp.focus(); saveDraft(); });

  // lokalizacja
  $('#locFix').addEventListener('click', () => {
    if (!gps) return;
    cur.loc = { lat: gps.lat, lon: gps.lon, acc: gps.acc, src: 'gps' }; cur.locMode = 'fixed';
    renderLoc(); saveDraft(); toast('Położenie zatwierdzone');
  });
  $('#locAvg').addEventListener('click', averageGPS);
  $('#locMap').addEventListener('click', enterPick);
  $('#locLive').addEventListener('click', () => {
    cur.locMode = 'live';
    cur.loc = gps ? { lat: gps.lat, lon: gps.lon, acc: gps.acc, src: 'gps' } : null;
    renderLoc(); saveDraft();
  });

  // pnie
  $$('.add-stem').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.target;
    cur[k] = (cur[k].length ? cur[k] : [null]).concat([null]);
    renderStems(k);
    $(`#${k}_${cur[k].length - 1}`).focus();
    saveDraft();
  }));

  // wymiary + suwaki
  for (const [id, key] of [['fH', 'h'], ['fCrown', 'crown'], ['fArea', 'area']]) {
    const inp = $('#' + id), sl = $('#' + id + 'r');
    inp.addEventListener('input', () => { cur[key] = num(inp.value); sl.value = cur[key] ?? 0; fillSlider(sl); renderCalc(); saveDraft(); });
    sl.addEventListener('input', () => { inp.value = sl.value; cur[key] = +sl.value; renderCalc(); saveDraft(); });
  }

  // chipy
  $$('#fStan button').forEach((b) => b.addEventListener('click', () => { cur.stan = cur.stan === b.dataset.v ? '' : b.dataset.v; setChips('#fStan', [cur.stan]); saveDraft(); }));
  $$('#fDecyzja button').forEach((b) => b.addEventListener('click', () => { cur.decyzja = cur.decyzja === b.dataset.v ? '' : b.dataset.v; setChips('#fDecyzja', [cur.decyzja]); saveDraft(); }));
  $$('#fCechy button').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.v;
    cur.cechy = cur.cechy.includes(v) ? cur.cechy.filter((x) => x !== v) : [...cur.cechy, v];
    setChips('#fCechy', cur.cechy); saveDraft();
  }));
  $('#fUwagi').addEventListener('input', () => { cur.uwagi = $('#fUwagi').value; saveDraft(); });

  // zdjęcia
  for (const id of ['photoCam', 'photoGal']) $('#' + id).addEventListener('change', async (e) => { await addPhotos(e.target.files); e.target.value = ''; });
  $('#viewer').addEventListener('click', () => { $('#viewer').hidden = true; });

  // zapis
  $('#btnSave').addEventListener('click', saveTree);
  $('#btnClear').addEventListener('click', clearForm);
  $('#btnDelete').addEventListener('click', deleteTree);
  $('#cancelEdit').addEventListener('click', cancelEdit);

  // mapa
  $('#mapLayerBtn').addEventListener('click', () => {
    map.removeLayer(baseLayers[settings.layer]);
    settings.layer = settings.layer === 'orto' ? 'osm' : 'orto';
    baseLayers[settings.layer].addTo(map); baseLayers[settings.layer].bringToBack();
    updateLayerBtns(); saveSettings();
  });
  $('#mapParcelsBtn').addEventListener('click', () => {
    settings.parcels = !settings.parcels;
    if (settings.parcels) { parcelsLayer.addTo(map); if (map.getZoom() < 14) toast('Działki widać od większego przybliżenia'); } else map.removeLayer(parcelsLayer);
    updateLayerBtns(); saveSettings();
  });
  $('#mapMeBtn').addEventListener('click', () => { if (gps) map.setView([gps.lat, gps.lon], Math.max(map.getZoom(), 18)); else toast('Brak pozycji GPS'); });
  $('#pickOk').addEventListener('click', () => exitPick(true));
  $('#pickCancel').addEventListener('click', () => exitPick(false));

  // lista
  $('#listSearch').addEventListener('input', renderList);

  // projekt
  $('#projNew').addEventListener('click', newProject);
  $('#projRename').addEventListener('click', renameProject);
  $('#projDelete').addEventListener('click', deleteProject);
  $('#expZip').addEventListener('click', () => exportAs('zip'));
  $('#expCsv').addEventListener('click', () => exportAs('csv'));
  $('#expGeo').addEventListener('click', () => exportAs('geo'));
  $('#expShare').addEventListener('click', shareReady);
  $('#expDownload').addEventListener('click', downloadReady);
  $('#impFile').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importZip(f); });

  // ustawienia
  $$('#setNumMode button').forEach((b) => b.addEventListener('click', async () => {
    project.numMode = b.dataset.v; await DB.put('projects', project);
    setSeg('#setNumMode', project.numMode);
    if (!editing && !hasContent(cur)) { cur.nr = nextNrString(); renderForm(); }
  }));
  $('#setPrefix').addEventListener('change', async () => {
    const old = (project.prefix || '') + project.nextNr;
    project.prefix = $('#setPrefix').value.trim(); await DB.put('projects', project);
    if (!editing && cur.nr === old) { cur.nr = nextNrString(); renderForm(); }
  });
  $('#setNext').addEventListener('change', async () => {
    const n = parseInt($('#setNext').value, 10); if (!Number.isFinite(n)) return;
    const old = (project.prefix || '') + project.nextNr;
    project.nextNr = n; await DB.put('projects', project);
    if (!editing && (cur.nr === old || !cur.nr)) { cur.nr = nextNrString(); renderForm(); }
    toast(`Następny numer: ${nextNrString() || n}`);
  });
  $('#setSliders').addEventListener('change', (e) => { settings.sliders = e.target.checked; document.body.classList.toggle('sliders', settings.sliders); saveSettings(); });
  $('#setStickyStan').addEventListener('change', (e) => { settings.stickyStan = e.target.checked; saveSettings(); });
  $('#setWake').addEventListener('change', (e) => { settings.wake = e.target.checked; saveSettings(); applyWake(); });
  $('#setEye').addEventListener('change', (e) => { const v = num(e.target.value); if (v) { settings.eye = v; saveSettings(); } });
  $('#installHintClose').addEventListener('click', () => { $('#installHint').hidden = true; settings.hintClosed = true; saveSettings(); });

  // klinometr
  $('#openClino').addEventListener('click', openClino);
  $('#clinoClose').addEventListener('click', closeClino);
  $('#clinoStart').addEventListener('click', startClinoSensors);
  $$('#clinoMode button').forEach((b) => b.addEventListener('click', () => { clino.mode = b.dataset.v; renderClino(); }));
  $('#clinoDist').addEventListener('input', () => { $('#clinoDistR').value = num($('#clinoDist').value) ?? 0; fillSlider($('#clinoDistR')); renderClino(); });
  $('#clinoDistR').addEventListener('input', () => { $('#clinoDist').value = $('#clinoDistR').value; renderClino(); });
  $('#clinoBase').addEventListener('click', () => captureAngle('base'));
  $('#clinoTop').addEventListener('click', () => captureAngle('top'));
  $('#clinoUse').addEventListener('click', () => {
    const r = clinoResult();
    if (!r || !(r.h > 0)) return;
    cur.h = round(r.h, 1);
    setDim('fH', cur.h); saveDraft();
    closeClino();
    toast(`Wysokość ${fmt(cur.h)} m`);
  });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') applyWake(); else saveSettings(); });
}

/* ============================ start ============================ */
async function boot() {
  $('#appVer').textContent = APP_VERSION;
  document.body.classList.toggle('sliders', settings.sliders);
  try { await DB.open(); } catch (e) {
    document.body.textContent = 'Ta przeglądarka nie pozwala zapisywać danych (tryb prywatny?). Otwórz stronę w zwykłym oknie.';
    return;
  }
  let projects = await DB.all('projects');
  if (!projects.length) {
    const p = { id: uid(), name: 'Projekt 1', prefix: '', nextNr: 1, numMode: 'auto', created: Date.now() };
    await DB.put('projects', p); projects = [p];
  }
  project = projects.find((p) => p.id === settings.currentProject) || projects.sort((a, b) => b.created - a.created)[0];
  settings.currentProject = project.id;
  trees = await DB.byIndex('trees', 'projectId', project.id);
  if (settings.stash && settings.stash.projectId === project.id) { cur = settings.stash; settings.stash = null; }
  else if (settings.draft && settings.draft.projectId === project.id) cur = settings.draft;
  else cur = blankTree(null);
  saveSettings();
  $('#projName').textContent = project.name;
  bindUI();
  renderForm(); renderRecent(); updateCount();
  Layers.load();
  startGPS();
  setupInstallHint();
  registerSW();
  applyWake();
  navigator.storage?.persist?.().catch(() => {});
  setTimeout(gcPhotos, 5000);
}
boot();
