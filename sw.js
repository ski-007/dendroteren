/* DendroTeren – service worker: aplikacja offline + pamięć podkładów mapowych. */
const VERSION = 'dendroteren-1.1.0';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'species.js', 'manifest.webmanifest',
  'layers.js', 'lib/leaflet.js', 'lib/leaflet.css', 'lib/jszip.min.js',
  'lib/proj4.js', 'lib/geotiff.js', 'lib/shp.js', 'lib/togeojson.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon.png',
];
const TILE_CACHE = 'dendroteren-tiles';
const TILE_HOSTS = ['tile.openstreetmap.org', 'mapy.geoportal.gov.pl', 'integracja.gugik.gov.pl', 'integracja02.gugik.gov.pl'];
const TILE_LIMIT = 6000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

let putCount = 0;
async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  if (keys.length > TILE_LIMIT) for (const k of keys.slice(0, keys.length - TILE_LIMIT)) await c.delete(k);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // podkłady mapowe: najpierw pamięć, potem sieć (zapis do pamięci)
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(TILE_CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'cors') {
          c.put(req, res.clone());
          if (++putCount % 200 === 0) trimTiles();
        }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // pliki aplikacji: pamięć, w tle odświeżenie z sieci
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const hit = await c.match(key, { ignoreSearch: true });
      const net = fetch(req).then((res) => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || new Response('Offline', { status: 503 });
    })());
  }
});
