import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '@flo-monster/core';

// Mock AgentContainer
const mockSetHubPersistInfo = vi.fn();
const mockAgent = {
  id: '',
  config: {} as any,
  state: 'stopped',
  hubPersistInfo: null as any,
  setHubPersistInfo: mockSetHubPersistInfo,
};

vi.mock('../../agent/agent-container.js', () => ({
  AgentContainer: vi.fn().mockImplementation((config: any, _state: string) => {
    mockAgent.id = config.id;
    mockAgent.config = config;
    mockAgent.state = _state || 'pending';
    return mockAgent;
  }),
}));

// Mock hub-context (used by createAgent, not adoptHubAgent, but needed for import)
vi.mock('../hub-context.js', () => ({
  generateHubContext: vi.fn().mockReturnValue(null),
}));

// Mock agent-storage (imported by agent-manager)
vi.mock('../../storage/agent-storage.js', () => ({
  getStorageProvider: vi.fn(),
}));

// Mock idb-helpers (imported by agent-manager)
vi.mock('../../utils/idb-helpers.js', () => ({
  openDB: vi.fn(),
  idbPut: vi.fn(),
}));

// Mock the worker bundle raw import
vi.mock('../../agent/worker-bundle.js?raw', () => ({
  default: '',
}));

// Stub crypto.randomUUID
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid-1234' });

import { AgentManager } from '../agent-manager.js';
import { AgentContainer } from '../../agent/agent-container.js';

const mockRegisterAgent = vi.fn();
const mockInitAgentStorage = vi.fn().mockResolvedValue(undefined);
const mockUnregisterAgent = vi.fn();

function createMockMessageRelay() {
  return {
    registerAgent: mockRegisterAgent,
    initAgentStorage: mockInitAgentStorage,
    unregisterAgent: mockUnregisterAgent,
  } as any;
}

function createSessionConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'original-agent-id-from-first-browser',
    name: 'Hub Agent',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    systemPrompt: 'You are a test agent.',
    tools: [{ name: 'dom', description: 'DOM tool', input_schema: { type: 'object' as const } }],
    maxTokens: 8192,
    tokenBudget: 100000,
    costBudgetUsd: 5.0,
    networkPolicy: { mode: 'blocklist' as const, blockedDomains: ['evil.com'] },
    hubConnectionId: 'conn-abc',
    hubSandboxPath: '/sandbox/agent-1',
    ...overrides,
  };
}

const defaultHubPersistInfo = {
  hubAgentId: 'hub-original-agent-id-from-first-browser-12345',
  hubName: 'Hub Agent',
  hubConnectionId: 'conn-abc',
};

describe('AgentManager.adoptHubAgent', () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent.hubPersistInfo = null;
    manager = new AgentManager(createMockMessageRelay());
  });

  it('creates agent with provided config fields', () => {
    const sessionConfig = createSessionConfig();
    const agent = manager.adoptHubAgent({
      config: sessionConfig,
      hubPersistInfo: defaultHubPersistInfo,
    });

    // Verify AgentContainer constructor was called
    expect(AgentContainer).toHaveBeenCalledTimes(1);
    const constructorCall = vi.mocked(AgentContainer).mock.calls[0];
    const passedConfig = constructorCall[0] as AgentConfig;

    // Config fields from session should carry through
    expect(passedConfig.name).toBe('Hub Agent');
    expect(passedConfig.model).toBe('claude-sonnet-4-20250514');
    expect(passedConfig.provider).toBe('anthropic');
    expect(passedConfig.systemPrompt).toBe('You are a test agent.');
    expect(passedConfig.maxTokens).toBe(8192);
    expect(passedConfig.networkPolicy).toEqual({ mode: 'blocklist', blockedDomains: ['evil.com'] });

    expect(agent).toBe(mockAgent);
  });

  it('generates a new local ID instead of using session agentId', () => {
    const sessionConfig = createSessionConfig({ id: 'foreign-browser-agent-999' });
    manager.adoptHubAgent({
      config: sessionConfig,
      hubPersistInfo: defaultHubPersistInfo,
    });

    const constructorCall = vi.mocked(AgentContainer).mock.calls[0];
    const passedConfig = constructorCall[0] as AgentConfig;

    // Should be our new local ID, not the session's original
    expect(passedConfig.id).toBe('agent-test-uuid-1234');
    expect(passedConfig.id).not.toBe('foreign-browser-agent-999');
  });

  it('uses default initial state (pending)', () => {
    manager.adoptHubAgent({
      config: createSessionConfig(),
      hubPersistInfo: defaultHubPersistInfo,
    });

    const constructorCall = vi.mocked(AgentContainer).mock.calls[0];
    // No second argument — uses AgentContainer default ('pending')
    expect(constructorCall[1]).toBeUndefined();
  });

  it('sets hubPersistInfo on the created agent', () => {
    const hubInfo = {
      hubAgentId: 'hub-xyz-99999',
      hubName: 'My Hub Agent',
      hubConnectionId: 'conn-xyz',
    };

    manager.adoptHubAgent({
      config: createSessionConfig(),
      hubPersistInfo: hubInfo,
    });

    expect(mockSetHubPersistInfo).toHaveBeenCalledOnce();
    expect(mockSetHubPersistInfo).toHaveBeenCalledWith(hubInfo);
  });

  it('registers agent in message relay', () => {
    manager.adoptHubAgent({
      config: createSessionConfig(),
      hubPersistInfo: defaultHubPersistInfo,
    });

    expect(mockRegisterAgent).toHaveBeenCalledOnce();
    expect(mockRegisterAgent).toHaveBeenCalledWith(mockAgent);
  });

  it('does NOT call initAgentStorage', () => {
    manager.adoptHubAgent({
      config: createSessionConfig(),
      hubPersistInfo: defaultHubPersistInfo,
    });

    expect(mockInitAgentStorage).not.toHaveBeenCalled();
  });

  it('fires onAgentCreated callback', () => {
    const createdCallback = vi.fn();
    manager.onAgentCreated(createdCallback);

    manager.adoptHubAgent({
      config: createSessionConfig(),
      hubPersistInfo: defaultHubPersistInfo,
    });

    expect(createdCallback).toHaveBeenCalledOnce();
    expect(createdCallback).toHaveBeenCalledWith(mockAgent);
  });

  it('agent appears in getAllAgents()', () => {
    const agent = manager.adoptHubAgent({
      config: createSessionConfig(),
      hubPersistInfo: defaultHubPersistInfo,
    });

    const allAgents = manager.getAllAgents();
    expect(allAgents).toContain(agent);
    expect(allAgents).toHaveLength(1);
  });

  it('config preserves all session fields with new local ID', () => {
    const sessionConfig = createSessionConfig({
      id: 'original-id',
      name: 'Special Agent',
      model: 'claude-opus-4-20250514',
      provider: 'anthropic',
      systemPrompt: 'Custom prompt with hub context.',
      tools: [
        { name: 'dom', description: 'DOM', input_schema: { type: 'object' as const } },
        { name: 'fetch', description: 'Fetch', input_schema: { type: 'object' as const } },
      ],
      maxTokens: 16384,
      tokenBudget: 500000,
      costBudgetUsd: 10.0,
      networkPolicy: { mode: 'allow-all' as const },
      hubConnectionId: 'conn-special',
      hubSandboxPath: '/sandbox/special',
    });

    manager.adoptHubAgent({
      config: sessionConfig,
      hubPersistInfo: defaultHubPersistInfo,
    });

    const constructorCall = vi.mocked(AgentContainer).mock.calls[0];
    const passedConfig = constructorCall[0] as AgentConfig;

    // New local ID
    expect(passedConfig.id).toBe('agent-test-uuid-1234');
    // All other fields preserved from session
    expect(passedConfig.name).toBe('Special Agent');
    expect(passedConfig.model).toBe('claude-opus-4-20250514');
    expect(passedConfig.provider).toBe('anthropic');
    expect(passedConfig.systemPrompt).toBe('Custom prompt with hub context.');
    expect(passedConfig.tools).toHaveLength(2);
    expect(passedConfig.tools![0].name).toBe('dom');
    expect(passedConfig.tools![1].name).toBe('fetch');
    expect(passedConfig.maxTokens).toBe(16384);
    expect(passedConfig.tokenBudget).toBe(500000);
    expect(passedConfig.costBudgetUsd).toBe(10.0);
    expect(passedConfig.networkPolicy).toEqual({ mode: 'allow-all' });
    expect(passedConfig.hubConnectionId).toBe('conn-special');
    expect(passedConfig.hubSandboxPath).toBe('/sandbox/special');
  });
});
