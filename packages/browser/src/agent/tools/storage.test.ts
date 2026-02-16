import { describe, it, expect, vi } from 'vitest';
import { createStorageTool } from './storage.js';
import type { ToolContext } from '@flo-monster/core';

function createMockContext(response: unknown): ToolContext {
  return {
    agentId: 'test-agent',
    sendToShell: vi.fn(),
    waitForResponse: vi.fn(async () => response),
  };
}

describe('createStorageTool', () => {
  const tool = createStorageTool();

  it('should have correct definition name and schema', () => {
    expect(tool.definition.name).toBe('storage');
    expect(tool.definition.input_schema.required).toContain('action');
    expect(tool.definition.input_schema.properties).toHaveProperty('action');
    expect(tool.definition.input_schema.properties).toHaveProperty('key');
    expect(tool.definition.input_schema.properties).toHaveProperty('value');
  });

  it('should send correct storage_request for set action', async () => {
    const ctx = createMockContext({ result: 'ok' });

    const result = await tool.execute({
      action: 'set',
      key: 'myKey',
      value: 'myValue',
    }, ctx);

    expect(ctx.sendToShell).toHaveBeenCalledOnce();
    const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; id: string; action: string; key: string; value: unknown;
    };
    expect(sentMessage.type).toBe('storage_request');
    expect(sentMessage.id).toMatch(/^storage-/);
    expect(sentMessage.action).toBe('set');
    expect(sentMessage.key).toBe('myKey');
    expect(sentMessage.value).toBe('myValue');

    expect(result.content).toBe('Value stored successfully');
    expect(result.is_error).toBeUndefined();
  });

  it('should return stored value for get action', async () => {
    const ctx = createMockContext({ result: 'storedValue' });

    const result = await tool.execute({
      action: 'get',
      key: 'myKey',
    }, ctx);

    const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; action: string; key: string;
    };
    expect(sentMessage.action).toBe('get');
    expect(sentMessage.key).toBe('myKey');

    expect(result.content).toBe('storedValue');
    expect(result.is_error).toBeUndefined();
  });

  it('should return "Key not found" for get action when key does not exist', async () => {
    const ctx = createMockContext({ result: undefined });

    const result = await tool.execute({
      action: 'get',
      key: 'nonexistent',
    }, ctx);

    expect(result.content).toBe('Key not found');
  });

  it('should send correct request for delete action', async () => {
    const ctx = createMockContext({ result: 'ok' });

    const result = await tool.execute({
      action: 'delete',
      key: 'myKey',
    }, ctx);

    const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; action: string; key: string;
    };
    expect(sentMessage.action).toBe('delete');
    expect(sentMessage.key).toBe('myKey');

    expect(result.content).toBe('Key deleted successfully');
    expect(result.is_error).toBeUndefined();
  });

  it('should return keys for list action', async () => {
    const ctx = createMockContext({ keys: ['key1', 'key2', 'key3'] });

    const result = await tool.execute({ action: 'list' }, ctx);

    const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      type: string; action: string;
    };
    expect(sentMessage.action).toBe('list');

    expect(result.content).toBe('Keys: key1, key2, key3');
    expect(result.is_error).toBeUndefined();
  });

  it('should return "No keys found" for empty list', async () => {
    const ctx = createMockContext({ keys: [] });

    const result = await tool.execute({ action: 'list' }, ctx);

    expect(result.content).toBe('No keys found');
  });

  it('should return error result when response has error', async () => {
    const ctx = createMockContext({ error: 'Storage quota exceeded' });

    const result = await tool.execute({
      action: 'set',
      key: 'bigKey',
      value: 'bigValue',
    }, ctx);

    expect(result.content).toBe('Storage error: Storage quota exceeded');
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

    const result = await tool.execute({ action: 'get', key: 'test' }, ctx);

    expect(result.content).toContain('Storage timeout');
    expect(result.is_error).toBe(true);
  });
});
