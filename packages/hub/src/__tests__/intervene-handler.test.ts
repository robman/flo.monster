/**
 * Tests for browse intervention message handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InterveneManager } from '../intervene-manager.js';

describe('Intervention message handler flow', () => {
  let manager: InterveneManager;

  beforeEach(() => {
    manager = new InterveneManager();
  });

  describe('request -> grant -> release flow', () => {
    it('should grant, log events, then release with event log', () => {
      // Request
      const session = manager.requestIntervene('agent-1', 'client-1', 'visible');
      expect(session).not.toBeNull();

      // Simulate events
      manager.logEvent('agent-1', 'click', { x: 100, y: 200 });
      manager.logEvent('agent-1', 'type', { text: 'hello' });
      manager.logEvent('agent-1', 'click', { x: 300, y: 400 });

      // Release
      const released = manager.release('agent-1', 'client-1');
      expect(released).not.toBeNull();
      expect(released!.eventLog).toHaveLength(3);
      expect(released!.eventLog[0].kind).toBe('click');
      expect(released!.eventLog[1].kind).toBe('type');
    });
  });

  describe('deny when already intervening', () => {
    it('should deny a second client', () => {
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      const denied = manager.requestIntervene('agent-1', 'client-2', 'visible');
      expect(denied).toBeNull();
    });
  });

  describe('client disconnect auto-release', () => {
    it('should release all sessions on client disconnect', () => {
      manager.requestIntervene('agent-1', 'client-1', 'visible');
      manager.requestIntervene('agent-2', 'client-1', 'private');

      const released = manager.releaseAllForClient('client-1');
      expect(released).toHaveLength(2);
      expect(manager.isIntervening('agent-1')).toBe(false);
      expect(manager.isIntervening('agent-2')).toBe(false);
    });
  });

  describe('private mode event isolation', () => {
    it('should NOT include events in released session for private mode', () => {
      manager.requestIntervene('agent-1', 'client-1', 'private');

      manager.logEvent('agent-1', 'click', { x: 100, y: 200 });
      manager.logEvent('agent-1', 'type', { text: 'password123' });

      const released = manager.release('agent-1', 'client-1');
      expect(released!.eventLog).toHaveLength(0);
    });
  });

  describe('timeout handling', () => {
    it('should timeout after inactivity', () => {
      vi.useFakeTimers();
      const onTimeout = vi.fn();
      const mgr = new InterveneManager({ inactivityTimeoutMs: 10_000, onTimeout });

      mgr.requestIntervene('agent-1', 'client-1', 'visible');
      vi.advanceTimersByTime(11_000);
      mgr.sweepTimeouts();

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(mgr.isIntervening('agent-1')).toBe(false);
      vi.useRealTimers();
    });
  });
});
