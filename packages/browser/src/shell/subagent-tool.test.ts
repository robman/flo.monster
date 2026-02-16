import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ShellToolContext, AgentConfig } from '@flo-monster/core';
import { createSubagentToolPlugin, MAX_DEPTH, agentDepthMap } from './subagent-tool.js';

vi.mock('./agent-manager.js', () => ({ AgentManager: vi.fn() }));
vi.mock('./message-relay.js', () => ({ MessageRelay: vi.fn() }));
vi.mock('./hook-manager.js', () => ({ HookManager: vi.fn() }));

type EventCallback = (event: { type: string; from?: string; to?: string; workerId?: string }) => void;

function createMockParentAgent(overrides: Record<string, unknown> = {}) {
  let eventCallback: EventCallback | null = null;

  const agent = {
    id: 'parent-agent-1',
    config: { id: 'parent-agent-1', name: 'Parent Agent', model: 'test-model', tools: [], maxTokens: 4096 },
    state: 'running',
    spawnSubworker: vi.fn(),
    killSubworker: vi.fn(),
    sendSubworkerHooksConfig: vi.fn(),
    sendUserMessage: vi.fn(),
    onEvent: vi.fn((cb: EventCallback) => {
      eventCallback = cb;
      return () => { eventCallback = null; };
    }),
    // Utility for tests to trigger subworker state change
    _triggerSubworkerStateChange(subworkerId: string, to: string) {
      eventCallback?.({ type: 'state_change', from: 'running', to, workerId: subworkerId });
    },
    ...overrides,
  };
  return agent;
}

function createMockDeps(mockParentAgent: ReturnType<typeof createMockParentAgent>) {
  return {
    agentManager: {
      getAgent: vi.fn(() => mockParentAgent),
    },
    messageRelay: {
      loadConversationContext: vi.fn(async () => []),
      initAgentStorage: vi.fn(async () => {}),
    },
    hookManager: {
      getHooksConfig: vi.fn(() => ({ activeHookTypes: [] })),
    },
    workerCode: '// mock worker code',
  };
}

function createContext(overrides: Partial<ShellToolContext> = {}): ShellToolContext {
  return {
    agentId: 'parent-agent-1',
    agentConfig: {
      id: 'parent-agent-1',
      name: 'Parent Agent',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'Default parent prompt',
      tools: [{ name: 'runjs', description: 'Execute JS', input_schema: { type: 'object', properties: {} } }],
      maxTokens: 4096,
    },
    ...overrides,
  };
}

describe('createSubagentToolPlugin', () => {
  beforeEach(() => {
    agentDepthMap.clear();
  });

  describe('plugin definition', () => {
    it('has correct name and schema', () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);

      expect(plugin.definition.name).toBe('subagent');
      expect(plugin.definition.input_schema).toEqual({
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The task for the subagent to perform',
          },
          systemPrompt: {
            type: 'string',
            description: 'Optional custom system prompt for the subagent',
          },
          maxTokensPerSubagent: {
            type: 'number',
            description: 'Optional token budget for this subagent (limits total tokens used)',
          },
          maxCostPerSubagent: {
            type: 'number',
            description: 'Optional cost budget in USD for this subagent',
          },
        },
        required: ['task'],
      });
    });
  });

  describe('input validation', () => {
    it('returns error when task is missing (undefined)', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      const result = await plugin.execute({}, context);

      expect(result.is_error).toBe(true);
      expect(result.content).toBe('Error: task must be a non-empty string');
    });

    it('returns error when task is not a string (number)', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      const result = await plugin.execute({ task: 42 }, context);

      expect(result.is_error).toBe(true);
      expect(result.content).toBe('Error: task must be a non-empty string');
    });

    it('returns error when task is empty string', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      const result = await plugin.execute({ task: '   ' }, context);

      expect(result.is_error).toBe(true);
      expect(result.content).toBe('Error: task must be a non-empty string');
    });
  });

  describe('depth tracking', () => {
    it('returns error at max depth (depth = MAX_DEPTH)', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      agentDepthMap.set('parent-agent-1', MAX_DEPTH);

      const result = await plugin.execute({ task: 'do something' }, context);

      expect(result.is_error).toBe(true);
      expect(result.content).toBe(`Error: maximum subagent depth of ${MAX_DEPTH} reached`);
      expect(mockParent.spawnSubworker).not.toHaveBeenCalled();
    });

    it('allows subagent below max depth', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      agentDepthMap.set('parent-agent-1', MAX_DEPTH - 1);

      // Trigger loop_complete after spawnSubworker is called
      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          // Find the subworkerId from the spawnSubworker call
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      const result = await plugin.execute({ task: 'do something' }, context);

      expect(result.is_error).toBeUndefined();
      expect(mockParent.spawnSubworker).toHaveBeenCalled();
    });

    it('sets child depth = parent + 1', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      agentDepthMap.set('parent-agent-1', 1);

      let capturedSubworkerId: string | null = null;
      let childDepthDuringExecution: number | undefined;

      // Capture depth during loadConversationContext
      deps.messageRelay.loadConversationContext = vi.fn(async (id: string) => {
        capturedSubworkerId = id;
        childDepthDuringExecution = agentDepthMap.get(id);
        return [];
      });

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'do something' }, context);

      expect(childDepthDuringExecution).toBe(2);
    });

    it('clears depth on successful completion', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      let capturedSubworkerId: string | null = null;

      deps.messageRelay.loadConversationContext = vi.fn(async (id: string) => {
        capturedSubworkerId = id;
        return [];
      });

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'do something' }, context);

      expect(capturedSubworkerId).not.toBeNull();
      expect(agentDepthMap.has(capturedSubworkerId!)).toBe(false);
    });
  });

  describe('subworker spawning', () => {
    it('spawns subworker in parent iframe with inherited config', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'do something' }, context);

      expect(mockParent.spawnSubworker).toHaveBeenCalledWith(
        expect.stringMatching(/^sub-/),
        expect.objectContaining({
          model: 'claude-sonnet-4-20250514',
          tools: context.agentConfig.tools,
        }),
        deps.workerCode,
      );
    });

    it('spawns subworker with custom systemPrompt', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'do something', systemPrompt: 'Custom prompt' }, context);

      expect(mockParent.spawnSubworker).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          systemPrompt: 'Custom prompt',
        }),
        expect.any(String),
      );
    });

    it('uses parent systemPrompt when no custom one provided', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'do something' }, context);

      expect(mockParent.spawnSubworker).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          systemPrompt: 'Default parent prompt',
        }),
        expect.any(String),
      );
    });
  });

  describe('subworker lifecycle', () => {
    it('sends hooks config to subworker', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      deps.hookManager.getHooksConfig = vi.fn(() => ({ activeHookTypes: ['pre_tool_use'] }));
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'do something' }, context);

      expect(mockParent.sendSubworkerHooksConfig).toHaveBeenCalledWith(
        expect.stringMatching(/^sub-/),
        ['pre_tool_use'],
      );
    });

    it('sends task as user message to subworker', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'Analyze this data' }, context);

      expect(mockParent.sendUserMessage).toHaveBeenCalledWith(
        'Analyze this data',
        expect.stringMatching(/^sub-/),
      );
    });

    it('waits for loop_complete and returns assistant text', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      deps.messageRelay.loadConversationContext = vi.fn(async () => [
        { role: 'user', content: 'Analyze this data' },
        { role: 'assistant', content: [{ type: 'text', text: 'Here is my analysis.' }] },
      ]);

      const result = await plugin.execute({ task: 'Analyze this data' }, context);

      expect(result.content).toBe('Here is my analysis.');
      expect(result.is_error).toBeUndefined();
    });

    it('kills subworker on completion', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      let capturedSubworkerId: string | null = null;

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            capturedSubworkerId = call[0];
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'do something' }, context);

      expect(mockParent.killSubworker).toHaveBeenCalledWith(capturedSubworkerId);
    });
  });

  describe('timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns error on timeout', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      // onEvent registers callback but never triggers completion
      mockParent.onEvent = vi.fn(() => () => {});

      const resultPromise = plugin.execute({ task: 'do something' }, context);

      await vi.advanceTimersByTimeAsync(300_000);

      const result = await resultPromise;

      expect(result.is_error).toBe(true);
      expect(result.content).toBe('Error: Subagent timed out after 5 minutes');
      expect(mockParent.killSubworker).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns error when parent agent not found', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      (deps.agentManager.getAgent as any) = vi.fn(() => null);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      const result = await plugin.execute({ task: 'do something' }, context);

      expect(result.is_error).toBe(true);
      expect(result.content).toBe('Error: parent agent not found');
    });

    it('returns error when subworker enters error state', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'state_change', from: 'running', to: 'error', workerId: call[0] });
          }
        });
        return () => {};
      });

      const result = await plugin.execute({ task: 'do something' }, context);

      expect(result.is_error).toBe(true);
      expect(result.content).toBe('Subagent encountered an error');
      expect(mockParent.killSubworker).toHaveBeenCalled();
    });

    it('cleans up on unexpected error', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      // Make initAgentStorage throw
      deps.messageRelay.initAgentStorage = vi.fn(async () => {
        throw new Error('Storage init failed');
      });

      const result = await plugin.execute({ task: 'do something' }, context);

      expect(result.is_error).toBe(true);
      expect(result.content).toBe('Error: Storage init failed');
      expect(mockParent.killSubworker).toHaveBeenCalled();
    });
  });

  describe('response extraction', () => {
    it('returns fallback when no assistant text', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      // Return only user messages, no assistant response
      deps.messageRelay.loadConversationContext = vi.fn(async () => [
        { role: 'user', content: 'do something' },
      ]);

      const result = await plugin.execute({ task: 'do something' }, context);

      expect(result.content).toBe('(Subagent completed but produced no text response)');
      expect(result.is_error).toBeUndefined();
    });
  });

  describe('per-subagent limits', () => {
    it('passes maxTokensPerSubagent as tokenBudget to subconfig', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'do something', maxTokensPerSubagent: 10000 }, context);

      expect(mockParent.spawnSubworker).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tokenBudget: 10000,
        }),
        expect.any(String),
      );
    });

    it('passes maxCostPerSubagent as costBudgetUsd to subconfig', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext();

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'do something', maxCostPerSubagent: 0.50 }, context);

      expect(mockParent.spawnSubworker).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          costBudgetUsd: 0.50,
        }),
        expect.any(String),
      );
    });

    it('inherits parent tokenBudget when maxTokensPerSubagent not provided', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext({
        agentConfig: {
          ...createContext().agentConfig,
          tokenBudget: 50000,
        },
      });

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'do something' }, context);

      expect(mockParent.spawnSubworker).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tokenBudget: 50000,
        }),
        expect.any(String),
      );
    });

    it('inherits parent costBudgetUsd when maxCostPerSubagent not provided', async () => {
      const mockParent = createMockParentAgent();
      const deps = createMockDeps(mockParent);
      const plugin = createSubagentToolPlugin(deps as any);
      const context = createContext({
        agentConfig: {
          ...createContext().agentConfig,
          costBudgetUsd: 1.25,
        },
      });

      mockParent.onEvent = vi.fn((cb: EventCallback) => {
        Promise.resolve().then(() => {
          const call = mockParent.spawnSubworker.mock.calls[0];
          if (call) {
            cb({ type: 'loop_complete', workerId: call[0] } as any);
          }
        });
        return () => {};
      });

      await plugin.execute({ task: 'do something' }, context);

      expect(mockParent.spawnSubworker).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          costBudgetUsd: 1.25,
        }),
        expect.any(String),
      );
    });
  });
});
