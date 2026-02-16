import { describe, it, expect, vi } from 'vitest';
import { createStateTool } from './state.js';
import type { ToolContext } from '@flo-monster/core';

function createMockContext(response: unknown): ToolContext {
  return {
    agentId: 'test-agent',
    sendToShell: vi.fn(),
    waitForResponse: vi.fn(async () => response),
  };
}

describe('createStateTool', () => {
  const tool = createStateTool();

  it('should have correct definition name and schema', () => {
    expect(tool.definition.name).toBe('state');
    expect(tool.definition.input_schema.required).toContain('action');
    expect(tool.definition.input_schema.properties).toHaveProperty('action');
    expect(tool.definition.input_schema.properties).toHaveProperty('key');
    expect(tool.definition.input_schema.properties).toHaveProperty('value');
    expect(tool.definition.input_schema.properties).toHaveProperty('condition');
    expect(tool.definition.input_schema.properties).toHaveProperty('message');
  });

  it('should send state_request for get action', async () => {
    const ctx = createMockContext({ result: 42 });
    const result = await tool.execute({ action: 'get', key: 'score' }, ctx);

    expect(ctx.sendToShell).toHaveBeenCalledOnce();
    const sent = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.type).toBe('state_request');
    expect(sent.id).toMatch(/^state-/);
    expect(sent.action).toBe('get');
    expect(sent.key).toBe('score');

    expect(result.content).toBe('42');
    expect(result.is_error).toBeUndefined();
  });

  it('should return "Key not found" for get when key does not exist', async () => {
    const ctx = createMockContext({ result: undefined });
    const result = await tool.execute({ action: 'get', key: 'missing' }, ctx);
    expect(result.content).toBe('Key not found');
  });

  it('should send state_request for get_all action', async () => {
    const ctx = createMockContext({ result: { score: 42, name: 'test' } });
    const result = await tool.execute({ action: 'get_all' }, ctx);
    expect(result.content).toBe('{"score":42,"name":"test"}');
  });

  it('should send state_request for set action', async () => {
    const ctx = createMockContext({ result: 'ok' });
    const result = await tool.execute({ action: 'set', key: 'score', value: 100 }, ctx);

    const sent = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.action).toBe('set');
    expect(sent.key).toBe('score');
    expect(sent.value).toBe(100);
    expect(result.content).toBe('State updated');
  });

  it('should send state_request for delete action', async () => {
    const ctx = createMockContext({ result: 'ok' });
    const result = await tool.execute({ action: 'delete', key: 'score' }, ctx);
    expect(result.content).toBe('State key deleted');
  });

  it('should send state_request for escalate action', async () => {
    const ctx = createMockContext({ result: 'ok' });
    const result = await tool.execute({
      action: 'escalate',
      key: 'score',
      condition: 'val > 100',
      message: 'High score reached',
    }, ctx);

    const sent = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.action).toBe('escalate');
    expect(sent.key).toBe('score');
    expect(sent.condition).toBe('val > 100');
    expect(sent.message).toBe('High score reached');
    expect(result.content).toBe('Escalation rule set');
  });

  it('should send state_request for clear_escalation action', async () => {
    const ctx = createMockContext({ result: 'ok' });
    const result = await tool.execute({ action: 'clear_escalation', key: 'score' }, ctx);
    expect(result.content).toBe('Escalation rule cleared');
  });

  it('should return escalation rules list', async () => {
    const rules = [{ key: 'score', condition: 'val > 100', message: 'High score' }];
    const ctx = createMockContext({ result: rules });
    const result = await tool.execute({ action: 'escalation_rules' }, ctx);
    expect(result.content).toBe(JSON.stringify(rules));
  });

  it('should return error when response has error', async () => {
    const ctx = createMockContext({ error: 'State operation failed' });
    const result = await tool.execute({ action: 'set', key: 'x', value: 1 }, ctx);
    expect(result.content).toBe('State error: State operation failed');
    expect(result.is_error).toBe(true);
  });

  it('should return error on timeout', async () => {
    const ctx: ToolContext = {
      agentId: 'test-agent',
      sendToShell: vi.fn(),
      waitForResponse: vi.fn(async () => {
        throw new Error('Timeout after 30000ms');
      }),
    };
    const result = await tool.execute({ action: 'get', key: 'x' }, ctx);
    expect(result.content).toContain('State timeout');
    expect(result.is_error).toBe(true);
  });

  it('should handle set with complex JSON value', async () => {
    const ctx = createMockContext({ result: 'ok' });
    const value = { players: [{ name: 'Alice', score: 10 }], round: 3 };
    const result = await tool.execute({ action: 'set', key: 'game', value }, ctx);

    const sent = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.value).toEqual(value);
    expect(result.content).toBe('State updated');
  });
});
