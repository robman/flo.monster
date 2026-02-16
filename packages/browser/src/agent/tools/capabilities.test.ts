import { describe, it, expect, vi } from 'vitest';
import { createCapabilitiesTool } from './capabilities.js';
import type { ToolContext } from '@flo-monster/core';

function createMockContext(response: unknown): ToolContext {
  return {
    agentId: 'test-agent',
    sendToShell: vi.fn(),
    waitForResponse: vi.fn(async () => response),
  };
}

describe('createCapabilitiesTool', () => {
  const tool = createCapabilitiesTool();

  it('should have correct definition name and schema', () => {
    expect(tool.definition.name).toBe('capabilities');
    expect(tool.definition.input_schema.properties).toHaveProperty('probe');
    expect(tool.definition.input_schema.properties).toHaveProperty('url');
    expect(tool.definition.input_schema.properties).toHaveProperty('name');
  });

  it('sends snapshot request with no arguments', async () => {
    const ctx = createMockContext({ result: { runtime: 'browser', tools: {} } });
    const result = await tool.execute({}, ctx);

    expect(ctx.sendToShell).toHaveBeenCalledOnce();
    const sent = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.type).toBe('capabilities_request');
    expect(sent.id).toMatch(/^cap-/);
    expect(sent.action).toBe('snapshot');
    expect(sent.probe).toBeUndefined();

    expect(result.is_error).toBeUndefined();
    expect(JSON.parse(result.content as string)).toEqual({ runtime: 'browser', tools: {} });
  });

  it('sends probe request with probe argument', async () => {
    const ctx = createMockContext({ result: { supported: true, version: 'webgl2' } });
    const result = await tool.execute({ probe: 'webgl' }, ctx);

    const sent = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.action).toBe('probe');
    expect(sent.probe).toBe('webgl');

    expect(JSON.parse(result.content as string)).toEqual({ supported: true, version: 'webgl2' });
  });

  it('includes url in probeArgs for network probe', async () => {
    const ctx = createMockContext({ result: { allowed: true } });
    await tool.execute({ probe: 'network', url: 'https://api.example.com' }, ctx);

    const sent = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.probeArgs.url).toBe('https://api.example.com');
  });

  it('includes name in probeArgs for tool probe', async () => {
    const ctx = createMockContext({ result: { available: true, source: 'hub' } });
    await tool.execute({ probe: 'tool', name: 'bash' }, ctx);

    const sent = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.probeArgs.name).toBe('bash');
  });

  it('returns error when response has error', async () => {
    const ctx = createMockContext({ error: 'Something went wrong' });
    const result = await tool.execute({}, ctx);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Something went wrong');
  });

  it('returns formatted JSON with indentation', async () => {
    const ctx = createMockContext({ result: { a: 1, b: 2 } });
    const result = await tool.execute({}, ctx);

    expect(result.content).toBe(JSON.stringify({ a: 1, b: 2 }, null, 2));
  });

  it('handles timeout errors', async () => {
    const ctx: ToolContext = {
      agentId: 'test-agent',
      sendToShell: vi.fn(),
      waitForResponse: vi.fn(async () => { throw new Error('Timeout'); }),
    };
    const result = await tool.execute({}, ctx);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Capabilities timeout');
  });
});
