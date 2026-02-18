import { describe, it, expect, vi } from 'vitest';
import { createToolExecutor, isBrowserOnlyTool, isHubTool } from '../runner-tool-executor.js';
import { getDefaultConfig } from '../config.js';
import { HubAgentStateStore } from '../tools/hub-state.js';
import { HubAgentStorageStore } from '../tools/hub-storage.js';
import type { AgentConfig } from '@flo-monster/core';

describe('runner-tool-executor', () => {
  describe('isBrowserOnlyTool', () => {
    it('returns true for browser-only tools', () => {
      expect(isBrowserOnlyTool('view_state')).toBe(true);
      expect(isBrowserOnlyTool('audit_log')).toBe(true);
    });

    it('runjs is not a browser-only tool (hub handles it with state/storage stores)', () => {
      expect(isBrowserOnlyTool('runjs')).toBe(false);
    });

    it('storage is no longer a browser-only tool (hub handles it)', () => {
      expect(isBrowserOnlyTool('storage')).toBe(false);
    });

    it('capabilities is not a browser-only tool (hub handles it)', () => {
      expect(isBrowserOnlyTool('capabilities')).toBe(false);
    });

    it('dom is not a browser-only tool (hub handles structural ops)', () => {
      expect(isBrowserOnlyTool('dom')).toBe(false);
    });

    it('returns false for hub tools', () => {
      expect(isBrowserOnlyTool('bash')).toBe(false);
      expect(isBrowserOnlyTool('filesystem')).toBe(false);
    });

    it('returns false for unknown tools', () => {
      expect(isBrowserOnlyTool('unknown_tool')).toBe(false);
    });
  });

  describe('isHubTool', () => {
    it('returns true for hub tools', () => {
      expect(isHubTool('bash')).toBe(true);
      expect(isHubTool('filesystem')).toBe(true);
      expect(isHubTool('list_skills')).toBe(true);
      expect(isHubTool('load_skill')).toBe(true);
      expect(isHubTool('context_search')).toBe(true);
    });

    it('returns false for browser-only tools', () => {
      expect(isHubTool('dom')).toBe(false);
      expect(isHubTool('runjs')).toBe(false);
    });
  });

  describe('createToolExecutor', () => {
    it('returns error for browser-only tools', async () => {
      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
      });

      const result = await executor('view_state', {});
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('browser-only tool');
    });

    it('returns error for runjs without stores or browser', async () => {
      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
      });

      const result = await executor('runjs', { code: 'console.log("test")' });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('hub state/storage stores or a connected browser');
    });

    it('routes browser-only tool through BrowserToolRouter when available', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'storage value', is_error: false }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
      });

      const result = await executor('storage', { action: 'get', key: 'test' });
      expect(result.content).toBe('storage value');
      expect(result.is_error).toBe(false);
      expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
        'hub-agent-1',
        'storage',
        { action: 'get', key: 'test' },
      );
    });

    it('routes runjs through BrowserToolRouter when available', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: '42' }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
      });

      const result = await executor('runjs', { code: '21 * 2' });
      expect(result.content).toBe('42');
      expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
        'hub-agent-1',
        'runjs',
        { code: '21 * 2' },
      );
    });

    it('routes runjs to hub when stateStore and storageStore available', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'browser result' }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
        stateStore: new HubAgentStateStore(),
        storageStore: new HubAgentStorageStore(),
      });

      const result = await executor('runjs', { code: '1 + 1' });
      // Should NOT route to browser — hub handles it
      expect(mockRouter.routeToBrowser).not.toHaveBeenCalled();
      // The result will be an error because the Worker .js file doesn't exist in tests,
      // but it should NOT be the "browser-only tool" error
      expect(result.content).not.toContain('browser-only tool');
    });

    it('returns error for runjs when router provided but no hubAgentId', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn(),
        isAvailable: vi.fn(),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        // hubAgentId is missing — runjs needs hubAgentId for both hub and browser paths
      });

      const result = await executor('runjs', { code: 'console.log("test")' });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('hub state/storage stores or a connected browser');
      expect(mockRouter.routeToBrowser).not.toHaveBeenCalled();
    });

    it('runjs falls back to browser when no stores but browser connected', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'browser result' }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
        // No stateStore or storageStore — should fall back to browser
      });

      const result = await executor('runjs', { code: 'console.log("hello")' });
      expect(result.content).toBe('browser result');
      expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
        'hub-agent-1',
        'runjs',
        { code: 'console.log("hello")' },
      );
    });

    it('capabilities tool returns hub capabilities when agentConfig provided', async () => {
      const mockConfig: AgentConfig = {
        id: 'test-agent',
        name: 'Test Agent',
        model: 'claude-sonnet-4-20250514',
        tools: [],
        maxTokens: 4096,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        hubAgentId: 'hub-agent-1',
        agentConfig: mockConfig,
      });

      const result = await executor('capabilities', {});
      expect(result.is_error).toBeUndefined();

      const parsed = JSON.parse(result.content);
      expect(parsed.runtime).toBe('hub');
      expect(parsed.executionMode).toBe('hub-only');
      expect(parsed.agent.name).toBe('Test Agent');
      expect(parsed.browserConnected).toBe(false);
    });

    it('capabilities tool returns hub-with-browser when router shows connected', async () => {
      const mockConfig: AgentConfig = {
        id: 'test-agent',
        name: 'Test Agent',
        model: 'claude-sonnet-4-20250514',
        tools: [],
        maxTokens: 4096,
      };

      const mockRouter = {
        routeToBrowser: vi.fn(),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        hubAgentId: 'hub-agent-1',
        agentConfig: mockConfig,
        browserToolRouter: mockRouter as any,
      });

      const result = await executor('capabilities', {});
      const parsed = JSON.parse(result.content);
      expect(parsed.executionMode).toBe('hub-with-browser');
      expect(parsed.browserConnected).toBe(true);
      expect(parsed.tools.browserRouted).toContain('dom');
    });

    it('capabilities falls back to browser routing when no agentConfig', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'browser caps', is_error: false }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
        // no agentConfig
      });

      const result = await executor('capabilities', {});
      expect(result.content).toBe('browser caps');
      expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
        'hub-agent-1',
        'capabilities',
        {},
      );
    });

    it('capabilities returns error when no agentConfig and no router', async () => {
      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        // no agentConfig, no browserToolRouter
      });

      const result = await executor('capabilities', {});
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('unavailable');
    });

    // Note: We can't easily test hub tool execution without mocking the
    // actual bash/filesystem tools, which would be integration tests.
    // The routing logic is the key thing to unit test here.

    it('state is no longer a browser-only tool', () => {
      expect(isBrowserOnlyTool('state')).toBe(false);
    });

    it('state tool executes on hub when stateStore is provided', async () => {
      const stateStore = new HubAgentStateStore();
      stateStore.set('score', 42);

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        stateStore,
      });

      const result = await executor('state', { action: 'get', key: 'score' });
      expect(result.is_error).toBeUndefined();
      expect(result.content).toBe('42');
    });

    it('state tool set/get roundtrip on hub', async () => {
      const stateStore = new HubAgentStateStore();

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        stateStore,
      });

      const setResult = await executor('state', { action: 'set', key: 'name', value: 'Alice' });
      expect(setResult.content).toBe('State updated');

      const getResult = await executor('state', { action: 'get', key: 'name' });
      expect(getResult.content).toBe('"Alice"');
    });

    it('state tool routes to browser when no stateStore', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'browser state', is_error: false }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
        // no stateStore
      });

      const result = await executor('state', { action: 'get', key: 'x' });
      expect(result.content).toBe('browser state');
      expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
        'hub-agent-1',
        'state',
        { action: 'get', key: 'x' },
      );
    });

    it('state tool returns error when no stateStore and no browser', async () => {
      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
      });

      const result = await executor('state', { action: 'get', key: 'x' });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('state store');
    });

    it('storage tool executes on hub when storageStore is provided', async () => {
      const storageStore = new HubAgentStorageStore();
      storageStore.set('score', 42);

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        storageStore,
      });

      const result = await executor('storage', { action: 'get', key: 'score' });
      expect(result.is_error).toBeUndefined();
      expect(result.content).toBe('42');
    });

    it('storage tool set/get roundtrip on hub', async () => {
      const storageStore = new HubAgentStorageStore();

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        storageStore,
      });

      const setResult = await executor('storage', { action: 'set', key: 'name', value: 'Alice' });
      expect(setResult.content).toBe('Value stored');

      const getResult = await executor('storage', { action: 'get', key: 'name' });
      expect(getResult.content).toBe('"Alice"');
    });

    it('storage tool routes to browser when no storageStore', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'browser storage', is_error: false }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
        // no storageStore
      });

      const result = await executor('storage', { action: 'get', key: 'x' });
      expect(result.content).toBe('browser storage');
      expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
        'hub-agent-1',
        'storage',
        { action: 'get', key: 'x' },
      );
    });

    it('storage tool returns error when no storageStore and no browser', async () => {
      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
      });

      const result = await executor('storage', { action: 'get', key: 'x' });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('storage store');
    });

    it('storage tool prefers hub store over browser routing', async () => {
      const storageStore = new HubAgentStorageStore();
      storageStore.set('local', 'hub-value');

      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'browser storage' }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        storageStore,
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
      });

      const result = await executor('storage', { action: 'get', key: 'local' });
      expect(result.content).toBe('"hub-value"');
      // Should NOT have routed to browser
      expect(mockRouter.routeToBrowser).not.toHaveBeenCalled();
    });

    it('files is no longer a browser-only tool', () => {
      expect(isBrowserOnlyTool('files')).toBe(false);
    });

    it('files tool executes on hub when filesRoot is provided', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const testDir = await mkdtemp(join(tmpdir(), 'hub-executor-files-'));
      const filesRoot = testDir + '/';
      await writeFile(join(testDir, 'test.txt'), 'hello world', 'utf-8');

      try {
        const executor = createToolExecutor({
          hubConfig: getDefaultConfig(),
          filesRoot,
        });

        const result = await executor('files', { action: 'read_file', path: 'test.txt' });
        expect(result.is_error).toBeUndefined();
        expect(result.content).toBe('hello world');
      } finally {
        await rm(testDir, { recursive: true, force: true });
      }
    });

    it('files tool routes to browser when no filesRoot', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'browser files', is_error: false }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
      });

      const result = await executor('files', { action: 'read_file', path: 'test.txt' });
      expect(result.content).toBe('browser files');
      expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
        'hub-agent-1',
        'files',
        { action: 'read_file', path: 'test.txt' },
      );
    });

    it('files tool returns error when no filesRoot and no browser', async () => {
      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
      });

      const result = await executor('files', { action: 'read_file', path: 'test.txt' });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('files root');
    });

    it('capabilities includes hubState when stateStore provided', async () => {
      const mockConfig: AgentConfig = {
        id: 'test-agent',
        name: 'Test Agent',
        model: 'claude-sonnet-4-20250514',
        tools: [],
        maxTokens: 4096,
      };

      const stateStore = new HubAgentStateStore();

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        hubAgentId: 'hub-agent-1',
        agentConfig: mockConfig,
        stateStore,
      });

      const result = await executor('capabilities', {});
      const parsed = JSON.parse(result.content);
      expect(parsed.tools.hubState).toBe(true);
    });

    it('dom tool routes to browser when connected', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'DOM updated', is_error: false }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
      });

      const result = await executor('dom', { action: 'create', html: '<p>test</p>' });
      expect(result.content).toBe('DOM updated');
      expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
        'hub-agent-1',
        'dom',
        { action: 'create', html: '<p>test</p>' },
      );
    });

    it('dom tool uses hub container when no browser connected', async () => {
      const { HubDomContainer } = await import('../dom-container.js');
      const container = new HubDomContainer();

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        domContainer: container,
      });

      const result = await executor('dom', { action: 'create', html: '<p>hello</p>' });
      expect(result.is_error).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.elementCount).toBe(1);

      container.destroy();
    });

    it('dom tool prefers browser over hub container when both available', async () => {
      const { HubDomContainer } = await import('../dom-container.js');
      const container = new HubDomContainer();

      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'Browser DOM' }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
        domContainer: container,
      });

      const result = await executor('dom', { action: 'create', html: '<p>test</p>' });
      expect(result.content).toBe('Browser DOM');
      expect(mockRouter.routeToBrowser).toHaveBeenCalled();

      container.destroy();
    });

    it('dom tool returns error when no browser and no container', async () => {
      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
      });

      const result = await executor('dom', { action: 'create', html: '<p>test</p>' });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('connected browser');
    });

    describe('per-agent bash sandbox', () => {
      it('uses agentSandbox for bash when set', async () => {
        const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');

        const sandboxBase = await mkdtemp(join(tmpdir(), 'hub-agent-sandbox-'));
        const agentSandbox = join(sandboxBase, 'agent-123');
        await mkdir(agentSandbox, { recursive: true });

        try {
          const executor = createToolExecutor({
            hubConfig: { ...getDefaultConfig(), sandboxPath: sandboxBase },
            agentSandbox,
          });

          // pwd should return the agent sandbox
          const result = await executor('bash', { command: 'pwd' });
          expect(result.is_error).toBeUndefined();
          expect(result.content.trim()).toBe(agentSandbox);
        } finally {
          await rm(sandboxBase, { recursive: true, force: true });
        }
      });

      it('rejects bash cwd outside agent sandbox', async () => {
        const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');

        const sandboxBase = await mkdtemp(join(tmpdir(), 'hub-agent-sandbox-'));
        const agentSandbox = join(sandboxBase, 'agent-123');
        const otherSandbox = join(sandboxBase, 'agent-456');
        await mkdir(agentSandbox, { recursive: true });
        await mkdir(otherSandbox, { recursive: true });

        try {
          const executor = createToolExecutor({
            hubConfig: { ...getDefaultConfig(), sandboxPath: sandboxBase },
            agentSandbox,
          });

          // Try to access another agent's sandbox
          const result = await executor('bash', { command: 'ls', cwd: otherSandbox });
          expect(result.is_error).toBe(true);
          expect(result.content).toContain('outside the sandbox');
        } finally {
          await rm(sandboxBase, { recursive: true, force: true });
        }
      });

      it('uses global sandbox when agentSandbox is not set', async () => {
        const { mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');

        const sandboxBase = await mkdtemp(join(tmpdir(), 'hub-global-sandbox-'));

        try {
          const executor = createToolExecutor({
            hubConfig: { ...getDefaultConfig(), sandboxPath: sandboxBase },
            // No agentSandbox set
          });

          const result = await executor('bash', { command: 'pwd' });
          expect(result.is_error).toBeUndefined();
          expect(result.content.trim()).toBe(sandboxBase);
        } finally {
          await rm(sandboxBase, { recursive: true, force: true });
        }
      });
    });

    it('capabilities includes hubDom when domContainer is provided', async () => {
      const mockConfig: AgentConfig = {
        id: 'test-agent',
        name: 'Test Agent',
        model: 'claude-sonnet-4-20250514',
        tools: [],
        maxTokens: 4096,
      };

      const { HubDomContainer } = await import('../dom-container.js');
      const container = new HubDomContainer();

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        hubAgentId: 'hub-agent-1',
        agentConfig: mockConfig,
        domContainer: container,
      });

      const result = await executor('capabilities', {});
      const parsed = JSON.parse(result.content);
      expect(parsed.tools.hubDom).toEqual(['create', 'modify', 'query', 'remove']);

      container.destroy();
    });

    it('agent_respond is a browser-only tool', () => {
      expect(isBrowserOnlyTool('agent_respond')).toBe(true);
    });

    it('worker_message is a browser-only tool', () => {
      expect(isBrowserOnlyTool('worker_message')).toBe(true);
    });

    it('agent_respond routes through BrowserToolRouter when available', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'Response sent', is_error: false }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
      });

      const result = await executor('agent_respond', { result: { color: 'blue' } });
      expect(result.content).toBe('Response sent');
      expect(result.is_error).toBe(false);
      expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
        'hub-agent-1',
        'agent_respond',
        { result: { color: 'blue' } },
      );
    });

    it('worker_message routes through BrowserToolRouter when available', async () => {
      const mockRouter = {
        routeToBrowser: vi.fn().mockResolvedValue({ content: 'Message sent', is_error: false }),
        isAvailable: vi.fn().mockReturnValue(true),
        handleResult: vi.fn(),
        pendingCount: 0,
      };

      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
        browserToolRouter: mockRouter as any,
        hubAgentId: 'hub-agent-1',
      });

      const result = await executor('worker_message', { to: 'sub-1', event: 'data', data: {} });
      expect(result.content).toBe('Message sent');
      expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
        'hub-agent-1',
        'worker_message',
        { to: 'sub-1', event: 'data', data: {} },
      );
    });

    it('agent_respond returns error when no browser connected', async () => {
      const executor = createToolExecutor({
        hubConfig: getDefaultConfig(),
      });

      const result = await executor('agent_respond', { result: 'test' });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('browser-only tool');
    });

    describe('context_search tool', () => {
      const sampleMessages = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }], turnId: 't1' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }], turnId: 't1' },
        { role: 'user', content: [{ type: 'text', text: 'Build a dashboard' }], turnId: 't2' },
        { role: 'assistant', content: [{ type: 'text', text: 'Created dashboard' }], turnId: 't2' },
      ];

      it('routes to executeHubContextSearch when getMessages is provided', async () => {
        const executor = createToolExecutor({
          hubConfig: getDefaultConfig(),
          getMessages: () => sampleMessages as any,
        });

        const result = await executor('context_search', { mode: 'tail', last: 2 });
        expect(result.is_error).toBeUndefined();
        expect(result.content).toContain('Build a dashboard');
        expect(result.content).toContain('Created dashboard');
      });

      it('search mode works through executor', async () => {
        const executor = createToolExecutor({
          hubConfig: getDefaultConfig(),
          getMessages: () => sampleMessages as any,
        });

        const result = await executor('context_search', { mode: 'search', query: 'dashboard' });
        expect(result.is_error).toBeUndefined();
        expect(result.content).toContain('dashboard');
      });

      it('falls back to browser routing when no getMessages', async () => {
        const mockRouter = {
          routeToBrowser: vi.fn().mockResolvedValue({ content: 'browser search', is_error: false }),
          isAvailable: vi.fn().mockReturnValue(true),
          handleResult: vi.fn(),
          pendingCount: 0,
        };

        const executor = createToolExecutor({
          hubConfig: getDefaultConfig(),
          browserToolRouter: mockRouter as any,
          hubAgentId: 'hub-agent-1',
          // no getMessages
        });

        const result = await executor('context_search', { mode: 'tail', last: 5 });
        expect(result.content).toBe('browser search');
        expect(mockRouter.routeToBrowser).toHaveBeenCalledWith(
          'hub-agent-1',
          'context_search',
          { mode: 'tail', last: 5 },
        );
      });

      it('returns error when no getMessages and no browser', async () => {
        const executor = createToolExecutor({
          hubConfig: getDefaultConfig(),
          // no getMessages, no browserToolRouter
        });

        const result = await executor('context_search', { mode: 'tail', last: 5 });
        expect(result.is_error).toBe(true);
        expect(result.content).toContain('message history');
      });
    });
  });
});
