/**
 * Tests for HookManager
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookManager } from '../hook-manager.js';
import type { HookRulesConfig, HookInput, HookRegistration } from '@flo-monster/core';

describe('HookManager', () => {
  let manager: HookManager;

  beforeEach(() => {
    manager = new HookManager();
  });

  describe('register', () => {
    it('should register a hook and return unregister function', () => {
      const hook: HookRegistration = {
        id: 'test-hook',
        type: 'pre_tool_use',
        callback: () => ({ decision: 'allow' }),
      };

      const unregister = manager.register(hook);
      expect(manager.getActiveHookTypes()).toContain('pre_tool_use');

      unregister();
      expect(manager.getActiveHookTypes()).not.toContain('pre_tool_use');
    });

    it('should track multiple hook types', () => {
      manager.register({
        id: 'hook-1',
        type: 'pre_tool_use',
        callback: () => ({ decision: 'default' }),
      });
      manager.register({
        id: 'hook-2',
        type: 'agent_start',
        callback: () => ({ decision: 'default' }),
      });

      const types = manager.getActiveHookTypes();
      expect(types).toContain('pre_tool_use');
      expect(types).toContain('agent_start');
    });
  });

  describe('evaluate', () => {
    it('should return default when no hooks registered', async () => {
      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'test_tool',
        toolInput: {},
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('default');
    });

    it('should return deny result immediately', async () => {
      manager.register({
        id: 'deny-hook',
        type: 'pre_tool_use',
        callback: () => ({ decision: 'deny', reason: 'Blocked' }),
      });

      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'test_tool',
        toolInput: {},
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('Blocked');
    });

    it('should return allow when at least one hook allows', async () => {
      manager.register({
        id: 'allow-hook',
        type: 'pre_tool_use',
        callback: () => ({ decision: 'allow' }),
      });

      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'test_tool',
        toolInput: {},
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('allow');
    });

    it('should respect priority ordering', async () => {
      const callback1 = vi.fn(() => ({ decision: 'allow' as const }));
      const callback2 = vi.fn(() => ({ decision: 'deny' as const, reason: 'High priority deny' }));

      manager.register({
        id: 'low-priority',
        type: 'pre_tool_use',
        priority: 1,
        callback: callback1,
      });
      manager.register({
        id: 'high-priority',
        type: 'pre_tool_use',
        priority: 10,
        callback: callback2,
      });

      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'test_tool',
        toolInput: {},
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('deny');
      expect(callback2).toHaveBeenCalled();
      // Low priority should not have been called because deny wins immediately
      expect(callback1).not.toHaveBeenCalled();
    });

    it('should filter hooks by tool name pattern', async () => {
      const bashCallback = vi.fn(() => ({ decision: 'deny' as const }));
      const otherCallback = vi.fn(() => ({ decision: 'allow' as const }));

      manager.register({
        id: 'bash-blocker',
        type: 'pre_tool_use',
        matcher: { toolNamePattern: '^bash$' },
        callback: bashCallback,
      });
      manager.register({
        id: 'allow-all',
        type: 'pre_tool_use',
        callback: otherCallback,
      });

      // bash should be denied
      const bashInput: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'bash',
        toolInput: {},
      };
      const bashResult = await manager.evaluate(bashInput);
      expect(bashResult.decision).toBe('deny');

      // read_file should be allowed
      const readInput: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'read_file',
        toolInput: {},
      };
      const readResult = await manager.evaluate(readInput);
      expect(readResult.decision).toBe('allow');
    });
  });

  describe('registerFromConfig', () => {
    it('should register hooks from PreToolUse rules', async () => {
      const config: HookRulesConfig = {
        PreToolUse: [
          {
            matcher: '^bash$',
            hooks: [{ type: 'action', action: 'deny', reason: 'bash is blocked' }],
          },
        ],
      };

      manager.registerFromConfig(config);

      expect(manager.getActiveHookTypes()).toContain('pre_tool_use');
      expect(manager.getConfigHookCount()).toBe(1);

      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'bash',
        toolInput: {},
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('bash is blocked');
    });

    it('should register hooks from multiple event types', () => {
      const config: HookRulesConfig = {
        PreToolUse: [
          { hooks: [{ type: 'action', action: 'log' }] },
        ],
        AgentStart: [
          { hooks: [{ type: 'action', action: 'allow' }] },
        ],
        Stop: [
          { hooks: [{ type: 'action', action: 'deny', reason: 'No stopping' }] },
        ],
      };

      manager.registerFromConfig(config);

      expect(manager.getActiveHookTypes()).toContain('pre_tool_use');
      expect(manager.getActiveHookTypes()).toContain('agent_start');
      expect(manager.getActiveHookTypes()).toContain('stop');
      expect(manager.getConfigHookCount()).toBe(3);
    });

    it('should clear previous config hooks when called again', () => {
      const config1: HookRulesConfig = {
        PreToolUse: [
          { hooks: [{ type: 'action', action: 'deny' }] },
        ],
      };

      manager.registerFromConfig(config1);
      expect(manager.getConfigHookCount()).toBe(1);

      const config2: HookRulesConfig = {
        AgentStart: [
          { hooks: [{ type: 'action', action: 'allow' }] },
        ],
        AgentEnd: [
          { hooks: [{ type: 'action', action: 'log' }] },
        ],
      };

      manager.registerFromConfig(config2);
      expect(manager.getConfigHookCount()).toBe(2);
      expect(manager.getActiveHookTypes()).not.toContain('pre_tool_use');
      expect(manager.getActiveHookTypes()).toContain('agent_start');
      expect(manager.getActiveHookTypes()).toContain('agent_end');
    });

    it('should handle log action by continuing to next hook', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const config: HookRulesConfig = {
        PreToolUse: [
          {
            hooks: [
              { type: 'action', action: 'log' },
              { type: 'action', action: 'allow', reason: 'After logging' },
            ],
          },
        ],
      };

      manager.registerFromConfig(config);

      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'test_tool',
        toolInput: { key: 'value' },
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('allow');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should respect priority in config rules', async () => {
      const config: HookRulesConfig = {
        PreToolUse: [
          {
            priority: 1,
            hooks: [{ type: 'action', action: 'allow' }],
          },
          {
            priority: 10,
            hooks: [{ type: 'action', action: 'deny', reason: 'High priority' }],
          },
        ],
      };

      manager.registerFromConfig(config);

      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'test_tool',
        toolInput: {},
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('High priority');
    });

    it('should handle UserPromptSubmit hooks', async () => {
      const config: HookRulesConfig = {
        UserPromptSubmit: [
          {
            hooks: [{ type: 'action', action: 'deny', reason: 'No prompts allowed' }],
          },
        ],
      };

      manager.registerFromConfig(config);

      const input: HookInput = {
        type: 'user_prompt_submit',
        agentId: 'agent-1',
        prompt: 'Hello',
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('No prompts allowed');
    });

    it('should handle AgentEnd hooks', async () => {
      const config: HookRulesConfig = {
        AgentEnd: [
          {
            hooks: [{ type: 'action', action: 'deny', reason: 'Keep going!' }],
          },
        ],
      };

      manager.registerFromConfig(config);

      const input: HookInput = {
        type: 'agent_end',
        agentId: 'agent-1',
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('Keep going!');
    });

    it('should preserve manually registered hooks after config update', async () => {
      // Register a manual hook
      manager.register({
        id: 'manual-hook',
        type: 'post_tool_use',
        callback: () => ({ decision: 'allow' }),
      });

      // Register config hooks
      manager.registerFromConfig({
        PreToolUse: [
          { hooks: [{ type: 'action', action: 'deny' }] },
        ],
      });

      // Manual hook should still exist
      expect(manager.getActiveHookTypes()).toContain('post_tool_use');
      expect(manager.getActiveHookTypes()).toContain('pre_tool_use');
    });

    it('should match inputMatchers against tool input fields', async () => {
      const config: HookRulesConfig = {
        PreToolUse: [
          {
            matcher: '^write_file$',
            inputMatchers: { path: '\\.py$' },
            hooks: [{ type: 'action', action: 'deny', reason: 'Python files blocked' }],
          },
        ],
      };

      manager.registerFromConfig(config);

      // Python file should be blocked
      const pyInput: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'write_file',
        toolInput: { path: '/home/user/script.py', content: 'print("hello")' },
      };
      const pyResult = await manager.evaluate(pyInput);
      expect(pyResult.decision).toBe('deny');
      expect(pyResult.reason).toBe('Python files blocked');

      // JavaScript file should not match (default decision)
      const jsInput: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'write_file',
        toolInput: { path: '/home/user/script.js', content: 'console.log("hello")' },
      };
      const jsResult = await manager.evaluate(jsInput);
      expect(jsResult.decision).toBe('default');
    });

    it('should require all inputMatchers to match', async () => {
      const config: HookRulesConfig = {
        PreToolUse: [
          {
            inputMatchers: {
              path: '\\.py$',
              content: 'import os',
            },
            hooks: [{ type: 'action', action: 'deny', reason: 'Dangerous import' }],
          },
        ],
      };

      manager.registerFromConfig(config);

      // Both matchers match - should deny
      const matchBoth: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'write_file',
        toolInput: { path: 'test.py', content: 'import os\nos.system("ls")' },
      };
      const bothResult = await manager.evaluate(matchBoth);
      expect(bothResult.decision).toBe('deny');

      // Only path matches - should not deny
      const onlyPath: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'write_file',
        toolInput: { path: 'test.py', content: 'print("safe")' },
      };
      const pathResult = await manager.evaluate(onlyPath);
      expect(pathResult.decision).toBe('default');
    });

    it('should not match inputMatchers when field is missing', async () => {
      const config: HookRulesConfig = {
        PreToolUse: [
          {
            inputMatchers: { path: '\\.py$' },
            hooks: [{ type: 'action', action: 'deny' }],
          },
        ],
      };

      manager.registerFromConfig(config);

      // No path field - should not match
      const noPath: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'write_file',
        toolInput: { content: 'some content' },
      };
      const result = await manager.evaluate(noPath);
      expect(result.decision).toBe('default');
    });

    it('should handle script action', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const config: HookRulesConfig = {
        PostToolUse: [
          {
            hooks: [{
              type: 'action',
              action: 'script',
              script: 'log("Script executed"); return { decision: "allow" };',
            }],
          },
        ],
      };

      manager.registerFromConfig(config);

      const input: HookInput = {
        type: 'post_tool_use',
        agentId: 'agent-1',
        toolName: 'write_file',
        toolInput: { path: 'test.txt' },
        toolResult: { content: 'File written' },
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('allow');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should handle script action that returns deny', async () => {
      const config: HookRulesConfig = {
        PreToolUse: [
          {
            hooks: [{
              type: 'action',
              action: 'script',
              script: 'return { decision: "deny", reason: "Blocked by script" };',
            }],
          },
        ],
      };

      manager.registerFromConfig(config);

      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'bash',
        toolInput: { command: 'ls' },
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('Blocked by script');
    });

    it('should handle script action with context variables', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const config: HookRulesConfig = {
        PreToolUse: [
          {
            hooks: [{
              type: 'action',
              action: 'script',
              script: 'log("Tool:", toolName, "Input:", JSON.stringify(toolInput));',
            }],
          },
        ],
      };

      manager.registerFromConfig(config);

      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'read_file',
        toolInput: { path: '/test.txt' },
      };

      await manager.evaluate(input);
      expect(consoleSpy).toHaveBeenCalledWith(
        '[Hook:PreToolUse:script]',
        'Tool:',
        'read_file',
        'Input:',
        '{"path":"/test.txt"}',
      );

      consoleSpy.mockRestore();
    });

    it('should handle script action errors with continueOnError=true (default)', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const config: HookRulesConfig = {
        PreToolUse: [
          {
            hooks: [{
              type: 'action',
              action: 'script',
              script: 'throw new Error("Script failed");',
              // continueOnError defaults to true
            }],
          },
        ],
      };

      manager.registerFromConfig(config);

      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'test_tool',
        toolInput: {},
      };

      // Should not deny, just log error and continue
      const result = await manager.evaluate(input);
      expect(result.decision).toBe('default');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should handle script action errors with continueOnError=false', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const config: HookRulesConfig = {
        PreToolUse: [
          {
            hooks: [{
              type: 'action',
              action: 'script',
              script: 'throw new Error("Script failed");',
              continueOnError: false,
            }],
          },
        ],
      };

      manager.registerFromConfig(config);

      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'test_tool',
        toolInput: {},
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('Hook script error');

      consoleSpy.mockRestore();
    });

    it('should have access to callTool in script context', async () => {
      const config: HookRulesConfig = {
        PreToolUse: [
          {
            hooks: [{
              type: 'action',
              action: 'script',
              script: `
                // Verify callTool is available
                if (typeof callTool !== 'function') {
                  return { decision: 'deny', reason: 'callTool not available' };
                }
                return { decision: 'allow' };
              `,
            }],
          },
        ],
      };

      manager.registerFromConfig(config);

      const input: HookInput = {
        type: 'pre_tool_use',
        agentId: 'agent-1',
        toolName: 'test_tool',
        toolInput: {},
      };

      const result = await manager.evaluate(input);
      expect(result.decision).toBe('allow');
    });
  });

  describe('clear', () => {
    it('should clear all hooks including config hooks', () => {
      manager.register({
        id: 'manual-hook',
        type: 'pre_tool_use',
        callback: () => ({ decision: 'allow' }),
      });

      manager.registerFromConfig({
        AgentStart: [
          { hooks: [{ type: 'action', action: 'allow' }] },
        ],
      });

      expect(manager.getActiveHookTypes().length).toBe(2);

      manager.clear();

      expect(manager.getActiveHookTypes().length).toBe(0);
      expect(manager.getConfigHookCount()).toBe(0);
    });
  });

  describe('getHooksConfig', () => {
    it('should return config with active hook types', () => {
      manager.register({
        id: 'hook-1',
        type: 'pre_tool_use',
        callback: () => ({ decision: 'default' }),
      });
      manager.register({
        id: 'hook-2',
        type: 'user_prompt_submit',
        callback: () => ({ decision: 'default' }),
      });

      const config = manager.getHooksConfig();
      expect(config.activeHookTypes).toContain('pre_tool_use');
      expect(config.activeHookTypes).toContain('user_prompt_submit');
    });
  });

  describe('exportConfigRules', () => {
    it('returns empty config by default', () => {
      expect(manager.exportConfigRules()).toEqual({});
    });

    it('returns stored config after registerFromConfig', () => {
      const rules: HookRulesConfig = {
        PreToolUse: [{
          matcher: '^bash$',
          hooks: [{ type: 'action', action: 'deny', reason: 'No bash' }],
        }],
      };
      manager.registerFromConfig(rules);
      expect(manager.exportConfigRules()).toEqual(rules);
    });

    it('returns a deep copy (mutating original does not affect stored)', () => {
      const rules: HookRulesConfig = {
        PreToolUse: [{
          hooks: [{ type: 'action', action: 'log' }],
        }],
      };
      manager.registerFromConfig(rules);
      // Mutate the original
      rules.PreToolUse![0].hooks.push({ type: 'action', action: 'deny' });
      // Stored copy should be unaffected
      const exported = manager.exportConfigRules();
      expect(exported.PreToolUse![0].hooks).toHaveLength(1);
    });

    it('returns empty after clear', () => {
      manager.registerFromConfig({
        PreToolUse: [{ hooks: [{ type: 'action', action: 'log' }] }],
      });
      manager.clear();
      expect(manager.exportConfigRules()).toEqual({});
    });

    it('updates when registerFromConfig is called again', () => {
      manager.registerFromConfig({
        PreToolUse: [{ hooks: [{ type: 'action', action: 'deny' }] }],
      });
      const newRules: HookRulesConfig = {
        PostToolUse: [{ hooks: [{ type: 'action', action: 'log' }] }],
      };
      manager.registerFromConfig(newRules);
      expect(manager.exportConfigRules()).toEqual(newRules);
    });
  });
});
