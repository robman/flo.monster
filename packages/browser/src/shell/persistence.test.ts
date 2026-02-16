import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { PersistenceLayer } from './persistence.js';
import type { AppSettings, AgentMetadata, PersistedConversationMessage } from './persistence.js';
import type { SavedAgentState } from './agent-manager.js';

describe('PersistenceLayer', () => {
  let persistence: PersistenceLayer;

  beforeEach(async () => {
    // Reset IndexedDB between tests by deleting the known database
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('flo-app');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    persistence = new PersistenceLayer();
    await persistence.open();
  });

  afterEach(() => {
    persistence.close();
  });

  it('open creates the database with 3 stores', async () => {
    // The fact that open() succeeded means the database was created
    // We verify by checking that operations on all three stores work
    const settings = await persistence.getSettings();
    expect(settings).toBeDefined();

    const agents = await persistence.listAgents();
    expect(agents).toEqual([]);

    const conv = await persistence.loadConversation('test');
    expect(conv).toEqual([]);
  });

  it('settings save/load roundtrip', async () => {
    const settings: AppSettings = {
      defaultModel: 'claude-opus-4-20250514',
      defaultBudget: { maxTokens: 8000, maxCostUsd: 1.5 },
      enabledExtensions: ['ext-1', 'ext-2'],
    };

    await persistence.saveSettings(settings);
    const loaded = await persistence.getSettings();

    expect(loaded.defaultModel).toBe('claude-opus-4-20250514');
    expect(loaded.defaultBudget).toEqual({ maxTokens: 8000, maxCostUsd: 1.5 });
    expect(loaded.enabledExtensions).toEqual(['ext-1', 'ext-2']);
  });

  it('settings save/load roundtrip with apiBaseUrl', async () => {
    const settings: AppSettings = {
      defaultModel: 'claude-sonnet-4-20250514',
      enabledExtensions: [],
      apiBaseUrl: 'https://api.flo.monster',
    };

    await persistence.saveSettings(settings);
    const loaded = await persistence.getSettings();

    expect(loaded.apiBaseUrl).toBe('https://api.flo.monster');
  });

  it('getSettings returns undefined apiBaseUrl when not set', async () => {
    const settings: AppSettings = {
      defaultModel: 'claude-sonnet-4-20250514',
      enabledExtensions: [],
    };

    await persistence.saveSettings(settings);
    const loaded = await persistence.getSettings();

    expect(loaded.apiBaseUrl).toBeUndefined();
  });

  it('getSettings returns defaults when empty', async () => {
    const settings = await persistence.getSettings();
    expect(settings.defaultModel).toBe('claude-sonnet-4-20250514');
    expect(settings.enabledExtensions).toEqual([]);
  });

  it('agent save/load roundtrip', async () => {
    const config = {
      id: 'agent-1',
      name: 'Test Agent',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
      tools: [],
      maxTokens: 4096,
    };
    const metadata: AgentMetadata = {
      id: 'agent-1',
      name: 'Test Agent',
      model: 'claude-sonnet-4-20250514',
      createdAt: 1000,
      lastActiveAt: 2000,
      totalCost: 0.05,
      terminated: false,
    };

    await persistence.saveAgent(config, metadata);
    const loaded = await persistence.loadAgent('agent-1');

    expect(loaded).not.toBeNull();
    expect(loaded!.config.name).toBe('Test Agent');
    expect(loaded!.metadata.totalCost).toBe(0.05);
  });

  it('listAgents returns all saved agents', async () => {
    const makeAgent = (id: string) => ({
      config: { id, name: id, model: 'test', tools: [], maxTokens: 4096 },
      metadata: {
        id,
        name: id,
        model: 'test',
        createdAt: 0,
        lastActiveAt: 0,
        totalCost: 0,
        terminated: false,
      },
    });

    const a1 = makeAgent('agent-1');
    const a2 = makeAgent('agent-2');
    await persistence.saveAgent(a1.config, a1.metadata);
    await persistence.saveAgent(a2.config, a2.metadata);

    const list = await persistence.listAgents();
    expect(list).toHaveLength(2);
    expect(
      list
        .map((a) => a.id)
        .sort(),
    ).toEqual(['agent-1', 'agent-2']);
  });

  it('updateAgentMetadata merges updates', async () => {
    const config = { id: 'agent-1', name: 'Test', model: 'test', tools: [], maxTokens: 4096 };
    const metadata: AgentMetadata = {
      id: 'agent-1',
      name: 'Test',
      model: 'test',
      createdAt: 1000,
      lastActiveAt: 1000,
      totalCost: 0,
      terminated: false,
    };

    await persistence.saveAgent(config, metadata);
    await persistence.updateAgentMetadata('agent-1', { totalCost: 0.1, lastActiveAt: 2000 });

    const loaded = await persistence.loadAgent('agent-1');
    expect(loaded!.metadata.totalCost).toBe(0.1);
    expect(loaded!.metadata.lastActiveAt).toBe(2000);
    expect(loaded!.metadata.name).toBe('Test'); // unchanged
  });

  it('deleteAgent removes agent and its conversation', async () => {
    const config = { id: 'agent-1', name: 'Test', model: 'test', tools: [], maxTokens: 4096 };
    const metadata: AgentMetadata = {
      id: 'agent-1',
      name: 'Test',
      model: 'test',
      createdAt: 0,
      lastActiveAt: 0,
      totalCost: 0,
      terminated: false,
    };

    await persistence.saveAgent(config, metadata);
    await persistence.appendMessage('agent-1', {
      role: 'user',
      content: 'Hello',
      timestamp: 1000,
    });

    await persistence.deleteAgent('agent-1');

    expect(await persistence.loadAgent('agent-1')).toBeNull();
    expect(await persistence.loadConversation('agent-1')).toEqual([]);
  });

  it('append/load conversation', async () => {
    const msg1: PersistedConversationMessage = {
      role: 'user',
      content: 'Hello',
      timestamp: 1000,
    };
    const msg2: PersistedConversationMessage = {
      role: 'assistant',
      content: 'Hi there!',
      timestamp: 2000,
      toolCalls: [{ id: 'tc-1', name: 'runjs', input: '{"code":"1+1"}', result: '2' }],
    };

    await persistence.appendMessage('agent-1', msg1);
    await persistence.appendMessage('agent-1', msg2);

    const conv = await persistence.loadConversation('agent-1');
    expect(conv).toHaveLength(2);
    expect(conv[0].role).toBe('user');
    expect(conv[1].role).toBe('assistant');
    expect(conv[1].toolCalls).toHaveLength(1);
  });

  it('clearAll removes all data', async () => {
    // Save some data
    await persistence.saveSettings({
      defaultModel: 'claude-opus-4-20250514',
      enabledExtensions: ['ext-1'],
    });
    const config = { id: 'agent-1', name: 'Test', model: 'test', tools: [], maxTokens: 4096 };
    await persistence.saveAgent(config, {
      id: 'agent-1',
      name: 'Test',
      model: 'test',
      createdAt: 0,
      lastActiveAt: 0,
      totalCost: 0,
      terminated: false,
    });
    await persistence.appendMessage('agent-1', {
      role: 'user',
      content: 'Hello',
      timestamp: 1000,
    });

    await persistence.clearAll();

    // Should get defaults
    const settings = await persistence.getSettings();
    expect(settings.defaultModel).toBe('claude-sonnet-4-20250514');
    expect(await persistence.listAgents()).toEqual([]);
    expect(await persistence.loadConversation('agent-1')).toEqual([]);
  });

  it('exportData/importData roundtrip', async () => {
    // Save data
    await persistence.saveSettings({
      defaultModel: 'claude-opus-4-20250514',
      enabledExtensions: ['ext-1'],
    });
    const config = { id: 'agent-1', name: 'Test', model: 'test', tools: [], maxTokens: 4096 };
    await persistence.saveAgent(config, {
      id: 'agent-1',
      name: 'Test',
      model: 'test',
      createdAt: 1000,
      lastActiveAt: 2000,
      totalCost: 0.05,
      terminated: false,
    });
    await persistence.appendMessage('agent-1', {
      role: 'user',
      content: 'Hello',
      timestamp: 1000,
    });

    // Export
    const exported = await persistence.exportData();
    expect(typeof exported).toBe('string');

    // Clear and import
    await persistence.clearAll();
    await persistence.importData(exported);

    // Verify roundtrip
    const settings = await persistence.getSettings();
    expect(settings.defaultModel).toBe('claude-opus-4-20250514');

    const agents = await persistence.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('agent-1');

    const conv = await persistence.loadConversation('agent-1');
    expect(conv).toHaveLength(1);
  });

  it('loadAgent returns null for nonexistent', async () => {
    const result = await persistence.loadAgent('nonexistent');
    expect(result).toBeNull();
  });

  it('importData rejects non-object data', async () => {
    await expect(persistence.importData('"just a string"')).rejects.toThrow('expected an object');
  });

  it('importData rejects malformed data', async () => {
    await expect(persistence.importData('{"settings":"not-an-array"}')).rejects.toThrow('settings must be an array');
  });

  // === Agent Registry (Reload Persistence) ===

  describe('Agent Registry', () => {
    it('saveAgentRegistry/loadAgentRegistry roundtrip', async () => {
      const agents: SavedAgentState[] = [
        {
          id: 'agent-1',
          name: 'Test Agent',
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'You are helpful',
          tools: [],
          maxTokens: 4096,
          networkPolicy: { mode: 'allow-all' },
          viewState: 'max',
          wasActive: true,
        },
        {
          id: 'agent-2',
          name: 'Second Agent',
          model: 'claude-opus-4-20250514',
          systemPrompt: 'Be concise',
          tools: [],
          maxTokens: 8192,
          networkPolicy: { mode: 'allow-all' },
          viewState: 'chat-only',
          wasActive: false,
        },
      ];

      await persistence.saveAgentRegistry(agents);
      const loaded = await persistence.loadAgentRegistry();

      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe('agent-1');
      expect(loaded[0].name).toBe('Test Agent');
      expect(loaded[0].wasActive).toBe(true);
      expect(loaded[1].id).toBe('agent-2');
      expect(loaded[1].viewState).toBe('chat-only');
    });

    it('loadAgentRegistry returns empty array when no registry exists', async () => {
      const loaded = await persistence.loadAgentRegistry();
      expect(loaded).toEqual([]);
    });

    it('clearAgentRegistry removes saved registry', async () => {
      const agents: SavedAgentState[] = [
        {
          id: 'agent-1',
          name: 'Test',
          model: 'test',
          systemPrompt: '',
          tools: [],
          maxTokens: 4096,
          networkPolicy: { mode: 'allow-all' },
        },
      ];

      await persistence.saveAgentRegistry(agents);
      await persistence.clearAgentRegistry();

      const loaded = await persistence.loadAgentRegistry();
      expect(loaded).toEqual([]);
    });

    it('saveAgentRegistry overwrites previous registry', async () => {
      const agents1: SavedAgentState[] = [
        {
          id: 'agent-1',
          name: 'First',
          model: 'test',
          systemPrompt: '',
          tools: [],
          maxTokens: 4096,
          networkPolicy: { mode: 'allow-all' },
        },
      ];

      const agents2: SavedAgentState[] = [
        {
          id: 'agent-2',
          name: 'Second',
          model: 'test',
          systemPrompt: '',
          tools: [],
          maxTokens: 4096,
          networkPolicy: { mode: 'allow-all' },
        },
      ];

      await persistence.saveAgentRegistry(agents1);
      await persistence.saveAgentRegistry(agents2);

      const loaded = await persistence.loadAgentRegistry();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('agent-2');
    });

    it('preserves optional fields', async () => {
      const agents: SavedAgentState[] = [
        {
          id: 'agent-1',
          name: 'Test',
          model: 'test',
          systemPrompt: '',
          tools: [],
          maxTokens: 4096,
          tokenBudget: 100000,
          costBudgetUsd: 5.0,
          networkPolicy: { mode: 'allowlist', allowedDomains: ['example.com'] },
          hubConnectionId: 'hub-1',
          hubSandboxPath: '/home/user/sandbox',
          viewState: 'ui-only',
          wasActive: true,
        },
      ];

      await persistence.saveAgentRegistry(agents);
      const loaded = await persistence.loadAgentRegistry();

      expect(loaded[0].tokenBudget).toBe(100000);
      expect(loaded[0].costBudgetUsd).toBe(5.0);
      expect(loaded[0].networkPolicy.mode).toBe('allowlist');
      expect(loaded[0].networkPolicy.allowedDomains).toEqual(['example.com']);
      expect(loaded[0].hubConnectionId).toBe('hub-1');
      expect(loaded[0].hubSandboxPath).toBe('/home/user/sandbox');
    });
  });
});
