import { describe, it, expect, vi } from 'vitest';
import { createFetchTool } from './fetch-tool.js';
import type { ToolContext } from '@flo-monster/core';

function createMockContext(response: unknown): ToolContext {
  return {
    agentId: 'test-agent',
    sendToShell: vi.fn(),
    waitForResponse: vi.fn(async () => response),
  };
}

describe('createFetchTool', () => {
  const tool = createFetchTool();

  it('should have correct definition name and schema', () => {
    expect(tool.definition.name).toBe('fetch');
    expect(tool.definition.input_schema.required).toContain('url');
    expect(tool.definition.input_schema.properties).toHaveProperty('url');
    expect(tool.definition.input_schema.properties).toHaveProperty('method');
    expect(tool.definition.input_schema.properties).toHaveProperty('headers');
    expect(tool.definition.input_schema.properties).toHaveProperty('body');
  });

  it('should return status and body for successful GET request', async () => {
    const ctx = createMockContext({
      type: 'fetch_response',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"data": "hello"}',
    });

    const result = await tool.execute({ url: 'https://example.com/api' }, ctx);

    expect(ctx.sendToShell).toHaveBeenCalledOnce();
    const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; id: string; url: string; options: Record<string, unknown>;
    };
    expect(sentMessage.type).toBe('fetch_request');
    expect(sentMessage.url).toBe('https://example.com/api');
    expect(sentMessage.options.method).toBe('GET');

    expect(result.content).toContain('Status: 200');
    expect(result.content).toContain('Headers: {"content-type":"application/json"}');
    expect(result.content).toContain('Body:\n{"data": "hello"}');
    expect(result.is_error).toBeUndefined();
  });

  it('should send correct options for POST request', async () => {
    const ctx = createMockContext({
      type: 'fetch_response',
      status: 201,
      body: '{"id": 1}',
    });

    const result = await tool.execute({
      url: 'https://example.com/api',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name": "test"}',
    }, ctx);

    const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; options: Record<string, unknown>;
    };
    expect(sentMessage.options.method).toBe('POST');
    expect(sentMessage.options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(sentMessage.options.body).toBe('{"name": "test"}');

    expect(result.content).toContain('Status: 201');
    expect(result.is_error).toBeUndefined();
  });

  it('should return error result on fetch error response', async () => {
    const ctx = createMockContext({
      type: 'fetch_error',
      error: 'Network request failed',
    });

    const result = await tool.execute({ url: 'https://bad.example.com' }, ctx);

    expect(result.content).toBe('Fetch error: Network request failed');
    expect(result.is_error).toBe(true);
  });

  it('should return error result on network timeout', async () => {
    const ctx: ToolContext = {
      agentId: 'test-agent',
      sendToShell: vi.fn(),
      waitForResponse: vi.fn(async () => {
        throw new Error('Timeout after 30000ms');
      }),
    };

    const result = await tool.execute({ url: 'https://slow.example.com' }, ctx);

    expect(result.content).toContain('Fetch timeout');
    expect(result.is_error).toBe(true);
  });
});
