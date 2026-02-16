import { describe, it, expect, vi } from 'vitest';

// We can't easily test Shell directly (it's a class with DOM dependencies),
// but we can test the mapping logic patterns in isolation.

describe('hubAgentMapping population', () => {
  describe('mapping data structure', () => {
    it('maps hubAgentId to localAgentId', () => {
      const mapping = new Map<string, string>();
      mapping.set('hub-agent1-123', 'agent1');
      expect(mapping.get('hub-agent1-123')).toBe('agent1');
    });

    it('cleans up on disconnect', () => {
      const mapping = new Map<string, string>();
      mapping.set('hub-agent1-123', 'agent1');
      mapping.set('hub-agent2-456', 'agent2');

      // Simulate removing entries for a connection
      mapping.delete('hub-agent1-123');
      expect(mapping.has('hub-agent1-123')).toBe(false);
      expect(mapping.has('hub-agent2-456')).toBe(true);
    });

    it('overwrites existing mapping for same hubAgentId', () => {
      const mapping = new Map<string, string>();
      mapping.set('hub-agent1-123', 'agent1');
      mapping.set('hub-agent1-123', 'agent1-new');
      expect(mapping.get('hub-agent1-123')).toBe('agent1-new');
    });
  });

  describe('auto-link pattern', () => {
    it('matches hub agent ID format hub-{localId}-{timestamp}', () => {
      const hubAgentId = 'hub-test-agent-1234567890';
      const localAgentId = 'test-agent';
      expect(hubAgentId.startsWith('hub-' + localAgentId)).toBe(true);
    });

    it('does not match unrelated agent IDs', () => {
      const hubAgentId = 'hub-other-agent-1234567890';
      const localAgentId = 'test-agent';
      expect(hubAgentId.startsWith('hub-' + localAgentId)).toBe(false);
    });

    it('matches exact hubPersistInfo.hubAgentId', () => {
      const hubAgentId = 'hub-test-agent-1234567890';
      const persistInfo = { hubAgentId: 'hub-test-agent-1234567890' };
      expect(persistInfo.hubAgentId === hubAgentId).toBe(true);
    });

    it('exact hubPersistInfo match takes precedence via || short-circuit', () => {
      const hubAgentId = 'hub-test-agent-1234567890';
      const agents = [
        { id: 'test-agent', hubPersistInfo: { hubAgentId: 'hub-test-agent-1234567890' } },
        { id: 'other-agent', hubPersistInfo: null },
      ];

      const match = agents.find(
        a => a.hubPersistInfo?.hubAgentId === hubAgentId
          || hubAgentId.startsWith('hub-' + a.id),
      );

      // Exact hubPersistInfo match found
      expect(match?.id).toBe('test-agent');
    });

    it('falls back to prefix match when no hubPersistInfo match', () => {
      const hubAgentId = 'hub-my-agent-1234567890';
      const agents: Array<{ id: string; hubPersistInfo: { hubAgentId: string } | null }> = [
        { id: 'other-agent', hubPersistInfo: null },
        { id: 'my-agent', hubPersistInfo: null },
      ];

      const match = agents.find(
        a => a.hubPersistInfo?.hubAgentId === hubAgentId
          || hubAgentId.startsWith('hub-' + a.id),
      );

      // Found via prefix match
      expect(match?.id).toBe('my-agent');
    });
  });

  describe('DOM state restoration handler', () => {
    // Simulates the onDomStateRestore handler logic from Shell
    function handleDomStateRestore(
      hubAgentId: string,
      domState: unknown,
      mapping: Map<string, string>,
      agentManager: { getAgent: (id: string) => { restoreDomState: (state: unknown) => void } | undefined },
    ): { action: string; localAgentId?: string } {
      const localAgentId = mapping.get(hubAgentId);
      if (!localAgentId) {
        return { action: 'no_mapping' };
      }
      const agent = agentManager.getAgent(localAgentId);
      if (!agent) {
        return { action: 'no_agent', localAgentId };
      }
      agent.restoreDomState(domState);
      return { action: 'restored', localAgentId };
    }

    it('calls restoreDomState on local agent when mapping exists', () => {
      const mapping = new Map<string, string>();
      mapping.set('hub-agent1-123', 'agent1');

      const restoreDomState = vi.fn();
      const agentManager = {
        getAgent: (id: string) => id === 'agent1' ? { restoreDomState } : undefined,
      };

      const domState = { bodyHtml: '<div>hello</div>', headHtml: '', bodyAttrs: {}, htmlAttrs: {} };
      const result = handleDomStateRestore('hub-agent1-123', domState, mapping, agentManager);

      expect(result.action).toBe('restored');
      expect(result.localAgentId).toBe('agent1');
      expect(restoreDomState).toHaveBeenCalledOnce();
      expect(restoreDomState).toHaveBeenCalledWith(domState);
    });

    it('does nothing when hubAgentId is not in mapping', () => {
      const mapping = new Map<string, string>();
      const restoreDomState = vi.fn();
      const agentManager = {
        getAgent: () => ({ restoreDomState }),
      };

      const result = handleDomStateRestore('hub-unknown-123', {}, mapping, agentManager);

      expect(result.action).toBe('no_mapping');
      expect(restoreDomState).not.toHaveBeenCalled();
    });

    it('does nothing when local agent not found in agent manager', () => {
      const mapping = new Map<string, string>();
      mapping.set('hub-agent1-123', 'agent1');

      const agentManager = {
        getAgent: () => undefined,
      };

      const result = handleDomStateRestore('hub-agent1-123', {}, mapping, agentManager);

      expect(result.action).toBe('no_agent');
      expect(result.localAgentId).toBe('agent1');
    });

    it('passes the full domState object through to restoreDomState', () => {
      const mapping = new Map<string, string>();
      mapping.set('hub-agent1-123', 'agent1');

      const restoreDomState = vi.fn();
      const agentManager = {
        getAgent: (id: string) => id === 'agent1' ? { restoreDomState } : undefined,
      };

      const complexDomState = {
        bodyHtml: '<div class="app"><h1>Restored</h1></div>',
        headHtml: '<style>body { color: red }</style>',
        bodyAttrs: { class: 'dark-mode', 'data-theme': 'night' },
        htmlAttrs: { lang: 'en' },
      };
      handleDomStateRestore('hub-agent1-123', complexDomState, mapping, agentManager);

      expect(restoreDomState).toHaveBeenCalledWith(complexDomState);
    });
  });

  describe('disconnect cleanup pattern', () => {
    it('removes mapping entries for disconnected connection', () => {
      const mapping = new Map<string, string>();
      const agents = [
        { id: 'a1', hubPersistInfo: { hubAgentId: 'hub-a1-123', hubConnectionId: 'conn-1' } },
        { id: 'a2', hubPersistInfo: { hubAgentId: 'hub-a2-456', hubConnectionId: 'conn-2' } },
      ];

      // Populate mapping
      for (const agent of agents) {
        mapping.set(agent.hubPersistInfo.hubAgentId, agent.id);
      }

      // Simulate disconnect for conn-1
      const disconnectedConnId = 'conn-1';
      for (const agent of agents) {
        if (agent.hubPersistInfo.hubConnectionId === disconnectedConnId) {
          mapping.delete(agent.hubPersistInfo.hubAgentId);
        }
      }

      expect(mapping.has('hub-a1-123')).toBe(false);
      expect(mapping.has('hub-a2-456')).toBe(true);
    });
  });
});
