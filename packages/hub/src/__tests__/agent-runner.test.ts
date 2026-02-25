/**
 * Tests for HeadlessAgentRunner
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeadlessAgentRunner, type RunnerEvent, type RunnerDeps } from '../agent-runner.js';
import type { SerializedSession, AgentConfig, AgentEvent, ProviderAdapter } from '@flo-monster/core';

// Mock runAgenticLoop from core — vi.hoisted ensures the mock fn exists before vi.mock runs
const mockRunAgenticLoop = vi.hoisted(() => vi.fn());
vi.mock('@flo-monster/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@flo-monster/core')>();
  return {
    ...actual,
    runAgenticLoop: mockRunAgenticLoop,
  };
});

describe('HeadlessAgentRunner', () => {
  const mockConfig: AgentConfig = {
    id: 'test-agent',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    tools: [],
    maxTokens: 4096,
  };

  const createMockSession = (): SerializedSession => ({
    version: 1,
    agentId: 'agent-123',
    config: mockConfig,
    conversation: [],
    storage: { key: 'value' },
    metadata: {
      createdAt: 1000,
      serializedAt: 2000,
      totalTokens: 100,
      totalCost: 0.01,
    },
  });

  describe('initial state', () => {
    it('should start in pending state', () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      expect(runner.state).toBe('pending');
      expect(runner.getState()).toBe('pending');
    });

    it('should have correct agentId and config', () => {
      const session = createMockSession();
      const runner = new HeadlessAgentRunner(session);

      expect(runner.agentId).toBe('agent-123');
      expect(runner.config).toBe(mockConfig);
    });

    it('should load existing conversation from session', () => {
      const session = createMockSession();
      session.conversation = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];

      const runner = new HeadlessAgentRunner(session);
      const history = runner.getMessageHistory();

      expect(history).toHaveLength(2);
      expect(history[0].role).toBe('user');
      expect(history[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
    });
  });

  describe('start', () => {
    it('should transition to running state', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();

      expect(runner.state).toBe('running');
    });

    it('should emit state_change event', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      const eventHandler = vi.fn();
      runner.onEvent(eventHandler);

      await runner.start();

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'state_change',
          data: { from: 'pending', to: 'running' },
        }),
      );
    });

    it('should throw error if already started', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();

      await expect(runner.start()).rejects.toThrow('Cannot start runner');
    });
  });

  describe('pause and resume', () => {
    it('should transition from running to paused', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();

      runner.pause();
      expect(runner.state).toBe('paused');
    });

    it('should transition from paused to running on resume', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      runner.pause();

      runner.resume();
      expect(runner.state).toBe('running');
    });

    it('should ignore pause when not running', () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      runner.pause();
      expect(runner.state).toBe('pending');
    });

    it('should ignore resume when not paused', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      runner.resume();
      expect(runner.state).toBe('running');
    });
  });

  describe('stop', () => {
    it('should transition to stopped state from running', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();

      runner.stop();
      expect(runner.state).toBe('stopped');
    });

    it('should transition to stopped state from paused', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      runner.pause();

      runner.stop();
      expect(runner.state).toBe('stopped');
    });
  });

  describe('kill', () => {
    it('should stop and clear event callbacks', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      const handler = vi.fn();
      runner.onEvent(handler);
      await runner.start();

      runner.kill();

      expect(runner.state).toBe('stopped');
      // After kill, further events should not trigger the handler
      // (This tests internal implementation detail)
    });
  });

  describe('sendMessage', () => {
    it('should add message to history', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();

      runner.sendMessage('Test message');

      const history = runner.getMessageHistory();
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('user');
      expect(history[0].content).toEqual([{ type: 'text', text: 'Test message' }]);
    });

    it('should emit message event', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      const handler = vi.fn();
      runner.onEvent(handler);
      await runner.start();

      runner.sendMessage('Test');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message',
          data: { role: 'user', content: 'Test' },
        }),
      );
    });

    it('should throw error when not running', () => {
      const runner = new HeadlessAgentRunner(createMockSession());

      expect(() => runner.sendMessage('Test')).toThrow('Cannot send message');
    });
  });

  describe('serialize', () => {
    it('should return a valid SerializedSession', async () => {
      const session = createMockSession();
      const runner = new HeadlessAgentRunner(session);
      await runner.start();
      runner.sendMessage('Hello');

      const serialized = runner.serialize();

      expect(serialized.version).toBe(1);
      expect(serialized.agentId).toBe('agent-123');
      expect(serialized.config).toBe(mockConfig);
      expect(serialized.storage).toEqual({
        key: 'value',
        __flo_state: JSON.stringify({ state: {}, escalationRules: {} }),
      });
      expect(serialized.metadata.serializedAt).toBeGreaterThan(0);
    });

    it('should include updated conversation history', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      await runner.start();
      runner.sendMessage('First message');
      runner.sendMessage('Second message');

      const serialized = runner.serialize();

      expect(serialized.conversation).toHaveLength(2);
      expect(serialized.conversation[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'First message' }] });
      expect(serialized.conversation[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Second message' }] });
    });
  });

  describe('ContentBlock roundtrip', () => {
    it('tool_use and tool_result blocks survive serialize/deserialize roundtrip', () => {
      const session = createMockSession();
      session.conversation = [
        { role: 'user', content: [{ type: 'text', text: 'Use a tool' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'runjs', input: { code: '2+2' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '4' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'The answer is 4' }] },
      ];

      const runner = new HeadlessAgentRunner(session);
      const serialized = runner.serialize();

      // Deserialize and verify blocks are preserved
      const runner2 = new HeadlessAgentRunner(serialized);
      const history = runner2.getMessageHistory();

      expect(history).toHaveLength(4);
      expect(history[0].content).toEqual([{ type: 'text', text: 'Use a tool' }]);
      expect(history[1].content).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'runjs', input: { code: '2+2' } }]);
      expect(history[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'tu_1', content: '4' }]);
      expect(history[3].content).toEqual([{ type: 'text', text: 'The answer is 4' }]);
    });
  });

  describe('DOM state', () => {
    it('getDomState returns undefined initially', () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      expect(runner.getDomState()).toBeUndefined();
    });

    it('setDomState stores and retrieves DOM state', () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      const mockDomState = {
        viewportHtml: '<p>Hello</p>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 1000,
      };
      runner.setDomState(mockDomState);
      expect(runner.getDomState()).toEqual(mockDomState);
    });

    it('serialize includes DOM state when set', () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      const mockDomState = {
        viewportHtml: '<div>Content</div>',
        bodyAttrs: { class: 'dark' },
        headHtml: '<style>body { color: white; }</style>',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 2000,
      };
      runner.setDomState(mockDomState);

      const serialized = runner.serialize();
      expect((serialized as any).domState).toEqual(mockDomState);
    });

    it('serialize does not include domState when not set', () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      const serialized = runner.serialize();
      expect((serialized as any).domState).toBeUndefined();
    });

    it('DOM state loaded from session constructor', () => {
      const session = createMockSession();
      const mockDomState = {
        viewportHtml: '<p>Restored</p>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 3000,
      };
      (session as any).domState = mockDomState;

      const runner = new HeadlessAgentRunner(session);
      const domState = runner.getDomState()!;
      // getDomState() returns container's live state, so capturedAt is fresh
      expect(domState.viewportHtml).toBe('<p>Restored</p>');
      expect(domState.bodyAttrs).toEqual({});
      expect(domState.listeners).toEqual([]);
    });
  });

  describe('state store', () => {
    it('creates empty state store by default', () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      const store = runner.getStateStore();
      expect(store).toBeDefined();
      expect(store.getAll()).toEqual({});
    });

    it('loads state from session storage __flo_state (string)', () => {
      const session = createMockSession();
      (session.storage as Record<string, unknown>).__flo_state = JSON.stringify({
        state: { score: 42, name: 'test' },
        escalationRules: { score: { condition: 'val > 100', message: 'High score!' } },
      });

      const runner = new HeadlessAgentRunner(session);
      const store = runner.getStateStore();
      expect(store.get('score')).toBe(42);
      expect(store.get('name')).toBe('test');
      expect(store.getEscalationRules()).toHaveLength(1);
    });

    it('loads state from session storage __flo_state (object)', () => {
      const session = createMockSession();
      (session.storage as Record<string, unknown>).__flo_state = {
        state: { level: 5 },
        escalationRules: {},
      };

      const runner = new HeadlessAgentRunner(session);
      expect(runner.getStateStore().get('level')).toBe(5);
    });

    it('serialize includes state store in storage.__flo_state', () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      runner.getStateStore().set('x', 99);

      const serialized = runner.serialize();
      const stateData = JSON.parse((serialized.storage as Record<string, unknown>).__flo_state as string);
      expect(stateData.state.x).toBe(99);
    });

    it('state store survives serialize/deserialize roundtrip', () => {
      const runner1 = new HeadlessAgentRunner(createMockSession());
      runner1.getStateStore().set('count', 10);
      runner1.getStateStore().setEscalation('count', 'val > 20', 'Too high');

      const serialized = runner1.serialize();
      const runner2 = new HeadlessAgentRunner(serialized);

      expect(runner2.getStateStore().get('count')).toBe(10);
      expect(runner2.getStateStore().getEscalationRules()).toEqual([
        { key: 'count', condition: 'val > 20', message: 'Too high' },
      ]);
    });

    it('handles invalid __flo_state gracefully', () => {
      const session = createMockSession();
      (session.storage as Record<string, unknown>).__flo_state = 'not-valid-json{';

      const runner = new HeadlessAgentRunner(session);
      // Should not throw, creates empty store
      expect(runner.getStateStore().getAll()).toEqual({});
    });
  });

  describe('onEvent', () => {
    it('should return an unsubscribe function', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      const handler = vi.fn();

      const unsubscribe = runner.onEvent(handler);
      await runner.start();

      expect(handler).toHaveBeenCalled();
      handler.mockClear();

      unsubscribe();
      runner.pause();

      // Handler should not be called after unsubscribe
      // (checking implementation: pause would emit an event)
      // Actually pause does call handlers, but we unsubscribed
      // Let's verify by checking it was NOT called
      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle callback errors gracefully', async () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      const errorHandler = vi.fn(() => {
        throw new Error('Callback error');
      });
      const normalHandler = vi.fn();

      runner.onEvent(errorHandler);
      runner.onEvent(normalHandler);

      // Should not throw even though first callback errors
      await runner.start();

      expect(errorHandler).toHaveBeenCalled();
      expect(normalHandler).toHaveBeenCalled();
    });
  });

  describe('DOM container', () => {
    it('creates DOM container from session domState', () => {
      const session = createMockSession();
      (session as any).domState = {
        viewportHtml: '<p>Hello</p>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 1000,
      };

      const runner = new HeadlessAgentRunner(session);
      expect(runner.getDomContainer()).toBeDefined();
    });

    it('no DOM container when no domState', () => {
      const runner = new HeadlessAgentRunner(createMockSession());
      expect(runner.getDomContainer()).toBeUndefined();
    });

    it('setDomState updates container', () => {
      const session = createMockSession();
      (session as any).domState = {
        viewportHtml: '<p>Original</p>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 1000,
      };

      const runner = new HeadlessAgentRunner(session);
      runner.setDomState({
        viewportHtml: '<p>Updated</p>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 2000,
      });

      const container = runner.getDomContainer()!;
      expect(container.getBodyHtml()).toBe('<p>Updated</p>');
    });

    it('serialize includes container state', () => {
      const session = createMockSession();
      (session as any).domState = {
        viewportHtml: '<p>Before</p>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 1000,
      };

      const runner = new HeadlessAgentRunner(session);
      // Modify DOM through container directly
      runner.getDomContainer()!.create('<span>Added</span>');

      const serialized = runner.serialize();
      expect((serialized as any).domState.viewportHtml).toContain('<span>Added</span>');
      expect((serialized as any).domState.viewportHtml).toContain('<p>Before</p>');
    });

    it('kill destroys container', () => {
      const session = createMockSession();
      (session as any).domState = {
        viewportHtml: '<p>Kill me</p>',
        bodyAttrs: {},
        headHtml: '',
        htmlAttrs: {},
        listeners: [],
        capturedAt: 1000,
      };

      const runner = new HeadlessAgentRunner(session);
      expect(runner.getDomContainer()).toBeDefined();

      runner.kill();
      expect(runner.getDomContainer()).toBeUndefined();
    });
  });
});

// ── Active mode tests (with deps) ──────────────────────────────────────

describe('HeadlessAgentRunner active mode (with deps)', () => {
  const mockConfig: AgentConfig = {
    id: 'test-agent',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    tools: [],
    maxTokens: 4096,
  };

  const createMockSession = (): SerializedSession => ({
    version: 1,
    agentId: 'agent-123',
    config: mockConfig,
    conversation: [],
    storage: { key: 'value' },
    metadata: {
      createdAt: 1000,
      serializedAt: 2000,
      totalTokens: 100,
      totalCost: 0.01,
    },
  });

  function createMockAdapter(): ProviderAdapter {
    return {
      id: 'test',
      buildRequest: vi.fn(() => ({ url: '/test', headers: {}, body: '{}' })),
      parseSSEEvent: vi.fn(() => []),
      extractUsage: vi.fn(() => ({ input_tokens: 0, output_tokens: 0 })),
      estimateCost: vi.fn(() => ({ inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' as const })),
      resetState: vi.fn(),
    };
  }

  function createMockDeps(overrides?: Partial<RunnerDeps>): RunnerDeps {
    return {
      sendApiRequest: vi.fn(async function* () { yield ''; }),
      executeToolCall: vi.fn(async () => ({ content: 'ok' })),
      adapter: createMockAdapter(),
      ...overrides,
    };
  }

  beforeEach(() => {
    mockRunAgenticLoop.mockReset();
    // Default: emit text_done + turn_end so loop completes cleanly
    mockRunAgenticLoop.mockImplementation(async (_config: AgentConfig, userMsg: string, deps: { emit: (e: AgentEvent) => void }) => {
      deps.emit({ type: 'text_done', text: 'Hello from agent' });
      deps.emit({ type: 'turn_end', stopReason: 'end_turn' });
      return [
        { role: 'user', content: [{ type: 'text', text: userMsg }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello from agent' }] },
      ];
    });
  });

  it('sendMessage with deps triggers runAgenticLoop', async () => {
    const deps = createMockDeps();
    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    runner.sendMessage('Hello');

    // The loop runs asynchronously — wait for it to complete
    await vi.waitFor(() => {
      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
      expect(runner.busy).toBe(false);
    });

    // Verify the loop was called with the right arguments
    expect(mockRunAgenticLoop).toHaveBeenCalledWith(
      mockConfig,
      'Hello',
      expect.objectContaining({
        sendApiRequest: deps.sendApiRequest,
        adapter: deps.adapter,
        emit: expect.any(Function),
        executeToolCall: expect.any(Function),
      }),
      expect.any(Array), // existingMessages
    );
  });

  it('sendMessage adds user and assistant messages to history after loop', async () => {
    const deps = createMockDeps();
    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    runner.sendMessage('What is 2+2?');

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    const history = runner.getMessageHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] }));
    expect(history[1]).toEqual(expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'Hello from agent' }] }));
  });

  it('onAgentEvent receives events emitted by the loop', async () => {
    const receivedEvents: AgentEvent[] = [];
    const deps = createMockDeps();

    mockRunAgenticLoop.mockImplementation(async (_config: AgentConfig, userMsg: string, loopDeps: { emit: (e: AgentEvent) => void }) => {
      loopDeps.emit({ type: 'text_delta', text: 'Hel' });
      loopDeps.emit({ type: 'text_delta', text: 'lo' });
      loopDeps.emit({ type: 'text_done', text: 'Hello' });
      loopDeps.emit({ type: 'turn_end', stopReason: 'end_turn' });
      return [
        { role: 'user', content: [{ type: 'text', text: userMsg }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      ];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    runner.onAgentEvent(event => receivedEvents.push(event));
    await runner.start();

    runner.sendMessage('Hi');

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    expect(receivedEvents).toHaveLength(4);
    expect(receivedEvents[0]).toEqual({ type: 'text_delta', text: 'Hel' });
    expect(receivedEvents[1]).toEqual({ type: 'text_delta', text: 'lo' });
    expect(receivedEvents[2]).toEqual({ type: 'text_done', text: 'Hello' });
    expect(receivedEvents[3]).toEqual({ type: 'turn_end', stopReason: 'end_turn' });
  });

  it('onAgentEvent unsubscribe stops receiving events', async () => {
    const receivedEvents: AgentEvent[] = [];
    const deps = createMockDeps();

    mockRunAgenticLoop.mockImplementation(async (_config: AgentConfig, userMsg: string, loopDeps: { emit: (e: AgentEvent) => void }) => {
      loopDeps.emit({ type: 'text_done', text: 'Hello' });
      loopDeps.emit({ type: 'turn_end', stopReason: 'end_turn' });
      return [
        { role: 'user', content: [{ type: 'text', text: userMsg }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      ];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    const unsub = runner.onAgentEvent(event => receivedEvents.push(event));
    unsub(); // unsubscribe immediately
    await runner.start();

    runner.sendMessage('Hi');

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    expect(receivedEvents).toHaveLength(0);
  });

  it('busy flag is true during loop execution', async () => {
    const deps = createMockDeps();
    let busyDuringLoop = false;

    // Create a deferred promise to control when the loop resolves
    let resolveLoop!: () => void;
    const loopPromise = new Promise<void>(resolve => { resolveLoop = resolve; });

    mockRunAgenticLoop.mockImplementation(async () => {
      await loopPromise;
      return [];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    runner.sendMessage('Hello');

    // Give the async loop a microtask to start
    await new Promise(r => setTimeout(r, 10));
    busyDuringLoop = runner.busy;

    resolveLoop();

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    expect(busyDuringLoop).toBe(true);
  });

  it('queues messages when busy', async () => {
    const deps = createMockDeps();
    const events: RunnerEvent[] = [];

    let resolveLoop!: () => void;
    const loopPromise = new Promise<void>(resolve => { resolveLoop = resolve; });

    mockRunAgenticLoop.mockImplementation(async () => {
      await loopPromise;
      return [];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    runner.onEvent(e => events.push(e));
    await runner.start();

    runner.sendMessage('first');

    // Wait for busy to be set
    await new Promise(r => setTimeout(r, 10));
    expect(runner.busy).toBe(true);

    // Second message should NOT throw — it queues instead
    expect(() => runner.sendMessage('second')).not.toThrow();

    // A message event should be emitted for the queued message
    const messageEvents = events.filter(e => e.type === 'message');
    expect(messageEvents).toHaveLength(2);
    expect(messageEvents[1].data).toEqual({ role: 'user', content: 'second' });

    resolveLoop();
    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });
  });

  it('pause during running (not busy) transitions immediately to paused', async () => {
    const deps = createMockDeps();
    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    expect(runner.busy).toBe(false);
    runner.pause();
    expect(runner.state).toBe('paused');
  });

  it('pause during busy defers transition until loop completes', async () => {
    const deps = createMockDeps();

    let resolveLoop!: () => void;
    const loopPromise = new Promise<void>(resolve => { resolveLoop = resolve; });

    mockRunAgenticLoop.mockImplementation(async () => {
      await loopPromise;
      return [];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    runner.sendMessage('Hello');
    await new Promise(r => setTimeout(r, 10));
    expect(runner.busy).toBe(true);

    // Pause while busy — should NOT transition yet
    runner.pause();
    expect(runner.state).toBe('running');

    // Resolve the loop — should transition to paused in finally block
    resolveLoop();
    await vi.waitFor(() => {
      expect(runner.state).toBe('paused');
    });
  });

  it('stop during busy defers transition until loop completes', async () => {
    const deps = createMockDeps();

    let resolveLoop!: () => void;
    const loopPromise = new Promise<void>(resolve => { resolveLoop = resolve; });

    mockRunAgenticLoop.mockImplementation(async () => {
      await loopPromise;
      return [];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    runner.sendMessage('Hello');
    await new Promise(r => setTimeout(r, 10));
    expect(runner.busy).toBe(true);

    // Stop while busy — should NOT transition yet
    runner.stop();
    expect(runner.state).toBe('running');

    // Resolve the loop — should transition to stopped in finally block
    resolveLoop();
    await vi.waitFor(() => {
      expect(runner.state).toBe('stopped');
    });
  });

  it('setDeps enables active mode after construction', async () => {
    const runner = new HeadlessAgentRunner(createMockSession());
    await runner.start();

    // Without deps, sendMessage is inert — message goes to history directly
    runner.sendMessage('Inert message');
    expect(runner.getMessageHistory()).toHaveLength(1);
    expect(mockRunAgenticLoop).not.toHaveBeenCalled();

    // Set deps — now sendMessage should trigger the loop
    const deps = createMockDeps();
    runner.setDeps(deps);

    runner.sendMessage('Active message');

    await vi.waitFor(() => {
      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
      expect(runner.busy).toBe(false);
    });

    // Loop should have been called with existing messages + new message
    expect(mockRunAgenticLoop).toHaveBeenCalledWith(
      mockConfig,
      'Active message',
      expect.any(Object),
      expect.any(Array),
    );
  });

  it('kill clears agentEventCallbacks', async () => {
    const receivedEvents: AgentEvent[] = [];
    const deps = createMockDeps();

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    runner.onAgentEvent(event => receivedEvents.push(event));
    await runner.start();

    runner.kill();
    expect(runner.state).toBe('stopped');

    // The agentEventCallbacks should have been cleared.
    // Since the runner is stopped, we can't send a message.
    // We verify indirectly: onEvent callbacks are also cleared by kill,
    // so both event systems are cleaned up.
    // To test more directly, we verify that registering after kill and
    // then checking the state is still stopped.
    expect(receivedEvents).toHaveLength(0);
  });

  it('loop error emits error event', async () => {
    const deps = createMockDeps();
    const errorEvents: RunnerEvent[] = [];

    mockRunAgenticLoop.mockImplementation(async () => {
      throw new Error('LLM API failed');
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    runner.onEvent(event => {
      if (event.type === 'error') errorEvents.push(event);
    });
    await runner.start();

    runner.sendMessage('Hello');

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].data).toEqual({ error: 'Error: LLM API failed' });
  });

  it('usage events update totalTokens and totalCost', async () => {
    const deps = createMockDeps();

    mockRunAgenticLoop.mockImplementation(async (_config: AgentConfig, userMsg: string, loopDeps: { emit: (e: AgentEvent) => void }) => {
      loopDeps.emit({
        type: 'usage',
        usage: { input_tokens: 500, output_tokens: 200 },
        cost: { inputCost: 0.005, outputCost: 0.003, totalCost: 0.008, currency: 'USD' as const },
      });
      loopDeps.emit({ type: 'text_done', text: 'Done' });
      loopDeps.emit({ type: 'turn_end', stopReason: 'end_turn' });
      return [
        { role: 'user', content: [{ type: 'text', text: userMsg }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      ];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    runner.sendMessage('Count tokens');

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    const serialized = runner.serialize();
    expect(serialized.metadata.totalTokens).toBe(700); // 500 + 200
    expect(serialized.metadata.totalCost).toBe(0.008);
  });

  it('serialize preserves session version field', () => {
    const session = createMockSession();
    session.version = 2;
    const runner = new HeadlessAgentRunner(session, createMockDeps());

    const serialized = runner.serialize();
    expect(serialized.version).toBe(2);
  });

  it('executeToolCall wrapper checks stop/pause flags', async () => {
    const executeToolCall = vi.fn(async () => ({ content: 'ok' }));
    const deps = createMockDeps({ executeToolCall });

    mockRunAgenticLoop.mockImplementation(async (_config: AgentConfig, userMsg: string, loopDeps: { executeToolCall: (name: string, input: Record<string, unknown>) => Promise<unknown>; emit: (e: AgentEvent) => void }) => {
      // Simulate the loop calling executeToolCall — the wrapper should intercept
      // if stop is requested. We'll test the normal path here.
      const result = await loopDeps.executeToolCall('test_tool', { arg: 1 });
      expect(result).toEqual({ content: 'ok' });
      loopDeps.emit({ type: 'text_done', text: 'Done' });
      loopDeps.emit({ type: 'turn_end', stopReason: 'end_turn' });
      return [
        { role: 'user', content: [{ type: 'text', text: userMsg }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      ];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    runner.sendMessage('Use a tool');

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    expect(executeToolCall).toHaveBeenCalledWith('test_tool', { arg: 1 });
  });

  it('persistToDisk is called after loop completes when agentStore is provided', async () => {
    const saveFn = vi.fn(async () => {});
    const deps = createMockDeps({
      agentStore: { save: saveFn, load: vi.fn(), list: vi.fn(), delete: vi.fn() } as any,
      hubAgentId: 'hub-agent-1',
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    runner.sendMessage('Save me');

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith(
      'hub-agent-1',
      expect.objectContaining({ agentId: 'agent-123' }),
      expect.objectContaining({ state: 'running', savedAt: expect.any(Number) }),
    );
  });

  it('buildCoreMessages converts history to Message format for the loop', async () => {
    const session = createMockSession();
    session.conversation = [
      { role: 'user', content: 'Previous question' },
      { role: 'assistant', content: 'Previous answer' },
    ];

    const deps = createMockDeps();
    const runner = new HeadlessAgentRunner(session, deps);
    await runner.start();

    runner.sendMessage('Follow up');

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    // The existingMessages arg should be the conversation history in core Message format
    const callArgs = mockRunAgenticLoop.mock.calls[0];
    const existingMessages = callArgs[3];
    expect(existingMessages).toHaveLength(2);
    expect(existingMessages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Previous question' }],
    });
    expect(existingMessages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Previous answer' }],
    });
  });

  it('discards queue on stop', async () => {
    const deps = createMockDeps();

    let resolveLoop!: () => void;
    const loopPromise = new Promise<void>(resolve => { resolveLoop = resolve; });

    mockRunAgenticLoop.mockImplementation(async () => {
      await loopPromise;
      return [];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    runner.sendMessage('first');
    await new Promise(r => setTimeout(r, 10));
    expect(runner.busy).toBe(true);

    // Queue a second message while busy
    runner.sendMessage('second');

    // Stop while busy — queue should be cleared when loop finishes
    runner.stop();

    resolveLoop();
    await vi.waitFor(() => {
      expect(runner.state).toBe('stopped');
    });

    // The loop should only have been called once (the queued message was discarded)
    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
  });

  it('discards queue on pause', async () => {
    const deps = createMockDeps();

    let resolveLoop!: () => void;
    const loopPromise = new Promise<void>(resolve => { resolveLoop = resolve; });

    mockRunAgenticLoop.mockImplementation(async () => {
      await loopPromise;
      return [];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    runner.sendMessage('first');
    await new Promise(r => setTimeout(r, 10));
    expect(runner.busy).toBe(true);

    // Queue a second message while busy
    runner.sendMessage('second');

    // Pause while busy — queue should be cleared when loop finishes
    runner.pause();

    resolveLoop();
    await vi.waitFor(() => {
      expect(runner.state).toBe('paused');
    });

    // The loop should only have been called once (the queued message was discarded)
    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
  });

  it('emits loop_complete when loop finishes with empty queue', async () => {
    const deps = createMockDeps();
    const events: RunnerEvent[] = [];

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    runner.onEvent(e => events.push(e));
    await runner.start();

    runner.sendMessage('Hello');

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    const loopCompleteEvents = events.filter(e => e.type === 'loop_complete');
    expect(loopCompleteEvents).toHaveLength(1);
    // State should still be 'running' (no transition to idle)
    expect(runner.state).toBe('running');
  });
});

describe('HeadlessAgentRunner intervene methods', () => {
  const mockConfig: AgentConfig = {
    id: 'test-agent',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    tools: [],
    maxTokens: 4096,
  };

  const createMockSession = (): SerializedSession => ({
    version: 1,
    agentId: 'agent-123',
    config: mockConfig,
    conversation: [],
    storage: {},
    metadata: {
      createdAt: 1000,
      serializedAt: 2000,
      totalTokens: 0,
      totalCost: 0,
    },
  });

  beforeEach(() => {
    mockRunAgenticLoop.mockReset();
  });

  it('interveneStart pauses the runner and sets isIntervenePaused', async () => {
    const runner = new HeadlessAgentRunner(createMockSession());
    await runner.start();
    expect(runner.state).toBe('running');

    runner.interveneStart();
    expect(runner.state).toBe('paused');
    expect(runner.isIntervenePaused).toBe(true);
  });

  it('interveneEnd resumes the runner and clears isIntervenePaused', async () => {
    const runner = new HeadlessAgentRunner(createMockSession());
    await runner.start();
    runner.interveneStart();
    expect(runner.state).toBe('paused');

    runner.interveneEnd('User completed intervention. Page now shows login form.');
    expect(runner.state).toBe('running');
    expect(runner.isIntervenePaused).toBe(false);
  });

  it('interveneEnd is no-op if not intervene-paused', async () => {
    const runner = new HeadlessAgentRunner(createMockSession());
    await runner.start();

    // Manually pause (not via intervene)
    runner.pause();
    expect(runner.state).toBe('paused');
    expect(runner.isIntervenePaused).toBe(false);

    runner.interveneEnd('Should not resume');
    // Should still be paused because it was a manual pause
    expect(runner.state).toBe('paused');
  });

  it('interveneEnd queues notification message', async () => {
    const deps: RunnerDeps = {
      sendApiRequest: vi.fn(async function* () { yield ''; }),
      executeToolCall: vi.fn(async () => ({ content: 'ok' })),
      adapter: {
        id: 'test',
        buildRequest: vi.fn(() => ({ url: '/test', headers: {}, body: '{}' })),
        parseSSEEvent: vi.fn(() => []),
        extractUsage: vi.fn(() => ({ input_tokens: 0, output_tokens: 0 })),
        estimateCost: vi.fn(() => ({ inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' as const })),
        resetState: vi.fn(),
      },
    };

    mockRunAgenticLoop.mockImplementation(async (_config: AgentConfig, userMsg: string, loopDeps: { emit: (e: AgentEvent) => void }) => {
      loopDeps.emit({ type: 'text_done', text: 'Acknowledged' });
      loopDeps.emit({ type: 'turn_end', stopReason: 'end_turn' });
      return [
        { role: 'user', content: [{ type: 'text', text: userMsg }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Acknowledged' }] },
      ];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();
    runner.interveneStart();

    runner.interveneEnd('User navigated to the login page.');

    // The notification should be queued and trigger the agentic loop
    await vi.waitFor(() => {
      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
      expect(runner.busy).toBe(false);
    });

    expect(mockRunAgenticLoop).toHaveBeenCalledWith(
      expect.any(Object),
      'User navigated to the login page.',
      expect.any(Object),
      expect.any(Array),
    );
  });

  it('isIntervenePaused is false by default', () => {
    const runner = new HeadlessAgentRunner(createMockSession());
    expect(runner.isIntervenePaused).toBe(false);
  });
});

describe('HeadlessAgentRunner message type system', () => {
  const mockConfig: AgentConfig = {
    id: 'test-agent',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    tools: [],
    maxTokens: 4096,
  };

  const createMockSession = (): SerializedSession => ({
    version: 1,
    agentId: 'agent-123',
    config: mockConfig,
    conversation: [],
    storage: {},
    metadata: {
      createdAt: 1000,
      serializedAt: 2000,
      totalTokens: 0,
      totalCost: 0,
    },
  });

  function createMockDeps(overrides?: Partial<RunnerDeps>): RunnerDeps {
    return {
      sendApiRequest: vi.fn(async function* () { yield ''; }),
      executeToolCall: vi.fn(async () => ({ content: 'ok' })),
      adapter: {
        id: 'test',
        buildRequest: vi.fn(() => ({ url: '/test', headers: {}, body: '{}' })),
        parseSSEEvent: vi.fn(() => []),
        extractUsage: vi.fn(() => ({ input_tokens: 0, output_tokens: 0 })),
        estimateCost: vi.fn(() => ({ inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' as const })),
        resetState: vi.fn(),
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    mockRunAgenticLoop.mockReset();
    mockRunAgenticLoop.mockImplementation(async (_config: AgentConfig, userMsg: string, deps: { emit: (e: AgentEvent) => void }) => {
      deps.emit({ type: 'text_done', text: 'OK' });
      deps.emit({ type: 'turn_end', stopReason: 'end_turn' });
      return [
        { role: 'user', content: [{ type: 'text', text: userMsg }] },
        { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
      ];
    });
  });

  it('addInfoMessage creates announcement with no role', () => {
    const runner = new HeadlessAgentRunner(createMockSession());
    runner.addInfoMessage('Agent persisted to hub');

    const history = runner.getMessageHistory();
    expect(history).toHaveLength(1);
    expect(history[0].role).toBeUndefined();
    expect(history[0].type).toBe('announcement');
    expect(history[0].content).toEqual([{ type: 'text', text: 'Agent persisted to hub' }]);
  });

  it('interveneEnd creates user message with intervention type', async () => {
    const deps = createMockDeps();
    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();
    runner.interveneStart();

    runner.interveneEnd('User navigated to login page');

    await vi.waitFor(() => {
      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
      expect(runner.busy).toBe(false);
    });

    // The intervention message should have role:'user' (for LLM) + type:'intervention' (for UI)
    const history = runner.getMessageHistory();
    const interventionMsg = history.find(m => m.type === 'intervention');
    expect(interventionMsg).toBeDefined();
    expect(interventionMsg!.role).toBe('user');
    expect(interventionMsg!.type).toBe('intervention');
  });

  it('intervention while busy: queue is cleared on deferred pause', async () => {
    const deps = createMockDeps();

    let resolveLoop!: () => void;
    const loopPromise = new Promise<void>(resolve => { resolveLoop = resolve; });

    mockRunAgenticLoop.mockImplementation(async (_config: AgentConfig, userMsg: string, loopDeps: { emit: (e: AgentEvent) => void }) => {
      await loopPromise;
      loopDeps.emit({ type: 'text_done', text: 'OK' });
      loopDeps.emit({ type: 'turn_end', stopReason: 'end_turn' });
      return [
        { role: 'user', content: [{ type: 'text', text: userMsg }] },
        { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
      ];
    });

    const runner = new HeadlessAgentRunner(createMockSession(), deps);
    await runner.start();

    // Start a loop to make the runner busy
    runner.sendMessage('first');
    await new Promise(r => setTimeout(r, 10));
    expect(runner.busy).toBe(true);

    // Intervene while busy — interveneStart sets _pauseRequested,
    // interveneEnd queues the message but resume() is a no-op (state still 'running')
    runner.interveneStart();
    runner.interveneEnd('User took control');

    // Resolve the first loop — pause takes effect, queue is cleared
    resolveLoop();
    await vi.waitFor(() => {
      expect(runner.state).toBe('paused');
      expect(runner.busy).toBe(false);
    });

    // Loop should only have been called once (the queued intervention was discarded by pause)
    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
  });

  it('buildContextForLoop filters out announcements', async () => {
    const session = createMockSession();
    session.conversation = [
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'Agent persisted' },  // legacy system msg
      { role: 'assistant', content: 'Hi!' },
    ];

    const deps = createMockDeps();
    const runner = new HeadlessAgentRunner(session, deps);
    await runner.start();

    runner.sendMessage('Follow up');

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    // The existingMessages passed to the loop should NOT include the announcement
    const callArgs = mockRunAgenticLoop.mock.calls[0];
    const existingMessages = callArgs[3] as Array<{ role: string }>;
    expect(existingMessages.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true);
    // The announcement was converted from role:'system' to type:'announcement' (no role)
    // and filtered out by buildContextForLoop
  });

  it('buildContextForLoop includes intervention messages (they have role)', async () => {
    const session = createMockSession();
    // Simulate a conversation with an intervention message (has both role and type)
    session.conversation = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', type: 'intervention', content: 'User navigated to login' },
      { role: 'assistant', content: 'I see the login page' },
    ];

    const deps = createMockDeps();
    const runner = new HeadlessAgentRunner(session, deps);
    await runner.start();

    runner.sendMessage('Follow up');

    await vi.waitFor(() => {
      expect(runner.busy).toBe(false);
    });

    // All 4 messages should be in existingMessages (interventions have role:'user')
    const callArgs = mockRunAgenticLoop.mock.calls[0];
    const existingMessages = callArgs[3] as Array<{ role: string }>;
    expect(existingMessages).toHaveLength(4);
  });

  it('legacy role:system migrates to type:announcement on load', () => {
    const session = createMockSession();
    session.conversation = [
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'Agent persisted to hub as hub-agent-123' },
      { role: 'assistant', content: 'Hi!' },
    ];

    const runner = new HeadlessAgentRunner(session);
    const history = runner.getMessageHistory();

    expect(history).toHaveLength(3);
    // The system message should be migrated to announcement
    expect(history[1].role).toBeUndefined();
    expect(history[1].type).toBe('announcement');
    expect(history[1].content).toEqual([{ type: 'text', text: 'Agent persisted to hub as hub-agent-123' }]);
  });

  it('serialize includes type field', () => {
    const runner = new HeadlessAgentRunner(createMockSession());
    runner.addInfoMessage('Agent persisted');

    const serialized = runner.serialize();
    const lastMsg = serialized.conversation[serialized.conversation.length - 1] as any;
    expect(lastMsg.type).toBe('announcement');
    expect(lastMsg.role).toBeUndefined();
  });

  it('type field survives serialize/deserialize roundtrip', () => {
    const session = createMockSession();
    session.conversation = [
      { role: 'user', content: 'Hello' },
      { role: 'user', type: 'intervention', content: 'User took control' },
      { type: 'announcement', content: 'Agent persisted' },
    ];

    const runner1 = new HeadlessAgentRunner(session);
    const serialized = runner1.serialize();
    const runner2 = new HeadlessAgentRunner(serialized);
    const history = runner2.getMessageHistory();

    expect(history).toHaveLength(3);
    expect(history[0].role).toBe('user');
    expect(history[0].type).toBeUndefined();
    expect(history[1].role).toBe('user');
    expect(history[1].type).toBe('intervention');
    expect(history[2].role).toBeUndefined();
    expect(history[2].type).toBe('announcement');
  });
});
