/* Azimo – service worker: powłoka aplikacji + kafelki/czcionki/ikony mapy do jazdy bez zasięgu */
const SHELL = 'azimo-shell-v13';
const TILES = 'azimo-tiles';
const SHELL_URLS = [
  './', 'index.html', 'app.js?v=38', 'style.css?v=25', 'manifest.webmanifest', '../assets/config.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css', 'https://unpkg.com/pmtiles@4.3.2/dist/pmtiles.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.allSettled(SHELL_URLS.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('azimo-shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const isTile = (u) => !/\.pmtiles(\?|$)/.test(u) && (/tiles\.openfreemap\.org\/(planet|fonts|sprites|styles)/.test(u) || /\.pbf(\?|$)/.test(u));
const isShell = (u) => SHELL_URLS.some((s) => u.endsWith(s.replace('./', '')) || u === s) || /\/gps\/(index\.html)?(\?.*)?$/.test(u);

self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = req.url;
  // mapa: najpierw cache (zapisane offline), potem sieć; sieć dokłada do cache
  if (isTile(u)) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req, { ignoreVary: true }); if (hit) return hit;
      try { const r = await fetch(req); if (r.ok && (/fonts|sprites|styles/.test(u))) c.put(req, r.clone()); return r; }
      catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }
  // powłoka: sieć, a bez sieci cache (ignorujemy ?v= przy dopasowaniu)
  if (isShell(u) || /\/gps\/.*\.(js|css|webmanifest|png|svg)(\?|$)/.test(u)) {
    e.respondWith(fetch(req).then((r) => { if (r.ok) caches.open(SHELL).then((c) => c.put(req, r.clone())); return r; })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) || (await caches.match('./')) || new Response('offline', { status: 503 })));
  }
});

// komunikaty z aplikacji: pobierz listę kafelków / sprawdź rozmiar / wyczyść
self.addEventListener('message', async (e) => {
  const d = e.data || {}; const port = e.ports && e.ports[0];
  const reply = (m) => port && port.postMessage(m);
  if (d.type === 'prefetch') {
    const c = await caches.open(TILES); let done = 0, fail = 0;
    const urls = d.urls || [];
    const worker = async () => {
      while (urls.length) {
        const u = urls.shift();
        try { if (!(await c.match(u))) { const r = await fetch(u); if (r.ok) await c.put(u, r); else fail++; } }
        catch (err) { fail++; }
        done++; if (done % 25 === 0) reply({ type: 'progress', done, fail });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    reply({ type: 'done', done, fail });
  } else if (d.type === 'size') {
    const c = await caches.open(TILES); const keys = await c.keys();
    reply({ type: 'size', count: keys.length });
  } else if (d.type === 'clear') {
    await caches.delete(TILES); reply({ type: 'cleared' });
  }
});
