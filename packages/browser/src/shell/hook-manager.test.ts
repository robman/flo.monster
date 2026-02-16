import { describe, it, expect, vi } from 'vitest';
import { HookManager } from './hook-manager.js';
import type { HookResult, PreToolUseInput, PostToolUseInput } from '@flo-monster/core';

function makePreToolUse(toolName: string = 'runjs'): PreToolUseInput {
  return {
    type: 'pre_tool_use',
    agentId: 'agent-1',
    toolName,
    toolInput: { code: '1+1' },
  };
}

function makePostToolUse(toolName: string = 'runjs'): PostToolUseInput {
  return {
    type: 'post_tool_use',
    agentId: 'agent-1',
    toolName,
    toolInput: { code: '1+1' },
    toolResult: { content: '2' },
  };
}

describe('HookManager', () => {
  it('register/unregister lifecycle', () => {
    const manager = new HookManager();
    const unsub = manager.register({
      id: 'hook-1',
      type: 'pre_tool_use',
      callback: async () => ({ decision: 'allow' }),
    });

    expect(manager.getActiveHookTypes()).toContain('pre_tool_use');

    unsub();
    expect(manager.getActiveHookTypes()).not.toContain('pre_tool_use');
  });

  it('getActiveHookTypes returns unique types', () => {
    const manager = new HookManager();
    manager.register({
      id: 'h1',
      type: 'pre_tool_use',
      callback: async () => ({ decision: 'default' }),
    });
    manager.register({
      id: 'h2',
      type: 'pre_tool_use',
      callback: async () => ({ decision: 'default' }),
    });
    manager.register({
      id: 'h3',
      type: 'stop',
      callback: async () => ({ decision: 'default' }),
    });

    const types = manager.getActiveHookTypes();
    expect(types).toHaveLength(2);
    expect(types).toContain('pre_tool_use');
    expect(types).toContain('stop');
  });

  it('evaluate returns default when no hooks match', async () => {
    const manager = new HookManager();
    const result = await manager.evaluate(makePreToolUse());
    expect(result.decision).toBe('default');
  });

  it('evaluate calls matching pre_tool_use hook', async () => {
    const manager = new HookManager();
    const cb = vi.fn(async (): Promise<HookResult> => ({ decision: 'allow' }));
    manager.register({
      id: 'h1',
      type: 'pre_tool_use',
      callback: cb,
    });

    const input = makePreToolUse();
    const result = await manager.evaluate(input);
    expect(cb).toHaveBeenCalledWith(input);
    expect(result.decision).toBe('allow');
  });

  it('evaluate calls matching post_tool_use hook', async () => {
    const manager = new HookManager();
    const cb = vi.fn(async (): Promise<HookResult> => ({ decision: 'allow' }));
    manager.register({
      id: 'h1',
      type: 'post_tool_use',
      callback: cb,
    });

    const input = makePostToolUse();
    const result = await manager.evaluate(input);
    expect(cb).toHaveBeenCalledWith(input);
    expect(result.decision).toBe('allow');
  });

  it('deny overrides allow (immediate return)', async () => {
    const manager = new HookManager();
    const allowCb = vi.fn(async (): Promise<HookResult> => ({ decision: 'allow' }));
    const denyCb = vi.fn(async (): Promise<HookResult> => ({ decision: 'deny', reason: 'blocked' }));

    manager.register({ id: 'h-allow', type: 'pre_tool_use', callback: allowCb, priority: 1 });
    manager.register({ id: 'h-deny', type: 'pre_tool_use', callback: denyCb, priority: 10 }); // higher priority

    const result = await manager.evaluate(makePreToolUse());
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('blocked');
    // Allow callback should NOT have been called (deny returned immediately)
    expect(allowCb).not.toHaveBeenCalled();
  });

  it('allow decision returned correctly', async () => {
    const manager = new HookManager();
    manager.register({
      id: 'h1',
      type: 'pre_tool_use',
      callback: async () => ({ decision: 'allow' }),
    });

    const result = await manager.evaluate(makePreToolUse());
    expect(result.decision).toBe('allow');
  });

  it('matcher filters by toolNamePattern regex', async () => {
    const manager = new HookManager();
    const cb = vi.fn(async (): Promise<HookResult> => ({ decision: 'deny', reason: 'blocked' }));
    manager.register({
      id: 'h1',
      type: 'pre_tool_use',
      callback: cb,
      matcher: { toolNamePattern: '^fetch$' },
    });

    // Should NOT match runjs
    const result1 = await manager.evaluate(makePreToolUse('runjs'));
    expect(result1.decision).toBe('default');
    expect(cb).not.toHaveBeenCalled();

    // Should match fetch
    const result2 = await manager.evaluate(makePreToolUse('fetch'));
    expect(result2.decision).toBe('deny');
    expect(cb).toHaveBeenCalled();
  });

  it('matcher supports alternation (Write|Edit)', async () => {
    const manager = new HookManager();
    const cb = vi.fn(async (): Promise<HookResult> => ({ decision: 'deny' }));
    manager.register({
      id: 'h1',
      type: 'pre_tool_use',
      callback: cb,
      matcher: { toolNamePattern: 'Write|Edit' },
    });

    expect((await manager.evaluate(makePreToolUse('Write'))).decision).toBe('deny');
    expect((await manager.evaluate(makePreToolUse('Edit'))).decision).toBe('deny');
    expect((await manager.evaluate(makePreToolUse('Read'))).decision).toBe('default');
  });

  it('hooks sorted by priority', async () => {
    const manager = new HookManager();
    const order: string[] = [];

    manager.register({
      id: 'low',
      type: 'pre_tool_use',
      callback: async () => { order.push('low'); return { decision: 'allow' }; },
      priority: 1,
    });
    manager.register({
      id: 'high',
      type: 'pre_tool_use',
      callback: async () => { order.push('high'); return { decision: 'allow' }; },
      priority: 10,
    });

    await manager.evaluate(makePreToolUse());
    expect(order).toEqual(['high', 'low']);
  });

  it('hook callback error does not block others', async () => {
    const manager = new HookManager();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    manager.register({
      id: 'bad',
      type: 'pre_tool_use',
      callback: async () => { throw new Error('hook crashed'); },
      priority: 10,
    });
    manager.register({
      id: 'good',
      type: 'pre_tool_use',
      callback: async () => ({ decision: 'allow' }),
      priority: 1,
    });

    const result = await manager.evaluate(makePreToolUse());
    expect(result.decision).toBe('allow');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('getHooksConfig returns config', () => {
    const manager = new HookManager();
    manager.register({
      id: 'h1',
      type: 'pre_tool_use',
      callback: async () => ({ decision: 'default' }),
    });
    manager.register({
      id: 'h2',
      type: 'stop',
      callback: async () => ({ decision: 'default' }),
    });

    const config = manager.getHooksConfig();
    expect(config.activeHookTypes).toContain('pre_tool_use');
    expect(config.activeHookTypes).toContain('stop');
    expect(config.activeHookTypes).toHaveLength(2);
  });

  describe('registerFromConfig', () => {
    it('returns registered hook IDs', () => {
      const manager = new HookManager();
      const ids = manager.registerFromConfig({
        PreToolUse: [
          { matcher: '^bash$', hooks: [{ type: 'action', action: 'deny', reason: 'blocked' }] },
          { matcher: '^runjs$', hooks: [{ type: 'action', action: 'allow' }] },
        ],
      });

      expect(ids).toHaveLength(2);
      expect(ids).toContain('config-PreToolUse-0');
      expect(ids).toContain('config-PreToolUse-1');
      expect(manager.getConfigHookCount()).toBe(2);
    });
  });
});
