// gdzieponiesie.pl – service worker (PWA)
// Strona działa offline z ostatnio wczytanymi plikami. Trasy, ceny i kolejki wymagają internetu (Worker), mapa – też.
const VERSION = 'gp-20261026h';           // podbij przy każdym wdrożeniu, razem z ?v= w index.html
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/assets/app.js', '/assets/style.css', '/assets/config.js',
  '/assets/dane/kraje.json', '/assets/dane/trasy-demo.json', '/assets/dane/lista.json', '/assets/dane/kraje-geo.json',
  '/icons/icon-192.png', '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // Worker, mapy, czcionki – zawsze z sieci
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.json')) {
    // strona i dane: najpierw sieć (świeże), bez sieci – kopia
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('/index.html'))));
    return;
  }
  // skrypty, style, ikony: dokładnie ta wersja (?v=) z pamięci, inaczej z sieci; bez sieci – dowolna zapisana wersja
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }))));
});
