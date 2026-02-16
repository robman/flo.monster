import { describe, it, expect, vi } from 'vitest';
import { createDomTool } from './dom.js';
import type { ToolContext } from '@flo-monster/core';

function createMockContext(response: unknown = { success: true }): ToolContext {
  return {
    agentId: 'test-agent',
    sendToShell: vi.fn(),
    waitForResponse: vi.fn(async () => response),
  };
}

describe('DOM Event Listener Actions', () => {
  const tool = createDomTool();

  describe('listen action', () => {
    it('should send dom_listen message with correct structure', async () => {
      const ctx = createMockContext({ success: true });

      const result = await tool.execute({
        action: 'listen',
        selector: '.btn',
        events: ['click', 'mouseenter'],
        options: { debounce: 100 },
      }, ctx);

      expect(ctx.sendToShell).toHaveBeenCalledOnce();
      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        type: string; id: string; selector: string; events: string[]; options: { debounce: number };
      };
      expect(sentMessage.type).toBe('dom_listen');
      expect(sentMessage.id).toMatch(/^dom-/);
      expect(sentMessage.selector).toBe('.btn');
      expect(sentMessage.events).toEqual(['click', 'mouseenter']);
      expect(sentMessage.options).toEqual({ debounce: 100 });
      expect(result.content).toContain('Event listener registered');
      expect(result.content).toContain('.btn');
      expect(result.is_error).toBeUndefined();
    });

    it('should handle listen error', async () => {
      const ctx = createMockContext({ success: false, error: 'Invalid selector' });

      const result = await tool.execute({
        action: 'listen',
        selector: '!!!invalid',
        events: ['click'],
      }, ctx);

      expect(result.content).toContain('Listen error');
      expect(result.content).toContain('Invalid selector');
      expect(result.is_error).toBe(true);
    });

    it('should handle empty events array', async () => {
      const ctx = createMockContext({ success: true });

      const result = await tool.execute({
        action: 'listen',
        selector: '#test',
      }, ctx);

      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        events: string[];
      };
      expect(sentMessage.events).toEqual([]);
      expect(result.is_error).toBeUndefined();
    });
  });

  describe('unlisten action', () => {
    it('should send dom_unlisten message', async () => {
      const ctx = createMockContext({ success: true });

      const result = await tool.execute({
        action: 'unlisten',
        selector: '.btn',
      }, ctx);

      expect(ctx.sendToShell).toHaveBeenCalledOnce();
      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        type: string; selector: string;
      };
      expect(sentMessage.type).toBe('dom_unlisten');
      expect(sentMessage.selector).toBe('.btn');
      expect(result.content).toContain('Event listener removed');
      expect(result.is_error).toBeUndefined();
    });

    it('should handle unlisten error', async () => {
      const ctx = createMockContext({ success: false, error: 'Listener not found' });

      const result = await tool.execute({
        action: 'unlisten',
        selector: '.nonexistent',
      }, ctx);

      expect(result.content).toContain('Unlisten error');
      expect(result.is_error).toBe(true);
    });
  });

  describe('wait_for action', () => {
    it('should send dom_wait message and return event data', async () => {
      const ctx = createMockContext({
        event: {
          type: 'click',
          selector: '#submit',
          target: { id: 'submit', value: undefined },
          formData: undefined,
        },
      });

      const result = await tool.execute({
        action: 'wait_for',
        selector: '#submit',
        event: 'click',
        timeout: 5000,
      }, ctx);

      expect(ctx.sendToShell).toHaveBeenCalledOnce();
      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        type: string; selector: string; event: string; timeout: number;
      };
      expect(sentMessage.type).toBe('dom_wait');
      expect(sentMessage.selector).toBe('#submit');
      expect(sentMessage.event).toBe('click');
      expect(sentMessage.timeout).toBe(5000);
      expect(result.content).toContain('Event received');
      expect(result.content).toContain('click');
      expect(result.is_error).toBeUndefined();
    });

    it('should include form data in result', async () => {
      const ctx = createMockContext({
        event: {
          type: 'submit',
          selector: 'form',
          target: { id: 'loginForm' },
          formData: { username: 'test', password: 'secret' },
        },
      });

      const result = await tool.execute({
        action: 'wait_for',
        selector: 'form',
        event: 'submit',
      }, ctx);

      expect(result.content).toContain('Form data');
      expect(result.content).toContain('username');
      expect(result.is_error).toBeUndefined();
    });

    it('should handle wait timeout', async () => {
      const ctx = createMockContext({
        error: 'Timeout waiting for click on #slow-btn',
      });

      const result = await tool.execute({
        action: 'wait_for',
        selector: '#slow-btn',
        event: 'click',
        timeout: 1000,
      }, ctx);

      expect(result.content).toContain('Wait error');
      expect(result.content).toContain('Timeout');
      expect(result.is_error).toBe(true);
    });

    it('should include target value in result', async () => {
      const ctx = createMockContext({
        event: {
          type: 'input',
          selector: '#search',
          target: { id: 'search', value: 'hello world' },
        },
      });

      const result = await tool.execute({
        action: 'wait_for',
        selector: '#search',
        event: 'input',
      }, ctx);

      expect(result.content).toContain('value: hello world');
      expect(result.is_error).toBeUndefined();
    });
  });

  describe('get_listeners action', () => {
    it('should return list of registered listeners', async () => {
      const ctx = createMockContext({
        listeners: [
          { selector: '.btn', events: ['click'], workerId: 'main' },
          { selector: 'form', events: ['submit', 'input'], workerId: 'sub-1' },
        ],
      });

      const result = await tool.execute({
        action: 'get_listeners',
      }, ctx);

      expect(ctx.sendToShell).toHaveBeenCalledOnce();
      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        type: string;
      };
      expect(sentMessage.type).toBe('dom_get_listeners');
      expect(result.content).toContain('Registered listeners');
      expect(result.content).toContain('.btn');
      expect(result.content).toContain('form');
      expect(result.content).toContain('main');
      expect(result.content).toContain('sub-1');
      expect(result.is_error).toBeUndefined();
    });

    it('should handle empty listeners', async () => {
      const ctx = createMockContext({
        listeners: [],
      });

      const result = await tool.execute({
        action: 'get_listeners',
      }, ctx);

      expect(result.content).toBe('No event listeners registered');
      expect(result.is_error).toBeUndefined();
    });
  });
});

describe('DOM Tool Schema', () => {
  const tool = createDomTool();

  it('should include event-related actions in enum', () => {
    const actionProp = tool.definition.input_schema.properties?.action as { enum: string[] };
    expect(actionProp.enum).toContain('listen');
    expect(actionProp.enum).toContain('unlisten');
    expect(actionProp.enum).toContain('wait_for');
    expect(actionProp.enum).toContain('get_listeners');
  });

  it('should include event-related properties in schema', () => {
    const props = tool.definition.input_schema.properties;
    expect(props).toHaveProperty('events');
    expect(props).toHaveProperty('event');
    expect(props).toHaveProperty('timeout');
    expect(props).toHaveProperty('options');
  });

  it('should have updated description mentioning event functionality', () => {
    expect(tool.definition.description).toContain('listen');
    expect(tool.definition.description).toContain('wait_for');
  });
});
