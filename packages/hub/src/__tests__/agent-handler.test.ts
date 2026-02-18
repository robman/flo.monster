/**
 * Tests for agent-handler functions: createRunnerDeps, setupEventForwarding,
 * handlePersistAgent, handleSendMessage, handleListHubAgents.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import type { SerializedSession, AgentConfig, AgentEvent } from '@flo-monster/core';
import type { ConnectedClient } from '../server.js';
import type { AgentHandlerDeps } from '../handlers/agent-handler.js';
import {
  createRunnerDeps,
  setupEventForwarding,
  handlePersistAgent,
  handleSubscribeAgent,
  handleSendMessage,
  handleListHubAgents,
  handleDomStateUpdate,
  handleRestoreAgent,
  handleStateWriteThrough,
} from '../handlers/agent-handler.js';
import { HeadlessAgentRunner, type RunnerEvent } from '../agent-runner.js';
import { getDefaultConfig } from '../config.js';

const { mockWriteFile, mockMkdir } = vi.hoisted(() => ({
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
  };
});

// ── Helpers ──────────────────────────────────────────────────────────

const mockConfig: AgentConfig = {
  id: 'test-agent',
  name: 'Test Agent',
  model: 'claude-sonnet-4-20250514',
  tools: [],
  maxTokens: 4096,
};

function createMockSession(overrides?: Partial<SerializedSession>): SerializedSession {
  return {
    version: 1,
    agentId: 'agent-123',
    config: { ...mockConfig, ...overrides?.config },
    conversation: [],
    storage: {},
    metadata: {
      createdAt: 1000,
      serializedAt: 2000,
      totalTokens: 100,
      totalCost: 0.01,
    },
    ...overrides,
  };
}

function createMockClient(): ConnectedClient {
  return {
    ws: { send: vi.fn(), readyState: WebSocket.OPEN } as any,
    authenticated: true,
    remoteAddress: '127.0.0.1',
    subscribedAgents: new Set(),
    messageCount: 0,
    messageWindowStart: Date.now(),
  };
}

function createMockDeps(overrides?: Partial<AgentHandlerDeps>): AgentHandlerDeps {
  return {
    hubConfig: getDefaultConfig(),
    clients: new Set<ConnectedClient>(),
    ...overrides,
  };
}

function parseSentMessages(client: ConnectedClient): any[] {
  const sendMock = client.ws.send as ReturnType<typeof vi.fn>;
  return sendMock.mock.calls.map((call: any[]) => JSON.parse(call[0]));
}

// ── Tests ────────────────────────────────────────────────────────────

describe('agent-handler', () => {
  describe('createRunnerDeps', () => {
    it('creates deps with anthropic adapter for default provider', () => {
      const session = createMockSession();
      const deps = createMockDeps();
      const hubAgentId = 'hub-agent-123-1000';

      const result = createRunnerDeps(session, hubAgentId, deps);

      expect(result.adapter).toBeDefined();
      expect(result.adapter.id).toBe('anthropic');
      expect(result.adapter.parseSSEEvent).toBeDefined();
    });

    it('creates deps with openai adapter for openai provider', () => {
      const session = createMockSession({
        config: { ...mockConfig, provider: 'openai' },
      });
      const deps = createMockDeps();
      const hubAgentId = 'hub-agent-123-1000';

      const result = createRunnerDeps(session, hubAgentId, deps);

      expect(result.adapter).toBeDefined();
      expect(result.adapter.id).toBe('openai-chat');
      expect(result.adapter.parseSSEEvent).toBeDefined();
    });

    it('includes agentStore and hubAgentId in returned deps', () => {
      const mockAgentStore = {
        save: vi.fn(),
        load: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
      } as any;
      const session = createMockSession();
      const deps = createMockDeps({ agentStore: mockAgentStore });
      const hubAgentId = 'hub-agent-123-1000';

      const result = createRunnerDeps(session, hubAgentId, deps);

      expect(result.agentStore).toBe(mockAgentStore);
      expect(result.hubAgentId).toBe(hubAgentId);
    });

    it('creates sendApiRequest function', () => {
      const session = createMockSession();
      const deps = createMockDeps();
      const hubAgentId = 'hub-agent-123-1000';

      const result = createRunnerDeps(session, hubAgentId, deps);

      expect(result.sendApiRequest).toBeDefined();
      expect(typeof result.sendApiRequest).toBe('function');
    });

    it('creates executeToolCall function', () => {
      const session = createMockSession();
      const deps = createMockDeps();
      const hubAgentId = 'hub-agent-123-1000';

      const result = createRunnerDeps(session, hubAgentId, deps);

      expect(result.executeToolCall).toBeDefined();
      expect(typeof result.executeToolCall).toBe('function');
    });

    it('passes browserToolRouter through to tool executor', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'routed result' }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const session = createMockSession();
      const deps = createMockDeps({ browserToolRouter: mockRouter as any });
      const hubAgentId = 'hub-agent-123-1000';

      const result = createRunnerDeps(session, hubAgentId, deps);

      // The executor should route browser-only tools through the router
      const toolResult = await result.executeToolCall('dom', { action: 'create', html: '<p>hi</p>' });
      expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
        hubAgentId,
        'dom',
        { action: 'create', html: '<p>hi</p>' },
      );
      expect(toolResult.content).toBe('routed result');
    });

    it('returns browser-only error when no browserToolRouter provided', async () => {
      const session = createMockSession();
      const deps = createMockDeps(); // no browserToolRouter
      const hubAgentId = 'hub-agent-123-1000';

      const result = createRunnerDeps(session, hubAgentId, deps);

      const toolResult = await result.executeToolCall('view_state', {});
      expect(toolResult.is_error).toBe(true);
      expect(toolResult.content).toContain('browser-only tool');
    });
  });

  describe('setupEventForwarding', () => {
    let runner: HeadlessAgentRunner;
    let clients: Set<ConnectedClient>;
    const hubAgentId = 'hub-agent-123-1000';

    beforeEach(async () => {
      runner = new HeadlessAgentRunner(createMockSession());
      clients = new Set();
    });

    it('forwards RunnerEvents to subscribed clients', async () => {
      const client = createMockClient();
      client.subscribedAgents.add(hubAgentId);
      clients.add(client);

      setupEventForwarding(runner, hubAgentId, clients);

      // Start the runner to trigger a state_change event
      await runner.start();

      const messages = parseSentMessages(client);
      const agentEvents = messages.filter((m: any) => m.type === 'agent_event');
      expect(agentEvents.length).toBeGreaterThanOrEqual(1);
      expect(agentEvents[0].agentId).toBe(hubAgentId);
      expect(agentEvents[0].event.type).toBe('state_change');
    });

    it('forwards AgentEvents to subscribed clients', () => {
      const client = createMockClient();
      client.subscribedAgents.add(hubAgentId);
      clients.add(client);

      setupEventForwarding(runner, hubAgentId, clients);

      // Manually trigger an AgentEvent by getting the callback and invoking it
      // Since onAgentEvent registers callbacks, we can fire one via the runner's internals.
      // We use onAgentEvent to capture the registration, then simulate emission
      // by calling the callback chain directly through a second registration.
      // Instead, we'll just trigger an event through the public API indirectly.

      // The runner emits AgentEvents only during _runLoop. Instead, test by registering
      // a callback and manually emitting. We access the internal emitter pattern:
      // runner.onAgentEvent registers callbacks that setupEventForwarding already registered into.
      // So we just need to cause an AgentEvent to fire.
      // Since we can't easily trigger _runLoop in tests, we test by checking that
      // the callback was registered and would forward correctly.

      // Alternative approach: directly test the forwarding by calling onEvent/onAgentEvent
      // and verifying the wiring. The setupEventForwarding function registers callbacks,
      // so we verify via the runner's callback invocation.

      // We can test this by making the runner active (with deps) and calling sendMessage,
      // but that requires a real agentic loop. Instead, let's verify the registration
      // pattern works by creating a runner, registering forwarding, then manually emitting.

      // Access the private emitAgentEvent via a known path: create deps with a mock
      // that will cause the runner to emit agent events.
      // Simpler: just use a fresh runner with deps that has a mock sendApiRequest.

      // Actually, the cleanest approach: create a wrapper runner, set up forwarding,
      // and then test by invoking the onAgentEvent callback directly.
      // HeadlessAgentRunner stores callbacks; setupEventForwarding registers one.
      // We can trigger it by registering our own callback that fires the same event.

      // Simplest: manually call the registered callback chain.
      // runner's agentEventCallbacks are private but we can test the forwarding
      // by registering a second callback to capture what's emitted and matching.

      // Let's use a pragmatic approach: verify by starting the runner (which emits
      // a RunnerEvent), and for AgentEvents test the registration explicitly.
      // We can verify the forwarding setup by checking that when an AgentEvent fires,
      // the client receives an agent_loop_event message.

      // Use a custom runner subclass or monkey-patch for testing:
      const emitAgentEvent = (runner as any).emitAgentEvent.bind(runner);
      const testEvent: AgentEvent = { type: 'text_delta', text: 'hello' };
      emitAgentEvent(testEvent);

      const messages = parseSentMessages(client);
      const loopEvents = messages.filter((m: any) => m.type === 'agent_loop_event');
      expect(loopEvents).toHaveLength(1);
      expect(loopEvents[0].agentId).toBe(hubAgentId);
      expect(loopEvents[0].event.type).toBe('text_delta');
      expect(loopEvents[0].event.text).toBe('hello');
    });

    it('does not forward to unsubscribed clients', async () => {
      const subscribedClient = createMockClient();
      subscribedClient.subscribedAgents.add(hubAgentId);
      clients.add(subscribedClient);

      const unsubscribedClient = createMockClient();
      // Not adding hubAgentId to subscribedAgents
      clients.add(unsubscribedClient);

      setupEventForwarding(runner, hubAgentId, clients);

      // Start runner to trigger state_change event
      await runner.start();

      const subscribedMessages = parseSentMessages(subscribedClient);
      const unsubscribedMessages = parseSentMessages(unsubscribedClient);

      expect(subscribedMessages.length).toBeGreaterThan(0);
      expect(unsubscribedMessages).toHaveLength(0);
    });

    it('handles multiple subscribers', async () => {
      const client1 = createMockClient();
      client1.subscribedAgents.add(hubAgentId);
      clients.add(client1);

      const client2 = createMockClient();
      client2.subscribedAgents.add(hubAgentId);
      clients.add(client2);

      setupEventForwarding(runner, hubAgentId, clients);

      await runner.start();

      const messages1 = parseSentMessages(client1);
      const messages2 = parseSentMessages(client2);

      // Both clients should receive the state_change event
      const events1 = messages1.filter((m: any) => m.type === 'agent_event');
      const events2 = messages2.filter((m: any) => m.type === 'agent_event');

      expect(events1.length).toBeGreaterThanOrEqual(1);
      expect(events2.length).toBeGreaterThanOrEqual(1);
      expect(events1[0].event.type).toBe('state_change');
      expect(events2[0].event.type).toBe('state_change');
    });

    it('does NOT trigger push on loop_complete', async () => {
      const client = createMockClient();
      client.subscribedAgents.add(hubAgentId);
      clients.add(client);

      const mockPushManager = {
        sendPush: vi.fn().mockResolvedValue(undefined),
      };

      setupEventForwarding(runner, hubAgentId, clients, mockPushManager as any);

      // Start the runner to trigger events (state_change, possibly loop_complete)
      await runner.start();

      // loop_complete should NOT trigger push
      expect(mockPushManager.sendPush).not.toHaveBeenCalled();
    });

    it('triggers push on notify_user event', async () => {
      const client = createMockClient();
      client.subscribedAgents.add(hubAgentId);
      clients.add(client);

      const mockPushManager = {
        sendPush: vi.fn().mockResolvedValue(undefined),
      };

      setupEventForwarding(runner, hubAgentId, clients, mockPushManager as any);

      // Start runner first so it's in running state
      await runner.start();

      // Manually emit a notify_user event via emitRunnerEvent
      runner.emitRunnerEvent({ type: 'notify_user', timestamp: Date.now(), data: { message: 'Hello!' } });

      expect(mockPushManager.sendPush).toHaveBeenCalledWith({
        title: 'flo.monster',
        body: 'Hello!',
        tag: `notify-${hubAgentId}`,
        agentId: hubAgentId,
      });
    });
  });

  describe('handlePersistAgent', () => {
    let agents: Map<string, HeadlessAgentRunner>;
    let clients: Set<ConnectedClient>;
    let deps: AgentHandlerDeps;

    beforeEach(() => {
      agents = new Map();
      clients = new Set();
      deps = createMockDeps({ clients });
      mockWriteFile.mockClear();
      mockMkdir.mockClear();
    });

    it('creates runner with deps', async () => {
      const client = createMockClient();
      clients.add(client);

      const session = createMockSession();

      await handlePersistAgent(client, { type: 'persist_agent', session }, agents, clients, deps);

      // Verify a runner was created and stored
      expect(agents.size).toBe(1);
      const [hubAgentId, runner] = [...agents.entries()][0];
      expect(hubAgentId).toMatch(/^hub-agent-123-/);
      expect(runner).toBeInstanceOf(HeadlessAgentRunner);
      expect(runner.getState()).toBe('running');
    });

    it('sends persist_result with success', async () => {
      const client = createMockClient();
      clients.add(client);

      const session = createMockSession();

      await handlePersistAgent(client, { type: 'persist_agent', session }, agents, clients, deps);

      const messages = parseSentMessages(client);
      const persistResults = messages.filter((m: any) => m.type === 'persist_result');
      expect(persistResults.length).toBeGreaterThanOrEqual(1);

      const successResult = persistResults.find((m: any) => m.success === true);
      expect(successResult).toBeDefined();
      expect(successResult.hubAgentId).toMatch(/^hub-agent-123-/);
    });

    it('auto-subscribes the persisting client', async () => {
      const client = createMockClient();
      clients.add(client);

      const session = createMockSession();

      await handlePersistAgent(client, { type: 'persist_agent', session }, agents, clients, deps);

      // Client should be subscribed to the new hub agent
      const [hubAgentId] = [...agents.keys()];
      expect(client.subscribedAgents.has(hubAgentId)).toBe(true);
    });

    it('sends error for invalid session', async () => {
      const client = createMockClient();
      clients.add(client);

      await handlePersistAgent(
        client,
        { type: 'persist_agent', session: {} as any },
        agents,
        clients,
        deps,
      );

      const messages = parseSentMessages(client);
      const persistResult = messages.find((m: any) => m.type === 'persist_result');
      expect(persistResult).toBeDefined();
      expect(persistResult.success).toBe(false);
      expect(persistResult.error).toBe('Invalid session data');
    });

    it('saves to agentStore when provided', async () => {
      const mockAgentStore = {
        save: vi.fn().mockResolvedValue(undefined),
        load: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
      } as any;

      const depsWithStore = createMockDeps({ clients, agentStore: mockAgentStore });
      const client = createMockClient();
      clients.add(client);

      const session = createMockSession();

      await handlePersistAgent(
        client,
        { type: 'persist_agent', session },
        agents,
        clients,
        depsWithStore,
      );

      expect(mockAgentStore.save).toHaveBeenCalledTimes(1);
      const [savedId] = mockAgentStore.save.mock.calls[0];
      expect(savedId).toMatch(/^hub-agent-123-/);
    });

    it('writes api-key.json with mode 0o600 when apiKey provided', async () => {
      const client = createMockClient();
      clients.add(client);

      const session = createMockSession();
      const depsWithStorePath = createMockDeps({
        clients,
        agentStorePath: '/tmp/test-agents',
      });

      await handlePersistAgent(
        client,
        {
          type: 'persist_agent',
          session,
          apiKey: 'sk-test-key-123',
          apiKeyProvider: 'anthropic',
        },
        agents,
        clients,
        depsWithStorePath,
      );

      // Find the writeFile call that writes api-key.json
      const apiKeyWriteCall = mockWriteFile.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].endsWith('api-key.json'),
      );
      expect(apiKeyWriteCall).toBeDefined();
      expect(apiKeyWriteCall![0]).toMatch(/^\/tmp\/test-agents\/hub-agent-123-.*\/api-key\.json$/);
      expect(apiKeyWriteCall![1]).toBe(
        JSON.stringify({ provider: 'anthropic', key: 'sk-test-key-123' }),
      );
      // Verify restrictive file permissions (owner read/write only)
      expect(apiKeyWriteCall![2]).toEqual({
        encoding: 'utf-8',
        mode: 0o600,
      });
    });
  });

  describe('handleSendMessage', () => {
    let agents: Map<string, HeadlessAgentRunner>;
    const hubAgentId = 'hub-test-agent-1000';

    beforeEach(() => {
      agents = new Map();
    });

    it('calls runner.sendMessage', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const sendMessageSpy = vi.spyOn(runner, 'sendMessage');

      const client = createMockClient();

      handleSendMessage(
        client,
        { type: 'send_message', agentId: hubAgentId, content: 'Hello agent' },
        agents,
      );

      expect(sendMessageSpy).toHaveBeenCalledWith('Hello agent');
    });

    it('returns error for non-existent agent', () => {
      const client = createMockClient();

      handleSendMessage(
        client,
        { type: 'send_message', agentId: 'nonexistent-agent', content: 'Hello' },
        agents,
      );

      const messages = parseSentMessages(client);
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('error');
      expect(messages[0].message).toContain('Agent not found');
      expect(messages[0].message).toContain('nonexistent-agent');
    });

    it('returns error when runner throws (not running state)', () => {
      // Create a runner in pending state (not started) -- sendMessage will throw
      const runner = new HeadlessAgentRunner(createMockSession());
      agents.set(hubAgentId, runner);

      const client = createMockClient();

      handleSendMessage(
        client,
        { type: 'send_message', agentId: hubAgentId, content: 'Hello' },
        agents,
      );

      const messages = parseSentMessages(client);
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('error');
      expect(messages[0].message).toContain('Cannot send message in state: pending');
    });
  });

  describe('handleListHubAgents', () => {
    it('includes busy field in response', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();

      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      const hubAgentId = 'hub-test-agent-1000';
      agents.set(hubAgentId, runner);

      const client = createMockClient();

      handleListHubAgents(client, agents);

      const messages = parseSentMessages(client);
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('hub_agents_list');
      expect(messages[0].agents).toHaveLength(1);

      const agentInfo = messages[0].agents[0];
      expect(agentInfo.hubAgentId).toBe(hubAgentId);
      expect(agentInfo.agentName).toBe('Test Agent');
      expect(agentInfo.model).toBe('claude-sonnet-4-20250514');
      expect(agentInfo.provider).toBe('anthropic');
      expect(agentInfo.state).toBe('running');
      expect(agentInfo.busy).toBe(false);
      expect(typeof agentInfo.totalCost).toBe('number');
      expect(typeof agentInfo.createdAt).toBe('number');
      expect(typeof agentInfo.lastActivity).toBe('number');
    });

    it('returns empty list when no agents', () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const client = createMockClient();

      handleListHubAgents(client, agents);

      const messages = parseSentMessages(client);
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('hub_agents_list');
      expect(messages[0].agents).toHaveLength(0);
    });

    it('lists multiple agents with correct fields', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();

      const session1 = createMockSession();
      const runner1 = new HeadlessAgentRunner(session1);
      await runner1.start();
      agents.set('hub-agent-1', runner1);

      const session2 = createMockSession({
        agentId: 'agent-456',
        config: { ...mockConfig, name: 'Agent Two', provider: 'openai' },
      });
      const runner2 = new HeadlessAgentRunner(session2);
      await runner2.start();
      runner2.pause();
      agents.set('hub-agent-2', runner2);

      const client = createMockClient();

      handleListHubAgents(client, agents);

      const messages = parseSentMessages(client);
      const agentList = messages[0].agents;

      expect(agentList).toHaveLength(2);
      expect(agentList[0].hubAgentId).toBe('hub-agent-1');
      expect(agentList[0].state).toBe('running');
      expect(agentList[1].hubAgentId).toBe('hub-agent-2');
      expect(agentList[1].state).toBe('paused');
      expect(agentList[1].provider).toBe('openai');
    });
  });

  describe('handleSubscribeAgent', () => {
    it('sends agent_state to client', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const client = createMockClient();

      handleSubscribeAgent(client, { type: 'subscribe_agent', agentId: hubAgentId }, agents);

      const messages = parseSentMessages(client);
      const stateMsg = messages.find((m: any) => m.type === 'agent_state');
      expect(stateMsg).toBeDefined();
      expect(stateMsg.agentId).toBe(hubAgentId);
      expect(stateMsg.state).toBe('running');
    });

    it('sends DOM state when available', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();

      const mockDomState = {
        viewportHtml: '<p>Hello</p>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 1000,
      };
      runner.setDomState(mockDomState);
      agents.set(hubAgentId, runner);

      const client = createMockClient();

      handleSubscribeAgent(client, { type: 'subscribe_agent', agentId: hubAgentId }, agents);

      const messages = parseSentMessages(client);
      const domMsg = messages.find((m: any) => m.type === 'restore_dom_state');
      expect(domMsg).toBeDefined();
      expect(domMsg.hubAgentId).toBe(hubAgentId);
      expect(domMsg.domState).toEqual(mockDomState);
    });

    it('does not send DOM state when not available', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const client = createMockClient();

      handleSubscribeAgent(client, { type: 'subscribe_agent', agentId: hubAgentId }, agents);

      const messages = parseSentMessages(client);
      const domMsg = messages.find((m: any) => m.type === 'restore_dom_state');
      expect(domMsg).toBeUndefined();
    });

    it('sends error for unknown agent', () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const client = createMockClient();

      handleSubscribeAgent(client, { type: 'subscribe_agent', agentId: 'nonexistent' }, agents);

      const messages = parseSentMessages(client);
      expect(messages[0].type).toBe('error');
      expect(messages[0].message).toContain('Agent not found');
    });
  });

  describe('handleDomStateUpdate', () => {
    it('stores DOM state in runner', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const client = createMockClient();
      client.subscribedAgents.add(hubAgentId);
      const mockDomState = {
        viewportHtml: '<div>Updated</div>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 2000,
      };

      handleDomStateUpdate(
        client,
        { type: 'dom_state_update', hubAgentId, domState: mockDomState },
        agents,
      );

      expect(runner.getDomState()).toEqual(mockDomState);
    });

    it('persists to agentStore when provided', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const mockStore = {
        save: vi.fn().mockResolvedValue(undefined),
        load: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        init: vi.fn(),
      } as any;

      const client = createMockClient();
      client.subscribedAgents.add(hubAgentId);
      const mockDomState = {
        viewportHtml: '<div>Saved</div>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 3000,
      };

      handleDomStateUpdate(
        client,
        { type: 'dom_state_update', hubAgentId, domState: mockDomState },
        agents,
        mockStore,
      );

      // Wait for async save
      await vi.waitFor(() => {
        expect(mockStore.save).toHaveBeenCalledTimes(1);
      });

      expect(mockStore.save).toHaveBeenCalledWith(
        hubAgentId,
        expect.objectContaining({ agentId: 'agent-123' }),
        expect.objectContaining({ state: 'running', savedAt: expect.any(Number) }),
      );
    });

    it('ignores unknown agent', () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const client = createMockClient();

      // Should not throw
      handleDomStateUpdate(
        client,
        { type: 'dom_state_update', hubAgentId: 'nonexistent', domState: {} },
        agents,
      );
    });

    it('broadcasts restore_dom_state to other subscribers', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const client1 = createMockClient();
      client1.subscribedAgents.add(hubAgentId);
      const client2 = createMockClient();
      client2.subscribedAgents.add(hubAgentId);

      const clients = new Set([client1, client2]);

      const mockDomState = {
        viewportHtml: '<div>Broadcast</div>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 5000,
      };

      handleDomStateUpdate(
        client1,
        { type: 'dom_state_update', hubAgentId, domState: mockDomState },
        agents,
        undefined,
        clients,
      );

      // client2 should receive restore_dom_state
      const client2Messages = parseSentMessages(client2);
      expect(client2Messages).toHaveLength(1);
      expect(client2Messages[0].type).toBe('restore_dom_state');
      expect(client2Messages[0].hubAgentId).toBe(hubAgentId);
      expect(client2Messages[0].domState).toEqual(mockDomState);

      // client1 (the sender) should NOT receive it
      const client1Messages = parseSentMessages(client1);
      expect(client1Messages).toHaveLength(0);
    });

    it('does not broadcast to unsubscribed clients', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const client1 = createMockClient();
      client1.subscribedAgents.add(hubAgentId);
      const client2 = createMockClient();
      // client2 is NOT subscribed

      const clients = new Set([client1, client2]);

      handleDomStateUpdate(
        client1,
        { type: 'dom_state_update', hubAgentId, domState: { viewportHtml: '<div>Test</div>' } },
        agents,
        undefined,
        clients,
      );

      // client2 should NOT receive anything (not subscribed)
      const client2Messages = parseSentMessages(client2);
      expect(client2Messages).toHaveLength(0);
    });

    it('no broadcast when only one subscriber', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const client1 = createMockClient();
      client1.subscribedAgents.add(hubAgentId);

      const clients = new Set([client1]);

      handleDomStateUpdate(
        client1,
        { type: 'dom_state_update', hubAgentId, domState: { viewportHtml: '<div>Solo</div>' } },
        agents,
        undefined,
        clients,
      );

      // client1 is the sender and should be excluded — no messages sent
      const client1Messages = parseSentMessages(client1);
      expect(client1Messages).toHaveLength(0);
    });

    it('ignores dom_state_update from unsubscribed client', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const client = createMockClient();
      // client is NOT subscribed to this agent

      const mockDomState = {
        viewportHtml: '<div>Unauthorized</div>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 9000,
      };

      handleDomStateUpdate(
        client,
        { type: 'dom_state_update', hubAgentId, domState: mockDomState },
        agents,
      );

      // Runner's DOM state should NOT have been updated
      expect(runner.getDomState()).toBeUndefined();
    });
  });

  describe('handleStateWriteThrough — authorization', () => {
    it('ignores state_write_through from unsubscribed client', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const client = createMockClient();
      // client is NOT subscribed to this agent

      const clients = new Set([client]);

      handleStateWriteThrough(
        client,
        { type: 'state_write_through', hubAgentId, key: 'score', value: 42, action: 'set' },
        agents,
        clients,
      );

      // State store should NOT have been updated
      expect(runner.getStateStore().get('score')).toBeUndefined();
    });

    it('processes state_write_through from subscribed client', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const client = createMockClient();
      client.subscribedAgents.add(hubAgentId);

      const clients = new Set([client]);

      handleStateWriteThrough(
        client,
        { type: 'state_write_through', hubAgentId, key: 'score', value: 42, action: 'set' },
        agents,
        clients,
      );

      // State store SHOULD have been updated
      expect(runner.getStateStore().get('score')).toBe(42);
    });
  });

  describe('handleRestoreAgent — authorization', () => {
    it('returns null session for unsubscribed client', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const client = createMockClient();
      // client is NOT subscribed to this agent

      handleRestoreAgent(
        client,
        { type: 'restore_agent', agentId: hubAgentId },
        agents,
      );

      const messages = parseSentMessages(client);
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('restore_session');
      expect(messages[0].session).toBeNull();
    });

    it('returns session for subscribed client', async () => {
      const agents = new Map<string, HeadlessAgentRunner>();
      const hubAgentId = 'hub-test-agent-1000';
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      agents.set(hubAgentId, runner);

      const client = createMockClient();
      client.subscribedAgents.add(hubAgentId);

      handleRestoreAgent(
        client,
        { type: 'restore_agent', agentId: hubAgentId },
        agents,
      );

      const messages = parseSentMessages(client);
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('restore_session');
      expect(messages[0].session).not.toBeNull();
      expect(messages[0].session.agentId).toBe('agent-123');
    });
  });
});
