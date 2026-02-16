/**
 * Tests for PushSubscribeFlow — overlay creation, PIN input, subscription flow.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PushSubscribeFlow, getDeviceId } from '../push-subscribe.js';

// Mock HubClient
function createMockHubClient(vapidKey: string | null = 'test-vapid-key') {
  const pushEventHandlers: ((msg: any) => void)[] = [];
  return {
    onPushEvent: vi.fn((handler: (msg: any) => void) => {
      pushEventHandlers.push(handler);
      return () => {
        const idx = pushEventHandlers.indexOf(handler);
        if (idx >= 0) pushEventHandlers.splice(idx, 1);
      };
    }),
    getVapidKey: vi.fn((_connectionId: string) => vapidKey),
    sendPushSubscribe: vi.fn(),
    sendPushVerifyPin: vi.fn(),
    sendPushUnsubscribe: vi.fn(),
    sendVisibilityState: vi.fn(),
    // Helper to simulate hub messages
    _emitPushEvent(msg: any) {
      for (const handler of [...pushEventHandlers]) {
        handler(msg);
      }
    },
    _pushEventHandlers: pushEventHandlers,
  };
}

describe('getDeviceId', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('generates a UUID and persists it', () => {
    const id = getDeviceId();
    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThan(10);
    expect(localStorage.getItem('flo-device-id')).toBe(id);
  });

  it('returns the same ID on subsequent calls', () => {
    const id1 = getDeviceId();
    const id2 = getDeviceId();
    expect(id1).toBe(id2);
  });

  it('uses existing ID from localStorage', () => {
    localStorage.setItem('flo-device-id', 'test-device-123');
    expect(getDeviceId()).toBe('test-device-123');
  });
});

describe('PushSubscribeFlow', () => {
  let flow: PushSubscribeFlow;
  let mockClient: ReturnType<typeof createMockHubClient>;

  beforeEach(() => {
    localStorage.clear();
    mockClient = createMockHubClient();
    flow = new PushSubscribeFlow(mockClient as any, 'conn-1');
  });

  afterEach(() => {
    flow.hideOverlay();
    // Clean up any remaining overlays
    document.querySelectorAll('.push-overlay').forEach(el => el.remove());
  });

  describe('overlay creation', () => {
    it('is not visible initially', () => {
      expect(flow.isVisible()).toBe(false);
      expect(document.querySelector('.push-overlay')).toBeNull();
    });

    it('creates overlay on start', async () => {
      vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });

      await flow.start();

      expect(flow.isVisible()).toBe(true);
      expect(document.querySelector('.push-overlay')).toBeTruthy();
      expect(document.querySelector('.push-overlay__card')).toBeTruthy();
      expect(document.querySelector('.push-overlay__pin-input')).toBeTruthy();
      expect(document.querySelector('.push-overlay__status')).toBeTruthy();
    });

    it('has correct overlay structure', async () => {
      vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });

      await flow.start();

      const card = document.querySelector('.push-overlay__card')!;
      expect(card.querySelector('h2')!.textContent).toBe('Enable Push Notifications');
      expect(card.querySelector('.push-overlay__pin-input')).toBeTruthy();

      const buttons = card.querySelectorAll('button');
      const cancelBtn = Array.from(buttons).find(b => b.textContent === 'Cancel');
      const verifyBtn = Array.from(buttons).find(b => b.textContent === 'Verify PIN');
      expect(cancelBtn).toBeTruthy();
      expect(verifyBtn).toBeTruthy();
    });

    it('PIN input is initially disabled', async () => {
      vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });
      await flow.start();

      const pinInput = document.querySelector('.push-overlay__pin-input') as HTMLInputElement;
      expect(pinInput.disabled).toBe(true);
    });

    it('removes overlay on cancel', async () => {
      vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });
      await flow.start();

      const cancelBtn = document.querySelector('.push-overlay__actions .btn:first-child') as HTMLButtonElement;
      cancelBtn.click();

      expect(flow.isVisible()).toBe(false);
      expect(document.querySelector('.push-overlay')).toBeNull();
    });

    it('hideOverlay cleans up', () => {
      vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });
      flow.start();

      flow.hideOverlay();
      expect(flow.isVisible()).toBe(false);
      expect(document.querySelector('.push-overlay')).toBeNull();
    });
  });

  describe('state transitions', () => {
    it('starts in idle state', () => {
      expect(flow.getState()).toBe('idle');
    });

    it('transitions to error when no VAPID key', async () => {
      // Create flow with no VAPID key
      const noKeyClient = createMockHubClient(null);
      const noKeyFlow = new PushSubscribeFlow(noKeyClient as any, 'conn-1');

      await noKeyFlow.start();

      expect(noKeyFlow.getState()).toBe('error');
      const status = document.querySelector('.push-overlay__status') as HTMLElement;
      expect(status?.textContent).toContain('not enabled');

      noKeyFlow.hideOverlay();
    });

    it('transitions to error when permission denied', async () => {
      vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });

      await flow.start();

      expect(flow.getState()).toBe('error');
    });

    it('reads VAPID key from hub client', async () => {
      vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });

      await flow.start();

      expect(mockClient.getVapidKey).toHaveBeenCalledWith('conn-1');
    });
  });

  describe('handleSubscribeResult', () => {
    it('handles subscribe error from hub', async () => {
      vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });

      await flow.start();

      const deviceId = getDeviceId();
      flow.handleSubscribeResult({
        deviceId,
        success: false,
        error: 'Push not enabled',
      });

      expect(flow.getState()).toBe('error');
      const status = document.querySelector('.push-overlay__status') as HTMLElement;
      expect(status?.textContent).toContain('Push not enabled');
    });

    it('ignores subscribe result for different device', async () => {
      vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });

      await flow.start();

      const prevState = flow.getState();
      flow.handleSubscribeResult({
        deviceId: 'other-device',
        success: false,
        error: 'Some error',
      });

      // State should not change since deviceId doesn't match
      expect(flow.getState()).toBe(prevState);
    });
  });

  describe('verify success', () => {
    it('replaces overlay content with success message on verified PIN', async () => {
      // Mock full subscription flow
      const mockSubscription = {
        toJSON: () => ({ endpoint: 'https://push.example.com', keys: { p256dh: 'key1', auth: 'key2' } }),
      };
      const mockRegistration = {
        pushManager: { subscribe: vi.fn().mockResolvedValue(mockSubscription) },
      };
      vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('granted') });
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { ready: Promise.resolve(mockRegistration) },
        configurable: true,
      });

      await flow.start();
      expect(flow.getState()).toBe('waiting-pin');

      // Enter PIN and verify
      const pinInput = document.querySelector('.push-overlay__pin-input') as HTMLInputElement;
      pinInput.value = '1234';

      const verifyBtn = document.querySelector('.push-overlay__actions .btn--primary') as HTMLButtonElement;
      verifyBtn.click();

      // Simulate hub verify result
      const deviceId = getDeviceId();
      mockClient._emitPushEvent({ type: 'push_verify_result', deviceId, verified: true });

      // Wait for async verify
      await vi.waitFor(() => {
        expect(flow.getState()).toBe('verified');
      });

      // Card should now show success content
      const card = document.querySelector('.push-overlay__card')!;
      expect(card.querySelector('h2')!.textContent).toBe('Push Notifications Enabled');
      expect(card.querySelector('.push-overlay__status')!.textContent).toContain('now set up');
      expect(card.querySelector('.push-overlay__status')!.textContent).toContain('agents can notify you');

      // Should have a close button, no PIN input
      expect(card.querySelector('.push-overlay__pin-input')).toBeNull();
      const closeBtn = card.querySelector('.btn--primary') as HTMLButtonElement;
      expect(closeBtn.textContent).toBe('Close');

      // Close button should dismiss overlay
      closeBtn.click();
      expect(flow.isVisible()).toBe(false);
    });
  });

  describe('PIN input', () => {
    it('has correct input attributes', () => {
      vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });
      flow.start();

      const pinInput = document.querySelector('.push-overlay__pin-input') as HTMLInputElement;
      expect(pinInput.type).toBe('tel');
      expect(pinInput.maxLength).toBe(4);
      expect(pinInput.inputMode).toBe('numeric');
      expect(pinInput.autocomplete).toBe('off');
    });
  });
});
