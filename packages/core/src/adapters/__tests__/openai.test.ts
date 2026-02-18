import { describe, it, expect, beforeEach } from 'vitest';
import { createOpenAIChatAdapter, OPENAI_MODELS, getProviderEndpoint } from '../openai.js';
import type { Message, ApiToolDef, TokenUsage } from '../../types/messages.js';
import type { AgentConfig } from '../../types/agent.js';
import type { ProviderAdapter, SSEEvent } from '../../types/provider.js';

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'test',
    name: 'Test',
    model: 'gpt-4o',
    provider: 'openai',
    tools: [],
    maxTokens: 4096,
    ...overrides,
  };
}

describe('OpenAI Chat Adapter', () => {
  let adapter: ProviderAdapter;

  beforeEach(() => {
    adapter = createOpenAIChatAdapter();
  });

  describe('buildRequest', () => {
    it('produces correct OpenAI Chat Completions format', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      expect(result.url).toBe('/api/openai/v1/chat/completions');
      expect(result.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(result.body);
      expect(body.model).toBe('gpt-4o');
      expect(body.max_completion_tokens).toBe(4096);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[0].content).toBe('Hello');
    });

    it('uses correct endpoint for ollama provider', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig({ provider: 'ollama', model: 'llama3' }));
      expect(result.url).toBe('/api/ollama/v1/chat/completions');
    });

    it('includes system prompt as first message', () => {
      const config = makeConfig({ systemPrompt: 'You are helpful' });
      const result = adapter.buildRequest([], [], config);
      const body = JSON.parse(result.body);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[0].content).toBe('You are helpful');
    });

    it('omits system message when not set', () => {
      const result = adapter.buildRequest(
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        [],
        makeConfig()
      );
      const body = JSON.parse(result.body);
      expect(body.messages[0].role).toBe('user');
    });

    it('includes stream_options for openai', () => {
      const result = adapter.buildRequest([], [], makeConfig());
      const body = JSON.parse(result.body);
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body.max_completion_tokens).toBe(4096);
    });

    it('does not set tool_choice for openai', () => {
      const tools: ApiToolDef[] = [{
        name: 'test',
        description: 'Test tool',
        input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }];
      const result = adapter.buildRequest([], tools, makeConfig());
      const body = JSON.parse(result.body);
      expect(body.tool_choice).toBeUndefined();
    });

    it('wraps tools in OpenAI function format', () => {
      const tools: ApiToolDef[] = [{
        name: 'runjs',
        description: 'Run JavaScript',
        input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      }];
      const result = adapter.buildRequest([], tools, makeConfig());
      const body = JSON.parse(result.body);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].type).toBe('function');
      expect(body.tools[0].function.name).toBe('runjs');
      expect(body.tools[0].function.parameters.type).toBe('object');
    });

    it('converts tool_use blocks to assistant tool_calls', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Run some code' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will run some code.' },
            { type: 'tool_use', id: 'tu_1', name: 'runjs', input: { code: '2+2' } },
          ],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      const assistantMsg = body.messages[1];
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.content).toBe('I will run some code.');
      expect(assistantMsg.tool_calls).toHaveLength(1);
      expect(assistantMsg.tool_calls[0].id).toBe('tu_1');
      expect(assistantMsg.tool_calls[0].type).toBe('function');
      expect(assistantMsg.tool_calls[0].function.name).toBe('runjs');
      expect(JSON.parse(assistantMsg.tool_calls[0].function.arguments)).toEqual({ code: '2+2' });
    });

    it('converts tool_result blocks to tool role messages', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '4' }],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      expect(body.messages[0].role).toBe('tool');
      expect(body.messages[0].tool_call_id).toBe('tu_1');
      expect(body.messages[0].content).toBe('4');
    });

    it('keeps tool_calls format for openai', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'check caps' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'capabilities', input: {} },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"mode":"browser"}' }],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      const msgs = body.messages;

      // Should have tool_calls on assistant
      const assistantMsg = msgs.find((m: any) => m.role === 'assistant');
      expect(assistantMsg.tool_calls).toHaveLength(1);

      // Should have tool role message
      expect(msgs.filter((m: any) => m.role === 'tool')).toHaveLength(1);
    });

    it('handles assistant with only tool_calls (no text)', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Run code' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'runjs', input: { code: '2+2' } },
          ],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      const assistantMsg = body.messages[1];
      expect(assistantMsg.content).toBeNull();
      expect(assistantMsg.tool_calls).toHaveLength(1);
    });
  });

  describe('parseSSEEvent', () => {
    it('parses initial chunk with message id', () => {
      const event: SSEEvent = {
        data: '{"id":"chatcmpl-123","object":"chat.completion.chunk","model":"gpt-4o","choices":[]}',
      };
      const events = adapter.parseSSEEvent(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message_start');
      if (events[0].type === 'message_start') {
        expect(events[0].messageId).toBe('chatcmpl-123');
      }
    });

    it('parses text content streaming', () => {
      // First chunk with content
      let events = adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{"content":"Hello"}}]}',
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_delta');
      if (events[0].type === 'text_delta') {
        expect(events[0].text).toBe('Hello');
      }

      // More content
      events = adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{"content":" world"}}]}',
      });
      expect(events[0].type).toBe('text_delta');

      // Finish with stop
      events = adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      });
      // Should flush text_done and turn_end
      const textDone = events.find(e => e.type === 'text_done');
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(textDone).toBeDefined();
      expect(turnEnd).toBeDefined();
      if (textDone?.type === 'text_done') {
        expect(textDone.text).toBe('Hello world');
      }
      if (turnEnd?.type === 'turn_end') {
        expect(turnEnd.stopReason).toBe('end_turn');
      }
    });

    it('parses tool_calls streaming', () => {
      // Tool call start
      let events = adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"runjs","arguments":""}}]}}]}',
      });
      const toolStart = events.find(e => e.type === 'tool_use_start');
      expect(toolStart).toBeDefined();
      if (toolStart?.type === 'tool_use_start') {
        expect(toolStart.toolUseId).toBe('call_1');
        expect(toolStart.toolName).toBe('runjs');
      }

      // Arguments delta
      events = adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"code\\":"}}]}}]}',
      });
      expect(events.find(e => e.type === 'tool_use_input_delta')).toBeDefined();

      events = adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"2+2\\"}"}}]}}]}',
      });

      // Finish with tool_calls
      events = adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      });
      const toolDone = events.find(e => e.type === 'tool_use_done');
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(toolDone).toBeDefined();
      if (toolDone?.type === 'tool_use_done') {
        expect(toolDone.toolUseId).toBe('call_1');
        expect(toolDone.toolName).toBe('runjs');
        expect(toolDone.input).toEqual({ code: '2+2' });
      }
      expect(turnEnd).toBeDefined();
      if (turnEnd?.type === 'turn_end') {
        expect(turnEnd.stopReason).toBe('tool_use');
      }
    });

    it('parses usage from final chunk', () => {
      const events = adapter.parseSSEEvent({
        data: '{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}',
      });
      const usageEvent = events.find(e => e.type === 'usage');
      expect(usageEvent).toBeDefined();
      if (usageEvent?.type === 'usage') {
        expect(usageEvent.usage.input_tokens).toBe(100);
        expect(usageEvent.usage.output_tokens).toBe(50);
      }
    });

    it('maps finish_reason stop to tool_use when tool calls were made', () => {
      // Some providers send finish_reason:"stop" even when making tool calls
      adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"dom","arguments":""}}]}}]}',
      });
      adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"action\\":\\"create\\"}"}}]}}]}',
      });
      // Provider sends "stop" instead of "tool_calls"
      const events = adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      });
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(turnEnd).toBeDefined();
      if (turnEnd?.type === 'turn_end') {
        expect(turnEnd.stopReason).toBe('tool_use');
      }
    });

    it('maps finish_reason length to max_tokens', () => {
      // Send some text first
      adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{"content":"hi"}}]}',
      });
      const events = adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
      });
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(turnEnd).toBeDefined();
      if (turnEnd?.type === 'turn_end') {
        expect(turnEnd.stopReason).toBe('max_tokens');
      }
    });

    it('ignores [DONE]', () => {
      const events = adapter.parseSSEEvent({ data: '[DONE]' });
      expect(events).toHaveLength(0);
    });

    it('handles invalid JSON gracefully', () => {
      const events = adapter.parseSSEEvent({ data: 'not json' });
      expect(events).toHaveLength(0);
    });
  });

  describe('estimateCost', () => {
    it('returns correct values for GPT-4o', () => {
      const usage: TokenUsage = { input_tokens: 1000, output_tokens: 500 };
      const cost = adapter.estimateCost('gpt-4o', usage);
      expect(cost.inputCost).toBeCloseTo(0.0025);
      expect(cost.outputCost).toBeCloseTo(0.005);
      expect(cost.totalCost).toBeCloseTo(0.0075);
      expect(cost.currency).toBe('USD');
    });

    it('returns zeros for unknown model', () => {
      const usage: TokenUsage = { input_tokens: 1000, output_tokens: 500 };
      const cost = adapter.estimateCost('unknown-model', usage);
      expect(cost.totalCost).toBe(0);
    });
  });

  describe('extractUsage', () => {
    it('extracts usage from OpenAI format', () => {
      const usage = adapter.extractUsage({
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
      expect(usage.input_tokens).toBe(100);
      expect(usage.output_tokens).toBe(50);
    });

    it('handles missing data', () => {
      const usage = adapter.extractUsage({});
      expect(usage.input_tokens).toBe(0);
      expect(usage.output_tokens).toBe(0);
    });
  });

  describe('resetState', () => {
    it('clears accumulated state', () => {
      // Parse partial tool call
      adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"test","arguments":"{\\"a\\":"}}]}}]}',
      });

      // Reset
      adapter.resetState();

      // Parse new text should not be affected
      const events = adapter.parseSSEEvent({
        data: '{"choices":[{"index":0,"delta":{"content":"hello"}}]}',
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_delta');
    });
  });
});

describe('getProviderEndpoint', () => {
  it('returns correct endpoints', () => {
    expect(getProviderEndpoint('anthropic')).toBe('/api/anthropic/v1/messages');
    expect(getProviderEndpoint('openai')).toBe('/api/openai/v1/chat/completions');
    expect(getProviderEndpoint('ollama')).toBe('/api/ollama/v1/chat/completions');
    expect(getProviderEndpoint('unknown')).toBe('/api/anthropic/v1/messages');
  });
});

describe('Model Info', () => {
  it('has correct OpenAI models', () => {
    expect(OPENAI_MODELS['gpt-4o']).toBeDefined();
    expect(OPENAI_MODELS['gpt-4o'].provider).toBe('openai');
    expect(OPENAI_MODELS['gpt-4o-mini']).toBeDefined();
    expect(OPENAI_MODELS['o3-mini']).toBeDefined();
  });
});
