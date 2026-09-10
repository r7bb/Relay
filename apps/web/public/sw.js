/**
 * Service worker: makes the app shell available with no network.
 *
 * Without this, "offline-first" was only half true. The board's *data* lives in
 * IndexedDB and survives a disconnection, but a cold page load still fetched
 * HTML and JavaScript from the dev server, so reloading while offline showed
 * the browser's error page and none of that data was reachable.
 *
 * Two strategies, chosen per request type:
 *
 * - **Navigations** are network-first with a cached fallback. The app changes
 *   between deploys, so a stale shell is worse than a slow one -- but a stale
 *   shell is far better than no page at all.
 * - **Static assets** are cache-first. Next.js fingerprints these filenames, so
 *   a given URL's contents never change and revalidating is wasted latency.
 *
 * API and WebSocket traffic is deliberately *not* cached. Those responses are
 * authorization-dependent and change constantly; serving a stale one could show
 * a user data they no longer have access to. The sync engine already owns
 * offline data.
 */

const VERSION = 'relay-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

/** Served when a navigation fails and nothing matching is cached. */
const OFFLINE_FALLBACK = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll([OFFLINE_FALLBACK]))
      // Replace the previous worker immediately rather than waiting for every
      // tab to close.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** True for requests that must never be served from cache. */
function isDynamic(url) {
  return (
    url.pathname.startsWith('/api/') ||
    // The API and gateway are separate origins in development.
    url.port === '4000' ||
    url.port === '4001'
  );
}

function isStaticAsset(url) {
  return url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/static/');
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);

  try {
    const response = await fetch(request);
    // Only cache successful, complete responses; a 404 or a redirect would be
    // a bad thing to replay offline.
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? (await cache.match(OFFLINE_FALLBACK));
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);

  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable; a mutation must always reach the server or fail
  // loudly so the sync queue can retry it.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isDynamic(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
});
