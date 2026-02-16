import { describe, it, expect, vi } from 'vitest';
import { createDomTool } from './dom.js';
import type { ToolContext } from '@flo-monster/core';

function createMockContext(response: unknown = { result: { description: 'Done', elementCount: 1, rendered: { width: 100, height: 50, visible: true, display: 'block', childCount: 0 } } }): ToolContext {
  return {
    agentId: 'test-agent',
    sendToShell: vi.fn(),
    waitForResponse: vi.fn(async () => response),
  };
}

describe('createDomTool', () => {
  const tool = createDomTool();

  it('should have correct definition name and schema', () => {
    expect(tool.definition.name).toBe('dom');
    expect(tool.definition.input_schema.required).toContain('action');
    expect(tool.definition.input_schema.properties).toHaveProperty('action');
    expect(tool.definition.input_schema.properties).toHaveProperty('selector');
    expect(tool.definition.input_schema.properties).toHaveProperty('html');
  });

  it('should send dom_command with correct structure for create action', async () => {
    const ctx = createMockContext({ result: { description: 'Element created', elementCount: 1, rendered: { width: 300, height: 200, visible: true, display: 'flex', childCount: 3 } } });

    const result = await tool.execute({
      action: 'create',
      html: '<div>Hello</div>',
      parentSelector: '#app',
    }, ctx);

    expect(ctx.sendToShell).toHaveBeenCalledOnce();
    const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; id: string; command: Record<string, unknown>;
    };
    expect(sentMessage.type).toBe('dom_command');
    expect(sentMessage.id).toMatch(/^dom-/);
    expect(sentMessage.command.action).toBe('create');
    expect(sentMessage.command.html).toBe('<div>Hello</div>');
    expect(sentMessage.command.parentSelector).toBe('#app');
    expect(result.content).toBe('Element created (1 element(s))\nRendered: 300x200, visible, display: flex, 3 children');
    expect(result.is_error).toBeUndefined();
  });

  it('should send correct command for query action', async () => {
    const ctx = createMockContext({ result: { description: 'Found elements', elementCount: 3, rendered: { width: 150, height: 100, visible: true, display: 'block', childCount: 2 } } });

    const result = await tool.execute({
      action: 'query',
      selector: '.item',
    }, ctx);

    const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; command: Record<string, unknown>;
    };
    expect(sentMessage.command.action).toBe('query');
    expect(sentMessage.command.selector).toBe('.item');
    expect(result.content).toBe('Found elements (3 element(s))\nRendered: 150x100, visible, display: block, 2 children');
  });

  it('should send correct command for modify action', async () => {
    const ctx = createMockContext({ result: { description: 'Element modified', elementCount: 1, rendered: { width: 200, height: 100, visible: true, display: 'block', childCount: 1 } } });

    const result = await tool.execute({
      action: 'modify',
      selector: '#title',
      attributes: { class: 'active' },
      textContent: 'Updated Title',
    }, ctx);

    const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; command: Record<string, unknown>;
    };
    expect(sentMessage.command.action).toBe('modify');
    expect(sentMessage.command.selector).toBe('#title');
    expect(sentMessage.command.attributes).toEqual({ class: 'active' });
    expect(sentMessage.command.textContent).toBe('Updated Title');
    expect(result.content).toBe('Element modified (1 element(s))\nRendered: 200x100, visible, display: block, 1 children');
  });

  it('should send innerHTML in modify command', async () => {
    const ctx = createMockContext({ result: { description: 'Modified innerHTML', elementCount: 1, rendered: { width: 100, height: 50, visible: true, display: 'block', childCount: 1 } } });

    const result = await tool.execute({
      action: 'modify',
      selector: 'body',
      innerHTML: '<div>Hello</div><script>console.log("hi")</script>',
    }, ctx);

    const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; command: Record<string, unknown>;
    };
    expect(sentMessage.command.action).toBe('modify');
    expect(sentMessage.command.selector).toBe('body');
    expect(sentMessage.command.innerHTML).toBe('<div>Hello</div><script>console.log("hi")</script>');
    expect(result.content).toBe('Modified innerHTML (1 element(s))\nRendered: 100x50, visible, display: block, 1 children');
  });

  it('should send correct command for remove action', async () => {
    const ctx = createMockContext({ result: { description: 'Elements removed', elementCount: 2 } });

    const result = await tool.execute({
      action: 'remove',
      selector: '.obsolete',
    }, ctx);

    const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; command: Record<string, unknown>;
    };
    expect(sentMessage.command.action).toBe('remove');
    expect(sentMessage.command.selector).toBe('.obsolete');
    expect(result.content).toBe('Elements removed (2 element(s))');
  });

  it('should format NOT VISIBLE when rendered.visible is false', async () => {
    const ctx = createMockContext({ result: { description: 'Element created', elementCount: 1, rendered: { width: 0, height: 0, visible: false, display: 'none', childCount: 0 } } });

    const result = await tool.execute({
      action: 'create',
      html: '<div style="display:none">Hidden</div>',
    }, ctx);

    expect(result.content).toBe('Element created (1 element(s))\nRendered: 0x0 [NOT VISIBLE], display: none, 0 children');
  });

  it('should work without rendered info in response', async () => {
    const ctx = createMockContext({ result: { description: 'Elements removed', elementCount: 2 } });

    const result = await tool.execute({
      action: 'remove',
      selector: '.item',
    }, ctx);

    expect(result.content).toBe('Elements removed (2 element(s))');
  });

  it('should return error result when response has error', async () => {
    const ctx = createMockContext({ error: 'Element not found' });

    const result = await tool.execute({
      action: 'query',
      selector: '#nonexistent',
    }, ctx);

    expect(result.content).toBe('DOM error: Element not found');
    expect(result.is_error).toBe(true);
  });

  it('should return error result on timeout', async () => {
    const ctx: ToolContext = {
      agentId: 'test-agent',
      sendToShell: vi.fn(),
      waitForResponse: vi.fn(async () => {
        throw new Error('Timeout after 30000ms');
      }),
    };

    const result = await tool.execute({ action: 'create', html: '<div/>' }, ctx);

    expect(result.content).toContain('DOM command timeout');
    expect(result.is_error).toBe(true);
  });
});
