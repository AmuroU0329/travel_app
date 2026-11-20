/* TabiFlow offline runtime — keep this file beside index.html. */
const VERSION = 'tabiflow-v3';
const CORE = `${VERSION}-core`;
const STATIC = `${VERSION}-static`;
const WEATHER = `${VERSION}-weather`;
const GEO = `${VERSION}-geo`;
const TILES = `${VERSION}-tiles`;
const SCOPE_URL = self.registration.scope;
const APP_URL = new URL('./index.html', SCOPE_URL).href;
const CORE_FILES = [
  new URL('./index.html', SCOPE_URL).href,
  new URL('./manifest.webmanifest', SCOPE_URL).href,
  new URL('./icons/icon.svg', SCOPE_URL).href,
  new URL('./icons/icon-192.png', SCOPE_URL).href,
  new URL('./icons/icon-512.png', SCOPE_URL).href
];
const CDN_FILES = [
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE);
    await Promise.all(CORE_FILES.map(async url => {
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok) await core.put(url, response);
      } catch (_) { /* install can still succeed offline */ }
    }));
    const staticCache = await caches.open(STATIC);
    await Promise.all(CDN_FILES.map(async url => {
      try {
        const response = await fetch(url, { mode: 'no-cors', cache: 'reload' });
        if (response.ok || response.type === 'opaque') await staticCache.put(url, response);
      } catch (_) { /* CDN assets are opportunistic */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([CORE, STATIC, WEATHER, GEO, TILES]);
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('tabiflow-') && !keep.has(key)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function cacheFirst(request, cacheName, maxEntries = 250) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      await cache.put(request, response.clone());
      if (maxEntries) await trimCache(cacheName, maxEntries);
    }
    return response;
  } catch (error) {
    throw error;
  }
}

async function networkFirst(request, cacheName, fallbackUrl = null) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque')) await cache.put(request, response.clone());
    return response;
  } catch (_) {
    const cached = await cache.match(request) || (fallbackUrl ? await cache.match(fallbackUrl) : null);
    if (cached) return cached;
    throw new Error('offline');
  }
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    await Promise.all(keys.slice(0, keys.length - maxEntries).map(key => cache.delete(key)));
  }
}

function offlineTile() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#edf1ed"/><path d="M0 64H256M0 128H256M0 192H256M64 0V256M128 0V256M192 0V256" stroke="#d8e1da" stroke-width="1"/><text x="128" y="119" text-anchor="middle" fill="#60756b" font-family="sans-serif" font-size="13">オフライン</text><text x="128" y="140" text-anchor="middle" fill="#829188" font-family="sans-serif" font-size="10">表示済みの地図を利用</text></svg>`;
  return new Response(svg, { status: 200, headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Travel map: cache tiles already viewed; tiles never visited offline show a neutral placeholder.
  if (url.hostname === 'server.arcgisonline.com' && url.pathname.includes('/MapServer/tile/')) {
    event.respondWith((async () => {
      try { return await cacheFirst(request, TILES, 320); }
      catch (_) { return offlineTile(); }
    })());
    return;
  }

  if (url.hostname === 'api.open-meteo.com') {
    event.respondWith((async () => {
      try { return await networkFirst(request, WEATHER); }
      catch (_) { return new Response(JSON.stringify({ error: true, reason: 'offline; no cached forecast' }), { headers: { 'Content-Type': 'application/json' } }); }
    })());
    return;
  }

  if (url.hostname === 'nominatim.openstreetmap.org') {
    event.respondWith((async () => {
      try { return await networkFirst(request, GEO); }
      catch (_) { return new Response('[]', { headers: { 'Content-Type': 'application/json' } }); }
    })());
    return;
  }

  if (url.origin !== self.location.origin) {
    if (['script', 'style', 'font', 'image'].includes(request.destination) || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
      event.respondWith((async () => {
        try { return await cacheFirst(request, STATIC, 120); }
        catch (_) { const cached = await caches.match(request); if (cached) return cached; throw new Error('offline asset unavailable'); }
      })());
    }
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CORE);
          await cache.put(APP_URL, response.clone());
        }
        return response;
      } catch (_) {
        return (await caches.match(APP_URL)) || (await caches.match(new URL('./', SCOPE_URL).href)) || new Response('TabiFlowのオフラインデータがまだありません。オンラインで一度開いてください。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && url.origin === self.location.origin) {
        const cache = await caches.open(CORE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (_) {
      const fallback = await caches.match(request);
      if (fallback) return fallback;
      throw new Error('offline resource unavailable');
    }
  })());
});
