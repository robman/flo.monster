/**
 * Tests for headless Chrome session manager.
 * Playwright is fully mocked — no real browser is launched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Playwright mock ---

const mockBrowser = {
  version: vi.fn(() => '143.0.7499.4'),
};

const mockPage = { url: vi.fn(() => 'about:blank') };

const mockCdpSession = {
  send: vi.fn(async () => {}),
  detach: vi.fn(async () => {}),
};

const mockContext = {
  pages: vi.fn(() => [mockPage]),
  newPage: vi.fn(async () => mockPage),
  close: vi.fn(async () => {}),
  browser: vi.fn(() => mockBrowser),
  addInitScript: vi.fn(async () => {}),
  route: vi.fn(async () => {}),
  newCDPSession: vi.fn(async () => mockCdpSession),
  on: vi.fn(),
};

vi.mock('playwright-core', () => ({
  chromium: {
    launchPersistentContext: vi.fn(async () => mockContext),
  },
}));

// --- fs/promises mock ---

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  stat: vi.fn(async () => { throw new Error('ENOENT'); }),
}));

import { chromium } from 'playwright-core';
import { mkdir, rm, stat } from 'node:fs/promises';
import { BrowseSessionManager } from '../browse-session.js';
import type { BrowseSessionConfig } from '../browse-session.js';

// --- Helpers ---

function makeConfig(overrides: Partial<BrowseSessionConfig> = {}): BrowseSessionConfig {
  return {
    proxyPort: 9090,
    maxConcurrentSessions: 3,
    sessionTimeoutMinutes: 30,
    viewport: { width: 1419, height: 813 },
    ...overrides,
  };
}

// --- Tests ---

describe('BrowseSessionManager', () => {
  let manager: BrowseSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    manager = new BrowseSessionManager(makeConfig());
  });

  afterEach(async () => {
    await manager.closeAll();
    vi.useRealTimers();
  });

  // --------------------------------------------------
  // start
  // --------------------------------------------------
  describe('start', () => {
    it('should set up the cleanup interval', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      manager.start();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      setIntervalSpy.mockRestore();
    });
  });

  // --------------------------------------------------
  // getOrCreateSession
  // --------------------------------------------------
  describe('getOrCreateSession', () => {
    it('should launch a persistent context with correct options', async () => {
      manager.start();
      const page = await manager.getOrCreateSession('agent-1');

      expect(chromium.launchPersistentContext).toHaveBeenCalledOnce();
      const call = vi.mocked(chromium.launchPersistentContext).mock.calls[0];
      // First arg: browser data dir
      expect(call[0]).toBe('/tmp/flo-browse-agent-1');
      // Second arg: options — no channel (Chromium default, ARM64 compatible)
      expect(call[1]).toEqual(expect.objectContaining({
        headless: false,
        viewport: { width: 1419, height: 813 },
        ignoreHTTPSErrors: true,
      }));
      // Locale is derived from system timezone
      expect(typeof call[1]!.locale).toBe('string');
      expect(call[1]).not.toHaveProperty('channel');
      // Should include headless=new and proxy args
      expect(call[1]!.args).toEqual(expect.arrayContaining([
        '--headless=new',
        '--proxy-server=http://127.0.0.1:9090',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--enforce-webrtc-ip-permission-check',
        '--disable-blink-features=AutomationControlled',
      ]));
      expect(page).toBe(mockPage);
    });

    it('should create browser data dir before launching', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');

      expect(mkdir).toHaveBeenCalledWith('/tmp/flo-browse-agent-1', { recursive: true });
    });

    it('should use the first page from persistent context', async () => {
      manager.start();
      const page = await manager.getOrCreateSession('agent-1');

      expect(mockContext.pages).toHaveBeenCalled();
      // Should use existing page, not create new one
      expect(mockContext.newPage).not.toHaveBeenCalled();
      expect(page).toBe(mockPage);
    });

    it('should create a new page if persistent context has no pages', async () => {
      // pages() is called twice: once for CDP UA override, once for default page selection
      mockContext.pages.mockReturnValueOnce([]).mockReturnValueOnce([]);
      manager.start();
      const page = await manager.getOrCreateSession('agent-1');

      expect(mockContext.newPage).toHaveBeenCalledOnce();
      expect(page).toBe(mockPage);
    });

    it('should return the existing page for a known agent', async () => {
      manager.start();

      const page1 = await manager.getOrCreateSession('agent-1');
      const page2 = await manager.getOrCreateSession('agent-1');

      expect(page1).toBe(page2);
      // launchPersistentContext should only have been called once
      expect(chromium.launchPersistentContext).toHaveBeenCalledOnce();
    });

    it('should throw when at max concurrent sessions', async () => {
      const limited = new BrowseSessionManager(makeConfig({ maxConcurrentSessions: 2 }));
      limited.start();

      await limited.getOrCreateSession('agent-1');
      await limited.getOrCreateSession('agent-2');

      await expect(limited.getOrCreateSession('agent-3')).rejects.toThrow(
        /Maximum concurrent sessions reached/,
      );

      await limited.closeAll();
    });

    it('should inject stealth init script via addInitScript', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');

      expect(mockContext.addInitScript).toHaveBeenCalledOnce();
      const script = (mockContext.addInitScript.mock.calls[0] as unknown[])[0] as string;
      expect(typeof script).toBe('string');
      // Script should contain the detected version
      expect(script).toContain('143.0.7499.4');
      // Script should contain window.chrome patch
      expect(script).toContain('window.chrome');
    });

    it('should rewrite UA header via context.route', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');

      expect(mockContext.route).toHaveBeenCalledOnce();
      expect(mockContext.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    });

    it('should set up route handler that intercepts ServiceWorker scripts', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');

      expect(mockContext.route).toHaveBeenCalledOnce();
      const routeCall = mockContext.route.mock.calls[0] as unknown as [string, Function];
      expect(typeof routeCall[1]).toBe('function');
    });

    it('should pass derived locale to launch options', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');

      const call = vi.mocked(chromium.launchPersistentContext).mock.calls[0];
      // locale should be a string (derived from system timezone)
      expect(typeof call[1]!.locale).toBe('string');
      expect(call[1]!.locale!.length).toBeGreaterThan(0);
    });

    it('should NOT set --user-agent flag (CDP + init script + route handler cover UA)', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');

      const call = vi.mocked(chromium.launchPersistentContext).mock.calls[0];
      const args: string[] = call[1]?.args ?? [];
      const uaArg = args.find((a: string) => a.startsWith('--user-agent='));
      expect(uaArg).toBeUndefined();
    });

    it('should use the configured proxy port', async () => {
      const custom = new BrowseSessionManager(makeConfig({ proxyPort: 4444 }));
      custom.start();
      await custom.getOrCreateSession('agent-1');

      const call = vi.mocked(chromium.launchPersistentContext).mock.calls[0];
      expect(call[1]!.args).toEqual(expect.arrayContaining([
        '--proxy-server=http://127.0.0.1:4444',
      ]));

      await custom.closeAll();
    });
  });

  // --------------------------------------------------
  // getBrowserDataDir
  // --------------------------------------------------
  describe('getBrowserDataDir', () => {
    it('should return temp dir when no agentStorePath configured', async () => {
      const dir = await manager.getBrowserDataDir('agent-1');
      expect(dir).toBe('/tmp/flo-browse-agent-1');
    });

    it('should return persistent dir when agent store dir exists', async () => {
      const withStore = new BrowseSessionManager(makeConfig({
        agentStorePath: '/home/user/.flo-monster/agents',
      }));
      // Mock stat to succeed (agent dir exists)
      vi.mocked(stat).mockResolvedValueOnce({ isDirectory: () => true } as any);

      const dir = await withStore.getBrowserDataDir('hub-agent-1');
      expect(dir).toBe('/home/user/.flo-monster/agents/hub-agent-1/browser');
      expect(stat).toHaveBeenCalledWith('/home/user/.flo-monster/agents/hub-agent-1');
    });

    it('should return temp dir when agent store dir does not exist', async () => {
      const withStore = new BrowseSessionManager(makeConfig({
        agentStorePath: '/home/user/.flo-monster/agents',
      }));
      // stat throws ENOENT (default mock behavior)

      const dir = await withStore.getBrowserDataDir('browser-agent-1');
      expect(dir).toBe('/tmp/flo-browse-browser-agent-1');
    });
  });

  // --------------------------------------------------
  // touchSession
  // --------------------------------------------------
  describe('touchSession', () => {
    it('should update the lastActivity timestamp', async () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      manager.start();
      await manager.getOrCreateSession('agent-1');

      // Advance time and touch
      vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
      manager.touchSession('agent-1');

      // The session should now have the updated timestamp.
      // Verify indirectly: if the timeout is 30 minutes from creation,
      // but we touched at +5 min, advancing 28 minutes from creation
      // should NOT close it (because touch pushed the window out).
      vi.advanceTimersByTime(25 * 60 * 1000); // +25 min from touch = +30 min from creation

      // Session should still exist because touch extended it
      expect(manager.hasSession('agent-1')).toBe(true);
    });

    it('should be a no-op for an unknown agent', () => {
      // Should not throw
      manager.touchSession('nonexistent');
    });
  });

  // --------------------------------------------------
  // closeSession
  // --------------------------------------------------
  describe('closeSession', () => {
    it('should close the context and remove the session', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');

      expect(manager.hasSession('agent-1')).toBe(true);

      await manager.closeSession('agent-1');

      expect(mockContext.close).toHaveBeenCalled();
      expect(manager.hasSession('agent-1')).toBe(false);
    });

    it('should be a no-op for an unknown agent', async () => {
      manager.start();
      // Should not throw
      await manager.closeSession('nonexistent');
    });

    it('should decrement sessionCount', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');
      expect(manager.sessionCount).toBe(1);

      await manager.closeSession('agent-1');
      expect(manager.sessionCount).toBe(0);
    });

    it('should clean up temp browser data dirs', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');
      await manager.closeSession('agent-1');

      expect(rm).toHaveBeenCalledWith('/tmp/flo-browse-agent-1', { recursive: true, force: true });
    });

    it('should NOT clean up persistent browser data dirs', async () => {
      const withStore = new BrowseSessionManager(makeConfig({
        agentStorePath: '/home/user/.flo-monster/agents',
      }));
      withStore.start();
      // Mock stat to succeed → persistent dir
      vi.mocked(stat).mockResolvedValueOnce({ isDirectory: () => true } as any);

      await withStore.getOrCreateSession('hub-agent-1');
      vi.mocked(rm).mockClear();
      await withStore.closeSession('hub-agent-1');

      // rm should NOT be called for persistent dirs
      expect(rm).not.toHaveBeenCalled();

      await withStore.closeAll();
    });
  });

  // --------------------------------------------------
  // Session timeout (cleanup)
  // --------------------------------------------------
  describe('session timeout', () => {
    it('should close sessions that exceed the timeout', async () => {
      const short = new BrowseSessionManager(makeConfig({ sessionTimeoutMinutes: 5 }));
      short.start();
      await short.getOrCreateSession('agent-1');

      expect(short.hasSession('agent-1')).toBe(true);

      // Advance past timeout (5 min) + one cleanup interval tick (1 min)
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

      expect(short.hasSession('agent-1')).toBe(false);

      await short.closeAll();
    });

    it('should not close recently active sessions', async () => {
      const short = new BrowseSessionManager(makeConfig({ sessionTimeoutMinutes: 5 }));
      short.start();
      await short.getOrCreateSession('agent-1');

      // Advance 3 minutes and touch the session
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      short.touchSession('agent-1');

      // Advance another 3 minutes (6 total from creation, but only 3 from touch)
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

      // Should still be alive — only 3 minutes since last activity
      expect(short.hasSession('agent-1')).toBe(true);

      await short.closeAll();
    });

    it('should close only expired sessions, keeping active ones', async () => {
      const short = new BrowseSessionManager(makeConfig({ sessionTimeoutMinutes: 5 }));
      short.start();

      // Create two sessions at t=0
      await short.getOrCreateSession('agent-old');
      await short.getOrCreateSession('agent-new');

      // Advance 4 minutes, touch only agent-new
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      short.touchSession('agent-new');

      // Advance 2 more minutes (agent-old at 6 min idle, agent-new at 2 min idle)
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(short.hasSession('agent-old')).toBe(false);
      expect(short.hasSession('agent-new')).toBe(true);

      await short.closeAll();
    });
  });

  // --------------------------------------------------
  // closeAll
  // --------------------------------------------------
  describe('closeAll', () => {
    it('should close all contexts', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');
      await manager.getOrCreateSession('agent-2');

      await manager.closeAll();

      // Context close called for each session
      expect(mockContext.close).toHaveBeenCalledTimes(2);
      expect(manager.sessionCount).toBe(0);
    });

    it('should clear the cleanup interval', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      manager.start();
      await manager.closeAll();

      expect(clearIntervalSpy).toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
    });

    it('should be safe to call when no sessions exist', async () => {
      // Should not throw
      await manager.closeAll();
    });

    it('should be safe to call multiple times', async () => {
      manager.start();
      await manager.closeAll();
      await manager.closeAll(); // Should not throw
    });
  });

  // --------------------------------------------------
  // sessionCount
  // --------------------------------------------------
  describe('sessionCount', () => {
    it('should return 0 initially', () => {
      expect(manager.sessionCount).toBe(0);
    });

    it('should increment when sessions are created', async () => {
      manager.start();

      await manager.getOrCreateSession('agent-1');
      expect(manager.sessionCount).toBe(1);

      await manager.getOrCreateSession('agent-2');
      expect(manager.sessionCount).toBe(2);
    });

    it('should decrement when sessions are closed', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');
      await manager.getOrCreateSession('agent-2');
      expect(manager.sessionCount).toBe(2);

      await manager.closeSession('agent-1');
      expect(manager.sessionCount).toBe(1);

      await manager.closeSession('agent-2');
      expect(manager.sessionCount).toBe(0);
    });
  });

  // --------------------------------------------------
  // getElementRefs
  // --------------------------------------------------
  describe('getElementRefs', () => {
    it('should create a new empty map for an unknown agent', () => {
      const refs = manager.getElementRefs('agent-1');
      expect(refs).toBeInstanceOf(Map);
      expect(refs.size).toBe(0);
    });

    it('should return the same map on subsequent calls', () => {
      const refs1 = manager.getElementRefs('agent-1');
      refs1.set('e1', { role: 'button', name: 'OK' } as any);

      const refs2 = manager.getElementRefs('agent-1');
      expect(refs2).toBe(refs1);
      expect(refs2.get('e1')).toEqual({ role: 'button', name: 'OK' });
    });

    it('should return different maps for different agents', () => {
      const refs1 = manager.getElementRefs('agent-1');
      const refs2 = manager.getElementRefs('agent-2');
      expect(refs1).not.toBe(refs2);
    });

    it('should be cleaned up when session is closed', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');
      const refs = manager.getElementRefs('agent-1');
      refs.set('e1', { role: 'button', name: 'OK' } as any);

      await manager.closeSession('agent-1');

      // getElementRefs creates a new empty map after cleanup
      const refsAfter = manager.getElementRefs('agent-1');
      expect(refsAfter.size).toBe(0);
      expect(refsAfter).not.toBe(refs);
    });

    it('should be cleaned up when all sessions are closed', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');
      const refs = manager.getElementRefs('agent-1');
      refs.set('e1', { role: 'button', name: 'OK' } as any);

      await manager.closeAll();

      const refsAfter = manager.getElementRefs('agent-1');
      expect(refsAfter.size).toBe(0);
      expect(refsAfter).not.toBe(refs);
    });
  });

  // --------------------------------------------------
  // rekeySession
  // --------------------------------------------------
  describe('rekeySession', () => {
    it('should transfer session from old ID to new ID', async () => {
      manager.start();
      await manager.getOrCreateSession('browser-agent-1');

      const result = manager.rekeySession('browser-agent-1', 'hub-agent-1');

      expect(result).toBe(true);
      expect(manager.hasSession('browser-agent-1')).toBe(false);
      expect(manager.hasSession('hub-agent-1')).toBe(true);
    });

    it('should transfer element refs when re-keying', async () => {
      manager.start();
      await manager.getOrCreateSession('browser-agent-1');
      const refs = manager.getElementRefs('browser-agent-1');
      refs.set('e1', { role: 'button', name: 'Submit' } as any);

      manager.rekeySession('browser-agent-1', 'hub-agent-1');

      const newRefs = manager.getElementRefs('hub-agent-1');
      expect(newRefs.get('e1')).toEqual({ role: 'button', name: 'Submit' });
    });

    it('should return false if old session does not exist', () => {
      const result = manager.rekeySession('nonexistent', 'hub-agent-1');
      expect(result).toBe(false);
    });

    it('should update the session agentId field', async () => {
      manager.start();
      await manager.getOrCreateSession('browser-agent-1');

      manager.rekeySession('browser-agent-1', 'hub-agent-1');

      const session = manager.getSession('hub-agent-1');
      expect(session?.agentId).toBe('hub-agent-1');
    });

    it('should preserve the page after re-keying', async () => {
      manager.start();
      const originalPage = await manager.getOrCreateSession('browser-agent-1');

      manager.rekeySession('browser-agent-1', 'hub-agent-1');

      expect(manager.getPage('hub-agent-1')).toBe(originalPage);
    });
  });

  // --------------------------------------------------
  // hasSession
  // --------------------------------------------------
  describe('hasSession', () => {
    it('should return false for an unknown agent', () => {
      expect(manager.hasSession('nonexistent')).toBe(false);
    });

    it('should return true after session creation', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');
      expect(manager.hasSession('agent-1')).toBe(true);
    });

    it('should return false after session is closed', async () => {
      manager.start();
      await manager.getOrCreateSession('agent-1');
      await manager.closeSession('agent-1');
      expect(manager.hasSession('agent-1')).toBe(false);
    });
  });
});
