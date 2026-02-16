import { describe, it, expect, vi } from 'vitest';
import { ToolPluginRegistry } from '../plugin-registry.js';
import type { ToolPlugin, ShellToolContext, ToolResult } from '../../types/tools.js';

function createMockPlugin(
  name: string,
  executeFn?: (input: Record<string, unknown>, ctx: ShellToolContext) => Promise<ToolResult>,
): ToolPlugin {
  return {
    definition: {
      name,
      description: `Mock plugin: ${name}`,
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

function createMockContext(): ShellToolContext {
  return {
    agentId: 'test-agent',
    agentConfig: {
      id: 'test-agent',
      name: 'Test Agent',
      model: 'test-model',
      tools: [],
      maxTokens: 4096,
    },
  };
}

describe('ToolPluginRegistry', () => {
  it('should register and get a plugin', () => {
    const registry = new ToolPluginRegistry();
    const plugin = createMockPlugin('my-plugin');

    registry.register(plugin);

    const retrieved = registry.get('my-plugin');
    expect(retrieved).toBe(plugin);
  });

  it('should return undefined for unknown plugin', () => {
    const registry = new ToolPluginRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('should return all registered plugins via getAll', () => {
    const registry = new ToolPluginRegistry();
    const plugin1 = createMockPlugin('plugin-a');
    const plugin2 = createMockPlugin('plugin-b');

    registry.register(plugin1);
    registry.register(plugin2);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(plugin1);
    expect(all).toContain(plugin2);
  });

  it('should return all definitions via getDefinitions', () => {
    const registry = new ToolPluginRegistry();
    const plugin1 = createMockPlugin('plugin-a');
    const plugin2 = createMockPlugin('plugin-b');

    registry.register(plugin1);
    registry.register(plugin2);

    const definitions = registry.getDefinitions();
    expect(definitions).toHaveLength(2);
    expect(definitions[0].name).toBe('plugin-a');
    expect(definitions[1].name).toBe('plugin-b');
    expect(definitions[0].description).toBe('Mock plugin: plugin-a');
    expect(definitions[1].description).toBe('Mock plugin: plugin-b');
  });

  it('should return true for has when plugin is registered', () => {
    const registry = new ToolPluginRegistry();
    const plugin = createMockPlugin('my-plugin');

    registry.register(plugin);

    expect(registry.has('my-plugin')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('should execute a registered plugin and return its result', async () => {
    const registry = new ToolPluginRegistry();
    const plugin = createMockPlugin('my-plugin', async (input) => ({
      content: `Executed with ${input.value}`,
    }));
    registry.register(plugin);

    const ctx = createMockContext();
    const result = await registry.execute('my-plugin', { value: 'hello' }, ctx);

    expect(result.content).toBe('Executed with hello');
    expect(result.is_error).toBeUndefined();
  });

  it('should return error result when executing an unknown plugin', async () => {
    const registry = new ToolPluginRegistry();
    const ctx = createMockContext();

    const result = await registry.execute('unknown-plugin', {}, ctx);

    expect(result.content).toBe('Unknown plugin tool: unknown-plugin');
    expect(result.is_error).toBe(true);
  });

  it('should catch thrown errors and return error result', async () => {
    const registry = new ToolPluginRegistry();
    const plugin = createMockPlugin('failing-plugin', async () => {
      throw new Error('Something went wrong');
    });
    registry.register(plugin);

    const ctx = createMockContext();
    const result = await registry.execute('failing-plugin', {}, ctx);

    expect(result.content).toBe('Plugin tool error: Error: Something went wrong');
    expect(result.is_error).toBe(true);
  });

  it('should unregister a plugin', () => {
    const registry = new ToolPluginRegistry();
    const plugin = createMockPlugin('my-plugin');

    registry.register(plugin);
    expect(registry.has('my-plugin')).toBe(true);

    registry.unregister('my-plugin');
    expect(registry.has('my-plugin')).toBe(false);
    expect(registry.get('my-plugin')).toBeUndefined();
  });

  it('should throw when registering duplicate tool name', () => {
    const registry = new ToolPluginRegistry();
    const plugin1 = createMockPlugin('duplicate-name');
    const plugin2 = createMockPlugin('duplicate-name');

    registry.register(plugin1);
    expect(() => registry.register(plugin2)).toThrow('Tool plugin already registered: duplicate-name');
  });
});
