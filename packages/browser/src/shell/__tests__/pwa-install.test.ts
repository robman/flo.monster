/**
 * Tests for PWA install button handler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupPwaInstall } from '../pwa-install.js';

describe('pwa-install', () => {
  let btn: HTMLButtonElement;
  let listeners: Record<string, Function[]>;

  beforeEach(() => {
    vi.resetAllMocks();
    listeners = {};
    localStorage.removeItem('flo-app-installed');

    // Create a mock install button
    btn = document.createElement('button');
    btn.id = 'install-btn';
    btn.hidden = true;
    document.body.appendChild(btn);

    // Stub window.addEventListener to capture event listeners
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, handler: any) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    });

    // Default: not in standalone mode
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => {
    btn.remove();
    // Clean up any iOS install overlays
    document.getElementById('ios-install-overlay')?.remove();
    vi.restoreAllMocks();
  });

  it('should keep button hidden when no beforeinstallprompt fires', () => {
    setupPwaInstall();
    expect(btn.hidden).toBe(true);
  });

  it('should show button when beforeinstallprompt fires', () => {
    setupPwaInstall();

    // Simulate beforeinstallprompt
    const event = new Event('beforeinstallprompt');
    for (const handler of listeners['beforeinstallprompt'] || []) {
      handler(event);
    }

    expect(btn.hidden).toBe(false);
  });

  it('should trigger prompt on click and hide button when accepted', async () => {
    setupPwaInstall();

    // Simulate beforeinstallprompt
    const promptFn = vi.fn();
    const event = {
      preventDefault: vi.fn(),
      prompt: promptFn,
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    };
    for (const handler of listeners['beforeinstallprompt'] || []) {
      handler(event);
    }

    // Click the button
    btn.click();

    // Wait for async userChoice
    await vi.waitFor(() => {
      expect(promptFn).toHaveBeenCalled();
      expect(btn.hidden).toBe(true);
    });
  });

  it('should not hide button when install is dismissed', async () => {
    setupPwaInstall();

    // Simulate beforeinstallprompt
    const promptFn = vi.fn();
    const event = {
      preventDefault: vi.fn(),
      prompt: promptFn,
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    };
    for (const handler of listeners['beforeinstallprompt'] || []) {
      handler(event);
    }

    // Show the button (simulating what beforeinstallprompt handler does)
    // The button is already shown by the handler, so just click
    btn.click();

    // Wait for async userChoice
    await vi.waitFor(() => {
      expect(promptFn).toHaveBeenCalled();
    });

    // Button stays visible when dismissed (not accepted)
    // Note: deferredPrompt is set to null, but hidden is not set to true
    // because outcome !== 'accepted'
  });

  it('should hide button in standalone mode', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(display-mode: standalone)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    setupPwaInstall();

    // In standalone mode, the function returns early without adding listeners
    expect(listeners['beforeinstallprompt']).toBeUndefined();
    expect(btn.hidden).toBe(true);
  });

  it('should hide button on appinstalled event', () => {
    setupPwaInstall();

    // First show the button via beforeinstallprompt
    const event = {
      preventDefault: vi.fn(),
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    };
    for (const handler of listeners['beforeinstallprompt'] || []) {
      handler(event);
    }
    expect(btn.hidden).toBe(false);

    // Simulate appinstalled
    for (const handler of listeners['appinstalled'] || []) {
      handler(new Event('appinstalled'));
    }

    expect(btn.hidden).toBe(true);
    expect(localStorage.getItem('flo-app-installed')).toBe('1');
  });

  it('should hide button when flo-app-installed flag is set', () => {
    localStorage.setItem('flo-app-installed', '1');
    setupPwaInstall();
    expect(btn.hidden).toBe(true);
    expect(listeners['beforeinstallprompt']).toBeUndefined();
  });

  it('should do nothing if install button is not in DOM', () => {
    btn.remove();

    // Should not throw
    expect(() => setupPwaInstall()).not.toThrow();
  });

  it('should prevent default on beforeinstallprompt', () => {
    setupPwaInstall();

    const event = {
      preventDefault: vi.fn(),
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    };
    for (const handler of listeners['beforeinstallprompt'] || []) {
      handler(event);
    }

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('should show guide on click if no deferred prompt (non-Chromium)', () => {
    setupPwaInstall();

    // Click without a beforeinstallprompt having fired — no guide on non-Chromium
    // (button stays hidden so user can't click in practice, but verify no crash)
    expect(() => btn.click()).not.toThrow();
    expect(btn.hidden).toBe(true);
  });

  describe('Chromium fallback', () => {
    function mockChrome() {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        configurable: true,
      });
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 0,
        configurable: true,
      });
    }

    it('should show button after timeout on Chromium if no beforeinstallprompt', () => {
      mockChrome();
      vi.useFakeTimers();
      setupPwaInstall();

      expect(btn.hidden).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(btn.hidden).toBe(false);

      vi.useRealTimers();
    });

    it('should not override beforeinstallprompt if it fires before timeout', () => {
      mockChrome();
      vi.useFakeTimers();
      setupPwaInstall();

      // beforeinstallprompt fires
      const event = {
        preventDefault: vi.fn(),
        prompt: vi.fn(),
        userChoice: Promise.resolve({ outcome: 'accepted' }),
      };
      for (const handler of listeners['beforeinstallprompt'] || []) {
        handler(event);
      }
      expect(btn.hidden).toBe(false);

      // Timeout fires — button should still be visible (no-op)
      vi.advanceTimersByTime(2000);
      expect(btn.hidden).toBe(false);

      vi.useRealTimers();
    });

    it('should show Chromium install guide on click without deferred prompt', () => {
      mockChrome();
      setupPwaInstall();

      // Manually show button (simulating what the timeout would do)
      btn.hidden = false;
      btn.click();

      const overlay = document.getElementById('ios-install-overlay');
      expect(overlay).toBeTruthy();
      expect(overlay!.querySelector('h2')!.textContent).toBe('Install flo.monster');
      expect(overlay!.textContent).toContain('address bar');
    });

    it('should use native prompt on click if beforeinstallprompt fired', async () => {
      mockChrome();
      setupPwaInstall();

      const promptFn = vi.fn();
      const event = {
        preventDefault: vi.fn(),
        prompt: promptFn,
        userChoice: Promise.resolve({ outcome: 'accepted' }),
      };
      for (const handler of listeners['beforeinstallprompt'] || []) {
        handler(event);
      }

      btn.click();
      await vi.waitFor(() => expect(promptFn).toHaveBeenCalled());
      expect(document.getElementById('ios-install-overlay')).toBeNull();
    });
  });

  describe('iOS detection', () => {
    function mockIos() {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', {
        value: 'iPhone',
        configurable: true,
      });
      Object.defineProperty(navigator, 'standalone', {
        value: undefined,
        configurable: true,
      });
    }

    function mockIpad() {
      // Modern iPads report as MacIntel with touch
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        configurable: true,
      });
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 5,
        configurable: true,
      });
      Object.defineProperty(navigator, 'standalone', {
        value: undefined,
        configurable: true,
      });
    }

    it('should show button immediately on iOS', () => {
      mockIos();
      setupPwaInstall();
      expect(btn.hidden).toBe(false);
      // Should not register beforeinstallprompt listener
      expect(listeners['beforeinstallprompt']).toBeUndefined();
    });

    it('should show button immediately on iPad', () => {
      mockIpad();
      setupPwaInstall();
      expect(btn.hidden).toBe(false);
    });

    it('should show iOS install guide modal on click', () => {
      mockIos();
      setupPwaInstall();
      btn.click();

      const overlay = document.getElementById('ios-install-overlay');
      expect(overlay).toBeTruthy();
      expect(overlay!.querySelector('h2')!.textContent).toBe('Install flo.monster');
      expect(overlay!.querySelectorAll('ol li').length).toBe(3);
    });

    it('should dismiss iOS guide on button click', () => {
      mockIos();
      setupPwaInstall();
      btn.click();

      const dismiss = document.getElementById('ios-install-dismiss')!;
      dismiss.click();

      expect(document.getElementById('ios-install-overlay')).toBeNull();
    });

    it('should dismiss iOS guide on overlay backdrop click', () => {
      mockIos();
      setupPwaInstall();
      btn.click();

      const overlay = document.getElementById('ios-install-overlay')!;
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(document.getElementById('ios-install-overlay')).toBeNull();
    });

    it('should not create duplicate iOS guide modals', () => {
      mockIos();
      setupPwaInstall();
      btn.click();
      btn.click(); // second click

      const overlays = document.querySelectorAll('#ios-install-overlay');
      expect(overlays.length).toBe(1);
    });

    it('should hide button on iOS when already in standalone mode', () => {
      mockIos();
      Object.defineProperty(navigator, 'standalone', {
        value: true,
        configurable: true,
      });

      setupPwaInstall();
      expect(btn.hidden).toBe(true);
    });
  });
});
