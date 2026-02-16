/**
 * Tests for SW update strategy — version check, throttling, skip_waiting, force_refresh
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestSkipWaiting, requestForceRefresh, setupUpdateListener, triggerVersionCheck } from '../sw-registration.js';

describe('SW update helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  describe('requestSkipWaiting', () => {
    it('sends skip_waiting to waiting SW when available', async () => {
      const mockWaitingPostMessage = vi.fn();
      vi.stubGlobal('navigator', {
        serviceWorker: {
          controller: { postMessage: vi.fn() },
          getRegistration: vi.fn().mockResolvedValue({
            waiting: { postMessage: mockWaitingPostMessage },
          }),
        },
      });

      await requestSkipWaiting();

      expect(mockWaitingPostMessage).toHaveBeenCalledWith({ type: 'skip_waiting' });
    });

    it('falls back to controller when no waiting SW', async () => {
      const mockPostMessage = vi.fn();
      vi.stubGlobal('navigator', {
        serviceWorker: {
          controller: { postMessage: mockPostMessage },
          getRegistration: vi.fn().mockResolvedValue({ waiting: null }),
        },
      });

      await requestSkipWaiting();

      expect(mockPostMessage).toHaveBeenCalledWith({ type: 'skip_waiting' });
    });

    it('does nothing when no controller and no waiting SW', async () => {
      vi.stubGlobal('navigator', {
        serviceWorker: {
          controller: null,
          getRegistration: vi.fn().mockResolvedValue(null),
        },
      });

      // Should not throw
      await requestSkipWaiting();
    });
  });

  describe('requestForceRefresh', () => {
    it('sends force_refresh message to controller', () => {
      const mockPostMessage = vi.fn();
      vi.stubGlobal('navigator', {
        serviceWorker: {
          controller: { postMessage: mockPostMessage },
        },
      });

      requestForceRefresh();

      expect(mockPostMessage).toHaveBeenCalledWith({ type: 'force_refresh' });
    });

    it('does nothing when no controller', () => {
      vi.stubGlobal('navigator', {
        serviceWorker: {
          controller: null,
        },
      });

      // Should not throw
      requestForceRefresh();
    });
  });

  describe('triggerVersionCheck', () => {
    it('sends check_update message to controller', () => {
      const mockPostMessage = vi.fn();
      vi.stubGlobal('navigator', {
        serviceWorker: {
          controller: { postMessage: mockPostMessage },
        },
      });

      triggerVersionCheck();

      expect(mockPostMessage).toHaveBeenCalledWith({ type: 'check_update' });
    });

    it('does nothing when no controller', () => {
      vi.stubGlobal('navigator', {
        serviceWorker: {
          controller: null,
        },
      });

      // Should not throw
      triggerVersionCheck();
    });
  });

  describe('setupUpdateListener', () => {
    it('does nothing when service workers not supported', () => {
      vi.stubGlobal('navigator', {});

      // Should not throw
      setupUpdateListener();
    });

    it('registers message listener for update_available', () => {
      const mockAddEventListener = vi.fn();
      vi.stubGlobal('navigator', {
        serviceWorker: {
          addEventListener: mockAddEventListener,
        },
      });

      setupUpdateListener();

      expect(mockAddEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('shows update banner when update_available message received', () => {
      let messageHandler: (event: any) => void = () => {};
      vi.stubGlobal('navigator', {
        serviceWorker: {
          addEventListener: (event: string, handler: any) => {
            if (event === 'message') messageHandler = handler;
          },
        },
      });

      setupUpdateListener();

      // Simulate update_available message
      messageHandler({ data: { type: 'update_available', version: '1.2.3' } });

      const banner = document.getElementById('update-banner');
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain('1.2.3');
    });

    it('ignores non-update messages', () => {
      let messageHandler: (event: any) => void = () => {};
      vi.stubGlobal('navigator', {
        serviceWorker: {
          addEventListener: (event: string, handler: any) => {
            if (event === 'message') messageHandler = handler;
          },
        },
      });

      setupUpdateListener();

      // Simulate other message
      messageHandler({ data: { type: 'caches_cleared' } });

      const banner = document.getElementById('update-banner');
      expect(banner).toBeNull();
    });

    it('ignores null/undefined data', () => {
      let messageHandler: (event: any) => void = () => {};
      vi.stubGlobal('navigator', {
        serviceWorker: {
          addEventListener: (event: string, handler: any) => {
            if (event === 'message') messageHandler = handler;
          },
        },
      });

      setupUpdateListener();

      messageHandler({ data: null });
      messageHandler({ data: undefined });

      const banner = document.getElementById('update-banner');
      expect(banner).toBeNull();
    });

    it('does not show duplicate banners', () => {
      let messageHandler: (event: any) => void = () => {};
      vi.stubGlobal('navigator', {
        serviceWorker: {
          addEventListener: (event: string, handler: any) => {
            if (event === 'message') messageHandler = handler;
          },
        },
      });

      setupUpdateListener();

      // Send two update messages
      messageHandler({ data: { type: 'update_available', version: '1.0.0' } });
      messageHandler({ data: { type: 'update_available', version: '1.0.1' } });

      const banners = document.querySelectorAll('#update-banner');
      expect(banners.length).toBe(1);
    });
  });

  describe('showUpdateBanner (via setupUpdateListener)', () => {
    it('banner has refresh button that calls requestSkipWaiting and reloads', async () => {
      let messageHandler: (event: any) => void = () => {};
      const mockWaitingPostMessage = vi.fn();

      vi.stubGlobal('navigator', {
        serviceWorker: {
          addEventListener: (event: string, handler: any) => {
            if (event === 'message') messageHandler = handler;
          },
          controller: { postMessage: vi.fn() },
          getRegistration: vi.fn().mockResolvedValue({
            waiting: { postMessage: mockWaitingPostMessage },
          }),
        },
      });

      // Mock reload
      const mockReload = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { reload: mockReload },
        writable: true,
        configurable: true,
      });

      setupUpdateListener();
      messageHandler({ data: { type: 'update_available', version: '2.0.0' } });

      const refreshBtn = document.querySelector('.update-banner__refresh') as HTMLButtonElement;
      expect(refreshBtn).not.toBeNull();

      refreshBtn.click();

      // requestSkipWaiting is async — wait for it
      await vi.waitFor(() => {
        expect(mockWaitingPostMessage).toHaveBeenCalledWith({ type: 'skip_waiting' });
      });
      expect(mockReload).toHaveBeenCalled();
    });

    it('banner has dismiss button that removes it', () => {
      let messageHandler: (event: any) => void = () => {};
      vi.stubGlobal('navigator', {
        serviceWorker: {
          addEventListener: (event: string, handler: any) => {
            if (event === 'message') messageHandler = handler;
          },
        },
      });

      setupUpdateListener();
      messageHandler({ data: { type: 'update_available', version: '2.0.0' } });

      expect(document.getElementById('update-banner')).not.toBeNull();

      const dismissBtn = document.querySelector('.update-banner__dismiss') as HTMLButtonElement;
      dismissBtn.click();

      expect(document.getElementById('update-banner')).toBeNull();
    });
  });
});
