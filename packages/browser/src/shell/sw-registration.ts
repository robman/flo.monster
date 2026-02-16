/**
 * Ensure the service worker is registered, active, and controlling the page
 * Does not configure an API key - use this for hub mode
 */
export async function ensureServiceWorkerReady(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service Workers are not supported in this browser');
  }

  const registration = await navigator.serviceWorker.register('/sw.js', {
    scope: '/',
  });

  // Wait for an active SW to be ready
  await navigator.serviceWorker.ready;

  // Wait for the controller to be set (after clients.claim() in SW)
  // With a timeout to avoid hanging if something goes wrong
  if (!navigator.serviceWorker.controller) {
    await Promise.race([
      new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      }),
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('Timeout waiting for service worker controller')), 5000);
      }),
    ]);
  }

  // Warm the cache with resources already loaded by this page.
  // On first install, the page's JS/CSS bundles were fetched before the SW
  // took control, so they missed cacheFirstWithRevalidate. Tell the SW
  // to cache them now so offline works immediately.
  warmCacheWithLoadedResources();

  return registration;
}

/**
 * Tell the SW to cache all scripts, stylesheets, and the current page URL
 * that are already loaded in the document. Non-blocking background operation.
 */
function warmCacheWithLoadedResources(): void {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;

  const urls = new Set<string>();
  urls.add(window.location.href);

  for (const script of document.querySelectorAll('script[src]')) {
    urls.add((script as HTMLScriptElement).src);
  }
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    urls.add((link as HTMLLinkElement).href);
  }
  // modulepreload links (Vite production builds)
  for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
    urls.add((link as HTMLLinkElement).href);
  }

  controller.postMessage({ type: 'cache_urls', urls: [...urls] });
}

export async function registerServiceWorker(apiKey: string): Promise<ServiceWorkerRegistration> {
  const registration = await ensureServiceWorkerReady();

  // Helper: send configure to whatever SW is currently controlling this page
  function sendConfigure() {
    const controller = navigator.serviceWorker.controller;
    if (controller) {
      controller.postMessage({ type: 'configure', apiKey });
    }
  }

  // When a new SW takes over (skipWaiting + clients.claim), re-send the key
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    sendConfigure();
  });

  // If the page already has a controller, configure it now
  sendConfigure();

  return registration;
}

export async function updateServiceWorkerKey(apiKey: string): Promise<void> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    throw new Error('No active service worker controller');
  }
  controller.postMessage({ type: 'update_key', apiKey });
}

/**
 * Configure API keys for multiple providers.
 * Keys object maps provider name to API key string.
 * Example: { anthropic: 'sk-ant-...', openai: 'sk-...', gemini: 'AIza...' }
 */
export async function configureProviderKeys(
  keys: Record<string, string>,
): Promise<void> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    throw new Error('No active service worker controller');
  }
  controller.postMessage({ type: 'configure_keys', keys });
}

/**
 * Configure the service worker to route API requests through a hub
 * @param enabled - Whether hub mode is enabled
 * @param httpUrl - The hub HTTP API URL (e.g., 'http://localhost:8765')
 * @param token - The hub authentication token
 */
export async function configureHubMode(
  enabled: boolean,
  httpUrl?: string,
  token?: string,
): Promise<void> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    throw new Error('No active service worker controller');
  }
  controller.postMessage({ type: 'configure_hub', enabled, httpUrl, token });
}

/**
 * Configure the service worker to route API requests through an external base URL.
 * Used for hosted deployments where API requests go to a separate domain.
 * @param apiBaseUrl - The base URL (e.g., 'https://api.flo.monster'), or empty string for same-origin
 */
export function configureApiBaseUrl(apiBaseUrl: string): void {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    console.warn('[flo] Cannot configure API base URL: no active service worker controller');
    return;
  }
  controller.postMessage({ type: 'configure_api_base', apiBaseUrl });
}

/**
 * Listen for update_available messages from the service worker.
 * Shows a non-intrusive update banner when a new version is detected.
 */
export function setupUpdateListener(): void {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'update_available') return;
    showUpdateBanner(data.version);
  });
}

/**
 * Manually trigger a version check via the service worker.
 */
export function triggerVersionCheck(): void {
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    controller.postMessage({ type: 'check_update' });
  }
}

/**
 * Request the waiting service worker to skip waiting and activate immediately.
 * Used when applying an update — the new SW takes over on next navigation.
 * Must message the WAITING SW (not the active controller).
 */
export async function requestSkipWaiting(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration();
  const waiting = registration?.waiting;
  if (waiting) {
    waiting.postMessage({ type: 'skip_waiting' });
  } else {
    // No waiting SW — try the controller as fallback
    navigator.serviceWorker.controller?.postMessage({ type: 'skip_waiting' });
  }
}

/**
 * Request the service worker to clear all caches (except config) and reload.
 * The SW will respond with a `caches_cleared` message when done.
 */
export function requestForceRefresh(): void {
  navigator.serviceWorker.controller?.postMessage({ type: 'force_refresh' });
}

function showUpdateBanner(version: string): void {
  // Don't show duplicate banners
  if (document.getElementById('update-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner';

  const text = document.createElement('span');
  text.className = 'update-banner__text';
  text.textContent = `Update available (v${version})`;

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'update-banner__refresh btn btn--primary';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', () => {
    requestSkipWaiting();
    window.location.reload();
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'update-banner__dismiss';
  dismissBtn.textContent = '\u00d7';
  dismissBtn.setAttribute('aria-label', 'Dismiss');
  dismissBtn.addEventListener('click', () => {
    banner.remove();
  });

  banner.appendChild(text);
  banner.appendChild(refreshBtn);
  banner.appendChild(dismissBtn);
  document.body.appendChild(banner);
}
