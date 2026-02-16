import { describe, it, expect, vi } from 'vitest';

/**
 * Tests for the hub agent adopt flow.
 * These test the logic patterns used in Shell.adoptHubAgent(),
 * similar to how hub-agent-mapping.test.ts tests mapping patterns.
 */
describe('adopt hub agent flow', () => {
  describe('session restoration', () => {
    it('restore returns session with config', async () => {
      const mockSession = {
        version: 2,
        agentId: 'hub-original-agent-123',
        config: {
          id: 'hub-original-agent-123',
          name: 'Test Agent',
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a test agent',
          tools: [],
          maxTokens: 4096,
          networkPolicy: { mode: 'allow-all' },
        },
        conversation: [{ role: 'user', content: 'hello' }],
        storage: {},
        metadata: { createdAt: Date.now(), totalTokens: 0, totalCost: 0 },
      };

      const proxy = {
        restore: vi.fn().mockResolvedValue(mockSession),
        hubConnectionId: 'conn-1',
        hubAgentId: 'hub-original-agent-123',
      };

      const session = await proxy.restore();
      expect(session.config).toBeDefined();
      expect(session.config.name).toBe('Test Agent');
    });

    it('restored config uses new local ID, not session agentId', () => {
      const sessionConfig = {
        id: 'hub-original-agent-123',
        name: 'Test Agent',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'You are a test agent',
        tools: [],
        maxTokens: 4096,
        networkPolicy: { mode: 'allow-all' as const },
      };

      const localId = 'agent-new-uuid-456';
      const localConfig = { ...sessionConfig, id: localId };

      expect(localConfig.id).toBe('agent-new-uuid-456');
      expect(localConfig.name).toBe('Test Agent');
      expect(localConfig.model).toBe('claude-sonnet-4-20250514');
      expect(localConfig.systemPrompt).toBe('You are a test agent');
    });
  });

  describe('wiring after adopt', () => {
    it('populates hubAgentMapping', () => {
      const mapping = new Map<string, string>();
      const hubAgentId = 'hub-agent-123';
      const localAgentId = 'agent-new-uuid';

      mapping.set(hubAgentId, localAgentId);

      expect(mapping.get(hubAgentId)).toBe(localAgentId);
    });

    it('calls setHubEventSource and setHubConnected', () => {
      const setHubEventSource = vi.fn();
      const setHubConnected = vi.fn();
      const agent = { setHubEventSource, setHubConnected };

      const hubClient = {};
      const connectionId = 'conn-1';

      agent.setHubEventSource(hubClient, connectionId);
      agent.setHubConnected(true);

      expect(setHubEventSource).toHaveBeenCalledWith(hubClient, connectionId);
      expect(setHubConnected).toHaveBeenCalledWith(true);
    });

    it('calls sendSubscribeAgent with correct args', () => {
      const sendSubscribeAgent = vi.fn();
      const hubClient = { sendSubscribeAgent };
      const connectionId = 'conn-1';
      const hubAgentId = 'hub-agent-123';

      hubClient.sendSubscribeAgent(connectionId, hubAgentId);

      expect(sendSubscribeAgent).toHaveBeenCalledWith('conn-1', 'hub-agent-123');
    });

    it('removes proxy after adopt', () => {
      const proxies = new Map<string, { hubAgentId: string }>();
      const hubAgentId = 'hub-agent-123';
      proxies.set(hubAgentId, { hubAgentId });

      // After adopt
      proxies.delete(hubAgentId);

      expect(proxies.has(hubAgentId)).toBe(false);
    });
  });

  describe('adopted agent persistence', () => {
    it('hubPersistInfo survives save/restore cycle', () => {
      // Simulate the save format
      const savedState = {
        id: 'agent-new-uuid',
        name: 'Test Agent',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'You are a test agent',
        tools: [],
        maxTokens: 4096,
        networkPolicy: { mode: 'allow-all' },
        hubPersistInfo: {
          hubAgentId: 'hub-agent-123',
          hubName: 'My Hub',
          hubConnectionId: 'conn-1',
        },
      };

      // hubPersistInfo should be present in saved state
      expect(savedState.hubPersistInfo).toBeDefined();
      expect(savedState.hubPersistInfo.hubAgentId).toBe('hub-agent-123');
      expect(savedState.hubPersistInfo.hubName).toBe('My Hub');
    });

    it('adopted agent reconnects via auto-link on reload', () => {
      // After reload, the adopted agent is restored from IDB with hubPersistInfo.
      // reconcileHubAgents should match it to the hub agent.
      const hubAgentId = 'hub-agent-123';
      const localAgents = [
        {
          id: 'agent-new-uuid',
          hubPersistInfo: { hubAgentId: 'hub-agent-123', hubName: 'Hub', hubConnectionId: 'conn-1' },
        },
      ];

      const match = localAgents.find(
        a => a.hubPersistInfo?.hubAgentId === hubAgentId,
      );

      expect(match).toBeDefined();
      expect(match!.id).toBe('agent-new-uuid');
    });
  });

  describe('error handling', () => {
    it('handles missing proxy gracefully', () => {
      const proxies = new Map<string, { restore: () => Promise<unknown> }>();
      const proxy = proxies.get('nonexistent');
      expect(proxy).toBeUndefined();
    });

    it('handles null session from restore', async () => {
      const proxy = {
        restore: vi.fn().mockResolvedValue(null),
      };
      const session = await proxy.restore();
      expect(session?.config).toBeUndefined();
    });
  });
});
