import { describe, it, expect, vi } from 'vitest';
import { ExtensionLoader } from './extension-loader.js';
import { ToolPluginRegistry } from '@flo-monster/core';
import type { Extension, ExtensionManifest } from '@flo-monster/core';
import type { ToolPlugin } from '@flo-monster/core';

function createMockPlugin(name: string): ToolPlugin {
  return {
    definition: {
      name,
      description: `Mock tool: ${name}`,
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    execute: vi.fn(async () => ({ content: `${name} executed` })),
  };
}

function createMockExtension(id: string, tools?: ToolPlugin[], systemPromptAddition?: string): Extension {
  return {
    id,
    name: `Extension ${id}`,
    version: '1.0.0',
    description: `Test extension ${id}`,
    tools,
    systemPromptAddition,
  };
}

describe('ExtensionLoader', () => {
  it('loadBuiltin registers extension and its tools', () => {
    const registry = new ToolPluginRegistry();
    const loader = new ExtensionLoader(registry);
    const tool = createMockPlugin('ext-tool-1');
    const ext = createMockExtension('ext-1', [tool]);

    loader.loadBuiltin(ext);

    expect(loader.isLoaded('ext-1')).toBe(true);
    expect(registry.has('ext-tool-1')).toBe(true);
  });

  it('loadBuiltin throws if extension already loaded', () => {
    const registry = new ToolPluginRegistry();
    const loader = new ExtensionLoader(registry);
    const ext = createMockExtension('ext-1');

    loader.loadBuiltin(ext);
    expect(() => loader.loadBuiltin(ext)).toThrow('Extension already loaded: ext-1');
  });

  it('unload removes extension and its tools', () => {
    const registry = new ToolPluginRegistry();
    const loader = new ExtensionLoader(registry);
    const tool = createMockPlugin('ext-tool-1');
    const ext = createMockExtension('ext-1', [tool]);

    loader.loadBuiltin(ext);
    loader.unload('ext-1');

    expect(loader.isLoaded('ext-1')).toBe(false);
    expect(registry.has('ext-tool-1')).toBe(false);
  });

  it('getLoaded returns all loaded extensions', () => {
    const registry = new ToolPluginRegistry();
    const loader = new ExtensionLoader(registry);

    loader.loadBuiltin(createMockExtension('ext-1'));
    loader.loadBuiltin(createMockExtension('ext-2'));

    expect(loader.getLoaded()).toHaveLength(2);
  });

  it('getExtension returns extension by id', () => {
    const registry = new ToolPluginRegistry();
    const loader = new ExtensionLoader(registry);
    const ext = createMockExtension('ext-1');

    loader.loadBuiltin(ext);

    expect(loader.getExtension('ext-1')).toBe(ext);
    expect(loader.getExtension('nonexistent')).toBeUndefined();
  });

  it('getToolDefinitions returns combined tool defs', () => {
    const registry = new ToolPluginRegistry();
    const loader = new ExtensionLoader(registry);
    const tool1 = createMockPlugin('tool-a');
    const tool2 = createMockPlugin('tool-b');

    loader.loadBuiltin(createMockExtension('ext-1', [tool1]));
    loader.loadBuiltin(createMockExtension('ext-2', [tool2]));

    const defs = loader.getToolDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs.map(d => d.name)).toEqual(['tool-a', 'tool-b']);
  });

  it('getSystemPromptAdditions joins additions', () => {
    const registry = new ToolPluginRegistry();
    const loader = new ExtensionLoader(registry);

    loader.loadBuiltin(createMockExtension('ext-1', [], 'Addition 1'));
    loader.loadBuiltin(createMockExtension('ext-2', [], 'Addition 2'));

    expect(loader.getSystemPromptAdditions()).toBe('Addition 1\n\nAddition 2');
  });

  it('loadFromUrl rejects if no entryUrl', async () => {
    const registry = new ToolPluginRegistry();
    const loader = new ExtensionLoader(registry);
    const manifest: ExtensionManifest = { id: 'ext-1', name: 'Ext', version: '1.0.0' };

    await expect(loader.loadFromUrl(manifest)).rejects.toThrow('Extension manifest missing entryUrl');
  });

  it('loadFromUrl rejects non-https URLs', async () => {
    const registry = new ToolPluginRegistry();
    const loader = new ExtensionLoader(registry);

    await expect(loader.loadFromUrl({
      id: 'ext-http',
      name: 'Bad Extension',
      version: '1.0.0',
      entryUrl: 'http://evil.com/ext.js',
    })).rejects.toThrow('Extension URL must use HTTPS');
  });

  it('loadFromUrl allows http://localhost', async () => {
    const registry = new ToolPluginRegistry();
    const loader = new ExtensionLoader(registry);

    // This should fail on the dynamic import, not the URL check
    await expect(loader.loadFromUrl({
      id: 'ext-local',
      name: 'Local Extension',
      version: '1.0.0',
      entryUrl: 'http://localhost:3000/ext.js',
    })).rejects.toThrow('Failed to load extension');
  });
});
