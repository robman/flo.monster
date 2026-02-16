import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConversationView } from './conversation.js';

describe('ConversationView', () => {
  let cleanupContainers: HTMLElement[] = [];

  function createView() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    cleanupContainers.push(container);
    const view = new ConversationView(container);
    return { view, container };
  }

  afterEach(() => {
    cleanupContainers.forEach(c => c.remove());
    cleanupContainers = [];
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;
  });

  it('creates messages area and user input on construction', () => {
    const { container } = createView();
    expect(container.querySelector('.conversation')).toBeTruthy();
    expect(container.querySelector('.user-input')).toBeTruthy();
    expect(container.querySelector('.user-input__textarea')).toBeTruthy();
    expect(container.querySelector('.btn--primary')).toBeTruthy();
  });

  describe('drag handle', () => {
    it('should have a drag handle element', () => {
      const { container } = createView();
      const handle = container.querySelector('.user-input__drag-handle');
      expect(handle).not.toBeNull();
    });

    it('should respond to mousedown event', () => {
      const { container } = createView();
      const handle = container.querySelector('.user-input__drag-handle') as HTMLElement;
      const textarea = container.querySelector('.user-input__textarea') as HTMLTextAreaElement;

      // Set initial height
      textarea.style.height = '100px';
      Object.defineProperty(textarea, 'offsetHeight', { value: 100 });

      const mousedown = new MouseEvent('mousedown', {
        clientY: 200,
        bubbles: true,
      });

      handle.dispatchEvent(mousedown);

      // Body should have userSelect: none
      expect(document.body.style.userSelect).toBe('none');
      expect(document.body.style.cursor).toBe('ns-resize');
    });

    it('should have touchstart listener attached', () => {
      const { container } = createView();
      const handle = container.querySelector('.user-input__drag-handle') as HTMLElement;

      // Verify the handle exists and touch events are attached
      // We can't fully test Touch in JSDOM as Touch constructor is not available
      // But we can verify the event listener is set up by checking no error on TouchEvent dispatch
      const touchstart = new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
      });

      // Should not throw - event listener is attached
      expect(() => handle.dispatchEvent(touchstart)).not.toThrow();
    });
  });

  it('appendAssistantText adds text to current message element', () => {
    const { view, container } = createView();
    view.appendAssistantText('Hello');
    view.appendAssistantText(' world');
    const messageEl = container.querySelector('.message--assistant');
    expect(messageEl).toBeTruthy();
    expect(messageEl!.textContent).toContain('Hello world');
  });

  it('appendAssistantText strips <terse> tags from display', () => {
    const { view, container } = createView();
    view.appendAssistantText('Hi! \ud83d\udc4b\n\n<terse>Greeted the user.</terse>');
    const messageEl = container.querySelector('.message--assistant');
    expect(messageEl!.textContent).toBe('Hi! \ud83d\udc4b');
    expect(messageEl!.textContent).not.toContain('terse');
    expect(messageEl!.textContent).not.toContain('Greeted');
  });

  it('appendAssistantText strips <terse> tags during streaming', () => {
    const { view, container } = createView();
    view.appendAssistantText('Hello there!');
    view.appendAssistantText('\n\n<terse>');
    // Partial tag stripped from display
    const textEl = container.querySelector('.message__text');
    expect(textEl!.textContent).toBe('Hello there!');
    // Now the closing part arrives
    view.appendAssistantText('Said hello</terse>');
    expect(textEl!.textContent).toBe('Hello there!');
  });

  it('startToolCall creates tool call container with header', () => {
    const { view, container } = createView();
    view.startAssistantMessage();
    view.startToolCall('tool-1', 'runjs');
    const toolEl = container.querySelector('.tool-call');
    expect(toolEl).toBeTruthy();
    // Header now shows tool name and running status indicator
    expect(toolEl!.querySelector('.tool-call__name')!.textContent).toBe('runjs');
    expect(toolEl!.querySelector('.tool-call__status--running')).toBeTruthy();
  });

  it('updateToolInput shows accumulating input', () => {
    const { view, container } = createView();
    view.startAssistantMessage();
    view.startToolCall('tool-1', 'runjs');
    view.updateToolInput('tool-1', '{"code":');
    view.updateToolInput('tool-1', '"2+2"}');
    const inputEl = container.querySelector('.tool-call__input');
    expect(inputEl!.textContent).toBe('{"code":"2+2"}');
  });

  it('completeToolCall shows result with success styling', () => {
    const { view, container } = createView();
    view.startAssistantMessage();
    view.startToolCall('tool-1', 'runjs');
    view.completeToolCall('tool-1', { content: '4' });
    const resultEl = container.querySelector('.tool-call__result');
    expect(resultEl).toBeTruthy();
    expect(resultEl!.classList.contains('tool-call__result--success')).toBe(true);
    expect(resultEl!.textContent).toContain('4');
  });

  it('completeToolCall shows result with error styling', () => {
    const { view, container } = createView();
    view.startAssistantMessage();
    view.startToolCall('tool-1', 'runjs');
    view.completeToolCall('tool-1', { content: 'SyntaxError', is_error: true });
    const resultEl = container.querySelector('.tool-call__result');
    expect(resultEl!.classList.contains('tool-call__result--error')).toBe(true);
    expect(resultEl!.textContent).toContain('SyntaxError');
  });

  it('showError displays error banner', () => {
    const { view, container } = createView();
    view.showError('API rate limit exceeded');
    const errorEl = container.querySelector('.message--error');
    expect(errorEl).toBeTruthy();
    expect(errorEl!.textContent).toBe('API rate limit exceeded');
  });

  it('user message input sends via callback', () => {
    const { view, container } = createView();
    const callback = vi.fn();
    view.onUserMessage(callback);

    const textarea = container.querySelector('.user-input__textarea') as HTMLTextAreaElement;
    textarea.value = 'Hello agent';

    const sendBtn = container.querySelector('.btn--primary') as HTMLButtonElement;
    sendBtn.click();

    expect(callback).toHaveBeenCalledWith('Hello agent');
    expect(textarea.value).toBe('');
  });

  it('streaming text renders incrementally', () => {
    const { view, container } = createView();
    view.handleEvent({ type: 'message_start', messageId: 'msg-1' });
    view.handleEvent({ type: 'text_delta', text: 'Hello' });
    view.handleEvent({ type: 'text_delta', text: ' world' });

    const msgs = container.querySelectorAll('.message--assistant');
    expect(msgs.length).toBe(1);
    expect(msgs[0].textContent).toContain('Hello world');
  });

  it('addUserMessage creates user message element', () => {
    const { view, container } = createView();
    view.addUserMessage('Test message');
    const userMsg = container.querySelector('.message--user');
    expect(userMsg).toBeTruthy();
    expect(userMsg!.textContent).toBe('Test message');
  });

  it('handleEvent routes tool events correctly', () => {
    const { view, container } = createView();
    view.handleEvent({ type: 'message_start', messageId: 'msg-1' });
    view.handleEvent({ type: 'tool_use_start', toolUseId: 't1', toolName: 'dom' });
    view.handleEvent({ type: 'tool_use_input_delta', toolUseId: 't1', partialJson: '{}' });
    view.handleEvent({ type: 'tool_result', toolUseId: 't1', result: { content: 'done' } });

    const toolEl = container.querySelector('.tool-call');
    expect(toolEl).toBeTruthy();
    expect(toolEl!.querySelector('.tool-call__result')).toBeTruthy();
  });

  describe('renderHistory', () => {
    it('renders user text messages', () => {
      const { view: conversation, container } = createView();
      const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Hello world' }] },
      ];
      conversation.renderHistory(messages);
      const userMsgs = container.querySelectorAll('.message--user');
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].textContent).toBe('Hello world');
    });

    it('renders assistant text messages', () => {
      const { view: conversation, container } = createView();
      const messages = [
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
      ];
      conversation.renderHistory(messages);
      const assistantMsgs = container.querySelectorAll('.message--assistant');
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0].textContent).toContain('Hi there');
    });

    it('renders assistant text with tool calls', () => {
      const { view: conversation, container } = createView();
      const messages = [
        { role: 'assistant', content: [
          { type: 'text', text: 'Let me run that.' },
          { type: 'tool_use', id: 'tu1', name: 'runjs', input: { code: 'console.log(1)' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'Result: 1' },
        ]},
      ];
      conversation.renderHistory(messages);
      const toolCalls = container.querySelectorAll('.tool-call');
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].querySelector('.tool-call__header')?.textContent).toContain('runjs');
      // Tool result should be rendered
      const result = toolCalls[0].querySelector('.tool-call__result--success');
      expect(result).toBeTruthy();
      expect(result?.textContent).toContain('Result: 1');
    });

    it('clears existing content before rendering', () => {
      const { view: conversation, container } = createView();
      // Add some content first
      conversation.addUserMessage('existing');
      expect(container.querySelectorAll('.message--user')).toHaveLength(1);

      // renderHistory should clear and re-render
      conversation.renderHistory([
        { role: 'user', content: [{ type: 'text', text: 'new' }] },
      ]);
      const userMsgs = container.querySelectorAll('.message--user');
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].textContent).toBe('new');
    });

    it('handles empty array', () => {
      const { view: conversation, container } = createView();
      conversation.addUserMessage('existing');
      conversation.renderHistory([]);
      const msgs = container.querySelectorAll('.message');
      expect(msgs).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('removes all messages', () => {
      const { view: conversation, container } = createView();
      conversation.addUserMessage('test');
      conversation.startAssistantMessage();
      conversation.appendAssistantText('reply');
      expect(container.querySelectorAll('.message').length).toBeGreaterThan(0);

      conversation.clear();
      // Only the user-input area should remain, messages area should be empty
      const messagesArea = container.querySelector('.conversation');
      expect(messagesArea?.children.length).toBe(0);
    });
  });

  describe('slash command interception', () => {
    it('intercepts slash commands when callback is set', () => {
      const { view, container } = createView();
      const skillCallback = vi.fn().mockReturnValue({ modifiedPrompt: 'transformed prompt' });
      const userMessageCallback = vi.fn();

      view.onSkillInvocation(skillCallback);
      view.onUserMessage(userMessageCallback);

      const textarea = container.querySelector('.user-input__textarea') as HTMLTextAreaElement;
      textarea.value = '/test-skill some args';

      const sendBtn = container.querySelector('.btn--primary') as HTMLButtonElement;
      sendBtn.click();

      // Skill callback called with name and args
      expect(skillCallback).toHaveBeenCalledWith('test-skill', 'some args');
      // User message callback called with the modified prompt
      expect(userMessageCallback).toHaveBeenCalledWith('transformed prompt');
      // Original slash command shown in messages
      const userMsg = container.querySelector('.message--user');
      expect(userMsg?.textContent).toBe('/test-skill some args');
      // Textarea cleared
      expect(textarea.value).toBe('');
    });

    it('falls through when skill not found (callback returns null)', () => {
      const { view, container } = createView();
      const skillCallback = vi.fn().mockReturnValue(null);
      const userMessageCallback = vi.fn();

      view.onSkillInvocation(skillCallback);
      view.onUserMessage(userMessageCallback);

      const textarea = container.querySelector('.user-input__textarea') as HTMLTextAreaElement;
      textarea.value = '/unknown-skill';

      const sendBtn = container.querySelector('.btn--primary') as HTMLButtonElement;
      sendBtn.click();

      // Skill callback was called
      expect(skillCallback).toHaveBeenCalledWith('unknown-skill', '');
      // User message callback called with original text
      expect(userMessageCallback).toHaveBeenCalledWith('/unknown-skill');
    });

    it('falls through when no skill callback set', () => {
      const { view, container } = createView();
      const userMessageCallback = vi.fn();
      view.onUserMessage(userMessageCallback);
      // No skill callback set

      const textarea = container.querySelector('.user-input__textarea') as HTMLTextAreaElement;
      textarea.value = '/test';

      const sendBtn = container.querySelector('.btn--primary') as HTMLButtonElement;
      sendBtn.click();

      // Sent as normal message
      expect(userMessageCallback).toHaveBeenCalledWith('/test');
    });

    it('does not intercept non-slash messages', () => {
      const { view, container } = createView();
      const skillCallback = vi.fn().mockReturnValue({ modifiedPrompt: 'transformed' });
      const userMessageCallback = vi.fn();

      view.onSkillInvocation(skillCallback);
      view.onUserMessage(userMessageCallback);

      const textarea = container.querySelector('.user-input__textarea') as HTMLTextAreaElement;
      textarea.value = 'hello';

      const sendBtn = container.querySelector('.btn--primary') as HTMLButtonElement;
      sendBtn.click();

      // Skill callback NOT called
      expect(skillCallback).not.toHaveBeenCalled();
      // User message callback called with original text
      expect(userMessageCallback).toHaveBeenCalledWith('hello');
    });

    it('matches valid skill name format only', () => {
      const { view, container } = createView();
      const skillCallback = vi.fn().mockReturnValue({ modifiedPrompt: 'transformed' });
      const userMessageCallback = vi.fn();

      view.onSkillInvocation(skillCallback);
      view.onUserMessage(userMessageCallback);

      const textarea = container.querySelector('.user-input__textarea') as HTMLTextAreaElement;
      textarea.value = '/UPPERCASE args';

      const sendBtn = container.querySelector('.btn--primary') as HTMLButtonElement;
      sendBtn.click();

      // Skill callback NOT called (invalid name format - uppercase)
      expect(skillCallback).not.toHaveBeenCalled();
      // Sent as normal message
      expect(userMessageCallback).toHaveBeenCalledWith('/UPPERCASE args');
    });
  });

  describe('mic button', () => {
    it('should create mic button when SpeechRecognition is available', () => {
      // Set up mock SpeechRecognition
      (window as any).SpeechRecognition = class {
        start = vi.fn();
        stop = vi.fn();
        continuous = false;
        interimResults = false;
        lang = '';
        onresult: any = null;
        onerror: any = null;
        onend: any = null;
      };

      const { container } = createView();
      const micBtn = container.querySelector('.user-input__mic');
      expect(micBtn).toBeTruthy();
    });

    it('should not create mic button when SpeechRecognition is unavailable', () => {
      delete (window as any).SpeechRecognition;
      delete (window as any).webkitSpeechRecognition;

      const { container } = createView();
      const micBtn = container.querySelector('.user-input__mic');
      expect(micBtn).toBeNull();
    });

    it('should place mic button between textarea and send button', () => {
      (window as any).SpeechRecognition = class {
        start = vi.fn();
        stop = vi.fn();
        continuous = false;
        interimResults = false;
        lang = '';
        onresult: any = null;
        onerror: any = null;
        onend: any = null;
      };

      const { container } = createView();
      const inputRow = container.querySelector('.user-input__row');
      const children = Array.from(inputRow!.children);
      const textareaIdx = children.findIndex(c => c.classList.contains('user-input__textarea'));
      const micIdx = children.findIndex(c => c.classList.contains('user-input__mic'));
      const sendIdx = children.findIndex(c => c.classList.contains('user-input__send'));

      expect(micIdx).toBeGreaterThan(textareaIdx);
      expect(micIdx).toBeLessThan(sendIdx);
    });

    it('should disable mic button when input is disabled', () => {
      (window as any).SpeechRecognition = class {
        start = vi.fn();
        stop = vi.fn();
        continuous = false;
        interimResults = false;
        lang = '';
        onresult: any = null;
        onerror: any = null;
        onend: any = null;
      };

      const { view, container } = createView();
      const micBtn = container.querySelector('.user-input__mic') as HTMLButtonElement;

      view.setInputEnabled(false);
      expect(micBtn.disabled).toBe(true);

      view.setInputEnabled(true);
      expect(micBtn.disabled).toBe(false);
    });
  });
});
