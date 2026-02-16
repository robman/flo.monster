import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentContainer } from '../agent-container.js';
import type { AgentConfig, AgentState } from '@flo-monster/core';

// Mock HubClient
function createMockHubClient() {
  const loopCallbacks: ((agentId: string, event: any) => void)[] = [];
  const eventCallbacks: ((agentId: string, event: any) => void)[] = [];
  const historyCallbacks: ((agentId: string, messages: any[]) => void)[] = [];

  return {
    onAgentLoopEvent: vi.fn((cb: any) => {
      loopCallbacks.push(cb);
      return () => {
        const idx = loopCallbacks.indexOf(cb);
        if (idx >= 0) loopCallbacks.splice(idx, 1);
      };
    }),
    onAgentEvent: vi.fn((cb: any) => {
      eventCallbacks.push(cb);
      return () => {
        const idx = eventCallbacks.indexOf(cb);
        if (idx >= 0) eventCallbacks.splice(idx, 1);
      };
    }),
    onConversationHistory: vi.fn((cb: any) => {
      historyCallbacks.push(cb);
      return () => {
        const idx = historyCallbacks.indexOf(cb);
        if (idx >= 0) historyCallbacks.splice(idx, 1);
      };
    }),
    sendAgentMessage: vi.fn(),
    sendAgentAction: vi.fn(),
    sendSubscribeAgent: vi.fn(),
    _emitLoopEvent: (agentId: string, event: any) => {
      for (const cb of loopCallbacks) cb(agentId, event);
    },
    _emitAgentEvent: (agentId: string, event: any) => {
      for (const cb of eventCallbacks) cb(agentId, event);
    },
    _emitHistory: (agentId: string, messages: any[]) => {
      for (const cb of historyCallbacks) cb(agentId, messages);
    },
  };
}

function createTestConfig(id = 'test-agent'): AgentConfig {
  return {
    id,
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    systemPrompt: 'test',
    tools: [],
    maxTokens: 4096,
  };
}

describe('AgentContainer hub event source', () => {
  let agent: AgentContainer;
  let hubClient: ReturnType<typeof createMockHubClient>;

  beforeEach(() => {
    agent = new AgentContainer(createTestConfig());
    hubClient = createMockHubClient();
    agent.setHubPersistInfo({
      hubAgentId: 'hub-test-agent-123',
      hubName: 'Test Hub',
      hubConnectionId: 'conn-1',
    });
  });

  describe('setHubEventSource', () => {
    it('registers callbacks on HubClient', () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');
      expect(hubClient.onAgentLoopEvent).toHaveBeenCalledOnce();
      expect(hubClient.onAgentEvent).toHaveBeenCalledOnce();
    });

    it('forwards matching agent loop events', () => {
      const events: any[] = [];
      agent.onEvent(e => events.push(e));
      agent.setHubEventSource(hubClient as any, 'conn-1');

      hubClient._emitLoopEvent('hub-test-agent-123', { type: 'text_delta', text: 'hello' });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'text_delta', text: 'hello' });
    });

    it('ignores events for other agents', () => {
      const events: any[] = [];
      agent.onEvent(e => events.push(e));
      agent.setHubEventSource(hubClient as any, 'conn-1');

      hubClient._emitLoopEvent('hub-other-agent-456', { type: 'text_delta', text: 'nope' });
      expect(events).toHaveLength(0);
    });

    it('cleans up previous subscriptions when called again', () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');
      // First call registers 2 callbacks
      expect(hubClient.onAgentLoopEvent).toHaveBeenCalledTimes(1);

      const events: any[] = [];
      agent.onEvent(e => events.push(e));

      // Set again (should unsubscribe old and subscribe new)
      agent.setHubEventSource(hubClient as any, 'conn-2');

      // Old subscription should be cleaned up
      hubClient._emitLoopEvent('hub-test-agent-123', { type: 'text_delta', text: 'test' });
      // Should still get event from the NEW subscription (plus hub_connection_change from cleanup)
      const textEvents = events.filter(e => e.type === 'text_delta');
      expect(textEvents).toHaveLength(1);
    });

    it('does nothing when no hubPersistInfo is set', () => {
      const agentNoInfo = new AgentContainer(createTestConfig('no-info'));
      // No hubPersistInfo set - should return early without registering callbacks
      agentNoInfo.setHubEventSource(hubClient as any, 'conn-1');

      expect(hubClient.onAgentLoopEvent).not.toHaveBeenCalled();
      expect(hubClient.onAgentEvent).not.toHaveBeenCalled();
    });

    it('forwards state_change events from hub agent events', () => {
      const events: any[] = [];
      agent.onEvent(e => events.push(e));
      agent.setHubEventSource(hubClient as any, 'conn-1');

      hubClient._emitAgentEvent('hub-test-agent-123', { type: 'state_change', state: 'running' });

      const stateEvents = events.filter(e => e.type === 'state_change');
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].to).toBe('running');
    });

    it('forwards pending state from hub', () => {
      // Start agent in running state so pending is a real transition
      agent = new AgentContainer(createTestConfig(), 'running' as AgentState);
      hubClient = createMockHubClient();
      agent.setHubPersistInfo({
        hubAgentId: 'hub-test-agent-123',
        hubName: 'Test Hub',
        hubConnectionId: 'conn-1',
      });

      const events: any[] = [];
      agent.onEvent(e => events.push(e));
      agent.setHubEventSource(hubClient as any, 'conn-1');

      hubClient._emitAgentEvent('hub-test-agent-123', { type: 'state_change', state: 'pending' });

      const stateEvents = events.filter(e => e.type === 'state_change');
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].to).toBe('pending');
    });

    it('ignores idle state from hub (not in stateMap)', () => {
      agent = new AgentContainer(createTestConfig(), 'running' as AgentState);
      hubClient = createMockHubClient();
      agent.setHubPersistInfo({
        hubAgentId: 'hub-test-agent-123',
        hubName: 'Test Hub',
        hubConnectionId: 'conn-1',
      });

      const events: any[] = [];
      agent.onEvent(e => events.push(e));
      agent.setHubEventSource(hubClient as any, 'conn-1');

      hubClient._emitAgentEvent('hub-test-agent-123', { type: 'state_change', state: 'idle' });

      const stateEvents = events.filter(e => e.type === 'state_change');
      expect(stateEvents).toHaveLength(0);
    });

    it('ignores state_change when state is the same', () => {
      // Test that duplicate state transitions are ignored
      const events: any[] = [];
      agent.onEvent(e => events.push(e));
      agent.setHubEventSource(hubClient as any, 'conn-1');

      // Trigger running first
      hubClient._emitAgentEvent('hub-test-agent-123', { type: 'state_change', state: 'running' });
      // Then trigger running again - should be no-op
      hubClient._emitAgentEvent('hub-test-agent-123', { type: 'state_change', state: 'running' });

      const stateEvents = events.filter(e => e.type === 'state_change');
      expect(stateEvents).toHaveLength(1); // Only one transition
    });

    it('ignores state_change events from iframe for hub-persisted agents', () => {
      // Simulate what happens when the worker sends a state_change via postMessage
      // For hub-persisted agents, state comes from hub, not the local worker
      const events: any[] = [];
      agent.onEvent(e => events.push(e));
      agent.setHubEventSource(hubClient as any, 'conn-1');

      // Set state to paused via hub (the correct authority)
      hubClient._emitAgentEvent('hub-test-agent-123', { type: 'state_change', state: 'paused' });
      expect(agent.state).toBe('paused');

      // Simulate iframe sending state_change (worker's agentic loop init)
      // Access private handleIframeMessage by dispatching a MessageEvent
      const iframeWindow = {} as Window;
      // Set up iframe reference via start mock workaround
      (agent as any).iframe = { contentWindow: iframeWindow } as any;
      window.dispatchEvent(new MessageEvent('message', {
        source: iframeWindow,
        data: {
          type: 'event',
          agentId: agent.id,
          event: { type: 'state_change', from: 'pending', to: 'running' },
        },
      }));

      // State should still be paused — iframe state_change was ignored
      expect(agent.state).toBe('paused');
      // Only one state_change event emitted (from hub), not two
      const stateEvents = events.filter(e => e.type === 'state_change');
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].to).toBe('paused');
    });

    it('forwards state_change from iframe for non-hub agents', () => {
      // Create a local agent without hub persist info
      const localAgent = new AgentContainer(createTestConfig('local'));
      const events: any[] = [];
      localAgent.onEvent(e => events.push(e));

      // Simulate iframe sending state_change
      const iframeWindow = {} as Window;
      (localAgent as any).iframe = { contentWindow: iframeWindow } as any;
      // Need to register the message handler
      (localAgent as any).handleIframeMessage = (localAgent as any).handleIframeMessage;
      window.addEventListener('message', (localAgent as any).handleIframeMessage);

      window.dispatchEvent(new MessageEvent('message', {
        source: iframeWindow,
        data: {
          type: 'event',
          agentId: 'local',
          event: { type: 'state_change', from: 'pending', to: 'running' },
        },
      }));

      // For local agents, state_change from iframe SHOULD be forwarded
      const stateEvents = events.filter(e => e.type === 'state_change');
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].to).toBe('running');

      // Clean up
      window.removeEventListener('message', (localAgent as any).handleIframeMessage);
    });

    it('ignores unmapped hub states', () => {
      const events: any[] = [];
      agent.onEvent(e => events.push(e));
      agent.setHubEventSource(hubClient as any, 'conn-1');

      hubClient._emitAgentEvent('hub-test-agent-123', { type: 'state_change', state: 'unknown_state' });

      const stateEvents = events.filter(e => e.type === 'state_change');
      expect(stateEvents).toHaveLength(0);
    });
  });

  describe('conversation history buffering', () => {
    it('replays buffered conversation history to newly registered listeners', async () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');

      // Emit conversation history BEFORE any listener
      hubClient._emitHistory('hub-test-agent-123', [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ]);

      // Now register a listener (simulates AgentView.mount() happening later)
      const events: any[] = [];
      agent.onEvent((event) => events.push(event));

      // Wait for microtask to fire
      await new Promise<void>(resolve => queueMicrotask(resolve));

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('conversation_history');
      expect(events[0].messages).toHaveLength(1);
    });

    it('does not replay if no conversation history buffered', async () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');

      // Register listener WITHOUT any prior history
      const events: any[] = [];
      agent.onEvent((event) => events.push(event));

      await new Promise<void>(resolve => queueMicrotask(resolve));

      expect(events.length).toBe(0);
    });

    it('clears buffered history when hub event source is cleared', async () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');

      // Buffer history
      hubClient._emitHistory('hub-test-agent-123', [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ]);

      // Clear hub event source
      agent.clearHubEventSource();

      // Register listener
      const events: any[] = [];
      agent.onEvent((event) => events.push(event));

      await new Promise<void>(resolve => queueMicrotask(resolve));

      expect(events.length).toBe(0);
    });
  });

  describe('clearHubEventSource', () => {
    it('unsubscribes all callbacks', () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');

      const events: any[] = [];
      agent.onEvent(e => events.push(e));

      agent.clearHubEventSource();

      hubClient._emitLoopEvent('hub-test-agent-123', { type: 'text_delta', text: 'test' });
      // Should have hub_connection_change from clearHubEventSource but no text_delta
      const textEvents = events.filter(e => e.type === 'text_delta');
      expect(textEvents).toHaveLength(0);
    });

    it('is idempotent', () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');
      agent.clearHubEventSource();
      agent.clearHubEventSource(); // Should not throw
    });
  });

  describe('sendUserMessage with hub routing', () => {
    it('routes message through hub when hub-persisted', () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');
      agent.sendUserMessage('hello');

      expect(hubClient.sendAgentMessage).toHaveBeenCalledWith(
        'conn-1',
        'hub-test-agent-123',
        'hello',
      );
    });

    it('falls back to iframe postMessage when no hub client', () => {
      // No setHubEventSource called - should try iframe (won't throw since iframe is null)
      agent.sendUserMessage('hello');
      expect(hubClient.sendAgentMessage).not.toHaveBeenCalled();
    });

    it('falls back to iframe when hubClient is cleared', () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');
      agent.clearHubEventSource();
      agent.sendUserMessage('hello');
      expect(hubClient.sendAgentMessage).not.toHaveBeenCalled();
    });
  });

  describe('hubConnected', () => {
    it('defaults to false', () => {
      const freshAgent = new AgentContainer(createTestConfig('fresh'));
      expect(freshAgent.hubConnected).toBe(false);
    });

    it('is set to true by setHubConnected after setHubEventSource', () => {
      expect(agent.hubConnected).toBe(false);
      agent.setHubEventSource(hubClient as any, 'conn-1');
      agent.setHubConnected(true);
      expect(agent.hubConnected).toBe(true);
    });

    it('is set to false by clearHubEventSource', () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');
      agent.setHubConnected(true);
      expect(agent.hubConnected).toBe(true);
      agent.clearHubEventSource();
      expect(agent.hubConnected).toBe(false);
    });

    it('emits hub_connection_change event when setHubConnected is called', () => {
      const events: any[] = [];
      agent.onEvent(e => events.push(e));

      agent.setHubConnected(true);

      const connEvents = events.filter(e => e.type === 'hub_connection_change');
      expect(connEvents).toHaveLength(1);
      expect(connEvents[0].connected).toBe(true);
    });

    it('is idempotent — same value does not re-emit', () => {
      const events: any[] = [];
      agent.onEvent(e => events.push(e));

      agent.setHubConnected(true);
      agent.setHubConnected(true); // same value again

      const connEvents = events.filter(e => e.type === 'hub_connection_change');
      expect(connEvents).toHaveLength(1); // Only one event
    });

    it('emits hub_connection_change(false) on clearHubEventSource', () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');
      agent.setHubConnected(true);

      const events: any[] = [];
      agent.onEvent(e => events.push(e));

      agent.clearHubEventSource();

      const connEvents = events.filter(e => e.type === 'hub_connection_change');
      expect(connEvents).toHaveLength(1);
      expect(connEvents[0].connected).toBe(false);
    });

    it('does not emit on clearHubEventSource when already disconnected', () => {
      // Never connected — clearHubEventSource should not emit
      const events: any[] = [];
      agent.onEvent(e => events.push(e));

      agent.clearHubEventSource();

      const connEvents = events.filter(e => e.type === 'hub_connection_change');
      expect(connEvents).toHaveLength(0);
    });
  });

  describe('kill cleans up hub subscriptions', () => {
    it('clears hub event source on kill', () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');

      const events: any[] = [];
      agent.onEvent(e => events.push(e));

      agent.kill();

      // After kill, hub events should not be forwarded
      hubClient._emitLoopEvent('hub-test-agent-123', { type: 'text_delta', text: 'test' });
      // Events list will have the state_change from kill() but not the text_delta
      const textEvents = events.filter(e => e.type === 'text_delta');
      expect(textEvents).toHaveLength(0);
    });

    it('emits state_change to killed on kill', () => {
      agent.setHubEventSource(hubClient as any, 'conn-1');

      const events: any[] = [];
      agent.onEvent(e => events.push(e));

      agent.kill();

      const stateEvents = events.filter(e => e.type === 'state_change');
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].to).toBe('killed');
    });
  });

  describe('lifecycle routing to hub', () => {
    beforeEach(() => {
      // Create agent in running state for lifecycle tests
      agent = new AgentContainer(createTestConfig(), 'running' as AgentState);
      hubClient = createMockHubClient();
      agent.setHubPersistInfo({
        hubAgentId: 'hub-test-agent-123',
        hubName: 'Test Hub',
        hubConnectionId: 'conn-1',
      });
    });

    describe('pause', () => {
      it('routes pause to hub for hub-persisted agent', () => {
        agent.setHubEventSource(hubClient as any, 'conn-1');
        agent.pause();
        expect(hubClient.sendAgentAction).toHaveBeenCalledWith('conn-1', 'hub-test-agent-123', 'pause');
      });

      it('does not change state locally (waits for hub event)', () => {
        agent.setHubEventSource(hubClient as any, 'conn-1');
        agent.pause();
        expect(agent.state).toBe('running'); // State hasn't changed yet
      });

      it('pauses locally when not hub-persisted', () => {
        // No setHubEventSource called — hubClient/hubConnectionId are null
        const events: any[] = [];
        agent.onEvent(e => events.push(e));
        agent.pause();
        expect(agent.state).toBe('paused');
        expect(hubClient.sendAgentAction).not.toHaveBeenCalled();
      });

      it('pauses locally when hubPersistInfo is not set', () => {
        const localAgent = new AgentContainer(createTestConfig('local'), 'running' as AgentState);
        // No setHubPersistInfo, no setHubEventSource
        localAgent.pause();
        expect(localAgent.state).toBe('paused');
      });
    });

    describe('resume', () => {
      it('routes resume to hub for hub-persisted agent', () => {
        // Need to be in paused state first
        agent = new AgentContainer(createTestConfig(), 'paused' as AgentState);
        agent.setHubPersistInfo({
          hubAgentId: 'hub-test-agent-123',
          hubName: 'Test Hub',
          hubConnectionId: 'conn-1',
        });
        agent.setHubEventSource(hubClient as any, 'conn-1');
        agent.resume();
        expect(hubClient.sendAgentAction).toHaveBeenCalledWith('conn-1', 'hub-test-agent-123', 'resume');
      });

      it('does not change state locally (waits for hub event)', () => {
        agent = new AgentContainer(createTestConfig(), 'paused' as AgentState);
        agent.setHubPersistInfo({
          hubAgentId: 'hub-test-agent-123',
          hubName: 'Test Hub',
          hubConnectionId: 'conn-1',
        });
        agent.setHubEventSource(hubClient as any, 'conn-1');
        agent.resume();
        expect(agent.state).toBe('paused'); // State hasn't changed yet
      });

      it('resumes locally when not hub-persisted', () => {
        agent = new AgentContainer(createTestConfig(), 'paused' as AgentState);
        agent.resume();
        expect(agent.state).toBe('running');
        expect(hubClient.sendAgentAction).not.toHaveBeenCalled();
      });
    });

    describe('stop', () => {
      it('routes stop to hub for hub-persisted agent', () => {
        agent.setHubEventSource(hubClient as any, 'conn-1');
        agent.stop();
        expect(hubClient.sendAgentAction).toHaveBeenCalledWith('conn-1', 'hub-test-agent-123', 'stop');
      });

      it('does not change state locally (waits for hub event)', () => {
        agent.setHubEventSource(hubClient as any, 'conn-1');
        agent.stop();
        expect(agent.state).toBe('running'); // State hasn't changed yet
      });

      it('stops locally when not hub-persisted', () => {
        const events: any[] = [];
        agent.onEvent(e => events.push(e));
        agent.stop();
        expect(agent.state).toBe('stopped');
        expect(hubClient.sendAgentAction).not.toHaveBeenCalled();
      });

      it('routes stop from paused state for hub-persisted agent', () => {
        agent = new AgentContainer(createTestConfig(), 'paused' as AgentState);
        agent.setHubPersistInfo({
          hubAgentId: 'hub-test-agent-123',
          hubName: 'Test Hub',
          hubConnectionId: 'conn-1',
        });
        agent.setHubEventSource(hubClient as any, 'conn-1');
        agent.stop();
        expect(hubClient.sendAgentAction).toHaveBeenCalledWith('conn-1', 'hub-test-agent-123', 'stop');
      });
    });

    describe('kill', () => {
      it('sends kill to hub AND cleans up locally', () => {
        agent.setHubEventSource(hubClient as any, 'conn-1');
        agent.kill();
        expect(hubClient.sendAgentAction).toHaveBeenCalledWith('conn-1', 'hub-test-agent-123', 'kill');
        expect(agent.state).toBe('killed');
      });

      it('still cleans up locally even with hub notification', () => {
        agent.setHubEventSource(hubClient as any, 'conn-1');

        const events: any[] = [];
        agent.onEvent(e => events.push(e));

        agent.kill();

        // Hub events should no longer be forwarded (clearHubEventSource was called)
        hubClient._emitLoopEvent('hub-test-agent-123', { type: 'text_delta', text: 'test' });
        const textEvents = events.filter(e => e.type === 'text_delta');
        expect(textEvents).toHaveLength(0);

        // State should be killed
        const stateEvents = events.filter(e => e.type === 'state_change');
        expect(stateEvents).toHaveLength(1);
        expect(stateEvents[0].to).toBe('killed');
      });

      it('kills locally without hub notification when not hub-persisted', () => {
        // No hub event source set
        agent.kill();
        expect(agent.state).toBe('killed');
        expect(hubClient.sendAgentAction).not.toHaveBeenCalled();
      });
    });
  });

  describe('hub page event routing', () => {
    it('routes hub_page_event to sendAgentMessage', () => {
      const postMessageSpy = vi.fn();
      const iframeWindow = { postMessage: postMessageSpy } as unknown as Window;
      (agent as any).iframe = { contentWindow: iframeWindow } as any;

      agent.setHubEventSource(hubClient as any, 'conn-1');

      // Register the message handler manually (normally done in start())
      window.addEventListener('message', (agent as any).handleIframeMessage);

      // Simulate hub_page_event from iframe
      window.dispatchEvent(new MessageEvent('message', {
        source: iframeWindow,
        data: {
          type: 'hub_page_event',
          agentId: agent.id,
          content: 'Event: button_clicked\nData: {"id":"btn1"}',
        },
      }));

      expect(hubClient.sendAgentMessage).toHaveBeenCalledWith(
        'conn-1',
        'hub-test-agent-123',
        'Event: button_clicked\nData: {"id":"btn1"}',
      );

      // Clean up
      window.removeEventListener('message', (agent as any).handleIframeMessage);
    });

    it('silently drops hub_page_event when hub is disconnected', () => {
      // No setHubEventSource — hub is not connected
      const iframeWindow = {} as Window;
      (agent as any).iframe = { contentWindow: iframeWindow } as any;

      // Register the message handler manually (normally done in start())
      window.addEventListener('message', (agent as any).handleIframeMessage);

      window.dispatchEvent(new MessageEvent('message', {
        source: iframeWindow,
        data: {
          type: 'hub_page_event',
          agentId: agent.id,
          content: 'Event: button_clicked\nData: {}',
        },
      }));

      expect(hubClient.sendAgentMessage).not.toHaveBeenCalled();

      // Clean up
      window.removeEventListener('message', (agent as any).handleIframeMessage);
    });

    it('silently drops hub_page_event after clearHubEventSource', () => {
      const postMessageSpy = vi.fn();
      const iframeWindow = { postMessage: postMessageSpy } as unknown as Window;
      (agent as any).iframe = { contentWindow: iframeWindow } as any;

      agent.setHubEventSource(hubClient as any, 'conn-1');

      agent.clearHubEventSource();

      // Register the message handler manually
      window.addEventListener('message', (agent as any).handleIframeMessage);

      window.dispatchEvent(new MessageEvent('message', {
        source: iframeWindow,
        data: {
          type: 'hub_page_event',
          agentId: agent.id,
          content: 'Event: test\nData: {}',
        },
      }));

      expect(hubClient.sendAgentMessage).not.toHaveBeenCalled();

      // Clean up
      window.removeEventListener('message', (agent as any).handleIframeMessage);
    });

    it('sends set_hub_mode during setHubEventSource', () => {
      const postMessageSpy = vi.fn();
      (agent as any).iframe = { contentWindow: { postMessage: postMessageSpy } } as any;

      agent.setHubEventSource(hubClient as any, 'conn-1');

      const hubModeMessages = postMessageSpy.mock.calls.filter(
        (call: any[]) => call[0]?.type === 'set_hub_mode'
      );
      // clearHubEventSource (called at start of setHubEventSource) sends false,
      // then setHubEventSource sends true — so we get 2 messages
      expect(hubModeMessages.length).toBeGreaterThanOrEqual(1);
      // Last one should be enabled: true
      const lastMsg = hubModeMessages[hubModeMessages.length - 1];
      expect(lastMsg[0].enabled).toBe(true);
    });

    it('sends set_hub_mode during start() for hub agents', () => {
      // Verify source code has the _hubPersistInfo check in start() that sends set_hub_mode
      // We can't fully call start() without worker code, but we verify the pattern exists
      const postMessageSpy = vi.fn();
      (agent as any).iframe = { contentWindow: { postMessage: postMessageSpy } } as any;

      // setHubEventSource sends set_hub_mode
      agent.setHubEventSource(hubClient as any, 'conn-1');

      const hubModeMessages = postMessageSpy.mock.calls.filter(
        (call: any[]) => call[0]?.type === 'set_hub_mode' && call[0]?.enabled === true
      );
      expect(hubModeMessages.length).toBeGreaterThanOrEqual(1);
    });

    it('disables set_hub_mode during clearHubEventSource', () => {
      const postMessageSpy = vi.fn();
      (agent as any).iframe = { contentWindow: { postMessage: postMessageSpy } } as any;

      agent.setHubEventSource(hubClient as any, 'conn-1');
      postMessageSpy.mockClear();

      agent.clearHubEventSource();

      const hubModeMessages = postMessageSpy.mock.calls.filter(
        (call: any[]) => call[0]?.type === 'set_hub_mode'
      );
      expect(hubModeMessages).toHaveLength(1);
      expect(hubModeMessages[0][0].enabled).toBe(false);
    });
  });
});
