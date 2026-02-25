/**
 * Tests for ScreencastManager — CDP screencast wrapping.
 * Playwright CDP sessions are fully mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScreencastManager } from '../screencast-manager.js';
import { decodeFrameHeader } from '../utils/viewport-frame.js';

// --- Mocks ---

function createMockCDPSession() {
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  return {
    send: vi.fn(async () => {}),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    detach: vi.fn(async () => {}),
    // Helper: emit a CDP event
    _emit(event: string, ...args: any[]) {
      for (const handler of listeners.get(event) || []) {
        handler(...args);
      }
    },
    _listeners: listeners,
  };
}

function createMockBrowseSessionManager(sessions: Record<string, { page: any; context: any }> = {}) {
  const manager = {
    getSession: vi.fn((agentId: string) => {
      const s = sessions[agentId];
      if (!s) return undefined;
      return {
        page: s.page,
        context: s.context,
        agentId,
        lastActivity: Date.now(),
      };
    }),
    hasSession: vi.fn((agentId: string) => !!sessions[agentId]),
  };
  return manager as any;
}

function createMockPage(mockCdpSession: ReturnType<typeof createMockCDPSession>) {
  return {
    viewportSize: vi.fn(() => ({ width: 1419, height: 813 })),
    context: vi.fn(() => ({
      newCDPSession: vi.fn(async () => mockCdpSession),
    })),
  };
}

// --- Tests ---

describe('ScreencastManager', () => {
  let cdpSession: ReturnType<typeof createMockCDPSession>;
  let mockPage: ReturnType<typeof createMockPage>;
  let browseSessionManager: any;
  let manager: ScreencastManager;

  beforeEach(() => {
    cdpSession = createMockCDPSession();
    mockPage = createMockPage(cdpSession);
    browseSessionManager = createMockBrowseSessionManager({
      'agent-1': { page: mockPage, context: mockPage.context() },
    });
    manager = new ScreencastManager(browseSessionManager);
  });

  afterEach(async () => {
    // Clean up any active sessions
    await manager.stopScreencast('client-1');
  });

  describe('startScreencast', () => {
    it('should start a CDP screencast and return viewport size', async () => {
      const sendFrame = vi.fn();
      const viewport = await manager.startScreencast('client-1', 'agent-1', sendFrame);

      expect(viewport).toEqual({ width: 1419, height: 813 });
      expect(cdpSession.send).toHaveBeenCalledWith('Page.startScreencast', expect.objectContaining({
        format: 'jpeg',
        quality: 40,
        maxWidth: 1419,
        maxHeight: 813,
        everyNthFrame: 1,
      }));
    });

    it('should throw if no browse session exists', async () => {
      const sendFrame = vi.fn();
      await expect(manager.startScreencast('client-1', 'nonexistent', sendFrame))
        .rejects.toThrow(/No browse session exists/);
    });

    it('should register listener for Page.screencastFrame', async () => {
      const sendFrame = vi.fn();
      await manager.startScreencast('client-1', 'agent-1', sendFrame);

      expect(cdpSession.on).toHaveBeenCalledWith('Page.screencastFrame', expect.any(Function));
    });

    it('should send encoded binary frames when CDP emits screencastFrame', async () => {
      const sendFrame = vi.fn();
      await manager.startScreencast('client-1', 'agent-1', sendFrame);

      // Simulate CDP screencast frame
      const jpegBase64 = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]).toString('base64');
      cdpSession._emit('Page.screencastFrame', {
        data: jpegBase64,
        metadata: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1280, deviceHeight: 720, scrollOffsetX: 0, scrollOffsetY: 0 },
        sessionId: 1,
      });

      expect(sendFrame).toHaveBeenCalledOnce();
      const frame = sendFrame.mock.calls[0][0] as Buffer;

      // Verify frame header
      const header = decodeFrameHeader(frame);
      expect(header.frameNum).toBe(1);
      expect(header.width).toBe(1280);
      expect(header.height).toBe(720);
      expect(header.quality).toBe(40);
    });

    it('should stop existing screencast before starting new one', async () => {
      const sendFrame1 = vi.fn();
      const sendFrame2 = vi.fn();

      await manager.startScreencast('client-1', 'agent-1', sendFrame1);
      await manager.startScreencast('client-1', 'agent-1', sendFrame2);

      // First session should have been stopped (detach called)
      expect(cdpSession.detach).toHaveBeenCalled();
    });
  });

  describe('stopScreencast', () => {
    it('should stop the CDP screencast and detach', async () => {
      const sendFrame = vi.fn();
      await manager.startScreencast('client-1', 'agent-1', sendFrame);

      await manager.stopScreencast('client-1');

      expect(cdpSession.send).toHaveBeenCalledWith('Page.stopScreencast');
      expect(cdpSession.detach).toHaveBeenCalled();
      expect(manager.hasScreencast('client-1')).toBe(false);
    });

    it('should be a no-op for unknown client', async () => {
      await manager.stopScreencast('nonexistent'); // Should not throw
    });

    it('should prevent further frames from being sent', async () => {
      const sendFrame = vi.fn();
      await manager.startScreencast('client-1', 'agent-1', sendFrame);

      await manager.stopScreencast('client-1');

      // Simulate a late CDP frame (shouldn't happen but be defensive)
      const jpegBase64 = Buffer.from([0xFF, 0xD8]).toString('base64');
      cdpSession._emit('Page.screencastFrame', {
        data: jpegBase64,
        metadata: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1280, deviceHeight: 720, scrollOffsetX: 0, scrollOffsetY: 0 },
        sessionId: 2,
      });

      // sendFrame should have been called before stop, not after
      // (the frame listener checks session.active)
      expect(sendFrame).not.toHaveBeenCalled();
    });
  });

  describe('handleAck', () => {
    it('should forward ack to CDP with stored sessionId', async () => {
      const sendFrame = vi.fn();
      await manager.startScreencast('client-1', 'agent-1', sendFrame);

      // Simulate a frame
      const jpegBase64 = Buffer.from([0xFF, 0xD8]).toString('base64');
      cdpSession._emit('Page.screencastFrame', {
        data: jpegBase64,
        metadata: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1280, deviceHeight: 720, scrollOffsetX: 0, scrollOffsetY: 0 },
        sessionId: 42,
      });

      // Client sends ack for frame 1
      manager.handleAck('client-1', 1);

      expect(cdpSession.send).toHaveBeenCalledWith('Page.screencastFrameAck', {
        sessionId: 42,
      });
    });

    it('should be a no-op for unknown client', () => {
      manager.handleAck('nonexistent', 1); // Should not throw
    });
  });

  describe('hasScreencast', () => {
    it('should return false for unknown client', () => {
      expect(manager.hasScreencast('nonexistent')).toBe(false);
    });

    it('should return true for active screencast', async () => {
      const sendFrame = vi.fn();
      await manager.startScreencast('client-1', 'agent-1', sendFrame);
      expect(manager.hasScreencast('client-1')).toBe(true);
    });

    it('should return false after stopping', async () => {
      const sendFrame = vi.fn();
      await manager.startScreencast('client-1', 'agent-1', sendFrame);
      await manager.stopScreencast('client-1');
      expect(manager.hasScreencast('client-1')).toBe(false);
    });
  });

  describe('activeCount', () => {
    it('should track active session count', async () => {
      expect(manager.activeCount).toBe(0);

      const sendFrame = vi.fn();
      await manager.startScreencast('client-1', 'agent-1', sendFrame);
      expect(manager.activeCount).toBe(1);

      await manager.stopScreencast('client-1');
      expect(manager.activeCount).toBe(0);
    });
  });
});
