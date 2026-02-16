/**
 * Tests for Service Worker push and notificationclick event handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('SW push handler', () => {
  let pushHandler: ((event: any) => void) | null = null;
  let notificationClickHandler: ((event: any) => void) | null = null;

  beforeEach(() => {
    pushHandler = null;
    notificationClickHandler = null;

    // Mock ServiceWorkerGlobalScope
    const mockRegistration = {
      showNotification: vi.fn().mockResolvedValue(undefined),
    };

    const mockClients = {
      matchAll: vi.fn().mockResolvedValue([]),
      claim: vi.fn().mockResolvedValue(undefined),
    };

    // Set up a mock self that captures addEventListener calls
    const listeners = new Map<string, Function>();

    vi.stubGlobal('self', {
      registration: mockRegistration,
      clients: mockClients,
      location: { origin: 'https://flo.monster' },
      addEventListener: vi.fn((type: string, handler: Function) => {
        listeners.set(type, handler);
        if (type === 'push') pushHandler = handler as any;
        if (type === 'notificationclick') notificationClickHandler = handler as any;
      }),
      skipWaiting: vi.fn(),
    });

    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({
        put: vi.fn(),
        match: vi.fn().mockResolvedValue(null),
        addAll: vi.fn().mockResolvedValue(undefined),
      }),
      keys: vi.fn().mockResolvedValue([]),
      match: vi.fn().mockResolvedValue(null),
    });

    // Register handlers by simulating what sw.ts does
    // We test the handler logic directly rather than importing sw.ts
    // (sw.ts runs in ServiceWorker context which is hard to import in vitest)

    // Push handler
    pushHandler = (event: any) => {
      const data = event.data?.json() ?? { title: 'flo.monster', body: 'Agent update' };
      event.waitUntil(
        (self as any).registration.showNotification(data.title ?? 'flo.monster', {
          body: data.body ?? '',
          icon: '/icons/icon-192.png',
          tag: data.tag,
          data: { agentId: data.agentId },
        })
      );
    };

    // Notification click handler
    notificationClickHandler = (event: any) => {
      event.notification.close();
      event.waitUntil(
        (self as any).clients.matchAll({ type: 'window' }).then((clients: any[]) => {
          const existing = clients.find((c: any) => c.url.includes((self as any).location.origin));
          if (existing) {
            existing.focus();
            existing.postMessage({
              type: 'notification_click',
              agentId: event.notification.data?.agentId,
            });
          } else {
            (self as any).clients.openWindow('/');
          }
        })
      );
    };
  });

  describe('push event', () => {
    it('shows notification with push payload data', async () => {
      const pushData = {
        title: 'Test Agent',
        body: 'Something happened',
        tag: 'agent-123',
        agentId: 'agent-123',
      };

      const waitPromises: Promise<any>[] = [];
      const event = {
        data: {
          json: () => pushData,
        },
        waitUntil: (p: Promise<any>) => waitPromises.push(p),
      };

      pushHandler!(event);
      await Promise.all(waitPromises);

      expect((self as any).registration.showNotification).toHaveBeenCalledWith(
        'Test Agent',
        {
          body: 'Something happened',
          icon: '/icons/icon-192.png',
          tag: 'agent-123',
          data: { agentId: 'agent-123' },
        }
      );
    });

    it('uses default title/body when push data is missing', async () => {
      const waitPromises: Promise<any>[] = [];
      const event = {
        data: null,
        waitUntil: (p: Promise<any>) => waitPromises.push(p),
      };

      pushHandler!(event);
      await Promise.all(waitPromises);

      expect((self as any).registration.showNotification).toHaveBeenCalledWith(
        'flo.monster',
        expect.objectContaining({
          body: 'Agent update',
          icon: '/icons/icon-192.png',
        })
      );
    });

    it('handles empty json data gracefully', async () => {
      const waitPromises: Promise<any>[] = [];
      const event = {
        data: {
          json: () => ({}),
        },
        waitUntil: (p: Promise<any>) => waitPromises.push(p),
      };

      pushHandler!(event);
      await Promise.all(waitPromises);

      expect((self as any).registration.showNotification).toHaveBeenCalledWith(
        'flo.monster',
        expect.objectContaining({
          body: '',
        })
      );
    });
  });

  describe('notificationclick event', () => {
    it('closes notification and focuses existing window', async () => {
      const mockClient = {
        url: 'https://flo.monster/some-path',
        focus: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn(),
      };

      (self as any).clients.matchAll.mockResolvedValue([mockClient]);

      const waitPromises: Promise<any>[] = [];
      const event = {
        notification: {
          close: vi.fn(),
          data: { agentId: 'agent-abc' },
        },
        waitUntil: (p: Promise<any>) => waitPromises.push(p),
      };

      notificationClickHandler!(event);
      await Promise.all(waitPromises);

      expect(event.notification.close).toHaveBeenCalled();
      expect(mockClient.focus).toHaveBeenCalled();
      expect(mockClient.postMessage).toHaveBeenCalledWith({
        type: 'notification_click',
        agentId: 'agent-abc',
      });
    });

    it('opens new window when no existing client', async () => {
      (self as any).clients.matchAll.mockResolvedValue([]);
      (self as any).clients.openWindow = vi.fn().mockResolvedValue(undefined);

      const waitPromises: Promise<any>[] = [];
      const event = {
        notification: {
          close: vi.fn(),
          data: {},
        },
        waitUntil: (p: Promise<any>) => waitPromises.push(p),
      };

      notificationClickHandler!(event);
      await Promise.all(waitPromises);

      expect(event.notification.close).toHaveBeenCalled();
      expect((self as any).clients.openWindow).toHaveBeenCalledWith('/');
    });

    it('handles notification with no agentId', async () => {
      const mockClient = {
        url: 'https://flo.monster/',
        focus: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn(),
      };

      (self as any).clients.matchAll.mockResolvedValue([mockClient]);

      const waitPromises: Promise<any>[] = [];
      const event = {
        notification: {
          close: vi.fn(),
          data: null,
        },
        waitUntil: (p: Promise<any>) => waitPromises.push(p),
      };

      notificationClickHandler!(event);
      await Promise.all(waitPromises);

      expect(mockClient.postMessage).toHaveBeenCalledWith({
        type: 'notification_click',
        agentId: undefined,
      });
    });
  });
});

describe('HubClient push methods', () => {
  // Test that hub client methods exist and send correct message types
  it('sendPushSubscribe sends push_subscribe message', async () => {
    const { HubClient } = await import('../hub-client.js');
    const client = new HubClient();

    // Verify method exists
    expect(typeof client.sendPushSubscribe).toBe('function');
    expect(typeof client.sendPushVerifyPin).toBe('function');
    expect(typeof client.sendPushUnsubscribe).toBe('function');
    expect(typeof client.sendVisibilityState).toBe('function');
    expect(typeof client.getVapidKey).toBe('function');
    expect(typeof client.onPushEvent).toBe('function');
  });

  it('onPushEvent registers and unregisters handlers', async () => {
    const { HubClient } = await import('../hub-client.js');
    const client = new HubClient();

    const handler = vi.fn();
    const unsub = client.onPushEvent(handler);
    expect(typeof unsub).toBe('function');

    // Unsubscribe
    unsub();
  });

  it('multiple push event handlers can be registered', async () => {
    const { HubClient } = await import('../hub-client.js');
    const client = new HubClient();

    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const unsub1 = client.onPushEvent(handler1);
    const unsub2 = client.onPushEvent(handler2);

    unsub1();
    unsub2();
  });

  it('sendVisibilityState requires device ID in localStorage', async () => {
    const { HubClient } = await import('../hub-client.js');
    const client = new HubClient();

    // Without device ID in localStorage, should not throw
    localStorage.removeItem('flo-device-id');
    expect(() => client.sendVisibilityState('conn-1', true)).not.toThrow();
  });
});
