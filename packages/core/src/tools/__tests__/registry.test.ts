import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolHandler, ToolContext, ToolResult } from '../../types/tools.js';

function createMockHandler(name: string, executeFn?: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>): ToolHandler {
  return {
    definition: {
      name,
      description: `Mock tool: ${name}`,
      input_schema: {
        type: 'object',
        properties: {
          input: { type: 'string' },
        },
        required: ['input'],
      },
    },
    execute: executeFn ?? vi.fn(async () => ({ content: `${name} result` })),
  };
}

function createMockContext(): ToolContext {
  return {
    agentId: 'test-agent',
    sendToShell: vi.fn(),
    waitForResponse: vi.fn(async () => ({})),
  };
}

describe('ToolRegistry', () => {
  it('should register and retrieve a tool handler', () => {
    const registry = new ToolRegistry();
    const handler = createMockHandler('test-tool');

    registry.register(handler);

    const retrieved = registry.get('test-tool');
    expect(retrieved).toBe(handler);
  });

  it('should return undefined for unregistered tool', () => {
    const registry = new ToolRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('should return all registered tool definitions via getDefinitions', () => {
    const registry = new ToolRegistry();
    const handler1 = createMockHandler('tool-a');
    const handler2 = createMockHandler('tool-b');

    registry.register(handler1);
    registry.register(handler2);

    const definitions = registry.getDefinitions();
    expect(definitions).toHaveLength(2);
    expect(definitions[0].name).toBe('tool-a');
    expect(definitions[1].name).toBe('tool-b');
    expect(definitions[0].description).toBe('Mock tool: tool-a');
    expect(definitions[1].description).toBe('Mock tool: tool-b');
  });

  it('should execute a registered handler and return its result', async () => {
    const registry = new ToolRegistry();
    const handler = createMockHandler('my-tool', async (input) => ({
      content: `Executed with ${input.value}`,
    }));
    registry.register(handler);

    const ctx = createMockContext();
    const result = await registry.execute('my-tool', { value: 'hello' }, ctx);

    expect(result.content).toBe('Executed with hello');
    expect(result.is_error).toBeUndefined();
  });

  it('should return error result when executing an unknown tool', async () => {
    const registry = new ToolRegistry();
    const ctx = createMockContext();

    const result = await registry.execute('unknown-tool', {}, ctx);

    expect(result.content).toBe('Unknown tool: unknown-tool');
    expect(result.is_error).toBe(true);
  });

  it('should catch handler errors and return error result', async () => {
    const registry = new ToolRegistry();
    const handler = createMockHandler('failing-tool', async () => {
      throw new Error('Something went wrong');
    });
    registry.register(handler);

    const ctx = createMockContext();
    const result = await registry.execute('failing-tool', {}, ctx);

    expect(result.content).toBe('Tool execution error: Error: Something went wrong');
    expect(result.is_error).toBe(true);
  });
});
