// flo.monster Service Worker — plain JS (no Vite transform)
// Intercepts /api/* requests and injects auth headers or routes through hub.
// Also caches shell assets (cache-first with background revalidation)
// and checks for app updates.

const CONFIG_CACHE = 'flo-sw-config-v2';
const SHELL_CACHE = 'flo-shell-v1';
const CONFIG_KEY = '/sw-config.json';

// Per-provider API key storage
let apiKeys = {};

// Hub mode state
let hubMode = false;
let hubHttpUrl = '';
let hubToken = '';

// API base URL for hosted deployments (e.g., 'https://api.flo.monster')
// Set at build time or via configure_api_base message
var apiBaseUrl = '';

// Version checking state
const VERSION_CHECK_INTERVAL = 60 * 60 * 1000; // Hourly

// Persist config to Cache API (survives SW termination)
async function saveConfig() {
  try {
    const cache = await caches.open(CONFIG_CACHE);
    const config = { apiKeys, hubMode, hubHttpUrl, hubToken, apiBaseUrl };
    await cache.put(CONFIG_KEY, new Response(JSON.stringify(config)));
  } catch (err) {
    console.error('[SW] Failed to save config:', err);
  }
}

// Load config from Cache API
async function loadConfig() {
  try {
    const cache = await caches.open(CONFIG_CACHE);
    const response = await cache.match(CONFIG_KEY);
    if (response) {
      const config = await response.json();
      apiKeys = config.apiKeys || {};
      // Backwards compat: old cache may have single apiKey instead of apiKeys
      if (!config.apiKeys && config.apiKey) {
        apiKeys = { anthropic: config.apiKey };
      }
      hubMode = config.hubMode ?? false;
      hubHttpUrl = config.hubHttpUrl || '';
      hubToken = config.hubToken || '';
      // Restore apiBaseUrl from cache (runtime override takes priority over build-time)
      if (config.apiBaseUrl !== undefined) {
        apiBaseUrl = config.apiBaseUrl;
      }
      console.log('[SW] Loaded config from cache:', {
        providers: Object.keys(apiKeys).filter(k => !!apiKeys[k]),
        hubMode,
        hubHttpUrl,
        hasToken: !!hubToken,
        apiBaseUrl: apiBaseUrl || '(same-origin)',
      });
    }
  } catch (err) {
    console.error('[SW] Failed to load config:', err);
  }
}

// Load config on startup — track promise so fetch handler can wait
const configLoaded = loadConfig();

// Detect provider from the request URL path
function getProviderFromPath(pathname) {
  if (pathname.startsWith('/api/anthropic/')) return 'anthropic';
  if (pathname.startsWith('/api/openai/')) return 'openai';
  if (pathname.startsWith('/api/gemini/')) return 'gemini';
  if (pathname.startsWith('/api/ollama/')) return 'ollama';
  // Backwards compat: /api/v1/messages (without /anthropic/ prefix) defaults to anthropic
  return 'anthropic';
}

// Determine if a URL is a shell asset that should be cached
function isShellAsset(url) {
  // SW itself should not be cached by SW
  if (url.pathname === '/sw.js') return false;
  // Navigation requests (HTML)
  if (url.pathname === '/' || url.pathname === '/index.html') return true;
  // Hashed JS/CSS assets (production build)
  if (url.pathname.startsWith('/assets/')) return true;
  // Manifest, icons, favicon
  if (url.pathname === '/manifest.json') return true;
  if (url.pathname.startsWith('/icons/')) return true;
  if (url.pathname === '/favicon.ico') return true;
  // Skin assets (images, CSS)
  if (url.pathname.startsWith('/skins/')) return true;
  return false;
}

// Cache-first strategy with background revalidation (stale-while-revalidate).
// Users get instant cached responses; fresh content is fetched in background.
async function cacheFirstWithRevalidate(request) {
  // ignoreVary: cache.add() stores responses with SW-internal request headers,
  // but browser requests have different headers (Sec-Fetch-Dest, Accept-Encoding).
  // Without ignoreVary, Vary:Accept-Encoding causes match to fail.
  const cached = await caches.match(request, { ignoreVary: true });

  // Background revalidation — always try to update cache.
  // Clone MUST happen synchronously before returning the response,
  // otherwise the body gets consumed before the deferred clone runs.
  // Use cache: 'no-cache' to bypass browser HTTP cache — otherwise
  // max-age headers cause the "revalidation" to just read HTTP cache.
  const fetchPromise = fetch(request.url, { cache: 'no-cache' }).then(response => {
    if (response.status === 200) {
      const clone = response.clone();
      caches.open(SHELL_CACHE).then(cache => cache.put(request, clone));
    }
    return response;
  }).catch(() => null);  // Silently fail if offline

  // Serve cached immediately if available
  if (cached) return cached;

  // No cache — wait for network
  const response = await fetchPromise;
  if (response) return response;

  return new Response('Offline — cached version not available', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}

// Check for app updates by fetching /version.txt.
// Throttled to once per day (timestamp persisted in config cache).
// Notifies all clients if a new version is detected.
async function checkForUpdate() {
  const configCache = await caches.open(CONFIG_CACHE);

  // Throttle to once per day
  const lastCheckResp = await configCache.match('lastVersionCheck');
  if (lastCheckResp) {
    const ts = await lastCheckResp.text();
    if (Date.now() - Number(ts) < VERSION_CHECK_INTERVAL) return;
  }

  try {
    const response = await fetch('/version.txt', { cache: 'no-store' });
    if (!response.ok) return;
    const serverVersion = (await response.text()).trim();

    const currentResp = await configCache.match('currentVersion');
    const currentVersion = currentResp ? (await currentResp.text()).trim() : null;

    if (currentVersion && serverVersion !== currentVersion) {
      // Notify all clients
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.postMessage({
          type: 'update_available',
          version: serverVersion,
          currentVersion,
        });
      }
    }

    await configCache.put('currentVersion', new Response(serverVersion));
    await configCache.put('lastVersionCheck', new Response(String(Date.now())));
  } catch (e) {
    // Version check failed (offline) — silent, will retry next interval
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  // Only accept configuration messages from WindowClient (main page)
  if (event.source && 'type' in event.source && event.source.type !== 'window') {
    console.warn('[SW] Rejected message from non-window client');
    return;
  }

  switch (data.type) {
    case 'configure':
      // Legacy single-key mode (backwards compatible — sets Anthropic key)
      apiKeys.anthropic = data.apiKey || '';
      saveConfig();
      console.log('[SW] Configured with Anthropic API key');
      break;
    case 'update_key':
      // Legacy single-key mode
      apiKeys.anthropic = data.apiKey || '';
      saveConfig();
      console.log('[SW] Updated Anthropic API key');
      break;
    case 'configure_keys':
      // Multi-provider key configuration
      apiKeys = { ...data.keys };
      saveConfig();
      console.log('[SW] Configured provider keys:', Object.keys(apiKeys).filter(k => !!apiKeys[k]));
      break;
    case 'configure_hub':
      hubMode = data.enabled ?? false;
      if (data.httpUrl) {
        try {
          const parsed = new URL(data.httpUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            console.warn('[SW] Rejected hub URL with invalid protocol:', parsed.protocol);
            break;
          }
          hubHttpUrl = data.httpUrl;
        } catch (e) {
          console.warn('[SW] Rejected invalid hub URL');
          break;
        }
      } else {
        hubHttpUrl = '';
      }
      hubToken = data.token || '';
      saveConfig();
      console.log('[SW] Hub mode configured:', { hubMode, hubHttpUrl, hasToken: !!hubToken });
      break;
    case 'configure_api_base':
      apiBaseUrl = data.apiBaseUrl || '';
      saveConfig();
      console.log('[SW] API base URL configured:', apiBaseUrl || '(same-origin)');
      break;
    case 'check_update':
      checkForUpdate();
      break;
    case 'skip_waiting':
      self.skipWaiting();
      break;
    case 'cache_urls':
      // Warm cache with URLs already loaded by the page (first-install scenario).
      // The page's resources were fetched before the SW took control.
      if (Array.isArray(data.urls)) {
        event.waitUntil(
          caches.open(SHELL_CACHE).then(cache =>
            Promise.all(data.urls.map(url =>
              cache.match(url).then(existing => {
                if (existing) return; // Already cached
                return fetch(url).then(r => {
                  if (r.ok) return cache.put(url, r);
                }).catch(() => {}); // Ignore fetch failures
              })
            ))
          )
        );
      }
      break;
    case 'force_refresh':
      // Delete all caches EXCEPT CONFIG_CACHE (preserves API keys)
      event.waitUntil((async () => {
        const allKeys = await caches.keys();
        await Promise.all(
          allKeys.filter(k => k !== CONFIG_CACHE).map(k => caches.delete(k))
        );
        // Notify all clients
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
          client.postMessage({ type: 'caches_cleared' });
        }
      })());
      break;
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API requests — proxy with auth
  if (url.pathname.startsWith('/api/')) {
    console.log('[SW] Intercepting API request:', url.pathname, { hubMode, hubHttpUrl });
    event.respondWith(handleApiProxy(event.request));
    return;
  }

  // Shell assets — cache-first with background revalidation
  if (isShellAsset(url)) {
    event.respondWith(cacheFirstWithRevalidate(event.request));
    return;
  }

  // Piggyback version check on navigation requests
  if (event.request.mode === 'navigate') {
    checkForUpdate();
  }

  // Everything else — pass through to network
});

async function handleApiProxy(request) {
  // Ensure config is loaded before processing
  await configLoaded;

  const headers = new Headers(request.headers);
  const url = new URL(request.url);
  const provider = getProviderFromPath(url.pathname);

  // Read body first (before making decisions)
  const body = request.method !== 'GET' && request.method !== 'HEAD'
    ? await request.arrayBuffer()
    : undefined;

  // Hub mode routing — user explicitly chose to route through hub.
  // Takes priority over apiBaseUrl because the user's hub has shared API keys
  // and the hub injects them server-side.
  if (hubMode && hubHttpUrl) {
    // Route to hub HTTP endpoint
    const hubUrl = hubHttpUrl + url.pathname + url.search;
    headers.set('x-hub-token', hubToken);
    headers.set('x-api-provider', provider);
    // Only set anthropic-version for Anthropic provider
    if (provider === 'anthropic') {
      headers.set('anthropic-version', '2023-06-01');
    }

    try {
      const proxyRequest = new Request(hubUrl, {
        method: request.method,
        headers,
        body,
      });
      return await fetch(proxyRequest);
    } catch (err) {
      return new Response(JSON.stringify({
        error: 'Hub request failed',
        details: String(err)
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Not in hub mode — browser keys are required.
  // Check before making a request that will fail with an unhelpful 401.
  if (!apiKeys[provider]) {
    var providerNames = {
      anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini', ollama: 'Ollama',
    };
    var name = providerNames[provider] || provider;
    return new Response(
      'No ' + name + ' API key configured. Open Settings and add your API key, or connect to a hub with shared keys.',
      { status: 401, headers: { 'Content-Type': 'text/plain' } },
    );
  }

  // API base URL routing (hosted deployments like flo.monster).
  // Used when user has browser-side API keys (Modes 1 & 2).
  if (apiBaseUrl) {
    // Rewrite /api/anthropic/v1/messages → https://api.flo.monster/anthropic/v1/messages
    const externalUrl = apiBaseUrl + url.pathname.replace(/^\/api/, '') + url.search;

    // Inject provider-specific auth headers
    const key = apiKeys[provider];
    if (key) {
      if (provider === 'anthropic') {
        headers.set('x-api-key', key);
        headers.set('anthropic-version', '2023-06-01');
      } else if (provider === 'gemini') {
        headers.set('x-goog-api-key', key);
      } else {
        headers.set('Authorization', 'Bearer ' + key);
      }
    } else if (provider === 'anthropic') {
      headers.set('anthropic-version', '2023-06-01');
    }

    try {
      const proxyRequest = new Request(externalUrl, {
        method: request.method,
        headers,
        body,
      });
      return await fetch(proxyRequest);
    } catch (err) {
      return new Response(JSON.stringify({
        error: 'API proxy request failed',
        details: String(err)
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Local key mode — inject provider-specific auth headers.
  // The Vite dev proxy forwards /api/* to the CORS proxy server-side,
  // so no URL rewriting is needed here (avoids mixed content issues).
  const key = apiKeys[provider];
  if (key) {
    if (provider === 'anthropic') {
      headers.set('x-api-key', key);
      headers.set('anthropic-version', '2023-06-01');
    } else if (provider === 'gemini') {
      headers.set('x-goog-api-key', key);
    } else {
      headers.set('Authorization', `Bearer ${key}`);
    }
  } else if (provider === 'anthropic') {
    // Backwards compatibility: always set anthropic-version even without key
    headers.set('anthropic-version', '2023-06-01');
  }

  try {
    const proxyRequest = new Request(request.url, {
      method: request.method,
      headers,
      body,
    });
    return await fetch(proxyRequest);
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Proxy request failed',
      details: String(err)
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

self.addEventListener('install', (event) => {
  const PRECACHE_URLS = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/skins/flo-monster/assets/flo-dancing.mp4'];
  console.log('[SW] Installing — precaching ' + PRECACHE_URLS.length + ' URLs');
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache =>
      Promise.all(PRECACHE_URLS.map(url =>
        cache.add(url)
          .then(() => console.log('[SW] Cached: ' + url))
          .catch(err => console.warn('[SW] Pre-cache FAILED for ' + url + ':', err))
      ))
    )
  );
  // Do NOT call self.skipWaiting() here — updates should wait for user action
  // via the update banner. The 'skip_waiting' message handler is the user-initiated path.
});

self.addEventListener('activate', (event) => {
  const KEEP_CACHES = [CONFIG_CACHE, SHELL_CACHE];
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Clean up old caches
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => !KEEP_CACHES.includes(k)).map(k => caches.delete(k)))
      )
    ])
  );
});

// Push notification handler — show notification from hub push payload
self.addEventListener('push', (event) => {
  let data = { title: 'flo.monster', body: 'Agent update' };
  try {
    data = event.data?.json() ?? data;
  } catch (e) {
    // If payload isn't valid JSON, use defaults
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'flo.monster', {
      body: data.body ?? '',
      icon: '/icons/icon-192.png',
      tag: data.tag,
      data: { agentId: data.agentId },
    })
  );
});

// Notification click handler — focus existing window or open new one
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.postMessage({
          type: 'notification_click',
          agentId: event.notification.data?.agentId,
        });
      } else {
        self.clients.openWindow('/');
      }
    })
  );
});
