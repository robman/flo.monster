import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRelay } from './message-relay.js';
import { ToolPluginRegistry } from '@flo-monster/core';
import type { AgentContainer } from '../agent/agent-container.js';
import * as agentStorage from '../storage/agent-storage.js';

function createMockAgent(id: string, networkPolicy?: any): AgentContainer {
  const iframeWindow = {
    postMessage: vi.fn(),
  };
  return {
    id,
    config: {
      id,
      name: 'Test',
      model: 'test',
      tools: [],
      maxTokens: 4096,
      networkPolicy,
    },
    state: 'running',
    getIframeElement: () => ({
      contentWindow: iframeWindow,
    }),
  } as any;
}

describe('MessageRelay', () => {
  let relay: MessageRelay;

  beforeEach(() => {
    relay = new MessageRelay();
  });

  describe('agent registration', () => {
    it('registers and finds agents', () => {
      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      // Internal - verified by message handling
      expect(agent.id).toBe('a1');
    });

    it('unregisters agents', () => {
      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.unregisterAgent('a1');
      // After unregister, messages for this agent should be ignored
    });
  });

  describe('start and stop', () => {
    it('start adds message listener', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      relay.start();
      expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function), expect.any(Object));
      relay.stop();
      addSpy.mockRestore();
    });

    it('stop removes listener via abort', () => {
      relay.start();
      relay.stop();
      // No error thrown = success
    });
  });

  describe('plugin registry', () => {
    it('setPluginRegistry sets the registry', () => {
      const registry = new ToolPluginRegistry();
      // Should not throw
      relay.setPluginRegistry(registry);
    });

    it('tool_execute message is dispatched to the plugin registry', async () => {
      const registry = new ToolPluginRegistry();
      vi.spyOn(registry, 'has').mockReturnValue(true);
      const executeSpy = vi.spyOn(registry, 'execute').mockResolvedValue({
        content: 'plugin result',
      });
      relay.setPluginRegistry(registry);

      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      // Simulate a tool_execute message from the iframe (with correct source)
      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      const messageEvent = new MessageEvent('message', {
        data: {
          type: 'tool_execute',
          id: 'te-1',
          agentId: 'a1',
          name: 'my-plugin-tool',
          input: { key: 'value' },
        },
        source: iframeWindow as any,
      });
      window.dispatchEvent(messageEvent);

      // Allow async handler to run
      await new Promise(r => setTimeout(r, 10));

      expect(executeSpy).toHaveBeenCalledWith(
        'my-plugin-tool',
        { key: 'value' },
        { agentId: 'a1', agentConfig: agent.config },
      );

      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_execute_result',
          id: 'te-1',
          result: 'plugin result',
        }),
        '*',
      );

      relay.stop();
    });
  });

  describe('fetch request sanitization', () => {
    it('rejects relative URLs', async () => {
      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'f-1',
          agentId: 'a1',
          url: '/relative/path',
          options: {},
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 10));
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_error',
          id: 'f-1',
          error: expect.stringContaining('Invalid or relative URL'),
        }),
        '*',
      );
      relay.stop();
    });

    it('forces credentials to omit', async () => {
      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      // Mock global fetch to capture the options
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'f-2',
          agentId: 'a1',
          url: 'https://example.com/api',
          options: { credentials: 'include' },
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 10));
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com/api',
        expect.objectContaining({ credentials: 'omit' }),
      );
      fetchSpy.mockRestore();
      relay.stop();
    });

    it('strips forbidden headers', async () => {
      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'f-3',
          agentId: 'a1',
          url: 'https://example.com/api',
          options: {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer secret',
              'Cookie': 'session=abc',
              'X-Api-Key': 'key123',
              'X-Custom': 'allowed',
            },
          },
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 10));
      const callArgs = fetchSpy.mock.calls[0];
      const usedHeaders = callArgs[1]?.headers as Record<string, string>;
      expect(usedHeaders['Content-Type']).toBe('application/json');
      expect(usedHeaders['X-Custom']).toBe('allowed');
      expect(usedHeaders['Authorization']).toBeUndefined();
      expect(usedHeaders['Cookie']).toBeUndefined();
      expect(usedHeaders['X-Api-Key']).toBeUndefined();
      fetchSpy.mockRestore();
      relay.stop();
    });

    it('rejects blocked domains', async () => {
      const agent = createMockAgent('a1', {
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
      });
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'f-4',
          agentId: 'a1',
          url: 'https://evil.com/steal',
          options: {},
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 10));
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_error',
          id: 'f-4',
          error: expect.stringContaining('blocked'),
        }),
        '*',
      );
      relay.stop();
    });

    it('allows fetch to valid domains', async () => {
      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('response body', { status: 200 }),
      );

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'f-5',
          agentId: 'a1',
          url: 'https://example.com/api',
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 10));
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_response',
          id: 'f-5',
          status: 200,
        }),
        '*',
      );
      fetchSpy.mockRestore();
      relay.stop();
    });
  });

  describe('hook messages', () => {
    it('pre_tool_use dispatched to HookManager', async () => {
      const { HookManager } = await import('./hook-manager.js');
      const hookManager = new HookManager();
      hookManager.register({
        id: 'test-hook',
        type: 'pre_tool_use',
        callback: async () => ({ decision: 'deny', reason: 'blocked by test' }),
      });
      relay.setHookManager(hookManager);

      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'pre_tool_use',
          id: 'hook-1',
          agentId: 'a1',
          toolName: 'runjs',
          toolInput: { code: '1+1' },
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pre_tool_use_result',
          id: 'hook-1',
          decision: 'deny',
          reason: 'blocked by test',
        }),
        '*',
      );
      relay.stop();
    });

    it('pre_tool_use_result sent with decision', async () => {
      const { HookManager } = await import('./hook-manager.js');
      const hookManager = new HookManager();
      hookManager.register({
        id: 'allow-hook',
        type: 'pre_tool_use',
        callback: async () => ({ decision: 'allow' }),
      });
      relay.setHookManager(hookManager);

      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'pre_tool_use',
          id: 'hook-2',
          agentId: 'a1',
          toolName: 'dom',
          toolInput: { action: 'query' },
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pre_tool_use_result',
          id: 'hook-2',
          decision: 'allow',
        }),
        '*',
      );
      relay.stop();
    });

    it('returns default when no HookManager set', async () => {
      // Don't set hook manager
      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'pre_tool_use',
          id: 'hook-3',
          agentId: 'a1',
          toolName: 'runjs',
          toolInput: {},
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pre_tool_use_result',
          id: 'hook-3',
          decision: 'default',
        }),
        '*',
      );
      relay.stop();
    });

    it('agent_stop evaluation works', async () => {
      const { HookManager } = await import('./hook-manager.js');
      const hookManager = new HookManager();
      hookManager.register({
        id: 'stop-hook',
        type: 'stop',
        callback: async () => ({ decision: 'deny', reason: 'keep going' }),
      });
      relay.setHookManager(hookManager);

      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'agent_stop',
          id: 'stop-1',
          agentId: 'a1',
          stopReason: 'end_turn',
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent_stop_result',
          id: 'stop-1',
          decision: 'deny',
          reason: 'keep going',
        }),
        '*',
      );
      relay.stop();
    });
  });

  describe('file request handling', () => {
    let getStorageProviderSpy: ReturnType<typeof vi.spyOn>;
    let mockProvider: any;

    beforeEach(() => {
      mockProvider = {
        name: 'mock' as const,
        readFile: vi.fn(),
        readFileBinary: vi.fn(),
        writeFile: vi.fn(),
        deleteFile: vi.fn(),
        mkdir: vi.fn(),
        listDir: vi.fn(),
        exists: vi.fn(),
        isFile: vi.fn(),
        isDirectory: vi.fn(),
        deleteDir: vi.fn(),
        exportFiles: vi.fn(),
        importFiles: vi.fn(),
        clearAgent: vi.fn(),
        initAgent: vi.fn(),
      };
      getStorageProviderSpy = vi.spyOn(agentStorage, 'getStorageProvider').mockResolvedValue(mockProvider);
    });

    afterEach(() => {
      getStorageProviderSpy.mockRestore();
    });

    it('file_request is handled and returns file_result', async () => {
      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      // Mock readFile to return content
      mockProvider.readFile.mockResolvedValue('file contents');

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'file_request',
          id: 'fr-1',
          agentId: 'a1',
          action: 'read_file',
          path: 'test.txt',
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      expect(mockProvider.readFile).toHaveBeenCalledWith('a1', 'test.txt');
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'file_result',
          id: 'fr-1',
          result: 'file contents',
        }),
        '*',
      );

      relay.stop();
    });

    it('file_request with error returns error in file_result', async () => {
      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      // Mock readFile to throw
      mockProvider.readFile.mockRejectedValue(new Error('File not found'));

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'file_request',
          id: 'fr-2',
          agentId: 'a1',
          action: 'read_file',
          path: 'missing.txt',
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'file_result',
          id: 'fr-2',
          result: null,
          error: expect.stringContaining('File not found'),
        }),
        '*',
      );

      relay.stop();
    });
  });

  describe('source verification', () => {
    it('rejects messages from wrong source', async () => {
      const agent = createMockAgent('a1');
      const registry = new ToolPluginRegistry();
      const executeSpy = vi.spyOn(registry, 'execute');
      relay.setPluginRegistry(registry);
      relay.registerAgent(agent);
      relay.start();

      // Simulate message from a different source (not the agent's iframe)
      const messageEvent = new MessageEvent('message', {
        data: {
          type: 'tool_execute',
          id: 'te-1',
          agentId: 'a1',
          name: 'my-tool',
          input: {},
        },
        // source defaults to null - doesn't match agent's contentWindow
      });
      window.dispatchEvent(messageEvent);

      await new Promise(r => setTimeout(r, 10));

      // Should NOT have been dispatched
      expect(executeSpy).not.toHaveBeenCalled();

      relay.stop();
    });

    it('accepts messages from correct source', async () => {
      const agent = createMockAgent('a1');
      const registry = new ToolPluginRegistry();
      vi.spyOn(registry, 'has').mockReturnValue(true);
      const executeSpy = vi.spyOn(registry, 'execute').mockResolvedValue({
        content: 'ok',
      });
      relay.setPluginRegistry(registry);
      relay.registerAgent(agent);
      relay.start();

      // Simulate message with correct source
      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      const messageEvent = new MessageEvent('message', {
        data: {
          type: 'tool_execute',
          id: 'te-1',
          agentId: 'a1',
          name: 'my-tool',
          input: {},
        },
        source: iframeWindow as any,
      });
      window.dispatchEvent(messageEvent);

      await new Promise(r => setTimeout(r, 10));

      expect(executeSpy).toHaveBeenCalled();

      relay.stop();
    });
  });

  describe('proxy settings', () => {
    it('default uses built-in proxy (/api/anthropic/v1/messages)', () => {
      const settings = relay.getProxySettings();
      expect(settings.useBuiltinProxy).toBe(true);

      // Verify the endpoint returns built-in path
      const endpoint = (relay as any).getApiEndpoint();
      expect(endpoint).toBe('/api/anthropic/v1/messages');
    });

    it('uses custom proxy URL when configured and useBuiltinProxy is false', () => {
      relay.setProxySettings({
        corsProxyUrl: 'https://proxy.example.com',
        useBuiltinProxy: false,
      });

      const endpoint = (relay as any).getApiEndpoint();
      expect(endpoint).toBe('https://proxy.example.com/anthropic/v1/messages');
    });

    it('useBuiltinProxy=true overrides custom URL', () => {
      relay.setProxySettings({
        corsProxyUrl: 'https://proxy.example.com',
        useBuiltinProxy: true,
      });

      const endpoint = (relay as any).getApiEndpoint();
      expect(endpoint).toBe('/api/anthropic/v1/messages');
    });

    it('strips trailing slash from corsProxyUrl', () => {
      relay.setProxySettings({
        corsProxyUrl: 'https://proxy.example.com/',
        useBuiltinProxy: false,
      });

      const endpoint = (relay as any).getApiEndpoint();
      expect(endpoint).toBe('https://proxy.example.com/anthropic/v1/messages');
    });

    it('falls back to built-in proxy when corsProxyUrl is empty and useBuiltinProxy is false', () => {
      relay.setProxySettings({
        corsProxyUrl: '',
        useBuiltinProxy: false,
      });

      const endpoint = (relay as any).getApiEndpoint();
      expect(endpoint).toBe('/api/anthropic/v1/messages');
    });
  });

  describe('network policy modes', () => {
    it('mode allow-all allows any domain', async () => {
      const agent = createMockAgent('a1', {
        mode: 'allow-all',
      });
      relay.registerAgent(agent);
      relay.start();

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'np-1',
          agentId: 'a1',
          url: 'https://any-domain.com/api',
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 10));
      expect(fetchSpy).toHaveBeenCalled();
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_response',
          id: 'np-1',
          status: 200,
        }),
        '*',
      );
      fetchSpy.mockRestore();
      relay.stop();
    });

    it('mode allowlist blocks unlisted domains', async () => {
      const agent = createMockAgent('a1', {
        mode: 'allowlist',
        allowedDomains: ['allowed.com'],
      });
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'np-2',
          agentId: 'a1',
          url: 'https://unlisted.com/api',
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 10));
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_error',
          id: 'np-2',
          error: expect.stringContaining('not allowed'),
        }),
        '*',
      );
      relay.stop();
    });

    it('mode allowlist allows listed domains', async () => {
      const agent = createMockAgent('a1', {
        mode: 'allowlist',
        allowedDomains: ['allowed.com', 'api.example.org'],
      });
      relay.registerAgent(agent);
      relay.start();

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'np-3',
          agentId: 'a1',
          url: 'https://allowed.com/data',
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 10));
      expect(fetchSpy).toHaveBeenCalled();
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_response',
          id: 'np-3',
          status: 200,
        }),
        '*',
      );
      fetchSpy.mockRestore();
      relay.stop();
    });

    it('mode blocklist blocks listed domains', async () => {
      const agent = createMockAgent('a1', {
        mode: 'blocklist',
        blockedDomains: ['blocked.com', 'evil.org'],
      });
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'np-4',
          agentId: 'a1',
          url: 'https://blocked.com/steal',
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 10));
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_error',
          id: 'np-4',
          error: expect.stringContaining('blocked'),
        }),
        '*',
      );
      relay.stop();
    });

    it('mode blocklist allows unlisted domains', async () => {
      const agent = createMockAgent('a1', {
        mode: 'blocklist',
        blockedDomains: ['blocked.com'],
      });
      relay.registerAgent(agent);
      relay.start();

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'np-5',
          agentId: 'a1',
          url: 'https://allowed-site.com/api',
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 10));
      expect(fetchSpy).toHaveBeenCalled();
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_response',
          id: 'np-5',
          status: 200,
        }),
        '*',
      );
      fetchSpy.mockRestore();
      relay.stop();
    });

    it('backward compatibility: old allowAll field treated as allow-all mode', async () => {
      // Old-style policy with allowAll: true but no mode
      const agent = createMockAgent('a1', {
        allowAll: true,
        allowedDomains: [],
      });
      relay.registerAgent(agent);
      relay.start();

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'np-6',
          agentId: 'a1',
          url: 'https://any-domain.com/api',
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 10));
      expect(fetchSpy).toHaveBeenCalled();
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_response',
          id: 'np-6',
          status: 200,
        }),
        '*',
      );
      fetchSpy.mockRestore();
      relay.stop();
    });
  });

  describe('per-agent hub configuration', () => {
    it('uses agent-specific hub for tool execution when configured', async () => {
      // Create a mock hub client
      const mockHubClient = {
        getConnections: vi.fn(() => [
          { id: 'hub-1', name: 'Hub 1', connected: true, tools: [{ name: 'bash' }] },
          { id: 'hub-2', name: 'Hub 2', connected: true, tools: [{ name: 'bash' }] },
        ]),
        getConnection: vi.fn((id: string) => {
          if (id === 'hub-1') return { id: 'hub-1', connected: true, tools: [{ name: 'bash' }] };
          if (id === 'hub-2') return { id: 'hub-2', connected: true, tools: [{ name: 'bash' }] };
          return undefined;
        }),
        findToolHub: vi.fn(() => 'hub-1'),
        executeTool: vi.fn().mockResolvedValue({ result: 'output', is_error: false }),
      };
      relay.setHubClient(mockHubClient as any);

      // Create agent with specific hub configured
      const agent = createMockAgent('a1');
      agent.config.hubConnectionId = 'hub-2';
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'tool_execute',
          id: 'te-1',
          agentId: 'a1',
          name: 'bash',
          input: { command: 'ls' },
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      // Should use hub-2 (agent-specific) not hub-1 (first available)
      expect(mockHubClient.executeTool).toHaveBeenCalledWith('hub-2', 'bash', { command: 'ls' }, 'a1');

      relay.stop();
    });

    it('falls back to findToolHub when no agent-specific hub configured', async () => {
      const mockHubClient = {
        getConnections: vi.fn(() => [
          { id: 'hub-1', name: 'Hub 1', connected: true, tools: [{ name: 'bash' }] },
        ]),
        getConnection: vi.fn(() => undefined),
        findToolHub: vi.fn(() => 'hub-1'),
        executeTool: vi.fn().mockResolvedValue({ result: 'output', is_error: false }),
      };
      relay.setHubClient(mockHubClient as any);

      // Create agent without specific hub
      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'tool_execute',
          id: 'te-1',
          agentId: 'a1',
          name: 'bash',
          input: { command: 'ls' },
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      expect(mockHubClient.findToolHub).toHaveBeenCalledWith('bash');
      expect(mockHubClient.executeTool).toHaveBeenCalledWith('hub-1', 'bash', { command: 'ls' }, 'a1');

      relay.stop();
    });

    it('skips hub if agent-specific hub does not have the tool', async () => {
      const registry = new ToolPluginRegistry();
      vi.spyOn(registry, 'has').mockReturnValue(true);
      const executeSpy = vi.spyOn(registry, 'execute').mockResolvedValue({ content: 'local result' });
      relay.setPluginRegistry(registry);

      const mockHubClient = {
        getConnections: vi.fn(() => [
          { id: 'hub-1', name: 'Hub 1', connected: true, tools: [{ name: 'bash' }] },
        ]),
        getConnection: vi.fn(() => ({
          id: 'hub-2',
          connected: true,
          tools: [{ name: 'other-tool' }], // Does not have 'my-local-tool'
        })),
        findToolHub: vi.fn(() => undefined),
        executeTool: vi.fn(),
      };
      relay.setHubClient(mockHubClient as any);

      // Agent has hub-2 configured, but that hub doesn't have 'my-local-tool'
      const agent = createMockAgent('a1');
      agent.config.hubConnectionId = 'hub-2';
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'tool_execute',
          id: 'te-1',
          agentId: 'a1',
          name: 'my-local-tool',
          input: {},
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      // Should NOT call hub executeTool, should fall through to local plugin registry
      expect(mockHubClient.executeTool).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalledWith('my-local-tool', {}, expect.any(Object));

      relay.stop();
    });

    it('prefers local plugin over hub when both provide same tool', async () => {
      const registry = new ToolPluginRegistry();
      const executeSpy = vi.spyOn(registry, 'execute').mockResolvedValue({ content: 'local result' });
      // Make the registry report it has 'list_skills'
      vi.spyOn(registry, 'has').mockReturnValue(true);
      relay.setPluginRegistry(registry);

      const mockHubClient = {
        getConnections: vi.fn(() => [
          { id: 'hub-1', name: 'Hub 1', connected: true, tools: [{ name: 'list_skills' }] },
        ]),
        getConnection: vi.fn(() => undefined),
        findToolHub: vi.fn(() => 'hub-1'),
        executeTool: vi.fn().mockResolvedValue({ result: 'hub result', is_error: false }),
      };
      relay.setHubClient(mockHubClient as any);

      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'tool_execute',
          id: 'te-1',
          agentId: 'a1',
          name: 'list_skills',
          input: {},
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      // Local plugin should be used, hub should NOT be called
      expect(executeSpy).toHaveBeenCalledWith('list_skills', {}, expect.any(Object));
      expect(mockHubClient.executeTool).not.toHaveBeenCalled();
      expect(mockHubClient.findToolHub).not.toHaveBeenCalled();

      relay.stop();
    });

    it('uses agent-specific hub for fetch proxying', async () => {
      const mockHubClient = {
        getConnections: vi.fn(() => [
          { id: 'hub-1', name: 'Hub 1', connected: true, tools: [] },
        ]),
        getConnection: vi.fn((id: string) => {
          if (id === 'hub-2') return { id: 'hub-2', connected: true, tools: [] };
          return { id: 'hub-1', connected: true, tools: [] };
        }),
        fetch: vi.fn().mockResolvedValue({ status: 200, body: 'proxied response' }),
      };
      relay.setHubClient(mockHubClient as any);

      // Create mock agent with stable iframe reference
      const mockIframeWindow = { postMessage: vi.fn() };
      const mockIframeElement = { contentWindow: mockIframeWindow };
      const agent = {
        id: 'a1',
        config: {
          id: 'a1',
          name: 'Test',
          model: 'test',
          tools: [],
          maxTokens: 4096,
          networkPolicy: {
            mode: 'allow-all' as const,
            useHubProxy: true,
            hubProxyPatterns: ['https://internal.corp/*'],
          },
          hubConnectionId: 'hub-2',
        },
        state: 'running',
        getIframeElement: () => mockIframeElement,
      } as any;

      relay.registerAgent(agent);
      relay.start();

      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'f-1',
          agentId: 'a1',
          url: 'https://internal.corp/data',
        },
        source: mockIframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      // Should use hub-2 (agent-specific) for fetch
      expect(mockHubClient.fetch).toHaveBeenCalledWith('hub-2', 'https://internal.corp/data', undefined);

      relay.stop();
    });

    it('falls back to first available hub for fetch when no agent-specific hub', async () => {
      const mockHubClient = {
        getConnections: vi.fn(() => [
          { id: 'hub-1', name: 'Hub 1', connected: true, tools: [] },
          { id: 'hub-2', name: 'Hub 2', connected: true, tools: [] },
        ]),
        getConnection: vi.fn(() => undefined),
        fetch: vi.fn().mockResolvedValue({ status: 200, body: 'proxied response' }),
      };
      relay.setHubClient(mockHubClient as any);

      // Create mock agent with stable iframe reference
      const mockIframeWindow = { postMessage: vi.fn() };
      const mockIframeElement = { contentWindow: mockIframeWindow };
      const agent = {
        id: 'a1',
        config: {
          id: 'a1',
          name: 'Test',
          model: 'test',
          tools: [],
          maxTokens: 4096,
          networkPolicy: {
            mode: 'allow-all' as const,
            useHubProxy: true,
            hubProxyPatterns: ['https://internal.corp/*'],
          },
        },
        state: 'running',
        getIframeElement: () => mockIframeElement,
      } as any;

      relay.registerAgent(agent);
      relay.start();

      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'fetch_request',
          id: 'f-1',
          agentId: 'a1',
          url: 'https://internal.corp/data',
        },
        source: mockIframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      // Should use hub-1 (first available)
      expect(mockHubClient.fetch).toHaveBeenCalledWith('hub-1', 'https://internal.corp/data', undefined);

      relay.stop();
    });
  });

  describe('parseAssistantFromSSE', () => {
    it('extracts text content from SSE stream', () => {
      const sseText = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n');

      const result = (relay as any).parseAssistantFromSSE(sseText);
      expect(result).toEqual({
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
        stopReason: 'end_turn',
      });
    });

    it('extracts tool_use content from SSE stream', () => {
      const sseText = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_02","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"runjs","input":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"code\\""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":": \\"1+1\\"}"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":10}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n');

      const result = (relay as any).parseAssistantFromSSE(sseText);
      expect(result).toEqual({
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_01',
            name: 'runjs',
            input: { code: '1+1' },
          }],
        },
        stopReason: 'tool_use',
      });
    });

    it('returns null for empty SSE stream', () => {
      const result = (relay as any).parseAssistantFromSSE('');
      expect(result).toBeNull();
    });

    it('handles \\r\\n line endings in Anthropic SSE stream', () => {
      const sseText = [
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        '',
      ].join('\r\n');

      const result = (relay as any).parseAssistantFromSSE(sseText, 'anthropic');
      expect(result).not.toBeNull();
      expect(result.message.content[0]).toEqual({ type: 'text', text: 'Hello' });
    });

    it('handles \\r\\n line endings in OpenAI SSE stream', () => {
      const sseText = [
        'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\r\n');

      const result = (relay as any).parseAssistantFromSSE(sseText, 'openai');
      expect(result).not.toBeNull();
      expect(result.message.content[0]).toEqual({ type: 'text', text: 'Hi' });
    });

    it('handles \\r\\n line endings in Gemini SSE stream', () => {
      const sseText = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"}}]}',
        '',
        'data: {"candidates":[{"content":{"parts":[],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}',
        '',
      ].join('\r\n');

      const result = (relay as any).parseAssistantFromSSE(sseText, 'gemini');
      expect(result).not.toBeNull();
      expect(result.message.content[0]).toEqual({ type: 'text', text: 'Hello' });
      expect(result.stopReason).toBe('end_turn');
    });

    it('parses Gemini multi-chunk SSE with function calls', () => {
      const sseText = [
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"dom","args":{"action":"create","html":"<p>Hi</p>"}}}],"role":"model"}}]}',
        '',
        'data: {"candidates":[{"content":{"parts":[],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}',
        '',
      ].join('\r\n');

      const result = (relay as any).parseAssistantFromSSE(sseText, 'gemini');
      expect(result).not.toBeNull();
      expect(result.message.content[0]).toEqual({
        type: 'tool_use',
        id: expect.stringMatching(/^gemini_tc_/),
        name: 'dom',
        input: { action: 'create', html: '<p>Hi</p>' },
      });
      expect(result.stopReason).toBe('tool_use');
    });
  });

  describe('srcdoc fetch routes through shared executeFetch', () => {
    it('srcdoc fetch records audit logging and network indicator', async () => {
      const mockAuditManager = {
        append: vi.fn(),
      };
      const mockNetworkIndicator = {
        recordActivity: vi.fn(),
      };
      relay.setAuditManager(mockAuditManager as any);
      relay.setNetworkIndicator(mockNetworkIndicator as any);

      const agent = createMockAgent('a1');
      relay.registerAgent(agent);
      relay.start();

      // Pre-approve the fetch tool for this agent/URL to skip the approval dialog
      const approvalKey = 'a1:fetch:https://example.com';
      (relay as any).networkApprovals.set(approvalKey, {
        origin: 'https://example.com',
        approved: true,
        approvedAt: Date.now(),
        persistent: true,
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('srcdoc response body', { status: 200 }),
      );

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'srcdoc_tool_call',
          id: 'stc-1',
          agentId: 'a1',
          name: 'fetch',
          input: { url: 'https://example.com/data', method: 'GET' },
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      // Verify audit logging was called (from executeFetch)
      expect(mockAuditManager.append).toHaveBeenCalledWith('a1', expect.objectContaining({
        source: 'srcdoc',
        action: 'fetch',
        url: 'https://example.com/data',
        size: expect.any(Number),
      }));

      // Verify network indicator was called (from executeFetch)
      expect(mockNetworkIndicator.recordActivity).toHaveBeenCalledWith('https://example.com/data');

      // Verify the result was sent back
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'srcdoc_tool_call_result',
          id: 'stc-1',
        }),
        '*',
      );

      fetchSpy.mockRestore();
      relay.stop();
    });

    it('srcdoc fetch enforces network policy blocklist', async () => {
      const agent = createMockAgent('a1', {
        mode: 'blocklist',
        blockedDomains: ['blocked.com'],
      });
      relay.registerAgent(agent);
      relay.start();

      // Pre-approve the fetch tool
      const approvalKey = 'a1:fetch:https://blocked.com';
      (relay as any).networkApprovals.set(approvalKey, {
        origin: 'https://blocked.com',
        approved: true,
        approvedAt: Date.now(),
        persistent: true,
      });

      const iframeWindow = agent.getIframeElement()!.contentWindow!;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'srcdoc_tool_call',
          id: 'stc-2',
          agentId: 'a1',
          name: 'fetch',
          input: { url: 'https://blocked.com/steal' },
        },
        source: iframeWindow as any,
      }));

      await new Promise(r => setTimeout(r, 50));

      // Should return an error because domain is blocked
      expect(iframeWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'srcdoc_tool_call_result',
          id: 'stc-2',
          error: expect.stringContaining('blocked'),
        }),
        '*',
      );
      relay.stop();
    });

    it('srcdoc fetch routes through hub automatically when connected', async () => {
      const mockHubClient = {
        getConnections: vi.fn(() => [
          { id: 'hub-1', name: 'Hub 1', connected: true, tools: [] },
        ]),
        getConnection: vi.fn((id: string) => {
          if (id === 'hub-1') return { id: 'hub-1', connected: true, tools: [] };
          return undefined;
        }),
        fetch: vi.fn().mockResolvedValue({ status: 200, body: 'hub proxied response' }),
      };
      relay.setHubClient(mockHubClient as any);

      const mockAuditManager = {
        append: vi.fn(),
      };
      const mockNetworkIndicator = {
        recordActivity: vi.fn(),
      };
      relay.setAuditManager(mockAuditManager as any);
      relay.setNetworkIndicator(mockNetworkIndicator as any);

      // No network policy — hub routing should happen automatically
      const agent = createMockAgent('a1');
      relay.registerAgent(agent);

      const result = await (relay as any).executeFetch(
        'https://example.com/data',
        { method: 'GET' },
        agent,
        'srcdoc',
      );

      // Should route through hub automatically (no useHubProxy/hubProxyPatterns needed)
      expect(mockHubClient.fetch).toHaveBeenCalledWith(
        'hub-1',
        'https://example.com/data',
        expect.any(Object),
      );

      expect(result.status).toBe(200);
      expect(result.body).toBe('hub proxied response');

      expect(mockAuditManager.append).toHaveBeenCalledWith('a1', expect.objectContaining({
        source: 'srcdoc',
        action: 'fetch',
        url: 'https://example.com/data',
      }));

      expect(mockNetworkIndicator.recordActivity).toHaveBeenCalledWith('https://example.com/data');
    });
  });
});
