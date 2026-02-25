/**
 * Tests for InterveneManager — intervention state tracking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InterveneManager, type InterveneSession } from '../intervene-manager.js';

describe('InterveneManager', () => {
  let manager: InterveneManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new InterveneManager();
  });

  afterEach(() => {
    manager.stopSweep();
    vi.useRealTimers();
  });

  describe('requestIntervene', () => {
    it('should grant intervention for an unoccupied agent', () => {
      const session = manager.requestIntervene('agent-1', 'client-1', 'visible');
      expect(session).not.toBeNull();
      expect(session!.agentId).toBe('agent-1');
      expect(session!.clientId).toBe('client-1');
      expect(session!.mode).toBe('visible');
      expect(session!.eventLog).toEqual([]);
    });

    it('should deny intervention when another client is already intervening', () => {
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      const denied = manager.requestIntervene('agent-1', 'client-2', 'private');
      expect(denied).toBeNull();
    });

    it('should allow intervention on different agents simultaneously', () => {
      const s1 = manager.requestIntervene('agent-1', 'client-1', 'visible');
      const s2 = manager.requestIntervene('agent-2', 'client-2', 'private');
      expect(s1).not.toBeNull();
      expect(s2).not.toBeNull();
    });
  });

  describe('release', () => {
    it('should release the session and return it', () => {
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      const released = manager.release('agent-1', 'client-1');
      expect(released).not.toBeNull();
      expect(released!.agentId).toBe('agent-1');
      expect(manager.isIntervening('agent-1')).toBe(false);
    });

    it('should return null if agent is not being intervened', () => {
      const released = manager.release('agent-1', 'client-1');
      expect(released).toBeNull();
    });

    it('should deny release from a different client', () => {
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      const released = manager.release('agent-1', 'client-2');
      expect(released).toBeNull();
      expect(manager.isIntervening('agent-1')).toBe(true);
    });

    it('should allow system release without clientId', () => {
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      const released = manager.release('agent-1');
      expect(released).not.toBeNull();
      expect(manager.isIntervening('agent-1')).toBe(false);
    });
  });

  describe('getSession and isIntervening', () => {
    it('should return session for active intervention', () => {
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      const session = manager.getSession('agent-1');
      expect(session).toBeDefined();
      expect(session!.mode).toBe('visible');
    });

    it('should return undefined for no intervention', () => {
      expect(manager.getSession('agent-1')).toBeUndefined();
    });

    it('isIntervening returns correct state', () => {
      expect(manager.isIntervening('agent-1')).toBe(false);
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      expect(manager.isIntervening('agent-1')).toBe(true);
    });
  });

  describe('logEvent', () => {
    it('should log events in visible mode', () => {
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      manager.logEvent('agent-1', 'click', { x: 100, y: 200 });
      manager.logEvent('agent-1', 'type', { text: 'hello' });

      const session = manager.getSession('agent-1')!;
      expect(session.eventLog).toHaveLength(2);
      expect(session.eventLog[0].kind).toBe('click');
      expect(session.eventLog[0].details).toEqual({ x: 100, y: 200 });
      expect(session.eventLog[1].kind).toBe('type');
    });

    it('should NOT log events in private mode', () => {
      manager.requestIntervene('agent-1', 'client-1', 'private');
      manager.logEvent('agent-1', 'click', { x: 100, y: 200 });
      manager.logEvent('agent-1', 'type', { text: 'password123' });

      const session = manager.getSession('agent-1')!;
      expect(session.eventLog).toHaveLength(0);
    });

    it('should be no-op for non-existent agent', () => {
      // Should not throw
      manager.logEvent('agent-1', 'click', { x: 100, y: 200 });
    });
  });

  describe('touch', () => {
    it('should update lastActivity timestamp', () => {
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      const beforeTouch = manager.getSession('agent-1')!.lastActivity;

      vi.advanceTimersByTime(1000);
      manager.touch('agent-1');

      const afterTouch = manager.getSession('agent-1')!.lastActivity;
      expect(afterTouch).toBeGreaterThan(beforeTouch);
    });

    it('should be no-op for non-existent agent', () => {
      // Should not throw
      manager.touch('agent-1');
    });
  });

  describe('releaseAllForClient', () => {
    it('should release all sessions for a client', () => {
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      manager.requestIntervene('agent-2', 'client-1', 'private');
      manager.requestIntervene('agent-3', 'client-2', 'visible');

      const released = manager.releaseAllForClient('client-1');
      expect(released).toHaveLength(2);
      expect(manager.isIntervening('agent-1')).toBe(false);
      expect(manager.isIntervening('agent-2')).toBe(false);
      expect(manager.isIntervening('agent-3')).toBe(true);
    });

    it('should return empty array when client has no sessions', () => {
      const released = manager.releaseAllForClient('client-1');
      expect(released).toHaveLength(0);
    });
  });

  describe('sweepTimeouts', () => {
    it('should remove sessions past inactivity timeout', () => {
      const mgr = new InterveneManager({ inactivityTimeoutMs: 60_000 });
      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      // Advance past timeout
      vi.advanceTimersByTime(61_000);

      const timedOut = mgr.sweepTimeouts();
      expect(timedOut).toHaveLength(1);
      expect(timedOut[0].agentId).toBe('agent-1');
      expect(mgr.isIntervening('agent-1')).toBe(false);
    });

    it('should NOT remove sessions within timeout window', () => {
      const mgr = new InterveneManager({ inactivityTimeoutMs: 60_000 });
      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      vi.advanceTimersByTime(30_000);

      const timedOut = mgr.sweepTimeouts();
      expect(timedOut).toHaveLength(0);
      expect(mgr.isIntervening('agent-1')).toBe(true);
    });

    it('should call onTimeout callback for timed-out sessions', () => {
      const onTimeout = vi.fn();
      const mgr = new InterveneManager({ inactivityTimeoutMs: 60_000, onTimeout });
      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      vi.advanceTimersByTime(61_000);
      mgr.sweepTimeouts();

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-1' }));
    });

    it('touch resets the inactivity window', () => {
      const mgr = new InterveneManager({ inactivityTimeoutMs: 60_000 });
      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      vi.advanceTimersByTime(50_000);
      mgr.touch('agent-1');

      vi.advanceTimersByTime(50_000);
      // Only 50s since last touch, within 60s timeout
      const timedOut = mgr.sweepTimeouts();
      expect(timedOut).toHaveLength(0);
      expect(mgr.isIntervening('agent-1')).toBe(true);
    });
  });

  describe('startSweep / stopSweep', () => {
    it('should sweep periodically', () => {
      const onTimeout = vi.fn();
      const mgr = new InterveneManager({ inactivityTimeoutMs: 60_000, onTimeout });
      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      mgr.startSweep();

      // Advance past timeout + at least one sweep interval (30s)
      vi.advanceTimersByTime(90_000);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      mgr.stopSweep();
    });

    it('startSweep is idempotent', () => {
      manager.startSweep();
      manager.startSweep(); // Should not create a second interval
      manager.stopSweep();
    });
  });

  describe('sessionCount', () => {
    it('should track active sessions', () => {
      expect(manager.sessionCount).toBe(0);
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      expect(manager.sessionCount).toBe(1);
      manager.requestIntervene('agent-2', 'client-2', 'private');
      expect(manager.sessionCount).toBe(2);
      manager.release('agent-1', 'client-1');
      expect(manager.sessionCount).toBe(1);
    });
  });
});
