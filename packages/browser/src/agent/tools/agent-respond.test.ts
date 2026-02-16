import { describe, it, expect, vi } from 'vitest';
import { createAgentRespondTool } from './agent-respond.js';
import type { ToolContext } from '@flo-monster/core';

function createMockContext(): ToolContext {
  return {
    agentId: 'test-agent',
    sendToShell: vi.fn(),
    waitForResponse: vi.fn(async () => ({})),
  };
}

describe('createAgentRespondTool', () => {
  const tool = createAgentRespondTool();

  describe('definition', () => {
    it('should have correct name', () => {
      expect(tool.definition.name).toBe('agent_respond');
    });

    it('should have description mentioning flo.ask()', () => {
      expect(tool.definition.description).toContain('flo.ask()');
    });

    it('should have result property in schema', () => {
      expect(tool.definition.input_schema.properties).toHaveProperty('result');
    });

    it('should have error property in schema', () => {
      expect(tool.definition.input_schema.properties).toHaveProperty('error');
    });
  });

  describe('execute', () => {
    it('should send agent_ask_response message with result', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        result: { answer: 42, status: 'success' },
      }, ctx);

      expect(ctx.sendToShell).toHaveBeenCalledOnce();
      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        type: string; result: unknown; error?: string;
      };
      expect(sentMessage.type).toBe('agent_ask_response');
      expect(sentMessage.result).toEqual({ answer: 42, status: 'success' });
      expect(sentMessage.error).toBeUndefined();
      expect(result.content).toBe('Response sent to caller');
      expect(result.is_error).toBeUndefined();
    });

    it('should send agent_ask_response message with error', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        error: 'Something went wrong',
      }, ctx);

      expect(ctx.sendToShell).toHaveBeenCalledOnce();
      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        type: string; result?: unknown; error: string;
      };
      expect(sentMessage.type).toBe('agent_ask_response');
      expect(sentMessage.error).toBe('Something went wrong');
      expect(result.content).toContain('Error response sent');
      expect(result.content).toContain('Something went wrong');
    });

    it('should handle primitive result values', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        result: 'simple string',
      }, ctx);

      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        result: unknown;
      };
      expect(sentMessage.result).toBe('simple string');
      expect(result.is_error).toBeUndefined();
    });

    it('should handle null result', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        result: null,
      }, ctx);

      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        result: unknown;
      };
      expect(sentMessage.result).toBeNull();
      expect(result.is_error).toBeUndefined();
    });

    it('should handle array result', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({
        result: [1, 2, 3],
      }, ctx);

      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        result: unknown;
      };
      expect(sentMessage.result).toEqual([1, 2, 3]);
      expect(result.is_error).toBeUndefined();
    });

    it('should handle empty input', async () => {
      const ctx = createMockContext();

      const result = await tool.execute({}, ctx);

      const sentMessage = (ctx.sendToShell as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        result?: unknown;
      };
      expect(sentMessage.result).toBeUndefined();
      expect(result.content).toBe('Response sent to caller');
    });
  });
});
