import { describe, it, expect, vi } from 'vitest';
import { createRunJsTool } from './runjs.js';
import type { ToolContext } from '@flo-monster/core';

const createMockContext = (responseMap: Record<string, unknown> = {}): ToolContext => ({
  agentId: 'test-agent',
  sendToShell: vi.fn(),
  waitForResponse: vi.fn(async (id: string) => responseMap[id] ?? { result: 'mock' }),
});

describe('createRunJsTool', () => {
  const tool = createRunJsTool();

  it('should have correct definition name and schema', () => {
    expect(tool.definition.name).toBe('runjs');
    expect(tool.definition.input_schema.required).toContain('code');
    expect(tool.definition.input_schema.properties).toHaveProperty('code');
    expect(tool.definition.input_schema.properties).toHaveProperty('context');
  });

  it('should execute simple expression in worker context and return result', async () => {
    const ctx = createMockContext();
    const result = await tool.execute({ code: 'return 2 + 2' }, ctx);

    expect(result.content).toContain('Result: 4');
    expect(result.is_error).toBeUndefined();
  });

  it('should capture console.log output in worker context', async () => {
    const ctx = createMockContext();
    const result = await tool.execute({ code: 'console.log("hello world")' }, ctx);

    expect(result.content).toContain('Console:\nhello world');
    expect(result.is_error).toBeUndefined();
  });

  it('should return error result when worker code throws', async () => {
    const ctx = createMockContext();
    const result = await tool.execute({ code: 'throw new Error("test error")' }, ctx);

    expect(result.content).toContain('Error: test error');
    expect(result.is_error).toBe(true);
  });

  it('should delegate to iframe via sendToShell and waitForResponse', async () => {
    const sendToShell = vi.fn();
    let capturedId = '';

    const ctx: ToolContext = {
      agentId: 'test-agent',
      sendToShell,
      waitForResponse: vi.fn(async (id: string) => {
        capturedId = id;
        return { result: '42' };
      }),
    };

    const result = await tool.execute({ code: 'document.title', context: 'iframe' }, ctx);

    expect(sendToShell).toHaveBeenCalledOnce();
    const sentMessage = sendToShell.mock.calls[0][0] as { type: string; id: string; code: string };
    expect(sentMessage.type).toBe('runjs_iframe');
    expect(sentMessage.code).toBe('document.title');
    expect(ctx.waitForResponse).toHaveBeenCalledWith(sentMessage.id);
    expect(result.content).toBe('42');
    expect(result.is_error).toBeUndefined();
  });

  it('should return error result when iframe response has error', async () => {
    const sendToShell = vi.fn();

    const ctx: ToolContext = {
      agentId: 'test-agent',
      sendToShell,
      waitForResponse: vi.fn(async () => ({ error: 'iframe script failed' })),
    };

    const result = await tool.execute({ code: 'bad code', context: 'iframe' }, ctx);

    expect(result.content).toBe('Error: iframe script failed');
    expect(result.is_error).toBe(true);
  });

  it('should return error result when iframe waitForResponse times out', async () => {
    const ctx: ToolContext = {
      agentId: 'test-agent',
      sendToShell: vi.fn(),
      waitForResponse: vi.fn(async () => {
        throw new Error('Timeout after 30000ms');
      }),
    };

    const result = await tool.execute({ code: 'slow code', context: 'iframe' }, ctx);

    expect(result.content).toContain('RunJS iframe timeout');
    expect(result.is_error).toBe(true);
  });
});
