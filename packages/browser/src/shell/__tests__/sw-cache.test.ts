/**
 * Tests for Service Worker cache strategies and message handlers.
 * Tests the cache-first-with-revalidate strategy, force_refresh, and skip_waiting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the SW logic by simulating the SW environment and importing the module.
// Since the SW uses global `self`, `caches`, `fetch`, etc., we mock those.

describe('sw.ts cache strategies and message handlers', () => {
  // Track registered event handlers
  let installHandler: ((event: any) => void) | null = null;
  let fetchHandler: ((event: any) => void) | null = null;
  let messageHandler: ((event: any) => void) | null = null;
  let activateHandler: ((event: any) => void) | null = null;

  // Mock cache storage
  let mockCacheStore: Map<string, Response>;
  let mockCacheNames: string[];
  let mockCache: {
    put: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    addAll: ReturnType<typeof vi.fn>;
    match: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  // Mock clients
  let mockClients: Array<{ postMessage: ReturnType<typeof vi.fn> }>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockCacheStore = new Map();
    mockCacheNames = ['flo-sw-config-v2', 'flo-shell-v1'];
    mockClients = [];

    mockCache = {
      put: vi.fn(async (req: Request, res: Response) => {
        mockCacheStore.set(typeof req === 'string' ? req : req.url, res);
      }),
      add: vi.fn(async () => {}),
      addAll: vi.fn(async () => {}),
      match: vi.fn(async (req: Request) => {
        return mockCacheStore.get(typeof req === 'string' ? req : req.url) || undefined;
      }),
      delete: vi.fn(async () => true),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    installHandler = null;
    fetchHandler = null;
    messageHandler = null;
    activateHandler = null;
  });

  /**
   * Helper: set up the SW global scope mocks and dynamically import sw.ts.
   */
  async function loadSW() {
    // Reset module registry so sw.ts can be re-imported fresh
    vi.resetModules();

    const addEventListener = vi.fn((type: string, handler: any) => {
      switch (type) {
        case 'install': installHandler = handler; break;
        case 'fetch': fetchHandler = handler; break;
        case 'message': messageHandler = handler; break;
        case 'activate': activateHandler = handler; break;
      }
    });

    const skipWaiting = vi.fn();

    const clientsMatchAll = vi.fn(async () => mockClients);
    const clientsClaim = vi.fn(async () => {});

    vi.stubGlobal('self', {
      addEventListener,
      skipWaiting,
      clients: {
        matchAll: clientsMatchAll,
        claim: clientsClaim,
      },
    });

    vi.stubGlobal('caches', {
      open: vi.fn(async () => mockCache),
      match: vi.fn(async (req: Request) => {
        return mockCacheStore.get(typeof req === 'string' ? req : req.url) || undefined;
      }),
      keys: vi.fn(async () => [...mockCacheNames]),
      delete: vi.fn(async (name: string) => {
        const idx = mockCacheNames.indexOf(name);
        if (idx >= 0) mockCacheNames.splice(idx, 1);
        return true;
      }),
    });

    vi.stubGlobal('fetch', vi.fn());

    // Import the SW module — this registers all event listeners.
    // Use a variable so TypeScript doesn't resolve the path — sw.ts uses
    // ServiceWorkerGlobalScope types that are incompatible with the DOM lib.
    const swModule = '../sw.js';
    await import(/* @vite-ignore */ swModule);

    return { addEventListener, skipWaiting, clientsMatchAll };
  }

  describe('cacheFirstWithRevalidate (via fetch handler)', () => {
    it('should serve cached response immediately when available', async () => {
      const { } = await loadSW();

      // Pre-populate cache with a response for /
      const cachedResponse = new Response('cached homepage', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
      mockCacheStore.set('https://example.com/', cachedResponse);

      // Also mock fetch to return a fresh response (for background revalidation)
      const freshResponse = new Response('fresh homepage', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(freshResponse);

      // Simulate a fetch event for a shell asset
      let respondedWith: Response | null = null;
      const fetchEvent = {
        request: new Request('https://example.com/'),
        respondWith: vi.fn((p: Promise<Response> | Response) => {
          if (p instanceof Promise) {
            p.then(r => { respondedWith = r; });
          } else {
            respondedWith = p;
          }
        }),
      };

      fetchHandler!(fetchEvent);

      // Wait for respondWith to be called
      await vi.waitFor(() => {
        expect(fetchEvent.respondWith).toHaveBeenCalled();
      });

      // Resolve the promise
      const result = await fetchEvent.respondWith.mock.calls[0][0];
      expect(result).toBeDefined();
      // The cached response should be served
      const text = await result.text();
      expect(text).toBe('cached homepage');
    });

    it('should fall back to network when no cache exists', async () => {
      await loadSW();

      const freshResponse = new Response('fresh asset', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(freshResponse.clone());

      const fetchEvent = {
        request: new Request('https://example.com/'),
        respondWith: vi.fn(),
      };

      fetchHandler!(fetchEvent);

      const result = await fetchEvent.respondWith.mock.calls[0][0];
      expect(result).toBeDefined();
      expect(result.status).toBe(200);
    });

    it('should return 503 when offline and no cache', async () => {
      await loadSW();

      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));

      const fetchEvent = {
        request: new Request('https://example.com/'),
        respondWith: vi.fn(),
      };

      fetchHandler!(fetchEvent);

      const result = await fetchEvent.respondWith.mock.calls[0][0];
      expect(result.status).toBe(503);
      const text = await result.text();
      expect(text).toContain('Offline');
    });

    it('should background revalidate cache even when serving from cache', async () => {
      await loadSW();

      // Put something in cache
      const cachedResponse = new Response('old', { status: 200 });
      mockCacheStore.set('https://example.com/assets/app.js', cachedResponse);

      const freshResponse = new Response('new', { status: 200 });
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(freshResponse);

      const fetchEvent = {
        request: new Request('https://example.com/assets/app.js'),
        respondWith: vi.fn(),
      };

      fetchHandler!(fetchEvent);

      // Should serve cached immediately
      const result = await fetchEvent.respondWith.mock.calls[0][0];
      const text = await result.text();
      expect(text).toBe('old');

      // Wait for background revalidation
      await vi.waitFor(() => {
        expect(mockCache.put).toHaveBeenCalled();
      });
    });

    it('should not cache non-shell assets', async () => {
      await loadSW();

      const response = new Response('agent data', { status: 200 });
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(response);

      const fetchEvent = {
        request: new Request('https://example.com/some/other/path'),
        respondWith: vi.fn(),
        // mode is not 'navigate'
      };

      // Non-shell, non-API path — should not call respondWith
      Object.defineProperty(fetchEvent.request, 'mode', { value: 'no-cors' });
      fetchHandler!(fetchEvent);

      expect(fetchEvent.respondWith).not.toHaveBeenCalled();
    });
  });

  describe('install event', () => {
    it('should precache homepage, manifest, and icons', async () => {
      await loadSW();

      expect(installHandler).not.toBeNull();

      const waitUntilPromises: Promise<any>[] = [];
      const installEvent = {
        waitUntil: vi.fn((p: Promise<any>) => waitUntilPromises.push(p)),
      };

      installHandler!(installEvent);

      expect(installEvent.waitUntil).toHaveBeenCalled();
      await Promise.allSettled(waitUntilPromises);

      // In test env, BUILD_ASSETS is empty so only '/' is precached.
      // In production, build-sw.js injects all dist/ files.
      expect(mockCache.add).toHaveBeenCalledWith('/');
    });

    it('should call self.skipWaiting() on install for immediate activation', async () => {
      const { skipWaiting } = await loadSW();

      const installEvent = {
        waitUntil: vi.fn(),
      };

      installHandler!(installEvent);

      expect(skipWaiting).toHaveBeenCalled();
    });
  });

  describe('skip_waiting message', () => {
    it('should call self.skipWaiting() when skip_waiting message is received', async () => {
      const { skipWaiting } = await loadSW();

      expect(messageHandler).not.toBeNull();

      const messageEvent = {
        data: { type: 'skip_waiting' },
        source: { type: 'window' },
      };

      messageHandler!(messageEvent);

      expect(skipWaiting).toHaveBeenCalled();
    });
  });

  describe('force_refresh message', () => {
    it('should delete all caches except CONFIG_CACHE', async () => {
      // Add extra cache names
      mockCacheNames.push('some-other-cache');

      await loadSW();

      const waitUntilPromises: Promise<any>[] = [];
      const messageEvent = {
        data: { type: 'force_refresh' },
        source: { type: 'window' },
        waitUntil: vi.fn((p: Promise<any>) => waitUntilPromises.push(p)),
      };

      messageHandler!(messageEvent);

      expect(messageEvent.waitUntil).toHaveBeenCalled();
      await Promise.all(waitUntilPromises);

      // Should delete flo-shell-v1 and some-other-cache but NOT flo-sw-config-v2
      const deleteCalls = (caches.delete as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: any[]) => c[0]
      );
      expect(deleteCalls).toContain('flo-shell-v1');
      expect(deleteCalls).toContain('some-other-cache');
      expect(deleteCalls).not.toContain('flo-sw-config-v2');
    });

    it('should notify all clients with caches_cleared message', async () => {
      await loadSW();

      const client1 = { postMessage: vi.fn() };
      const client2 = { postMessage: vi.fn() };
      mockClients.push(client1, client2);

      const waitUntilPromises: Promise<any>[] = [];
      const messageEvent = {
        data: { type: 'force_refresh' },
        source: { type: 'window' },
        waitUntil: vi.fn((p: Promise<any>) => waitUntilPromises.push(p)),
      };

      messageHandler!(messageEvent);
      await Promise.all(waitUntilPromises);

      expect(client1.postMessage).toHaveBeenCalledWith({ type: 'caches_cleared' });
      expect(client2.postMessage).toHaveBeenCalledWith({ type: 'caches_cleared' });
    });
  });
});
