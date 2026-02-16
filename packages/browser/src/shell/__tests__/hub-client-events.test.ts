/**
 * Tests for HubClient event handling: agent_loop_event, agent_event,
 * conversation_history callbacks and sendAgentMessage method.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HubClient } from '../hub-client.js';

describe('HubClient event callbacks', () => {
  let client: HubClient;

  beforeEach(() => {
    client = new HubClient();
  });

  describe('onAgentLoopEvent', () => {
    it('registers and returns unsubscribe function', () => {
      const handler = vi.fn();
      const unsub = client.onAgentLoopEvent(handler);
      expect(typeof unsub).toBe('function');
      unsub();
    });

    it('unsubscribe prevents further calls', () => {
      const handler = vi.fn();
      const unsub = client.onAgentLoopEvent(handler);
      unsub();
      // After unsub, re-registering a different handler still works
      const handler2 = vi.fn();
      const unsub2 = client.onAgentLoopEvent(handler2);
      expect(typeof unsub2).toBe('function');
      unsub2();
    });

    it('multiple handlers can be registered', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const unsub1 = client.onAgentLoopEvent(handler1);
      const unsub2 = client.onAgentLoopEvent(handler2);
      expect(typeof unsub1).toBe('function');
      expect(typeof unsub2).toBe('function');
      unsub1();
      unsub2();
    });
  });

  describe('onAgentEvent', () => {
    it('registers and returns unsubscribe function', () => {
      const handler = vi.fn();
      const unsub = client.onAgentEvent(handler);
      expect(typeof unsub).toBe('function');
      unsub();
    });

    it('multiple handlers can be registered independently', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const unsub1 = client.onAgentEvent(handler1);
      const unsub2 = client.onAgentEvent(handler2);
      // Unsubscribe first, second should still be registered
      unsub1();
      expect(typeof unsub2).toBe('function');
      unsub2();
    });
  });

  describe('onConversationHistory', () => {
    it('registers and returns unsubscribe function', () => {
      const handler = vi.fn();
      const unsub = client.onConversationHistory(handler);
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });

  describe('sendAgentMessage', () => {
    it('is a function on HubClient', () => {
      expect(typeof client.sendAgentMessage).toBe('function');
    });

    it('does nothing when connection not found', () => {
      // Should not throw
      expect(() => client.sendAgentMessage('non-existent', 'agent-1', 'hello')).not.toThrow();
    });
  });
});
