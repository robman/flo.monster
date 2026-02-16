import { describe, it, expect } from 'vitest';
import type {
  DomCommand,
  DomEventData,
  DomListenerInfo,
  DomListenOptions,
  WorkerToIframe,
  IframeToWorker,
  IframeToShell,
  ShellToIframe,
} from './protocol.js';
import type { AgentViewState } from './agent.js';

describe('DOM Event Protocol Types', () => {
  describe('DomCommand', () => {
    it('should support event listener actions', () => {
      const listenCommand: DomCommand = {
        action: 'listen',
        selector: '.btn',
        events: ['click', 'mouseenter'],
        options: { debounce: 100 },
      };
      expect(listenCommand.action).toBe('listen');
      expect(listenCommand.events).toEqual(['click', 'mouseenter']);
      expect(listenCommand.options?.debounce).toBe(100);

      const unlistenCommand: DomCommand = {
        action: 'unlisten',
        selector: '.btn',
      };
      expect(unlistenCommand.action).toBe('unlisten');

      const waitForCommand: DomCommand = {
        action: 'wait_for',
        selector: '#submit',
        event: 'click',
        timeout: 5000,
      };
      expect(waitForCommand.action).toBe('wait_for');
      expect(waitForCommand.event).toBe('click');
      expect(waitForCommand.timeout).toBe(5000);

      const getListenersCommand: DomCommand = {
        action: 'get_listeners',
      };
      expect(getListenersCommand.action).toBe('get_listeners');
    });

    it('should support traditional DOM actions', () => {
      const createCommand: DomCommand = {
        action: 'create',
        html: '<div>Hello</div>',
        parentSelector: '#container',
      };
      expect(createCommand.action).toBe('create');
      expect(createCommand.html).toBe('<div>Hello</div>');
    });
  });

  describe('DomEventData', () => {
    it('should have all required fields', () => {
      const eventData: DomEventData = {
        type: 'click',
        selector: '.btn',
        timestamp: Date.now(),
        target: {
          tagName: 'BUTTON',
          id: 'submit-btn',
          className: 'btn primary',
          value: undefined,
          textContent: 'Submit',
          dataset: { action: 'submit' },
        },
      };
      expect(eventData.type).toBe('click');
      expect(eventData.selector).toBe('.btn');
      expect(eventData.target.tagName).toBe('BUTTON');
      expect(eventData.target.dataset.action).toBe('submit');
    });

    it('should support form data', () => {
      const formEventData: DomEventData = {
        type: 'submit',
        selector: 'form',
        timestamp: Date.now(),
        target: {
          tagName: 'FORM',
          id: 'login-form',
          className: '',
          dataset: {},
        },
        formData: {
          username: 'test',
          password: 'secret',
        },
      };
      expect(formEventData.formData?.username).toBe('test');
      expect(formEventData.formData?.password).toBe('secret');
    });
  });

  describe('DomListenerInfo', () => {
    it('should describe a registered listener', () => {
      const listenerInfo: DomListenerInfo = {
        selector: '.clickable',
        events: ['click', 'touchstart'],
        workerId: 'main',
        options: { debounce: 50 },
      };
      expect(listenerInfo.selector).toBe('.clickable');
      expect(listenerInfo.events).toContain('click');
      expect(listenerInfo.workerId).toBe('main');
    });
  });

  describe('DomListenOptions', () => {
    it('should support debounce option', () => {
      const options: DomListenOptions = {
        debounce: 100,
      };
      expect(options.debounce).toBe(100);
    });
  });
});

describe('Worker ↔ Iframe Protocol', () => {
  describe('WorkerToIframe messages', () => {
    it('should support dom_listen message', () => {
      const msg: WorkerToIframe = {
        type: 'dom_listen',
        id: 'req-1',
        selector: '.btn',
        events: ['click'],
        options: { debounce: 100 },
      };
      expect(msg.type).toBe('dom_listen');
    });

    it('should support dom_unlisten message', () => {
      const msg: WorkerToIframe = {
        type: 'dom_unlisten',
        id: 'req-2',
        selector: '.btn',
      };
      expect(msg.type).toBe('dom_unlisten');
    });

    it('should support dom_wait message', () => {
      const msg: WorkerToIframe = {
        type: 'dom_wait',
        id: 'req-3',
        selector: '#submit',
        event: 'click',
        timeout: 5000,
      };
      expect(msg.type).toBe('dom_wait');
    });

    it('should support dom_get_listeners message', () => {
      const msg: WorkerToIframe = {
        type: 'dom_get_listeners',
        id: 'req-4',
      };
      expect(msg.type).toBe('dom_get_listeners');
    });

    it('should support agent_ask_response message', () => {
      const msg: WorkerToIframe = {
        type: 'agent_ask_response',
        id: 'ask-1',
        result: { answer: 42 },
      };
      expect(msg.type).toBe('agent_ask_response');
    });

    it('should support worker_message message', () => {
      const msg: WorkerToIframe = {
        type: 'worker_message',
        target: 'sub-1',
        event: 'progress',
        data: { percent: 50 },
      };
      expect(msg.type).toBe('worker_message');
    });
  });

  describe('IframeToWorker messages', () => {
    it('should support dom_event message', () => {
      const msg: IframeToWorker = {
        type: 'dom_event',
        event: {
          type: 'click',
          selector: '.btn',
          timestamp: Date.now(),
          target: {
            tagName: 'BUTTON',
            id: 'btn-1',
            className: 'btn',
            dataset: {},
          },
        },
      };
      expect(msg.type).toBe('dom_event');
    });

    it('should support dom_wait_result message', () => {
      const msg: IframeToWorker = {
        type: 'dom_wait_result',
        id: 'req-3',
        event: {
          type: 'click',
          selector: '#submit',
          timestamp: Date.now(),
          target: {
            tagName: 'BUTTON',
            id: 'submit',
            className: '',
            dataset: {},
          },
        },
      };
      expect(msg.type).toBe('dom_wait_result');
    });

    it('should support dom_wait_result error message', () => {
      const msg: IframeToWorker = {
        type: 'dom_wait_result',
        id: 'req-3',
        error: 'Timeout waiting for click on #submit',
      };
      expect(msg.type).toBe('dom_wait_result');
      expect(msg.error).toContain('Timeout');
    });

    it('should support dom_listen_result message', () => {
      const msg: IframeToWorker = {
        type: 'dom_listen_result',
        id: 'req-1',
        success: true,
      };
      expect(msg.type).toBe('dom_listen_result');
    });

    it('should support dom_listeners_result message', () => {
      const msg: IframeToWorker = {
        type: 'dom_listeners_result',
        id: 'req-4',
        listeners: [
          { selector: '.btn', events: ['click'], workerId: 'main' },
        ],
      };
      expect(msg.type).toBe('dom_listeners_result');
    });

    it('should support agent_notify message', () => {
      const msg: IframeToWorker = {
        type: 'agent_notify',
        event: 'user_action',
        data: { action: 'clicked' },
      };
      expect(msg.type).toBe('agent_notify');
    });

    it('should support agent_ask message', () => {
      const msg: IframeToWorker = {
        type: 'agent_ask',
        id: 'ask-1',
        event: 'calculate',
        data: { a: 5, b: 3 },
      };
      expect(msg.type).toBe('agent_ask');
    });

    it('should support worker_event message', () => {
      const msg: IframeToWorker = {
        type: 'worker_event',
        from: 'sub-1',
        event: 'task_complete',
        data: { taskId: '1', result: 'success' },
      };
      expect(msg.type).toBe('worker_event');
    });
  });
});

describe('IframeToShell api_request', () => {
    it('api_request should accept optional browserId', () => {
      const msgWithBrowserId: IframeToShell = {
        type: 'api_request',
        id: 'req-1',
        agentId: 'agent-1',
        payload: { messages: [] },
        browserId: 'browser-uuid-1234',
      };
      expect(msgWithBrowserId.browserId).toBe('browser-uuid-1234');

      const msgWithoutBrowserId: IframeToShell = {
        type: 'api_request',
        id: 'req-2',
        agentId: 'agent-1',
        payload: { messages: [] },
      };
      expect(msgWithoutBrowserId.type).toBe('api_request');
    });
});

describe('View State Protocol Messages', () => {
  describe('IframeToShell request_view_state', () => {
    it('should construct valid request_view_state message with min state', () => {
      const msg: IframeToShell = {
        type: 'request_view_state',
        agentId: 'agent-1',
        state: 'min',
      };
      expect(msg.type).toBe('request_view_state');
      expect(msg.agentId).toBe('agent-1');
      expect(msg.state).toBe('min');
    });

    it('should construct valid request_view_state message with max state', () => {
      const msg: IframeToShell = {
        type: 'request_view_state',
        agentId: 'agent-2',
        state: 'max',
      };
      expect(msg.type).toBe('request_view_state');
      expect(msg.state).toBe('max');
    });

    it('should construct valid request_view_state message with ui-only state', () => {
      const msg: IframeToShell = {
        type: 'request_view_state',
        agentId: 'game-agent',
        state: 'ui-only',
      };
      expect(msg.type).toBe('request_view_state');
      expect(msg.state).toBe('ui-only');
    });

    it('should construct valid request_view_state message with chat-only state', () => {
      const msg: IframeToShell = {
        type: 'request_view_state',
        agentId: 'chat-agent',
        state: 'chat-only',
      };
      expect(msg.type).toBe('request_view_state');
      expect(msg.state).toBe('chat-only');
    });

    it('should require agentId field', () => {
      const msg: IframeToShell = {
        type: 'request_view_state',
        agentId: 'required-agent-id',
        state: 'max',
      };
      expect(msg.agentId).toBeDefined();
      expect(msg.agentId).toBe('required-agent-id');
    });
  });

  describe('ShellToIframe set_view_state', () => {
    it('should construct valid set_view_state message with min state', () => {
      const msg: ShellToIframe = {
        type: 'set_view_state',
        state: 'min',
      };
      expect(msg.type).toBe('set_view_state');
      expect(msg.state).toBe('min');
    });

    it('should construct valid set_view_state message with max state', () => {
      const msg: ShellToIframe = {
        type: 'set_view_state',
        state: 'max',
      };
      expect(msg.type).toBe('set_view_state');
      expect(msg.state).toBe('max');
    });

    it('should construct valid set_view_state message with ui-only state', () => {
      const msg: ShellToIframe = {
        type: 'set_view_state',
        state: 'ui-only',
      };
      expect(msg.type).toBe('set_view_state');
      expect(msg.state).toBe('ui-only');
    });

    it('should construct valid set_view_state message with chat-only state', () => {
      const msg: ShellToIframe = {
        type: 'set_view_state',
        state: 'chat-only',
      };
      expect(msg.type).toBe('set_view_state');
      expect(msg.state).toBe('chat-only');
    });
  });

  describe('view state type compatibility', () => {
    it('all AgentViewState values should work with request_view_state', () => {
      const states: AgentViewState[] = ['min', 'max', 'ui-only', 'chat-only'];

      for (const state of states) {
        const msg: IframeToShell = {
          type: 'request_view_state',
          agentId: 'test-agent',
          state,
        };
        expect(msg.state).toBe(state);
      }
    });

    it('all AgentViewState values should work with set_view_state', () => {
      const states: AgentViewState[] = ['min', 'max', 'ui-only', 'chat-only'];

      for (const state of states) {
        const msg: ShellToIframe = {
          type: 'set_view_state',
          state,
        };
        expect(msg.state).toBe(state);
      }
    });
  });

  describe('integration scenarios', () => {
    it('agent can request immersive mode for games', () => {
      // Agent builds a game and requests ui-only mode
      const request: IframeToShell = {
        type: 'request_view_state',
        agentId: 'snake-game',
        state: 'ui-only',
      };
      expect(request.type).toBe('request_view_state');
      expect(request.state).toBe('ui-only');

      // Shell grants the request
      const response: ShellToIframe = {
        type: 'set_view_state',
        state: 'ui-only',
      };
      expect(response.state).toBe('ui-only');
    });

    it('shell can force chat-only for mobile viewport', () => {
      const msg: ShellToIframe = {
        type: 'set_view_state',
        state: 'chat-only',
      };
      expect(msg.type).toBe('set_view_state');
      expect(msg.state).toBe('chat-only');
    });

    it('user minimizes agent to dashboard', () => {
      // Shell notifies iframe of minimization
      const msg: ShellToIframe = {
        type: 'set_view_state',
        state: 'min',
      };
      expect(msg.state).toBe('min');
    });

    it('user restores agent to full view', () => {
      // Shell notifies iframe of restoration
      const msg: ShellToIframe = {
        type: 'set_view_state',
        state: 'max',
      };
      expect(msg.state).toBe('max');
    });
  });
});

describe('Speech Protocol Types', () => {
  describe('IframeToShell speech messages', () => {
    it('should support speech_listen_start', () => {
      const msg: IframeToShell = {
        type: 'speech_listen_start',
        id: 'speech-1',
        agentId: 'agent-1',
        lang: 'en-US',
      };
      expect(msg.type).toBe('speech_listen_start');
    });

    it('should support speech_listen_done', () => {
      const msg: IframeToShell = {
        type: 'speech_listen_done',
        id: 'speech-1',
        agentId: 'agent-1',
      };
      expect(msg.type).toBe('speech_listen_done');
    });

    it('should support speech_listen_cancel', () => {
      const msg: IframeToShell = {
        type: 'speech_listen_cancel',
        id: 'speech-1',
        agentId: 'agent-1',
      };
      expect(msg.type).toBe('speech_listen_cancel');
    });

    it('should support speech_speak', () => {
      const msg: IframeToShell = {
        type: 'speech_speak',
        id: 'speech-1',
        agentId: 'agent-1',
        text: 'Hello world',
        voice: 'Samantha',
        lang: 'en-US',
      };
      expect(msg.type).toBe('speech_speak');
      expect((msg as any).text).toBe('Hello world');
    });

    it('should support speech_voices', () => {
      const msg: IframeToShell = {
        type: 'speech_voices',
        id: 'speech-1',
        agentId: 'agent-1',
      };
      expect(msg.type).toBe('speech_voices');
    });
  });

  describe('ShellToIframe speech messages', () => {
    it('should support speech_interim', () => {
      const msg: ShellToIframe = {
        type: 'speech_interim',
        id: 'speech-1',
        text: 'partial transcript',
      };
      expect(msg.type).toBe('speech_interim');
    });

    it('should support speech_result', () => {
      const msg: ShellToIframe = {
        type: 'speech_result',
        id: 'speech-1',
        text: 'final transcript',
        confidence: 0.95,
      };
      expect(msg.type).toBe('speech_result');
      expect((msg as any).confidence).toBe(0.95);
    });

    it('should support speech_cancelled', () => {
      const msg: ShellToIframe = {
        type: 'speech_cancelled',
        id: 'speech-1',
      };
      expect(msg.type).toBe('speech_cancelled');
    });

    it('should support speech_error', () => {
      const msg: ShellToIframe = {
        type: 'speech_error',
        id: 'speech-1',
        error: 'Microphone denied',
      };
      expect(msg.type).toBe('speech_error');
    });

    it('should support speech_speak_done', () => {
      const msg: ShellToIframe = {
        type: 'speech_speak_done',
        id: 'speech-1',
      };
      expect(msg.type).toBe('speech_speak_done');
    });

    it('should support speech_voices_result', () => {
      const msg: ShellToIframe = {
        type: 'speech_voices_result',
        id: 'speech-1',
        voices: [
          { name: 'Samantha', lang: 'en-US', local: true },
          { name: 'Google UK', lang: 'en-GB', local: false },
        ],
      };
      expect(msg.type).toBe('speech_voices_result');
      expect((msg as any).voices).toHaveLength(2);
    });
  });
});
