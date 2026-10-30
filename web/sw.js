// Service worker: l'app si apre anche senza rete. Pagine e file del sito: prima la rete (così gli aggiornamenti arrivano), se manca si usa la copia salvata. Le API non si salvano mai.
const VERSIONE = 'cri-v1';
const BASE = ['/', '/index.html', '/stile.css', '/mobile.css', '/mobile.js', '/coda.js', '/offline.js', '/barra.js', '/layout.js', '/widget.js', '/comitati.js', '/logo-cri.jpg', '/manifest.webmanifest',
  '/fonti/atkinson-hyperlegible-latin-400-normal.woff2', '/fonti/atkinson-hyperlegible-latin-700-normal.woff2', '/fonti/barlow-semi-condensed-latin-600-normal.woff2', '/fonti/barlow-semi-condensed-latin-700-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSIONE).then((c) => Promise.all(BASE.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== VERSIONE).map((x) => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(r).then((resp) => { if (resp.ok) { const copia = resp.clone(); caches.open(VERSIONE).then((c) => c.put(r, copia)); } return resp; })
    .catch(() => caches.match(r, { ignoreSearch: true }).then((c) => c || (r.mode === 'navigate' ? caches.match('/index.html') : Response.error()))));
});
