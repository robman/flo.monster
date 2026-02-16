import { describe, it, expect, vi } from 'vitest';
import { createWorkerMessageTool } from './worker-message.js';
import type { ToolContext } from '@flo-monster/core';

function createMockContext(): ToolContext {
  return {
    agentId: 'test-agent',
    sendToShell: vi.fn(),
    waitForResponse: vi.fn(async () => ({})),
  };
}

describe('createWorkerMessageTool', () => {
  const tool = createWorkerMessageTool();

  describe('definition', () => {
    it('should have correct name', () => {
      expect(tool.definition.name).toBe('worker_message');
    });

    it('should have description mentioning inter-worker communication', () => {
      expect(tool.definition.description).toContain('worker');
      expect(tool.definition.description).toContain('subagent');
    });

    it('should have target property in schema', () => {
      expect(tool.definition.input_schema.properties).toHaveProperty('target');
    });

    it('should have event property in schema', () => {
      expect(tool.definition.input_schema.properties).toHaveProperty('event');
    });

    it('should have data property in schema', () => {
      expect(tool.definition.input_schema.properties).toHaveProperty('data');
    });

    it('should require target and event', () => {
      expect(tool.definition.input_schema.required).toContain('target');
      expect(tool.definition.input_schema.required).toContain('event');
    });
  });

  describe('execute', () => {
    it('should send worker_message to specific target', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        target: 'sub-abc123',
        event: 'progress_update',
        data: { percent: 50, status: 'processing' },
      }, ctx);

      expect(ctx.sendToShell).toHaveBeenCalledOnce();
      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        type: string; target: string; event: string; data: unknown;
      };
      expect(sentMessage.type).toBe('worker_message');
      expect(sentMessage.target).toBe('sub-abc123');
      expect(sentMessage.event).toBe('progress_update');
      expect(sentMessage.data).toEqual({ percent: 50, status: 'processing' });
      expect(result.content).toContain('Message sent to worker');
      expect(result.content).toContain('sub-abc123');
      expect(result.is_error).toBeUndefined();
    });

    it('should send broadcast message', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        target: 'broadcast',
        event: 'shutdown',
        data: { reason: 'user request' },
      }, ctx);

      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        target: string;
      };
      expect(sentMessage.target).toBe('broadcast');
      expect(result.content).toContain('broadcast');
      expect(result.is_error).toBeUndefined();
    });

    it('should send message to main worker', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        target: 'main',
        event: 'task_complete',
        data: { taskId: 'task-1', result: 'success' },
      }, ctx);

      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        target: string;
      };
      expect(sentMessage.target).toBe('main');
      expect(result.content).toContain('main');
      expect(result.is_error).toBeUndefined();
    });

    it('should default to main when target not provided', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        event: 'ping',
        data: null,
      }, ctx);

      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        target: string;
      };
      expect(sentMessage.target).toBe('main');
      expect(result.is_error).toBeUndefined();
    });

    it('should return error when event is not provided', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        target: 'main',
      }, ctx);

      expect(result.content).toContain('Event name is required');
      expect(result.is_error).toBe(true);
    });

    it('should handle undefined data', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        target: 'sub-1',
        event: 'notify',
      }, ctx);

      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        data: unknown;
      };
      expect(sentMessage.data).toBeUndefined();
      expect(result.is_error).toBeUndefined();
    });

    it('should handle complex nested data', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        target: 'sub-worker',
        event: 'complex_event',
        data: {
          nested: { deeply: { value: [1, 2, 3] } },
          array: [{ a: 1 }, { b: 2 }],
        },
      }, ctx);

      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        data: unknown;
      };
      expect(sentMessage.data).toEqual({
        nested: { deeply: { value: [1, 2, 3] } },
        array: [{ a: 1 }, { b: 2 }],
      });
      expect(result.is_error).toBeUndefined();
    });
  });
});
