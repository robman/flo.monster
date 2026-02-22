/**
 * Tests for SW update strategy — version check, throttling, skip_waiting, force_refresh,
 * waiting SW detection, homepage gating
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// For tests that don't care about module state, import statically
import { requestSkipWaiting, requestForceRefresh, setupUpdateListener, triggerVersionCheck } from '../sw-registration.js';

describe('SW update helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Clear className first — may trigger MutationObservers that create banners.
    // Then innerHTML clears those banners.
    document.body.className = '';
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

/**
 * Tests that need fresh module state (no stale pendingUpdateVersion / homepageObserver).
 * Use vi.resetModules() + dynamic import to get a clean module instance per test.
 */
describe('SW waiting detection & homepage gating (isolated module state)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    // Ensure clean body state for homepage class detection
    document.body.className = '';
    document.body.innerHTML = '';
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // Flush microtasks (MutationObserver callbacks) before cleanup
    await new Promise(r => setTimeout(r, 0));
    document.body.className = '';
    document.body.innerHTML = '';
  });

  describe('setupWaitingSwDetection', () => {
    it('does nothing when service workers not supported', async () => {
      vi.stubGlobal('navigator', {});
      const mod = await import('../sw-registration.js');

      // Should not throw
      mod.setupWaitingSwDetection();
    });

    it('shows banner when reg.waiting exists at page load', async () => {
      vi.stubGlobal('navigator', {
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue({
            waiting: { state: 'installed' },
            installing: null,
            addEventListener: vi.fn(),
          }),
          controller: { postMessage: vi.fn() },
        },
      });

      const mod = await import('../sw-registration.js');
      mod.setupWaitingSwDetection();

      // Wait for the async getRegistration to resolve
      await vi.waitFor(() => {
        expect(document.getElementById('update-banner')).not.toBeNull();
      });

      // Banner without version should show plain text
      const text = document.querySelector('.update-banner__text');
      expect(text!.textContent).toBe('Update available');
    });

    it('tracks installing worker and shows banner when it becomes installed', async () => {
      let stateChangeHandler: (() => void) | null = null;
      const mockWorker = {
        state: 'installing',
        addEventListener: (event: string, handler: any) => {
          if (event === 'statechange') stateChangeHandler = handler;
        },
      };

      vi.stubGlobal('navigator', {
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue({
            waiting: null,
            installing: mockWorker,
            addEventListener: vi.fn(),
          }),
          controller: { postMessage: vi.fn() },
        },
      });

      const mod = await import('../sw-registration.js');
      mod.setupWaitingSwDetection();

      // Wait for getRegistration to resolve
      await vi.waitFor(() => {
        expect(stateChangeHandler).not.toBeNull();
      });

      // No banner yet
      expect(document.getElementById('update-banner')).toBeNull();

      // Simulate the worker becoming installed
      mockWorker.state = 'installed';
      stateChangeHandler!();

      expect(document.getElementById('update-banner')).not.toBeNull();
    });

    it('listens for updatefound and tracks new installing worker', async () => {
      let updateFoundHandler: (() => void) | null = null;
      let stateChangeHandler: (() => void) | null = null;
      const mockReg = {
        waiting: null,
        installing: null as any,
        addEventListener: (event: string, handler: any) => {
          if (event === 'updatefound') updateFoundHandler = handler;
        },
      };

      vi.stubGlobal('navigator', {
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue(mockReg),
          controller: { postMessage: vi.fn() },
        },
      });

      const mod = await import('../sw-registration.js');
      mod.setupWaitingSwDetection();

      // Wait for getRegistration to resolve
      await vi.waitFor(() => {
        expect(updateFoundHandler).not.toBeNull();
      });

      // Simulate a future update
      const newWorker = {
        state: 'installing',
        addEventListener: (event: string, handler: any) => {
          if (event === 'statechange') stateChangeHandler = handler;
        },
      };
      mockReg.installing = newWorker;
      updateFoundHandler!();

      // Worker transitions to installed
      newWorker.state = 'installed';
      stateChangeHandler!();

      expect(document.getElementById('update-banner')).not.toBeNull();
    });

    it('does not show banner if no controller (first install)', async () => {
      let stateChangeHandler: (() => void) | null = null;
      const mockWorker = {
        state: 'installing',
        addEventListener: (event: string, handler: any) => {
          if (event === 'statechange') stateChangeHandler = handler;
        },
      };

      vi.stubGlobal('navigator', {
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue({
            waiting: null,
            installing: mockWorker,
            addEventListener: vi.fn(),
          }),
          controller: null, // No existing controller = first install
        },
      });

      const mod = await import('../sw-registration.js');
      mod.setupWaitingSwDetection();

      await vi.waitFor(() => {
        expect(stateChangeHandler).not.toBeNull();
      });

      // Simulate worker becoming installed — should NOT show banner (first install)
      mockWorker.state = 'installed';
      stateChangeHandler!();

      expect(document.getElementById('update-banner')).toBeNull();
    });
  });

  describe('homepage gating (showUpdateBannerIfAllowed)', () => {
    it('shows banner immediately when not on homepage', async () => {
      // No mode-homepage class
      document.body.className = 'mode-dashboard';

      const mod = await import('../sw-registration.js');
      mod.showUpdateBannerIfAllowed('3.0.0');

      const banner = document.getElementById('update-banner');
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain('3.0.0');
    });

    it('defers banner when on homepage', async () => {
      document.body.className = 'mode-homepage';

      const mod = await import('../sw-registration.js');
      mod.showUpdateBannerIfAllowed('3.0.0');

      // No banner shown yet
      expect(document.getElementById('update-banner')).toBeNull();
    });

    it('shows deferred banner when leaving homepage', async () => {
      document.body.className = 'mode-homepage';

      const mod = await import('../sw-registration.js');
      mod.showUpdateBannerIfAllowed('3.0.0');
      expect(document.getElementById('update-banner')).toBeNull();

      // Simulate leaving homepage
      document.body.className = 'mode-dashboard';

      // MutationObserver is async
      await vi.waitFor(() => {
        expect(document.getElementById('update-banner')).not.toBeNull();
      });

      const text = document.querySelector('.update-banner__text');
      expect(text!.textContent).toContain('3.0.0');
    });

    it('shows banner without version text when no version provided', async () => {
      const mod = await import('../sw-registration.js');
      mod.showUpdateBannerIfAllowed();

      const text = document.querySelector('.update-banner__text');
      expect(text!.textContent).toBe('Update available');
    });

    it('shows banner with version text when version provided', async () => {
      const mod = await import('../sw-registration.js');
      mod.showUpdateBannerIfAllowed('1.5.0');

      const text = document.querySelector('.update-banner__text');
      expect(text!.textContent).toBe('Update available (v1.5.0)');
    });
  });
});
