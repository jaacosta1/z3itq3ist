/**
 * sw.js — Perpetual Side-by-Side Web Diary Service Worker (File 3 of 11 · Phase 20 PWA)
 *
 * Caching & Privacy Architecture:
 * - App Shell (HTML, CSS, JS modules): Network-first with fast timeout fallback to cache,
 *   ensuring updates appear immediately when online while booting 100% offline.
 * - Static Same-Origin Data (`./data/*`): Network-first with offline cache fallback
 *   (automatically bypassed & purged whenever Shared-Computer Zero-Footprint Mode is active).
 * - Authenticated GitHub API & Cross-Origin Writes: Strictly pass-through (NEVER cached in
 *   CacheStorage so PAT headers, private vault blobs, and mutations never touch disk cache).
 * - Google Fonts: Cache-first with background refresh for offline editorial typography.
 */

const CACHE_VERSION = 'v20';
const SHELL_CACHE = `perpetual-shell-${CACHE_VERSION}`;
const DATA_CACHE = `perpetual-data-${CACHE_VERSION}`;
const FONT_CACHE = `perpetual-fonts-${CACHE_VERSION}`;
const VALID_CACHES = new Set([SHELL_CACHE, DATA_CACHE, FONT_CACHE]);

// Relative URLs work identically at domain root (/) and inside subfolders (/diary/)
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './manifest.webmanifest',
  './manifest.json',
  './js/app.js',
  './js/crypto.js',
  './js/kdf.js',
  './js/argon2-worker.js',
  './js/markdown.js',
  './js/github.js',
  './js/media.js',
  './js/media-vault.js',
  './js/media-sharding.js',
  './js/cloak.js',
  './js/vault-auth.js',
  './js/share.js',
  './js/conflict.js',
  './js/history.js',
  './js/features.js',
  './js/recovery.js',
];

// In-memory Zero-Footprint flag controlled by js/app.js via postMessage
let zeroFootprintEnabled = false;

/**
 * Fetches a request with an optional timeout so flaky/captive networks fall back
 * rapidly to the cached offline app shell instead of hanging indefinitely.
 * @param {Request | string} req
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(req, timeoutMs = 4500) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Network request timed out'));
      }
    }, timeoutMs);

    fetch(req)
      .then((res) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(res);
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
  });
}

/**
 * Strips cache-busting query params (`?t=...`, `?_t=...`) to produce a stable cache key
 * for offline reads of `./data/*` files.
 * @param {URL} urlObj
 * @returns {string}
 */
function stripCacheBusterKey(urlObj) {
  const clean = new URL(urlObj.href);
  clean.searchParams.delete('t');
  clean.searchParams.delete('_t');
  return clean.href;
}

/**
 * Safely checks whether a response is cacheable (HTTP 200 and non-opaque or allowed font).
 * @param {Response} response
 * @param {boolean} allowOpaque
 * @returns {boolean}
 */
function isCacheableResponse(response, allowOpaque = false) {
  if (!response) return false;
  if (response.type === 'opaque') return allowOpaque;
  return response.ok && response.status === 200;
}

/* ============================================================================
   INSTALL: Resilient App Shell Pre-Cache
   ============================================================================ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Cache each asset individually so optional files (e.g., manifest.json vs .webmanifest)
      // never abort the installation of the Service Worker.
      await Promise.allSettled(
        APP_SHELL_ASSETS.map(async (assetUrl) => {
          try {
            const req = new Request(assetUrl, { cache: 'reload' });
            const res = await fetch(req);
            if (isCacheableResponse(res)) {
              await cache.put(assetUrl, res.clone());
            }
          } catch {
            // Skip missing optional assets cleanly
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

/* ============================================================================
   ACTIVATE: Purge Legacy Version Caches & Claim Clients
   ============================================================================ */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('perpetual-') && !VALID_CACHES.has(key))
          .map((oldKey) => caches.delete(oldKey))
      );
      await self.clients.claim();
    })()
  );
});

/* ============================================================================
   MESSAGE CHANNEL: Zero-Footprint Control, Forced Cache Wipe & Update Trigger
   ============================================================================ */
self.addEventListener('message', (event) => {
  const payload = event.data || {};

  if (payload.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (payload.type === 'SET_ZERO_FOOTPRINT') {
    zeroFootprintEnabled = Boolean(payload.enabled);
    if (zeroFootprintEnabled) {
      event.waitUntil(
        caches.delete(DATA_CACHE).then(() => {
          if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({ ok: true, zeroFootprint: true });
          }
        })
      );
    } else if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ ok: true, zeroFootprint: false });
    }
    return;
  }

  if (payload.type === 'CLEAR_ALL_CACHES') {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => key.startsWith('perpetual-'))
            .map((key) => caches.delete(key))
        );
        if (event.ports && event.ports[0]) {
          event.ports[0].postMessage({ ok: true, cleared: true });
        }
      })()
    );
  }
});

/* ============================================================================
   FETCH ROUTER
   ============================================================================ */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 1. Only handle GET requests — all GitHub API writes (PUT/POST/PATCH/DELETE) pass straight through
  if (request.method !== 'GET') return;

  // 2. Never intercept requests carrying Authorization headers (GitHub PAT security boundary)
  if (request.headers && request.headers.has('Authorization')) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Ignore browser-extension and non-HTTP(S) schemes
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 3. Always pass GitHub API and weather/geocoding external APIs straight to network
  if (
    url.hostname === 'api.github.com' ||
    url.hostname.endsWith('.github.com') ||
    url.hostname === 'api.open-meteo.com' ||
    url.hostname === 'nominatim.openstreetmap.org'
  ) {
    return;
  }

  // 4. Google Fonts: Cache-first for offline editorial typography
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FONT_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const networkRes = await fetch(request);
          if (isCacheableResponse(networkRes, true)) {
            cache.put(request, networkRes.clone()).catch(() => {});
          }
          return networkRes;
        } catch {
          return new Response('', { status: 503, statusText: 'Offline' });
        }
      })()
    );
    return;
  }

  // Only cache same-origin resources beyond this point
  if (url.origin !== self.location.origin) return;

  // 5. Navigation requests (HTML document loads): Network-first -> cached ./index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        try {
          const fresh = await fetchWithTimeout(request, 4500);
          if (isCacheableResponse(fresh)) {
            cache.put('./index.html', fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          const cachedShell =
            (await cache.match('./index.html')) || (await cache.match('./'));
          if (cachedShell) return cachedShell;
          return new Response(
            '<!doctype html><title>Perpetual — Offline</title><body style="background:#0d0d0d;color:#eaeaea;font-family:system-ui,sans-serif;padding:2rem;"><h1>Perpetual Diary is Offline</h1><p>Reconnect briefly to load the app shell.</p></body>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        }
      })()
    );
    return;
  }

  // Compute path relative to SW scope so subfolder deployments (/diary/) work seamlessly
  const scopeUrl = new URL(self.registration.scope);
  const relPath = url.pathname.startsWith(scopeUrl.pathname)
    ? url.pathname.slice(scopeUrl.pathname.length)
    : url.pathname.replace(/^\/+/, '');

  // 6. Static Same-Origin Diary Data (`data/*`): Network-first, cached only if Zero-Footprint is OFF
  if (relPath.startsWith('data/')) {
    event.respondWith(
      (async () => {
        const cleanKey = stripCacheBusterKey(url);
        try {
          const fresh = await fetchWithTimeout(request, 5000);
          if (!zeroFootprintEnabled && isCacheableResponse(fresh)) {
            const dataCache = await caches.open(DATA_CACHE);
            dataCache.put(cleanKey, fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          if (!zeroFootprintEnabled) {
            const dataCache = await caches.open(DATA_CACHE);
            const cachedData = await dataCache.match(cleanKey);
            if (cachedData) return cachedData;
          }
          return new Response(
            JSON.stringify({ error: 'Offline and data file not cached locally.' }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }
          );
        }
      })()
    );
    return;
  }

  // 7. Same-Origin App Shell Assets (`css/*`, `js/*`, `manifest.*`): Network-first -> Shell Cache
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cleanKey = stripCacheBusterKey(url);
      try {
        const fresh = await fetchWithTimeout(request, 4500);
        if (isCacheableResponse(fresh)) {
          cache.put(cleanKey, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch {
        const cached = (await cache.match(cleanKey)) || (await cache.match(request));
        if (cached) return cached;
        return new Response('Offline resource unavailable', {
          status: 503,
          statusText: 'Offline',
        });
      }
    })()
  );
});
