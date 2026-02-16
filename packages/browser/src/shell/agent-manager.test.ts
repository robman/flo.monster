import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentManager, type SavedAgentState } from './agent-manager.js';
import { MessageRelay } from './message-relay.js';
import type { HubClient, HubConnection } from './hub-client.js';
import type { ToolDef, StoredTemplate, AgentTemplateManifest } from '@flo-monster/core';
import type { TemplateManager } from './template-manager.js';

// Mock MessageRelay
vi.mock('./message-relay.js', () => {
  return {
    MessageRelay: vi.fn().mockImplementation(() => ({
      registerAgent: vi.fn(),
      unregisterAgent: vi.fn(),
      initAgentStorage: vi.fn(async () => {}),
    })),
  };
});

// Helper to create a mock hub client
function createMockHubClient(connections: HubConnection[] = []): HubClient {
  return {
    getConnections: vi.fn(() => connections),
    getConnection: vi.fn((id: string) => connections.find(c => c.id === id)),
    connect: vi.fn(),
    disconnect: vi.fn(),
    executeTool: vi.fn(),
    fetch: vi.fn(),
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onToolsAnnounced: vi.fn(),
    getAllTools: vi.fn(() => connections.flatMap(c => c.tools)),
    findToolHub: vi.fn(),
  } as unknown as HubClient;
}

// Helper to create a hub connection
function createConnection(
  overrides: Partial<HubConnection> = {}
): HubConnection {
  return {
    id: 'conn-1',
    name: 'Test Hub',
    url: 'ws://localhost:3002',
    connected: true,
    tools: [],
    ...overrides,
  };
}

// Mock AgentContainer to avoid iframe/worker issues in tests
vi.mock('../agent/agent-container.js', () => {
  return {
    AgentContainer: vi.fn().mockImplementation((config) => ({
      id: config.id,
      config,
      state: 'pending',
      customSrcdoc: null as string | null,
      _viewState: 'max',
      start: vi.fn(async () => {}),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(function(this: any) { this.state = 'stopped'; }),
      kill: vi.fn(function(this: any) { this.state = 'killed'; }),
      restart: vi.fn(function(this: any) { this.state = 'pending'; }),
      terminate: vi.fn(function(this: any) { this.state = 'killed'; }),
      sendUserMessage: vi.fn(),
      onEvent: vi.fn(() => () => {}),
      getIframeElement: vi.fn(() => null),
      updateConfig: vi.fn(),
      showInPane: vi.fn(),
      hideFromPane: vi.fn(),
      setCustomSrcdoc: vi.fn(function(this: any, html: string) {
        this.customSrcdoc = html;
      }),
      getViewState: vi.fn(function(this: any) { return this._viewState; }),
      setViewState: vi.fn(function(this: any, state: string) { this._viewState = state; }),
      setRestorationContext: vi.fn(),
      getRestorationContext: vi.fn(() => null),
    })),
  };
});

// Helper to create a mock template manager
function createMockTemplateManager(templates: Map<string, StoredTemplate> = new Map()): TemplateManager {
  return {
    getTemplate: vi.fn((name: string) => templates.get(name)),
    listTemplates: vi.fn(() => Array.from(templates.values())),
    hasTemplate: vi.fn((name: string) => templates.has(name)),
    installFromUrl: vi.fn(),
    installFromZip: vi.fn(),
    installFromFile: vi.fn(),
    removeTemplate: vi.fn(),
    createFromAgent: vi.fn(),
    exportEntries: vi.fn(),
    importEntries: vi.fn(),
  } as unknown as TemplateManager;
}

// Helper to create a stored template
function createTemplate(
  overrides: Partial<AgentTemplateManifest> & { srcdoc?: string; files?: any[] } = {}
): StoredTemplate {
  const manifest: AgentTemplateManifest = {
    name: 'test-template',
    version: '1.0.0',
    description: 'A test template',
    config: {},
    ...overrides,
  };
  return {
    manifest,
    srcdoc: overrides.srcdoc,
    files: overrides.files ?? [],
    source: { type: 'local' },
    installedAt: Date.now(),
  };
}

// Mock worker code import
vi.mock('../agent/worker-bundle.js?raw', () => {
  return { default: '// mock worker code' };
});

describe('AgentManager', () => {
  let relay: MessageRelay;
  let manager: AgentManager;

  beforeEach(() => {
    relay = new MessageRelay();
    manager = new AgentManager(relay);
  });

  it('creates an agent with default options', () => {
    const agent = manager.createAgent();
    expect(agent).toBeDefined();
    expect(agent.config.name).toBe('Agent 1');
    expect(agent.config.model).toBe('claude-sonnet-4-20250514');
    expect(relay.registerAgent).toHaveBeenCalledWith(agent);
  });

  it('creates an agent with custom options', () => {
    const agent = manager.createAgent({
      name: 'Custom',
      model: 'claude-opus-4-20250514',
      systemPrompt: 'Custom prompt',
    });
    expect(agent.config.name).toBe('Custom');
    expect(agent.config.model).toBe('claude-opus-4-20250514');
    expect(agent.config.systemPrompt).toBe('Custom prompt');
  });

  it('increments agent numbers', () => {
    const a1 = manager.createAgent();
    const a2 = manager.createAgent();
    expect(a1.config.name).toBe('Agent 1');
    expect(a2.config.name).toBe('Agent 2');
  });

  it('getAllAgents returns all created agents', () => {
    manager.createAgent();
    manager.createAgent();
    manager.createAgent();
    expect(manager.getAllAgents()).toHaveLength(3);
  });

  it('getAgent returns specific agent', () => {
    const agent = manager.createAgent();
    expect(manager.getAgent(agent.id)).toBe(agent);
    expect(manager.getAgent('nonexistent')).toBeUndefined();
  });

  it('terminateAgent kills and closes (backward compat)', () => {
    const agent = manager.createAgent();
    manager.terminateAgent(agent.id);
    expect(agent.kill).toHaveBeenCalled();
    expect(relay.unregisterAgent).toHaveBeenCalledWith(agent.id);
    expect(manager.getAgent(agent.id)).toBeUndefined();
  });

  it('switchToAgent sets active agent', () => {
    const agent = manager.createAgent();
    manager.switchToAgent(agent.id);
    expect(manager.getActiveAgent()).toBe(agent);
  });

  it('clearActiveAgent clears active', () => {
    const agent = manager.createAgent();
    manager.switchToAgent(agent.id);
    manager.clearActiveAgent();
    expect(manager.getActiveAgent()).toBeNull();
  });

  it('onAgentCreated fires callback', () => {
    const cb = vi.fn();
    manager.onAgentCreated(cb);
    const agent = manager.createAgent();
    expect(cb).toHaveBeenCalledWith(agent);
  });

  it('onAgentTerminated fires callback on close', () => {
    const cb = vi.fn();
    manager.onAgentTerminated(cb);
    const agent = manager.createAgent();
    manager.terminateAgent(agent.id);
    expect(cb).toHaveBeenCalledWith(agent.id);
  });

  it('onActiveAgentChanged fires on switch and terminate', () => {
    const cb = vi.fn();
    manager.onActiveAgentChanged(cb);
    const agent = manager.createAgent();

    manager.switchToAgent(agent.id);
    expect(cb).toHaveBeenCalledWith(agent);

    manager.terminateAgent(agent.id);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it('unsubscribe works for callbacks', () => {
    const cb = vi.fn();
    const unsub = manager.onAgentCreated(cb);
    unsub();
    manager.createAgent();
    expect(cb).not.toHaveBeenCalled();
  });

  it('getAgentCount returns correct count', () => {
    expect(manager.getAgentCount()).toBe(0);
    manager.createAgent();
    expect(manager.getAgentCount()).toBe(1);
    manager.createAgent();
    expect(manager.getAgentCount()).toBe(2);
  });

  it('callback exception does not break other callbacks', () => {
    const cb1 = vi.fn(() => { throw new Error('cb1 error'); });
    const cb2 = vi.fn();
    manager.onAgentCreated(cb1);
    manager.onAgentCreated(cb2);

    manager.createAgent();

    expect(cb1).toHaveBeenCalled();
    expect(cb2).toHaveBeenCalled();
  });

  describe('killAgent', () => {
    it('keeps agent in map after kill', () => {
      const agent = manager.createAgent();
      manager.killAgent(agent.id);
      expect(agent.kill).toHaveBeenCalled();
      expect(manager.getAgent(agent.id)).toBe(agent);
    });

    it('clears active agent if killed agent was active', () => {
      const cb = vi.fn();
      manager.onActiveAgentChanged(cb);
      const agent = manager.createAgent();
      manager.switchToAgent(agent.id);
      cb.mockClear();

      manager.killAgent(agent.id);
      expect(cb).toHaveBeenCalledWith(null);
      expect(manager.getActiveAgent()).toBeNull();
    });
  });

  describe('stopAgent', () => {
    it('calls agent.stop()', () => {
      const agent = manager.createAgent();
      manager.stopAgent(agent.id);
      expect(agent.stop).toHaveBeenCalled();
    });

    it('is no-op for nonexistent agent', () => {
      // Should not throw
      manager.stopAgent('nonexistent');
    });
  });

  describe('restartAgent', () => {
    it('calls agent.restart()', () => {
      const agent = manager.createAgent();
      // Force killed state so restart works
      (agent as any).state = 'killed';
      manager.restartAgent(agent.id);
      expect(agent.restart).toHaveBeenCalled();
    });

    it('is no-op for nonexistent agent', () => {
      // Should not throw
      manager.restartAgent('nonexistent');
    });
  });

  describe('closeAgent', () => {
    it('removes agent from map', () => {
      const agent = manager.createAgent();
      // Must be in killed/stopped/error state
      (agent as any).state = 'killed';
      manager.closeAgent(agent.id);
      expect(manager.getAgent(agent.id)).toBeUndefined();
      expect(relay.unregisterAgent).toHaveBeenCalledWith(agent.id);
    });

    it('only works for killed/stopped/error states', () => {
      const agent = manager.createAgent();
      // Agent is in 'pending' state -- closeAgent should be a no-op
      manager.closeAgent(agent.id);
      expect(manager.getAgent(agent.id)).toBe(agent);
    });

    it('fires onTerminated callback', () => {
      const cb = vi.fn();
      manager.onAgentTerminated(cb);
      const agent = manager.createAgent();
      (agent as any).state = 'stopped';
      manager.closeAgent(agent.id);
      expect(cb).toHaveBeenCalledWith(agent.id);
    });
  });

  describe('onAgentKilled', () => {
    it('fires callback when agent is killed', () => {
      const cb = vi.fn();
      manager.onAgentKilled(cb);
      const agent = manager.createAgent();
      manager.killAgent(agent.id);
      expect(cb).toHaveBeenCalledWith(agent.id);
    });

    it('returns unsubscribe function', () => {
      const cb = vi.fn();
      const unsub = manager.onAgentKilled(cb);
      unsub();
      const agent = manager.createAgent();
      manager.killAgent(agent.id);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('hub client integration', () => {
    it('setHubClient updates the hub client', () => {
      const hubClient = createMockHubClient();
      expect(manager.getHubClient()).toBeNull();
      manager.setHubClient(hubClient);
      expect(manager.getHubClient()).toBe(hubClient);
    });

    it('accepts hub client in constructor', () => {
      const hubClient = createMockHubClient();
      const managerWithHub = new AgentManager(relay, hubClient);
      expect(managerWithHub.getHubClient()).toBe(hubClient);
    });

    it('does not append hub context when no hub client', () => {
      const agent = manager.createAgent({ systemPrompt: 'Test prompt' });
      expect(agent.config.systemPrompt).toBe('Test prompt');
      expect(agent.config.systemPrompt).not.toContain('Hub Environment');
    });

    it('does not append hub context when hub has no tools', () => {
      const hubClient = createMockHubClient([
        createConnection({ tools: [] }),
      ]);
      manager.setHubClient(hubClient);
      const agent = manager.createAgent({ systemPrompt: 'Test prompt' });
      expect(agent.config.systemPrompt).toBe('Test prompt');
      expect(agent.config.systemPrompt).not.toContain('Hub Environment');
    });

    it('appends hub context to system prompt when hub has tools', () => {
      const tools: ToolDef[] = [
        { name: 'bash', description: 'Execute shell commands', input_schema: { type: 'object' } },
        { name: 'read_file', description: 'Read file contents', input_schema: { type: 'object' } },
      ];
      const hubClient = createMockHubClient([
        createConnection({ tools }),
      ]);
      manager.setHubClient(hubClient);

      const agent = manager.createAgent({ systemPrompt: 'Base prompt' });

      expect(agent.config.systemPrompt).toContain('Base prompt');
      expect(agent.config.systemPrompt).toContain('## Hub Environment');
      expect(agent.config.systemPrompt).toContain('### Available Hub Tools');
      expect(agent.config.systemPrompt).toContain('- bash: Execute shell commands');
      expect(agent.config.systemPrompt).toContain('- read_file: Read file contents');
      expect(agent.config.systemPrompt).toContain('### Working Directory');
    });

    it('uses agent-specific hub connection when hubConnectionId is set', () => {
      const tools1: ToolDef[] = [
        { name: 'tool_a', description: 'Tool A', input_schema: { type: 'object' } },
      ];
      const tools2: ToolDef[] = [
        { name: 'tool_b', description: 'Tool B', input_schema: { type: 'object' } },
      ];
      const hubClient = createMockHubClient([
        createConnection({ id: 'conn-1', tools: tools1 }),
        createConnection({ id: 'conn-2', tools: tools2 }),
      ]);
      manager.setHubClient(hubClient);

      const agent = manager.createAgent({
        systemPrompt: 'Test',
        hubConnectionId: 'conn-2',
      });

      expect(agent.config.systemPrompt).toContain('- tool_b: Tool B');
      expect(agent.config.systemPrompt).not.toContain('tool_a');
    });

    it('uses agent-specific sandbox path when hubSandboxPath is set', () => {
      const tools: ToolDef[] = [
        { name: 'bash', description: 'Run commands', input_schema: { type: 'object' } },
      ];
      const hubClient = createMockHubClient([
        createConnection({ tools }),
      ]);
      manager.setHubClient(hubClient);

      const agent = manager.createAgent({
        systemPrompt: 'Test',
        hubSandboxPath: '/custom/path',
      });

      expect(agent.config.systemPrompt).toContain('Your working directory is: /custom/path');
      expect(agent.config.systemPrompt).not.toContain('~/.flo-monster/sandbox');
    });

    it('stores hubConnectionId and hubSandboxPath in agent config', () => {
      const tools: ToolDef[] = [
        { name: 'bash', description: 'Run commands', input_schema: { type: 'object' } },
      ];
      const hubClient = createMockHubClient([
        createConnection({ tools }),
      ]);
      manager.setHubClient(hubClient);

      const agent = manager.createAgent({
        hubConnectionId: 'my-hub',
        hubSandboxPath: '/my/sandbox',
      });

      expect(agent.config.hubConnectionId).toBe('my-hub');
      expect(agent.config.hubSandboxPath).toBe('/my/sandbox');
    });
  });

  describe('createFromTemplate', () => {
    it('throws if template not found', async () => {
      const templateManager = createMockTemplateManager();
      await expect(
        manager.createFromTemplate(templateManager, { templateName: 'nonexistent' })
      ).rejects.toThrow('Template not found: nonexistent');
    });

    it('creates agent with template name', async () => {
      const templates = new Map<string, StoredTemplate>();
      templates.set('my-template', createTemplate({ name: 'my-template' }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, { templateName: 'my-template' });

      expect(agent.config.name).toBe('my-template');
      expect(relay.registerAgent).toHaveBeenCalledWith(agent);
    });

    it('uses custom agent name if provided', async () => {
      const templates = new Map<string, StoredTemplate>();
      templates.set('my-template', createTemplate({ name: 'my-template' }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, {
        templateName: 'my-template',
        agentName: 'Custom Agent Name',
      });

      expect(agent.config.name).toBe('Custom Agent Name');
    });

    it('uses template config values', async () => {
      const templates = new Map<string, StoredTemplate>();
      templates.set('configured-template', createTemplate({
        name: 'configured-template',
        config: {
          model: 'claude-opus-4-20250514',
          systemPrompt: 'You are a specialized agent.',
          maxTokens: 8192,
          tokenBudget: 100000,
          costBudgetUsd: 5.0,
        },
      }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, {
        templateName: 'configured-template',
      });

      expect(agent.config.model).toBe('claude-opus-4-20250514');
      expect(agent.config.systemPrompt).toContain('You are a specialized agent.');
      expect(agent.config.maxTokens).toBe(8192);
      expect(agent.config.tokenBudget).toBe(100000);
      expect(agent.config.costBudgetUsd).toBe(5.0);
    });

    it('allows overrides for template config values', async () => {
      const templates = new Map<string, StoredTemplate>();
      templates.set('my-template', createTemplate({
        name: 'my-template',
        config: {
          model: 'claude-opus-4-20250514',
          systemPrompt: 'Template prompt',
          maxTokens: 8192,
        },
      }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, {
        templateName: 'my-template',
        overrides: {
          model: 'claude-sonnet-4-20250514',
          systemPrompt: 'Overridden prompt',
          maxTokens: 4096,
        },
      });

      expect(agent.config.model).toBe('claude-sonnet-4-20250514');
      expect(agent.config.systemPrompt).toContain('Overridden prompt');
      expect(agent.config.maxTokens).toBe(4096);
    });

    it('sets custom srcdoc when template has one', async () => {
      const customHtml = '<html><body><div id="app">Custom UI</div></body></html>';
      const templates = new Map<string, StoredTemplate>();
      templates.set('ui-template', createTemplate({
        name: 'ui-template',
        srcdoc: customHtml,
      }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, {
        templateName: 'ui-template',
      });

      expect(agent.setCustomSrcdoc).toHaveBeenCalledWith(customHtml);
    });

    it('does not set custom srcdoc when template has none', async () => {
      const templates = new Map<string, StoredTemplate>();
      templates.set('simple-template', createTemplate({
        name: 'simple-template',
      }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, {
        templateName: 'simple-template',
      });

      expect(agent.setCustomSrcdoc).not.toHaveBeenCalled();
    });

    it('fires onAgentCreated callback', async () => {
      const cb = vi.fn();
      manager.onAgentCreated(cb);

      const templates = new Map<string, StoredTemplate>();
      templates.set('my-template', createTemplate({ name: 'my-template' }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, {
        templateName: 'my-template',
      });

      expect(cb).toHaveBeenCalledWith(agent);
    });

    it('uses default values when template config is empty', async () => {
      const templates = new Map<string, StoredTemplate>();
      templates.set('minimal-template', createTemplate({
        name: 'minimal-template',
        config: {},
      }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, {
        templateName: 'minimal-template',
      });

      expect(agent.config.model).toBe('claude-sonnet-4-20250514');
      expect(agent.config.maxTokens).toBe(16384);
    });

    it('uses template network policy', async () => {
      const templates = new Map<string, StoredTemplate>();
      templates.set('network-template', createTemplate({
        name: 'network-template',
        config: {
          networkPolicy: {
            mode: 'allowlist',
            allowedDomains: ['api.example.com'],
          },
        },
      }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, {
        templateName: 'network-template',
      });

      expect(agent.config.networkPolicy).toEqual({
        mode: 'allowlist',
        allowedDomains: ['api.example.com'],
      });
    });

    it('initializes template files when template has files', async () => {
      const templates = new Map<string, StoredTemplate>();
      templates.set('file-template', createTemplate({
        name: 'file-template',
        files: [
          { path: 'readme.md', content: '# Hello', encoding: 'utf8' },
          { path: 'nested/data.json', content: '{"key": "value"}', encoding: 'utf8' },
        ],
      }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, {
        templateName: 'file-template',
      });

      expect(agent).toBeDefined();
      expect(agent.config.name).toBe('file-template');
    });

    it('handles templates with base64-encoded files', async () => {
      const templates = new Map<string, StoredTemplate>();
      templates.set('binary-template', createTemplate({
        name: 'binary-template',
        files: [
          { path: 'image.png', content: btoa('fake binary content'), encoding: 'base64' },
        ],
      }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, {
        templateName: 'binary-template',
      });

      expect(agent).toBeDefined();
    });

    it('handles templates with no files', async () => {
      const templates = new Map<string, StoredTemplate>();
      templates.set('no-files-template', createTemplate({
        name: 'no-files-template',
        files: [],
      }));
      const templateManager = createMockTemplateManager(templates);

      const agent = await manager.createFromTemplate(templateManager, {
        templateName: 'no-files-template',
      });

      expect(agent).toBeDefined();
    });
  });

  describe('restoreAgent', () => {
    it('restores agent with saved ID', () => {
      const savedState: SavedAgentState = {
        id: 'agent-saved-123',
        name: 'Saved Agent',
        model: 'claude-opus-4-20250514',
        systemPrompt: 'You are a restored agent.',
        tools: [],
        maxTokens: 8192,
        networkPolicy: { mode: 'allow-all' },
      };

      const agent = manager.restoreAgent(savedState);

      expect(agent.id).toBe('agent-saved-123');
      expect(agent.config.name).toBe('Saved Agent');
      expect(agent.config.model).toBe('claude-opus-4-20250514');
      expect(agent.config.systemPrompt).toBe('You are a restored agent.');
      expect(agent.config.maxTokens).toBe(8192);
    });

    it('registers restored agent with message relay', () => {
      const savedState: SavedAgentState = {
        id: 'agent-saved-456',
        name: 'Test',
        model: 'test',
        systemPrompt: '',
        tools: [],
        maxTokens: 4096,
        networkPolicy: { mode: 'allow-all' },
      };

      const agent = manager.restoreAgent(savedState);

      expect(relay.registerAgent).toHaveBeenCalledWith(agent);
    });

    it('does NOT call initAgentStorage (storage already exists)', () => {
      const savedState: SavedAgentState = {
        id: 'agent-saved-789',
        name: 'Test',
        model: 'test',
        systemPrompt: '',
        tools: [],
        maxTokens: 4096,
        networkPolicy: { mode: 'allow-all' },
      };

      manager.restoreAgent(savedState);

      // initAgentStorage should NOT be called for restored agents
      // because their storage already exists from previous session
      expect(relay.initAgentStorage).not.toHaveBeenCalled();
    });

    it('fires onAgentCreated callback', () => {
      const cb = vi.fn();
      manager.onAgentCreated(cb);

      const savedState: SavedAgentState = {
        id: 'agent-callback-test',
        name: 'Test',
        model: 'test',
        systemPrompt: '',
        tools: [],
        maxTokens: 4096,
        networkPolicy: { mode: 'allow-all' },
      };

      const agent = manager.restoreAgent(savedState);

      expect(cb).toHaveBeenCalledWith(agent);
    });

    it('restores viewState when provided', () => {
      const savedState: SavedAgentState = {
        id: 'agent-view-state',
        name: 'Test',
        model: 'test',
        systemPrompt: '',
        tools: [],
        maxTokens: 4096,
        networkPolicy: { mode: 'allow-all' },
        viewState: 'chat-only',
      };

      const agent = manager.restoreAgent(savedState);

      expect(agent.setViewState).toHaveBeenCalledWith('chat-only', 'user');
    });

    it('preserves optional fields', () => {
      const savedState: SavedAgentState = {
        id: 'agent-full-state',
        name: 'Full Agent',
        model: 'test',
        systemPrompt: 'Test prompt',
        tools: [{ name: 'test', description: 'Test tool', input_schema: { type: 'object' } }],
        maxTokens: 4096,
        tokenBudget: 100000,
        costBudgetUsd: 5.0,
        networkPolicy: { mode: 'allowlist', allowedDomains: ['example.com'] },
        hubConnectionId: 'hub-1',
        hubSandboxPath: '/home/sandbox',
      };

      const agent = manager.restoreAgent(savedState);

      expect(agent.config.tokenBudget).toBe(100000);
      expect(agent.config.costBudgetUsd).toBe(5.0);
      expect(agent.config.networkPolicy?.mode).toBe('allowlist');
      expect(agent.config.hubConnectionId).toBe('hub-1');
      expect(agent.config.hubSandboxPath).toBe('/home/sandbox');
    });

    it('agent is accessible via getAgent', () => {
      const savedState: SavedAgentState = {
        id: 'agent-accessible',
        name: 'Test',
        model: 'test',
        systemPrompt: '',
        tools: [],
        maxTokens: 4096,
        networkPolicy: { mode: 'allow-all' },
      };

      const agent = manager.restoreAgent(savedState);

      expect(manager.getAgent('agent-accessible')).toBe(agent);
      expect(manager.getAgentCount()).toBe(1);
    });
  });

  describe('getSavedState', () => {
    it('extracts saved state from agent', () => {
      const agent = manager.createAgent({
        name: 'Test Agent',
        model: 'claude-opus-4-20250514',
        systemPrompt: 'Custom prompt',
      });

      const savedState = manager.getSavedState(agent);

      expect(savedState.id).toBe(agent.id);
      expect(savedState.name).toBe('Test Agent');
      expect(savedState.model).toBe('claude-opus-4-20250514');
      expect(savedState.systemPrompt).toBe('Custom prompt');
      expect(savedState.tools).toEqual([]);
      expect(savedState.maxTokens).toBe(16384);
      expect(savedState.networkPolicy).toEqual({ mode: 'allow-all' });
    });

    it('marks active agent with wasActive: true', () => {
      const agent = manager.createAgent();
      manager.switchToAgent(agent.id);

      const savedState = manager.getSavedState(agent);

      expect(savedState.wasActive).toBe(true);
    });

    it('marks non-active agent with wasActive: false', () => {
      const agent1 = manager.createAgent();
      const agent2 = manager.createAgent();
      manager.switchToAgent(agent1.id);

      const savedState = manager.getSavedState(agent2);

      expect(savedState.wasActive).toBe(false);
    });

    it('includes viewState from agent', () => {
      const agent = manager.createAgent();
      // Mock getViewState to return a specific state
      (agent.getViewState as any).mockReturnValue('ui-only');

      const savedState = manager.getSavedState(agent);

      expect(savedState.viewState).toBe('ui-only');
    });
  });

  describe('getAllSavedStates', () => {
    it('returns saved states for all agents', () => {
      manager.createAgent({ name: 'Agent A' });
      manager.createAgent({ name: 'Agent B' });
      manager.createAgent({ name: 'Agent C' });

      const savedStates = manager.getAllSavedStates();

      expect(savedStates).toHaveLength(3);
      expect(savedStates.map(s => s.name).sort()).toEqual(['Agent A', 'Agent B', 'Agent C']);
    });

    it('returns empty array when no agents', () => {
      const savedStates = manager.getAllSavedStates();

      expect(savedStates).toEqual([]);
    });

    it('includes wasActive flag for active agent', () => {
      const a1 = manager.createAgent({ name: 'Agent 1' });
      manager.createAgent({ name: 'Agent 2' });
      manager.switchToAgent(a1.id);

      const savedStates = manager.getAllSavedStates();
      const activeState = savedStates.find(s => s.id === a1.id);
      const inactiveState = savedStates.find(s => s.id !== a1.id);

      expect(activeState?.wasActive).toBe(true);
      expect(inactiveState?.wasActive).toBe(false);
    });
  });

  describe('getActiveAgentId', () => {
    it('returns null when no active agent', () => {
      expect(manager.getActiveAgentId()).toBeNull();
    });

    it('returns active agent ID when set', () => {
      const agent = manager.createAgent();
      manager.switchToAgent(agent.id);

      expect(manager.getActiveAgentId()).toBe(agent.id);
    });

    it('returns null after clearActiveAgent', () => {
      const agent = manager.createAgent();
      manager.switchToAgent(agent.id);
      manager.clearActiveAgent();

      expect(manager.getActiveAgentId()).toBeNull();
    });
  });
});
