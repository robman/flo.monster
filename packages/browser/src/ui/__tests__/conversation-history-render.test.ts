import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationView } from '../conversation.js';

describe('ConversationView conversation_history handling', () => {
  let container: HTMLElement;
  let conversation: ConversationView;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    conversation = new ConversationView(container);
  });

  it('renders conversation history from hub on subscribe', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
    ];

    conversation.handleEvent({ type: 'conversation_history', messages } as any);

    const userMsgs = container.querySelectorAll('.message--user');
    const assistantMsgs = container.querySelectorAll('.message--assistant');
    expect(userMsgs.length).toBe(1);
    expect(assistantMsgs.length).toBe(1);
  });

  it('renders tool calls in conversation history', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Run something' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me run that' },
        { type: 'tool_use', id: 'tool_1', name: 'runjs', input: { code: 'console.log(1)' } },
      ]},
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tool_1', content: '1' },
      ]},
    ];

    conversation.handleEvent({ type: 'conversation_history', messages } as any);

    const toolCalls = container.querySelectorAll('.tool-call');
    expect(toolCalls.length).toBeGreaterThan(0);
  });

  it('clears existing messages before rendering history', () => {
    // Add some existing content
    conversation.handleEvent({ type: 'message_start' } as any);
    conversation.handleEvent({ type: 'text_delta', text: 'old message' } as any);

    // Now render history
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'New conversation' }] },
    ];
    conversation.handleEvent({ type: 'conversation_history', messages } as any);

    // Old content should be gone, only new history
    const allMessages = container.querySelectorAll('.message');
    expect(allMessages.length).toBe(1);
  });
  it('renders conversation history with string content format (hub format)', () => {
    const messages = [
      { role: 'user', content: 'Hello from hub' },
      { role: 'assistant', content: 'Hub response here' },
    ];

    conversation.handleEvent({ type: 'conversation_history', messages } as any);

    const userMsgs = container.querySelectorAll('.message--user');
    const assistantMsgs = container.querySelectorAll('.message--assistant');
    expect(userMsgs.length).toBe(1);
    expect(userMsgs[0].textContent).toBe('Hello from hub');
    expect(assistantMsgs.length).toBe(1);
    // Assistant text goes into a .message__text span
    const textSpan = assistantMsgs[0].querySelector('.message__text');
    expect(textSpan).not.toBeNull();
    expect(textSpan!.textContent).toBe('Hub response here');
  });

  it('renders conversation history with mixed content formats', () => {
    const messages = [
      { role: 'user', content: 'String format' },
      { role: 'assistant', content: [{ type: 'text', text: 'Block format response' }] },
      { role: 'user', content: [{ type: 'text', text: 'Block format question' }] },
      { role: 'assistant', content: 'String format response' },
    ];

    conversation.handleEvent({ type: 'conversation_history', messages } as any);

    const userMsgs = container.querySelectorAll('.message--user');
    const assistantMsgs = container.querySelectorAll('.message--assistant');
    expect(userMsgs.length).toBe(2);
    expect(userMsgs[0].textContent).toBe('String format');
    expect(userMsgs[1].textContent).toBe('Block format question');
    expect(assistantMsgs.length).toBe(2);
  });
});