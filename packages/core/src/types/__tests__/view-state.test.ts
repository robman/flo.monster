import { describe, it, expect } from 'vitest';
import type { AgentViewState } from '../agent.js';
import type { ViewStateChangeEvent, AgentEvent } from '../events.js';
import type { IframeToShell, ShellToIframe } from '../protocol.js';

describe('AgentViewState type', () => {
  describe('valid values', () => {
    it('should accept "min" as a valid view state', () => {
      const state: AgentViewState = 'min';
      expect(state).toBe('min');
    });

    it('should accept "max" as a valid view state', () => {
      const state: AgentViewState = 'max';
      expect(state).toBe('max');
    });

    it('should accept "ui-only" as a valid view state', () => {
      const state: AgentViewState = 'ui-only';
      expect(state).toBe('ui-only');
    });

    it('should accept "chat-only" as a valid view state', () => {
      const state: AgentViewState = 'chat-only';
      expect(state).toBe('chat-only');
    });

    it('should accept "web-max" as a valid view state', () => {
      const state: AgentViewState = 'web-max';
      expect(state).toBe('web-max');
    });

    it('should accept "web-only" as a valid view state', () => {
      const state: AgentViewState = 'web-only';
      expect(state).toBe('web-only');
    });

    it('should have exactly 6 valid values', () => {
      const validStates: AgentViewState[] = ['min', 'max', 'ui-only', 'chat-only', 'web-max', 'web-only'];
      expect(validStates).toHaveLength(6);
    });
  });

  describe('semantic meaning', () => {
    it('min represents dashboard card (minimized)', () => {
      const state: AgentViewState = 'min';
      // min = agent is minimized to dashboard card
      expect(state).toBe('min');
    });

    it('max represents full view with both panes', () => {
      const state: AgentViewState = 'max';
      // max = full view with both iframe and chat panes visible (default)
      expect(state).toBe('max');
    });

    it('ui-only represents iframe-only view', () => {
      const state: AgentViewState = 'ui-only';
      // ui-only = only the iframe viewport visible (apps, games, immersive UIs)
      expect(state).toBe('ui-only');
    });

    it('chat-only represents conversation-only view', () => {
      const state: AgentViewState = 'chat-only';
      // chat-only = only the chat/conversation pane visible (text-focused, mobile)
      expect(state).toBe('chat-only');
    });
  });
});

describe('ViewStateChangeEvent type', () => {
  describe('structure', () => {
    it('should have type "view_state_change"', () => {
      const event: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'min',
        to: 'max',
        requestedBy: 'user',
      };
      expect(event.type).toBe('view_state_change');
    });

    it('should have "from" field with AgentViewState value', () => {
      const event: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'max',
        to: 'ui-only',
        requestedBy: 'agent',
      };
      expect(event.from).toBe('max');
    });

    it('should have "to" field with AgentViewState value', () => {
      const event: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'chat-only',
        to: 'min',
        requestedBy: 'user',
      };
      expect(event.to).toBe('min');
    });

    it('should have "requestedBy" field indicating who initiated the change', () => {
      const userEvent: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'min',
        to: 'max',
        requestedBy: 'user',
      };
      expect(userEvent.requestedBy).toBe('user');

      const agentEvent: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'max',
        to: 'ui-only',
        requestedBy: 'agent',
      };
      expect(agentEvent.requestedBy).toBe('agent');
    });
  });

  describe('all valid transitions', () => {
    it('should support transition from min to max', () => {
      const event: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'min',
        to: 'max',
        requestedBy: 'user',
      };
      expect(event.from).toBe('min');
      expect(event.to).toBe('max');
    });

    it('should support transition from max to ui-only', () => {
      const event: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'max',
        to: 'ui-only',
        requestedBy: 'agent',
      };
      expect(event.from).toBe('max');
      expect(event.to).toBe('ui-only');
    });

    it('should support transition from max to chat-only', () => {
      const event: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'max',
        to: 'chat-only',
        requestedBy: 'user',
      };
      expect(event.from).toBe('max');
      expect(event.to).toBe('chat-only');
    });

    it('should support transition from ui-only to max', () => {
      const event: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'ui-only',
        to: 'max',
        requestedBy: 'user',
      };
      expect(event.from).toBe('ui-only');
      expect(event.to).toBe('max');
    });

    it('should support transition from chat-only to max', () => {
      const event: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'chat-only',
        to: 'max',
        requestedBy: 'agent',
      };
      expect(event.from).toBe('chat-only');
      expect(event.to).toBe('max');
    });

    it('should support transition to min from any state', () => {
      const fromMax: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'max',
        to: 'min',
        requestedBy: 'user',
      };
      expect(fromMax.to).toBe('min');

      const fromUiOnly: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'ui-only',
        to: 'min',
        requestedBy: 'user',
      };
      expect(fromUiOnly.to).toBe('min');

      const fromChatOnly: ViewStateChangeEvent = {
        type: 'view_state_change',
        from: 'chat-only',
        to: 'min',
        requestedBy: 'user',
      };
      expect(fromChatOnly.to).toBe('min');
    });
  });

  describe('as part of AgentEvent union', () => {
    it('ViewStateChangeEvent should be assignable to AgentEvent', () => {
      const event: AgentEvent = {
        type: 'view_state_change',
        from: 'min',
        to: 'max',
        requestedBy: 'user',
      };
      expect(event.type).toBe('view_state_change');
    });

    it('should be distinguishable from other event types', () => {
      const events: AgentEvent[] = [
        { type: 'text_delta', text: 'hello' },
        { type: 'view_state_change', from: 'min', to: 'max', requestedBy: 'user' },
        { type: 'error', error: 'something went wrong' },
      ];

      const viewStateEvents = events.filter((e) => e.type === 'view_state_change');
      expect(viewStateEvents).toHaveLength(1);
      expect(viewStateEvents[0].type).toBe('view_state_change');
    });
  });
});

describe('View state protocol messages', () => {
  describe('IframeToShell request_view_state', () => {
    it('should construct valid request_view_state message', () => {
      const msg: IframeToShell = {
        type: 'request_view_state',
        agentId: 'agent-1',
        state: 'ui-only',
      };
      expect(msg.type).toBe('request_view_state');
      expect(msg.agentId).toBe('agent-1');
      expect(msg.state).toBe('ui-only');
    });

    it('should support all view state values in request', () => {
      const states: AgentViewState[] = ['min', 'max', 'ui-only', 'chat-only', 'web-max', 'web-only'];
      for (const state of states) {
        const msg: IframeToShell = {
          type: 'request_view_state',
          agentId: 'agent-test',
          state,
        };
        expect(msg.state).toBe(state);
      }
    });
  });

  describe('ShellToIframe set_view_state', () => {
    it('should construct valid set_view_state message', () => {
      const msg: ShellToIframe = {
        type: 'set_view_state',
        state: 'max',
      };
      expect(msg.type).toBe('set_view_state');
      expect(msg.state).toBe('max');
    });

    it('should support all view state values', () => {
      const states: AgentViewState[] = ['min', 'max', 'ui-only', 'chat-only', 'web-max', 'web-only'];
      for (const state of states) {
        const msg: ShellToIframe = {
          type: 'set_view_state',
          state,
        };
        expect(msg.state).toBe(state);
      }
    });
  });

  describe('bidirectional communication', () => {
    it('agent can request ui-only mode for immersive apps', () => {
      // Agent requests ui-only mode
      const request: IframeToShell = {
        type: 'request_view_state',
        agentId: 'game-agent',
        state: 'ui-only',
      };
      expect(request.state).toBe('ui-only');

      // Shell confirms the state change
      const confirmation: ShellToIframe = {
        type: 'set_view_state',
        state: 'ui-only',
      };
      expect(confirmation.state).toBe('ui-only');
    });

    it('shell can set chat-only mode for mobile optimization', () => {
      const msg: ShellToIframe = {
        type: 'set_view_state',
        state: 'chat-only',
      };
      expect(msg.state).toBe('chat-only');
    });
  });
});
