import { describe, it, expect, vi } from 'vitest';
import { handleSrcdocToolCall } from './srcdoc-handler.js';
import type { AgentContainer } from '../../agent/agent-container.js';
import type { SrcdocContext } from './srcdoc-handler.js';

function createMockAgent(): AgentContainer {
  return {
    id: 'agent-1',
    config: {
      id: 'agent-1',
      name: 'Test Agent',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      systemPrompt: '',
      tools: [],
      maxTokens: 4096,
      networkPolicy: { mode: 'allow-all' },
    },
  } as unknown as AgentContainer;
}

function createMockTarget() {
  return { postMessage: vi.fn() } as unknown as Window;
}

function createMockContext(overrides: Partial<SrcdocContext> = {}): SrcdocContext {
  return {
    pluginRegistry: null,
    extensionLoader: null,
    auditManager: null,
    networkIndicator: null,
    approvalCallback: null,
    getProvider: vi.fn(),
    ...overrides,
  } as SrcdocContext;
}

describe('handleSrcdocToolCall', () => {
  it('blocks bash tool with error', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const ctx = createMockContext();

    await handleSrcdocToolCall(
      { type: 'srcdoc_tool_call', id: 'tool-1', agentId: 'agent-1', name: 'bash', input: { command: 'rm -rf /' } },
      agent,
      target,
      ctx,
    );

    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'srcdoc_tool_call_result',
        id: 'tool-1',
        error: expect.stringContaining('not allowed'),
      }),
      '*',
    );
  });

  it('does not block subagent tool', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const executeFn = vi.fn().mockResolvedValue({ content: 'subagent result' });
    const ctx = createMockContext({
      pluginRegistry: {
        execute: executeFn,
        getExtensionId: vi.fn().mockReturnValue(undefined),
      } as any,
    });

    await handleSrcdocToolCall(
      { type: 'srcdoc_tool_call', id: 'tool-2', agentId: 'agent-1', name: 'subagent', input: { task: 'classify item' } },
      agent,
      target,
      ctx,
    );

    // Should NOT have an error about being blocked
    const call = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.error).toBeUndefined();
    expect(call.result).toBe('subagent result');
  });

  it('routes subagent to plugin registry', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const executeFn = vi.fn().mockResolvedValue({ content: 'done' });
    const ctx = createMockContext({
      pluginRegistry: {
        execute: executeFn,
        getExtensionId: vi.fn().mockReturnValue(undefined),
      } as any,
    });

    await handleSrcdocToolCall(
      { type: 'srcdoc_tool_call', id: 'tool-3', agentId: 'agent-1', name: 'subagent', input: { task: 'do work' } },
      agent,
      target,
      ctx,
    );

    expect(executeFn).toHaveBeenCalledWith('subagent', { task: 'do work' }, expect.objectContaining({ agentId: 'agent-1' }));
  });

  it('includes task excerpt in audit log for subagent', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const appendFn = vi.fn();
    const ctx = createMockContext({
      auditManager: { append: appendFn } as any,
      pluginRegistry: {
        execute: vi.fn().mockResolvedValue({ content: 'ok' }),
        getExtensionId: vi.fn().mockReturnValue(undefined),
      } as any,
    });

    const longTask = 'a'.repeat(300);
    await handleSrcdocToolCall(
      { type: 'srcdoc_tool_call', id: 'tool-4', agentId: 'agent-1', name: 'subagent', input: { task: longTask } },
      agent,
      target,
      ctx,
    );

    // Find the audit call for the plugin registry path (not the builtin path)
    const auditCall = appendFn.mock.calls.find(
      (c: any[]) => c[1].tool === 'subagent' && c[1].task !== undefined
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1].task).toHaveLength(200);
    expect(auditCall![1].task).toBe(longTask.substring(0, 200));
  });

  it('does not include task in audit log for non-subagent tools', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const appendFn = vi.fn();
    const ctx = createMockContext({
      auditManager: { append: appendFn } as any,
      pluginRegistry: {
        execute: vi.fn().mockResolvedValue({ content: 'ok' }),
        getExtensionId: vi.fn().mockReturnValue(undefined),
      } as any,
    });

    await handleSrcdocToolCall(
      { type: 'srcdoc_tool_call', id: 'tool-5', agentId: 'agent-1', name: 'capabilities', input: {} },
      agent,
      target,
      ctx,
    );

    // The plugin registry audit call should NOT have a task field
    const auditCall = appendFn.mock.calls.find(
      (c: any[]) => c[1].tool === 'capabilities'
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1].task).toBeUndefined();
  });

  it('posts result back to target', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const ctx = createMockContext({
      pluginRegistry: {
        execute: vi.fn().mockResolvedValue({ content: 'hello world' }),
        getExtensionId: vi.fn().mockReturnValue(undefined),
      } as any,
    });

    await handleSrcdocToolCall(
      { type: 'srcdoc_tool_call', id: 'tool-6', agentId: 'agent-1', name: 'subagent', input: { task: 'greet' } },
      agent,
      target,
      ctx,
    );

    expect(target.postMessage).toHaveBeenCalledWith(
      {
        type: 'srcdoc_tool_call_result',
        id: 'tool-6',
        result: 'hello world',
      },
      '*',
    );
  });
});
