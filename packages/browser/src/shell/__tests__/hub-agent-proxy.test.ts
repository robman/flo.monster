import { describe, it, expect, vi } from 'vitest';
import { HubAgentProxy } from '../hub-agent-proxy.js';
import type { HubAgentProxyCallback } from '../hub-agent-proxy.js';

function createMockHubClient() {
  return {
    getConnection: vi.fn().mockReturnValue({ connected: true }),
    sendAgentAction: vi.fn(),
    sendSubscribeAgent: vi.fn(),
    sendUnsubscribeAgent: vi.fn(),
    restoreAgent: vi.fn().mockResolvedValue({}),
    listHubAgents: vi.fn().mockResolvedValue([]),
  } as any;
}

function createMockSummary(overrides: Partial<any> = {}): any {
  return {
    hubAgentId: 'hub-agent-1',
    agentName: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    state: 'running',
    totalCost: 0.05,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    ...overrides,
  };
}

describe('HubAgentProxy', () => {
  describe('constructor', () => {
    it('populates all fields from summary', () => {
      const summary = createMockSummary({
        hubAgentId: 'agent-xyz',
        agentName: 'My Agent',
        model: 'claude-opus-4-20250514',
        provider: 'anthropic',
        state: 'paused',
        totalCost: 1.23,
        createdAt: 1000,
        lastActivity: 2000,
      });
      const hubClient = createMockHubClient();
      const proxy = new HubAgentProxy(summary, hubClient, 'conn-1');

      expect(proxy.hubAgentId).toBe('agent-xyz');
      expect(proxy.hubConnectionId).toBe('conn-1');
      expect(proxy.agentName).toBe('My Agent');
      expect(proxy.model).toBe('claude-opus-4-20250514');
      expect(proxy.provider).toBe('anthropic');
      expect(proxy.state).toBe('paused');
      expect(proxy.totalCost).toBe(1.23);
      expect(proxy.createdAt).toBe(1000);
      expect(proxy.lastActivity).toBe(2000);
    });
  });

  describe('sendAction', () => {
    it('calls hubClient.sendAgentAction with correct args', async () => {
      const hubClient = createMockHubClient();
      const proxy = new HubAgentProxy(createMockSummary(), hubClient, 'conn-1');

      await proxy.sendAction('pause');

      expect(hubClient.sendAgentAction).toHaveBeenCalledWith('conn-1', 'hub-agent-1', 'pause');
    });

    it('throws when hub is not connected', async () => {
      const hubClient = createMockHubClient();
      hubClient.getConnection.mockReturnValue({ connected: false });
      const proxy = new HubAgentProxy(createMockSummary(), hubClient, 'conn-1');

      await expect(proxy.sendAction('stop')).rejects.toThrow('Hub not connected');
    });

    it('throws when connection does not exist', async () => {
      const hubClient = createMockHubClient();
      hubClient.getConnection.mockReturnValue(undefined);
      const proxy = new HubAgentProxy(createMockSummary(), hubClient, 'conn-1');

      await expect(proxy.sendAction('kill')).rejects.toThrow('Hub not connected');
    });
  });

  describe('subscribe', () => {
    it('calls hubClient.sendSubscribeAgent', () => {
      const hubClient = createMockHubClient();
      const proxy = new HubAgentProxy(createMockSummary(), hubClient, 'conn-1');

      proxy.subscribe();

      expect(hubClient.sendSubscribeAgent).toHaveBeenCalledWith('conn-1', 'hub-agent-1');
    });
  });

  describe('unsubscribe', () => {
    it('calls hubClient.sendUnsubscribeAgent', () => {
      const hubClient = createMockHubClient();
      const proxy = new HubAgentProxy(createMockSummary(), hubClient, 'conn-1');

      proxy.unsubscribe();

      expect(hubClient.sendUnsubscribeAgent).toHaveBeenCalledWith('conn-1', 'hub-agent-1');
    });
  });

  describe('restore', () => {
    it('calls hubClient.restoreAgent and returns result', async () => {
      const hubClient = createMockHubClient();
      const sessionData = { messages: [], model: 'test' };
      hubClient.restoreAgent.mockResolvedValue(sessionData);
      const proxy = new HubAgentProxy(createMockSummary(), hubClient, 'conn-1');

      const result = await proxy.restore();

      expect(hubClient.restoreAgent).toHaveBeenCalledWith('conn-1', 'hub-agent-1');
      expect(result).toBe(sessionData);
    });
  });

  describe('updateState', () => {
    it('updates state property', () => {
      const proxy = new HubAgentProxy(
        createMockSummary({ state: 'running' }),
        createMockHubClient(),
        'conn-1',
      );

      proxy.updateState('paused');

      expect(proxy.state).toBe('paused');
    });

    it('notifies callbacks with state_change event', () => {
      const proxy = new HubAgentProxy(
        createMockSummary({ state: 'running' }),
        createMockHubClient(),
        'conn-1',
      );
      const cb = vi.fn();
      proxy.onEvent(cb);

      proxy.updateState('paused');

      expect(cb).toHaveBeenCalledWith({
        type: 'state_change',
        data: { from: 'running', to: 'paused' },
      });
    });

    it('notifies multiple callbacks', () => {
      const proxy = new HubAgentProxy(
        createMockSummary({ state: 'running' }),
        createMockHubClient(),
        'conn-1',
      );
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      proxy.onEvent(cb1);
      proxy.onEvent(cb2);

      proxy.updateState('stopped');

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe('onEvent', () => {
    it('returns an unsubscribe function', () => {
      const proxy = new HubAgentProxy(
        createMockSummary({ state: 'running' }),
        createMockHubClient(),
        'conn-1',
      );
      const cb = vi.fn();
      const unsub = proxy.onEvent(cb);

      // Should receive events before unsubscribe
      proxy.updateState('paused');
      expect(cb).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsub();

      // Should NOT receive events after unsubscribe
      proxy.updateState('stopped');
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('callback error handling', () => {
    it('does not break other callbacks when one throws', () => {
      const proxy = new HubAgentProxy(
        createMockSummary({ state: 'running' }),
        createMockHubClient(),
        'conn-1',
      );

      const errorCb: HubAgentProxyCallback = () => { throw new Error('callback error'); };
      const goodCb = vi.fn();

      proxy.onEvent(errorCb);
      proxy.onEvent(goodCb);

      // Should not throw and should still call goodCb
      proxy.updateState('paused');

      expect(goodCb).toHaveBeenCalledWith({
        type: 'state_change',
        data: { from: 'running', to: 'paused' },
      });
    });
  });
});
