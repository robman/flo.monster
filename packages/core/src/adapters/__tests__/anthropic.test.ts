import { describe, it, expect, beforeEach } from 'vitest';
import { createAnthropicAdapter, MODEL_INFO } from '../anthropic.js';
import type { Message, ApiToolDef, TokenUsage } from '../../types/messages.js';
import type { AgentConfig } from '../../types/agent.js';
import type { ProviderAdapter, SSEEvent } from '../../types/provider.js';

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'test',
    name: 'Test',
    model: 'claude-sonnet-4-20250514',
    tools: [],
    maxTokens: 4096,
    ...overrides,
  };
}

describe('Anthropic Adapter', () => {
  let adapter: ProviderAdapter;

  beforeEach(() => {
    adapter = createAnthropicAdapter();
  });

  describe('buildRequest', () => {
    it('produces correct Anthropic API format', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      expect(result.url).toBe('/api/anthropic/v1/messages');
      expect(result.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(result.body);
      expect(body.model).toBe('claude-sonnet-4-20250514');
      expect(body.max_tokens).toBe(4096);
      expect(body.stream).toBe(true);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
    });

    it('includes tools in correct format', () => {
      const tools: ApiToolDef[] = [{
        name: 'runjs',
        description: 'Run JavaScript',
        input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      }];
      const result = adapter.buildRequest([], tools, makeConfig());
      const body = JSON.parse(result.body);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].name).toBe('runjs');
      expect(body.tools[0].input_schema.type).toBe('object');
    });

    it('includes system prompt when set', () => {
      const config = makeConfig({ systemPrompt: 'You are helpful' });
      const result = adapter.buildRequest([], [], config);
      const body = JSON.parse(result.body);
      expect(body.system).toBe('You are helpful');
    });

    it('omits system when not set', () => {
      const result = adapter.buildRequest([], [], makeConfig());
      const body = JSON.parse(result.body);
      expect(body.system).toBeUndefined();
    });

    it('formats tool_result content correctly', () => {
      const messages: Message[] = [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'result text' }],
      }];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      expect(body.messages[0].content[0].type).toBe('tool_result');
      expect(body.messages[0].content[0].content).toBe('result text');
    });
  });

  describe('parseSSEEvent', () => {
    it('parses message_start', () => {
      const event: SSEEvent = {
        event: 'message_start',
        data: '{"type":"message_start","message":{"id":"msg_123"}}',
      };
      const events = adapter.parseSSEEvent(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message_start');
      if (events[0].type === 'message_start') {
        expect(events[0].messageId).toBe('msg_123');
      }
    });

    it('does not emit usage from message_start (deferred to message_delta)', () => {
      const event: SSEEvent = {
        event: 'message_start',
        data: '{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":150,"output_tokens":0}}}',
      };
      const events = adapter.parseSSEEvent(event);
      // Only message_start — no usage event (usage is deferred to message_delta)
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message_start');
    });

    it('emits merged usage once at message_delta, not double-counted', () => {
      // Simulate message_start with input_tokens
      adapter.parseSSEEvent({
        data: '{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":150,"output_tokens":0}}}',
      });
      // Simulate message_delta with output_tokens (Anthropic may also repeat input_tokens)
      const events = adapter.parseSSEEvent({
        data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
      });
      // Should emit exactly one usage event with merged totals
      const usageEvents = events.filter((e) => e.type === 'usage');
      expect(usageEvents).toHaveLength(1);
      if (usageEvents[0].type === 'usage') {
        expect(usageEvents[0].usage.input_tokens).toBe(150);
        expect(usageEvents[0].usage.output_tokens).toBe(42);
      }
    });

    it('merges cache token fields across message_start and message_delta', () => {
      adapter.parseSSEEvent({
        data: '{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":200,"output_tokens":0,"cache_creation_input_tokens":50,"cache_read_input_tokens":100}}}',
      });
      const events = adapter.parseSSEEvent({
        data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":30}}',
      });
      const usageEvents = events.filter((e) => e.type === 'usage');
      expect(usageEvents).toHaveLength(1);
      if (usageEvents[0].type === 'usage') {
        expect(usageEvents[0].usage.input_tokens).toBe(200);
        expect(usageEvents[0].usage.output_tokens).toBe(30);
        expect(usageEvents[0].usage.cache_creation_input_tokens).toBe(50);
        expect(usageEvents[0].usage.cache_read_input_tokens).toBe(100);
      }
    });

    it('parses text content streaming', () => {
      // content_block_start with text
      let events = adapter.parseSSEEvent({
        data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      });
      expect(events).toHaveLength(0);

      // text delta
      events = adapter.parseSSEEvent({
        data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_delta');
      if (events[0].type === 'text_delta') {
        expect(events[0].text).toBe('Hello');
      }

      // more text
      events = adapter.parseSSEEvent({
        data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
      });
      expect(events[0].type).toBe('text_delta');

      // content_block_stop -> text_done
      events = adapter.parseSSEEvent({
        data: '{"type":"content_block_stop","index":0}',
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_done');
      if (events[0].type === 'text_done') {
        expect(events[0].text).toBe('Hello world');
      }
    });

    it('parses tool_use streaming', () => {
      // block_start with tool_use
      let events = adapter.parseSSEEvent({
        data: '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"runjs"}}',
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_use_start');

      // input_json_delta
      events = adapter.parseSSEEvent({
        data: '{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"code\\":"}}',
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_use_input_delta');

      events = adapter.parseSSEEvent({
        data: '{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"2+2\\"}"}}',
      });

      // block_stop -> tool_use_done with parsed input
      events = adapter.parseSSEEvent({
        data: '{"type":"content_block_stop","index":1}',
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_use_done');
      if (events[0].type === 'tool_use_done') {
        expect(events[0].toolUseId).toBe('tu_1');
        expect(events[0].toolName).toBe('runjs');
        expect(events[0].input).toEqual({ code: '2+2' });
      }
    });

    it('parses message_delta with usage and stop_reason', () => {
      const events = adapter.parseSSEEvent({
        data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
      });
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('usage');
      expect(events[1].type).toBe('turn_end');
      if (events[1].type === 'turn_end') {
        expect(events[1].stopReason).toBe('end_turn');
      }
    });

    it('ignores message_stop', () => {
      const events = adapter.parseSSEEvent({
        data: '{"type":"message_stop"}',
      });
      expect(events).toHaveLength(0);
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
    it('returns correct values for Sonnet', () => {
      const usage: TokenUsage = { input_tokens: 1000, output_tokens: 500 };
      const cost = adapter.estimateCost('claude-sonnet-4-20250514', usage);
      expect(cost.inputCost).toBeCloseTo(0.003);
      expect(cost.outputCost).toBeCloseTo(0.0075);
      expect(cost.totalCost).toBeCloseTo(0.0105);
      expect(cost.currency).toBe('USD');
    });

    it('returns zeros for unknown model', () => {
      const usage: TokenUsage = { input_tokens: 1000, output_tokens: 500 };
      const cost = adapter.estimateCost('unknown-model', usage);
      expect(cost.totalCost).toBe(0);
    });

    it('includes cache costs', () => {
      const usage: TokenUsage = {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      };
      const cost = adapter.estimateCost('claude-sonnet-4-20250514', usage);
      expect(cost.totalCost).toBeGreaterThan(0.0105);
    });
  });

  describe('extractUsage', () => {
    it('extracts usage from response data', () => {
      const usage = adapter.extractUsage({ usage: { input_tokens: 100, output_tokens: 50 } });
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
      // Parse a partial tool use
      adapter.parseSSEEvent({
        data: '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"test"}}',
      });
      adapter.parseSSEEvent({
        data: '{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}',
      });

      // Reset
      adapter.resetState();

      // Parse new text - should not be affected by old state
      const events = adapter.parseSSEEvent({
        data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      });
      // Should not produce tool_use events
      expect(events.every((e) => e.type !== 'tool_use_done')).toBe(true);
    });
  });
});
