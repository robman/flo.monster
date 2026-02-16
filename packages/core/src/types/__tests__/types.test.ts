import { describe, it, expect } from 'vitest';
import type {
  Message, ContentBlock, TextContent, ToolUseContent, ToolResultContent,
  TokenUsage, ApiRequest, ApiResponse, JsonSchema,
} from '../messages.js';
import type { ToolDef, ToolHandler, ToolResult, ToolContext } from '../tools.js';
import type {
  AgentEvent, MessageStartEvent, TextDeltaEvent, ToolUseStartEvent,
  ErrorEvent,
} from '../events.js';
import type { AgentState, AgentConfig, NetworkPolicy } from '../agent.js';
import type { ProviderAdapter, CostEstimate, ModelInfo, SSEEvent } from '../provider.js';
import type {
  WorkerToIframe, IframeToWorker, IframeToShell, ShellToIframe, DomCommand,
  ShellToServiceWorker,
} from '../protocol.js';
import { isTextEvent, isToolEvent } from '../events.js';

describe('Type contracts', () => {
  describe('Message types', () => {
    it('should construct valid text content', () => {
      const text: TextContent = { type: 'text', text: 'hello' };
      expect(text.type).toBe('text');
      expect(text.text).toBe('hello');
    });

    it('should construct valid tool use content', () => {
      const toolUse: ToolUseContent = {
        type: 'tool_use',
        id: 'tu_123',
        name: 'runjs',
        input: { code: 'console.log("hi")' },
      };
      expect(toolUse.type).toBe('tool_use');
      expect(toolUse.name).toBe('runjs');
    });

    it('should construct valid tool result content', () => {
      const result: ToolResultContent = {
        type: 'tool_result',
        tool_use_id: 'tu_123',
        content: 'result text',
      };
      expect(result.type).toBe('tool_result');
    });

    it('should construct valid message with mixed content', () => {
      const msg: Message = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me calculate that' },
          { type: 'tool_use', id: 'tu_1', name: 'runjs', input: { code: '2+2' } },
        ],
      };
      expect(msg.role).toBe('assistant');
      expect(msg.content).toHaveLength(2);
    });

    it('should construct valid token usage', () => {
      const usage: TokenUsage = {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      };
      expect(usage.input_tokens).toBe(100);
    });
  });

  describe('Tool types', () => {
    it('should construct valid tool definition', () => {
      const tool: ToolDef = {
        name: 'runjs',
        description: 'Execute JavaScript',
        input_schema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'JavaScript code to execute' },
          },
          required: ['code'],
        },
      };
      expect(tool.name).toBe('runjs');
    });

    it('should construct valid tool result', () => {
      const result: ToolResult = {
        content: 'execution result',
        is_error: false,
      };
      expect(result.is_error).toBe(false);
    });
  });

  describe('Event type guards', () => {
    it('isTextEvent should identify text events', () => {
      const delta: AgentEvent = { type: 'text_delta', text: 'hello' };
      const done: AgentEvent = { type: 'text_done', text: 'hello world' };
      const error: AgentEvent = { type: 'error', error: 'fail' };
      expect(isTextEvent(delta)).toBe(true);
      expect(isTextEvent(done)).toBe(true);
      expect(isTextEvent(error)).toBe(false);
    });

    it('isToolEvent should identify tool events', () => {
      const start: AgentEvent = { type: 'tool_use_start', toolUseId: 'tu_1', toolName: 'runjs' };
      const inputDelta: AgentEvent = { type: 'tool_use_input_delta', toolUseId: 'tu_1', partialJson: '{"code"' };
      const result: AgentEvent = { type: 'tool_result', toolUseId: 'tu_1', result: { content: 'ok' } };
      const text: AgentEvent = { type: 'text_delta', text: 'hi' };
      expect(isToolEvent(start)).toBe(true);
      expect(isToolEvent(inputDelta)).toBe(true);
      expect(isToolEvent(result)).toBe(true);
      expect(isToolEvent(text)).toBe(false);
    });
  });

  describe('Agent types', () => {
    it('should construct valid agent config', () => {
      const config: AgentConfig = {
        id: 'agent-1',
        name: 'Test Agent',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'You are a helpful assistant.',
        tools: [],
        maxTokens: 4096,
        tokenBudget: 100000,
        costBudgetUsd: 1.0,
        networkPolicy: { mode: 'allowlist', allowedDomains: ['example.com'] },
      };
      expect(config.id).toBe('agent-1');
    });

    it('should accept hubConnectionId and hubSandboxPath', () => {
      const config: AgentConfig = {
        id: 'agent-2',
        name: 'Hub Agent',
        model: 'claude-sonnet-4-20250514',
        tools: [],
        maxTokens: 4096,
        hubConnectionId: 'hub-abc123',
        hubSandboxPath: '/home/user/sandbox',
      };
      expect(config.hubConnectionId).toBe('hub-abc123');
      expect(config.hubSandboxPath).toBe('/home/user/sandbox');
    });

    it('should allow omitting hub fields', () => {
      const config: AgentConfig = {
        id: 'agent-3',
        name: 'No Hub Agent',
        model: 'claude-sonnet-4-20250514',
        tools: [],
        maxTokens: 4096,
      };
      expect(config.hubConnectionId).toBeUndefined();
      expect(config.hubSandboxPath).toBeUndefined();
    });

    it('should accept all valid agent states', () => {
      const states: AgentState[] = ['pending', 'running', 'paused', 'stopped', 'error', 'killed'];
      expect(states).toHaveLength(6);
    });
  });

  describe('Provider types', () => {
    it('should construct valid cost estimate', () => {
      const cost: CostEstimate = {
        inputCost: 0.003,
        outputCost: 0.015,
        totalCost: 0.018,
        currency: 'USD',
      };
      expect(cost.totalCost).toBe(0.018);
    });

    it('should construct valid model info', () => {
      const model: ModelInfo = {
        id: 'claude-sonnet-4-20250514',
        displayName: 'Claude Sonnet 4',
        provider: 'anthropic',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        pricing: {
          inputPerMillion: 3.0,
          outputPerMillion: 15.0,
        },
      };
      expect(model.id).toBe('claude-sonnet-4-20250514');
    });

    it('should construct valid SSE event', () => {
      const event: SSEEvent = {
        event: 'message_start',
        data: '{"type": "message_start"}',
      };
      expect(event.event).toBe('message_start');
    });
  });

  describe('Protocol types', () => {
    it('should construct valid worker-to-iframe message', () => {
      const msg: WorkerToIframe = {
        type: 'api_request',
        id: 'req-1',
        payload: { model: 'claude-sonnet-4-20250514' },
      };
      expect(msg.type).toBe('api_request');
    });

    it('should construct valid iframe-to-shell message', () => {
      const msg: IframeToShell = {
        type: 'api_request',
        id: 'req-1',
        agentId: 'agent-1',
        payload: {},
      };
      expect(msg.type).toBe('api_request');
    });

    it('should construct valid DOM command', () => {
      const cmd: DomCommand = {
        action: 'create',
        html: '<div>Hello</div>',
        parentSelector: '#container',
      };
      expect(cmd.action).toBe('create');
    });

    it('ShellToIframe includes user_message, pause, resume', () => {
      const userMsg: ShellToIframe = { type: 'user_message', content: 'hello' };
      const pause: ShellToIframe = { type: 'pause' };
      const resume: ShellToIframe = { type: 'resume' };
      expect(userMsg.type).toBe('user_message');
      expect(pause.type).toBe('pause');
      expect(resume.type).toBe('resume');
    });

    it('ShellToServiceWorker types compile correctly', () => {
      const configure: ShellToServiceWorker = { type: 'configure', apiKey: 'sk-test' };
      const update: ShellToServiceWorker = { type: 'update_key', apiKey: 'sk-new' };
      expect(configure.type).toBe('configure');
      expect(update.type).toBe('update_key');
    });
  });
});
