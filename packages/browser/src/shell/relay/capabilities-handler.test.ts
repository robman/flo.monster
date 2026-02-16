import { describe, it, expect, vi } from 'vitest';
import { handleCapabilitiesRequest } from './capabilities-handler.js';
import type { AgentContainer } from '../../agent/agent-container.js';

function createMockAgent(overrides: Partial<AgentContainer['config']> = {}): AgentContainer {
  return {
    id: 'agent-1',
    config: {
      id: 'agent-1',
      name: 'Test Agent',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      systemPrompt: '',
      tools: [
        { name: 'dom', description: '', input_schema: { type: 'object' } },
        { name: 'runjs', description: '', input_schema: { type: 'object' } },
      ],
      maxTokens: 4096,
      networkPolicy: { mode: 'allow-all' },
      ...overrides,
    },
  } as unknown as AgentContainer;
}

function createMockTarget() {
  return { postMessage: vi.fn() } as unknown as Window;
}

describe('handleCapabilitiesRequest', () => {
  it('returns merged result with iframeData', () => {
    const agent = createMockAgent();
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-1', agentId: 'agent-1', iframeData: { platform: { browser: 'Chrome' }, viewport: { width: 1920, height: 1080 } } },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    expect(target.postMessage).toHaveBeenCalledOnce();
    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.type).toBe('capabilities_result');
    expect(msg.id).toBe('cap-1');
    expect(msg.result.platform.browser).toBe('Chrome');
    expect(msg.result.viewport.width).toBe(1920);
    expect(msg.result.runtime).toBe('browser');
  });

  it('includes builtin tools from agent config', () => {
    const agent = createMockAgent();
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-2', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.tools.builtin).toEqual(['dom', 'runjs']);
  });

  it('reports hub not connected when no hubClient', () => {
    const agent = createMockAgent();
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-3', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.hubConnected).toBe(false);
    expect(msg.result.tools.hub).toEqual([]);
  });

  it('includes hub tools when hub is connected', () => {
    const agent = createMockAgent({ hubConnectionId: 'hub-1' });
    const target = createMockTarget();

    const mockHubClient = {
      getConnection: vi.fn(() => ({
        tools: [{ name: 'bash' }, { name: 'filesystem' }],
      })),
    };

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-4', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: mockHubClient as any, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.hubConnected).toBe(true);
    expect(msg.result.tools.hub).toEqual(['bash', 'filesystem']);
  });

  it('includes extension tools', () => {
    const agent = createMockAgent();
    const target = createMockTarget();

    const mockExtLoader = {
      getLoaded: vi.fn(() => [
        { name: 'my-ext', version: '1.0', tools: [{ definition: { name: 'custom_tool' } }] },
      ]),
    };

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-5', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: mockExtLoader as any },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.tools.extension).toEqual(['custom_tool']);
    expect(msg.result.extensions).toEqual([{ name: 'my-ext', version: '1.0', tools: ['custom_tool'] }]);
  });

  it('includes permissions from agent config', () => {
    const agent = createMockAgent({ sandboxPermissions: { camera: true } });
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-6', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.permissions.camera).toBe(true);
    expect(msg.result.permissions.microphone).toBe('prompt');
    expect(msg.result.permissions.geolocation).toBe('prompt');
  });

  it('includes agent identity', () => {
    const agent = createMockAgent();
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-7', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.agent).toEqual({ id: 'agent-1', name: 'Test Agent' });
  });

  it('includes network policy', () => {
    const agent = createMockAgent({ networkPolicy: { mode: 'blocklist' } });
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-8', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.networkPolicy).toEqual({ mode: 'blocklist' });
  });

  it('includes limits with token and cost budgets', () => {
    const agent = createMockAgent({ tokenBudget: 50000, costBudgetUsd: 1.5 });
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-9', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.limits.tokenBudget).toBe(50000);
    expect(msg.result.limits.costBudget).toBe(1.5);
    expect(msg.result.limits.maxSubagentDepth).toBe(3);
    expect(msg.result.limits.subagentTimeout).toBe(300000);
  });

  it('includes provider and model', () => {
    const agent = createMockAgent({ provider: 'openai', model: 'gpt-4o' });
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-10', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.provider).toBe('openai');
    expect(msg.result.model).toBe('gpt-4o');
  });

  it('reports runtime as browser when not hub-persisted', () => {
    const agent = createMockAgent();
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-11', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.runtime).toBe('browser');
    expect(msg.result.hubAgentId).toBeUndefined();
    expect(msg.result.hubName).toBeUndefined();
  });

  it('reports runtime as hub when hub-persisted', () => {
    const agent = createMockAgent();
    (agent as any).hubPersistInfo = { hubAgentId: 'hub-agent-1', hubName: 'My Hub', hubConnectionId: 'conn-1' };
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-12', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.runtime).toBe('hub');
    expect(msg.result.hubAgentId).toBe('hub-agent-1');
    expect(msg.result.hubName).toBe('My Hub');
  });

  it('executionMode is browser-only when no hub connected', () => {
    const agent = createMockAgent();
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-13', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.executionMode).toBe('browser-only');
  });

  it('executionMode is browser-with-hub when hub connected but not persisted', () => {
    const agent = createMockAgent({ hubConnectionId: 'hub-1' });
    const target = createMockTarget();

    const mockHubClient = {
      getConnection: vi.fn(() => ({
        tools: [{ name: 'bash' }],
      })),
    };

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-14', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: mockHubClient as any, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.executionMode).toBe('browser-with-hub');
  });

  it('executionMode is hub-with-browser when hub-persisted', () => {
    const agent = createMockAgent();
    (agent as any).hubPersistInfo = { hubAgentId: 'hub-agent-1', hubName: 'My Hub', hubConnectionId: 'conn-1' };
    const target = createMockTarget();

    handleCapabilitiesRequest(
      { type: 'capabilities_request', id: 'cap-15', agentId: 'agent-1', iframeData: {} },
      agent,
      target,
      { hubClient: null, extensionLoader: null },
    );

    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.result.executionMode).toBe('hub-with-browser');
  });
});
