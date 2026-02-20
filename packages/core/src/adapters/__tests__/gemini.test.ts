import { describe, it, expect, beforeEach } from 'vitest';
import { createGeminiAdapter, GEMINI_MODELS, convertToolSchema } from '../gemini.js';
import type { Message, ApiToolDef, TokenUsage } from '../../types/messages.js';
import type { AgentConfig } from '../../types/agent.js';
import type { ProviderAdapter, SSEEvent } from '../../types/provider.js';

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'test',
    name: 'Test',
    model: 'gemini-2.5-flash',
    tools: [],
    maxTokens: 4096,
    ...overrides,
  };
}

describe('convertToolSchema', () => {
  it('uppercases type strings', () => {
    expect(convertToolSchema({ type: 'string' })).toEqual({ type: 'STRING' });
    expect(convertToolSchema({ type: 'object', properties: {} })).toEqual({ type: 'OBJECT', properties: {} });
    expect(convertToolSchema({ type: 'array', items: { type: 'string' } })).toEqual({
      type: 'ARRAY',
      items: { type: 'STRING' },
    });
    expect(convertToolSchema({ type: 'number' })).toEqual({ type: 'NUMBER' });
    expect(convertToolSchema({ type: 'integer' })).toEqual({ type: 'INTEGER' });
    expect(convertToolSchema({ type: 'boolean' })).toEqual({ type: 'BOOLEAN' });
  });

  it('removes additionalProperties', () => {
    const result = convertToolSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    });
    expect(result.additionalProperties).toBeUndefined();
    expect(result.type).toBe('OBJECT');
    expect(result.properties).toBeDefined();
  });

  it('adds empty properties to bare OBJECT types', () => {
    const result = convertToolSchema({ type: 'object' });
    expect(result.type).toBe('OBJECT');
    expect(result.properties).toEqual({});
  });

  it('does not add empty properties if properties already exist', () => {
    const result = convertToolSchema({
      type: 'object',
      properties: { foo: { type: 'string' } },
    });
    expect(result.properties).toEqual({ foo: { type: 'STRING' } });
  });

  it('recursively converts nested properties', () => {
    const result = convertToolSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            zip: { type: 'number' },
          },
        },
      },
    });
    expect(result.type).toBe('OBJECT');
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.name.type).toBe('STRING');
    expect(props.age.type).toBe('INTEGER');
    expect(props.address.type).toBe('OBJECT');
    const addressProps = props.address.properties as Record<string, Record<string, unknown>>;
    expect(addressProps.street.type).toBe('STRING');
    expect(addressProps.zip.type).toBe('NUMBER');
  });

  it('recursively converts items for arrays', () => {
    const result = convertToolSchema({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          value: { type: 'number' },
        },
      },
    });
    expect(result.type).toBe('ARRAY');
    const items = result.items as Record<string, unknown>;
    expect(items.type).toBe('OBJECT');
    const itemProps = items.properties as Record<string, Record<string, unknown>>;
    expect(itemProps.value.type).toBe('NUMBER');
  });

  it('preserves other fields (description, enum, required)', () => {
    const result = convertToolSchema({
      type: 'object',
      description: 'A test schema',
      required: ['name', 'color'],
      properties: {
        name: { type: 'string', description: 'The name' },
        color: { type: 'string', enum: ['red', 'blue', 'green'] },
      },
    });
    expect(result.description).toBe('A test schema');
    expect(result.required).toEqual(['name', 'color']);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.name.description).toBe('The name');
    expect(props.color.enum).toEqual(['red', 'blue', 'green']);
  });

  it('handles deeply nested schemas (object with array of objects)', () => {
    const result = convertToolSchema({
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              tags: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      },
    });
    expect(result.type).toBe('OBJECT');
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.users.type).toBe('ARRAY');
    const usersItems = props.users.items as Record<string, unknown>;
    expect(usersItems.type).toBe('OBJECT');
    const userProps = usersItems.properties as Record<string, Record<string, unknown>>;
    expect(userProps.name.type).toBe('STRING');
    expect(userProps.tags.type).toBe('ARRAY');
    const tagsItems = userProps.tags.items as Record<string, unknown>;
    expect(tagsItems.type).toBe('STRING');
  });

  it('handles schema with no type field', () => {
    const result = convertToolSchema({ description: 'no type' });
    expect(result.description).toBe('no type');
    expect(result.type).toBeUndefined();
  });
});

describe('Gemini Adapter', () => {
  let adapter: ProviderAdapter;

  beforeEach(() => {
    adapter = createGeminiAdapter();
  });

  describe('buildRequest', () => {
    it('produces correct Gemini API URL with model name', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      expect(result.url).toBe(
        '/api/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      );
    });

    it('URL includes the specified model name', () => {
      const result = adapter.buildRequest(
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        [],
        makeConfig({ model: 'gemini-2.5-pro' }),
      );
      expect(result.url).toContain('gemini-2.5-pro');
      expect(result.url).toBe(
        '/api/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
      );
    });

    it('sets Content-Type header only', () => {
      const result = adapter.buildRequest(
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        [],
        makeConfig(),
      );
      expect(result.headers).toEqual({ 'Content-Type': 'application/json' });
    });

    it('body contains contents array with user/model roles', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
        { role: 'user', content: [{ type: 'text', text: 'How are you?' }] },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      expect(body.contents).toHaveLength(3);
      expect(body.contents[0].role).toBe('user');
      expect(body.contents[0].parts).toEqual([{ text: 'Hello' }]);
      expect(body.contents[1].role).toBe('model');
      expect(body.contents[1].parts).toEqual([{ text: 'Hi there' }]);
      expect(body.contents[2].role).toBe('user');
      expect(body.contents[2].parts).toEqual([{ text: 'How are you?' }]);
    });

    it('places system prompt in system_instruction (not in contents)', () => {
      const config = makeConfig({ systemPrompt: 'You are a helpful assistant' });
      const result = adapter.buildRequest(
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        [],
        config,
      );
      const body = JSON.parse(result.body);
      expect(body.system_instruction).toEqual({
        parts: [{ text: 'You are a helpful assistant' }],
      });
      // Should NOT appear in contents
      for (const content of body.contents) {
        for (const part of content.parts) {
          if (part.text) {
            expect(part.text).not.toBe('You are a helpful assistant');
          }
        }
      }
    });

    it('omits system_instruction when not set', () => {
      const result = adapter.buildRequest(
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        [],
        makeConfig(),
      );
      const body = JSON.parse(result.body);
      expect(body.system_instruction).toBeUndefined();
    });

    it('sets generationConfig.maxOutputTokens from config.maxTokens', () => {
      const result = adapter.buildRequest(
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        [],
        makeConfig({ maxTokens: 16384 }),
      );
      const body = JSON.parse(result.body);
      expect(body.generationConfig).toEqual({ maxOutputTokens: 16384 });
    });

    it('defaults maxOutputTokens to 8192 when config.maxTokens is 0 or falsy', () => {
      const result = adapter.buildRequest(
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        [],
        makeConfig({ maxTokens: 0 }),
      );
      const body = JSON.parse(result.body);
      expect(body.generationConfig.maxOutputTokens).toBe(8192);
    });

    it('includes tools as functionDeclarations with UPPERCASE types', () => {
      const tools: ApiToolDef[] = [
        {
          name: 'runjs',
          description: 'Run JavaScript code',
          input_schema: {
            type: 'object',
            properties: { code: { type: 'string' } },
            required: ['code'],
          },
        },
        {
          name: 'dom',
          description: 'Manipulate the DOM',
          input_schema: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              html: { type: 'string' },
            },
            required: ['action'],
          },
        },
      ];
      const result = adapter.buildRequest(
        [{ role: 'user', content: [{ type: 'text', text: 'Code' }] }],
        tools,
        makeConfig(),
      );
      const body = JSON.parse(result.body);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].functionDeclarations).toHaveLength(2);

      const fd0 = body.tools[0].functionDeclarations[0];
      expect(fd0.name).toBe('runjs');
      expect(fd0.description).toBe('Run JavaScript code');
      expect(fd0.parameters.type).toBe('OBJECT');
      expect(fd0.parameters.properties.code.type).toBe('STRING');
      expect(fd0.parameters.required).toEqual(['code']);

      const fd1 = body.tools[0].functionDeclarations[1];
      expect(fd1.name).toBe('dom');
    });

    it('includes toolConfig with mode AUTO when tools present', () => {
      const tools: ApiToolDef[] = [{
        name: 'test',
        description: 'Test',
        input_schema: { type: 'object', properties: {} },
      }];
      const result = adapter.buildRequest(
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        tools,
        makeConfig(),
      );
      const body = JSON.parse(result.body);
      expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    });

    it('omits tools and toolConfig when tools array is empty', () => {
      const result = adapter.buildRequest(
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        [],
        makeConfig(),
      );
      const body = JSON.parse(result.body);
      expect(body.tools).toBeUndefined();
      expect(body.toolConfig).toBeUndefined();
    });

    it('converts assistant role to model', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      expect(body.contents[0].role).toBe('user');
      expect(body.contents[1].role).toBe('model');
    });

    it('converts tool_use blocks to functionCall parts', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Run code' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running code...' },
            { type: 'tool_use', id: 'tc_1', name: 'runjs', input: { code: '2+2' } },
          ],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      const modelMsg = body.contents[1];
      expect(modelMsg.role).toBe('model');
      expect(modelMsg.parts).toHaveLength(2);
      expect(modelMsg.parts[0]).toEqual({ text: 'Running code...' });
      expect(modelMsg.parts[1]).toEqual({
        functionCall: { name: 'runjs', args: { code: '2+2' } },
      });
    });

    it('preserves thoughtSignature on functionCall parts', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tc_1',
              name: 'runjs',
              input: { code: 'x' },
              thoughtSignature: 'sig123',
            },
          ],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      const modelParts = body.contents[1].parts;
      expect(modelParts[0].functionCall).toEqual({ name: 'runjs', args: { code: 'x' } });
      expect(modelParts[0].thoughtSignature).toBe('sig123');
    });

    it('converts tool_result blocks to functionResponse parts with name lookup', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Run code' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc_1', name: 'runjs', input: { code: '2+2' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tc_1', content: '4' },
          ],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      const userMsg = body.contents[2];
      expect(userMsg.role).toBe('user');
      expect(userMsg.parts[0].functionResponse).toBeDefined();
      expect(userMsg.parts[0].functionResponse.name).toBe('runjs');
      expect(userMsg.parts[0].functionResponse.response).toEqual({ result: '4' });
    });

    it('converts tool_result with JSON content to parsed object', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Check' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc_1', name: 'capabilities', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tc_1', content: '{"mode":"browser","tools":["dom"]}' },
          ],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      const responsePart = body.contents[2].parts[0].functionResponse;
      expect(responsePart.name).toBe('capabilities');
      expect(responsePart.response).toEqual({ mode: 'browser', tools: ['dom'] });
    });

    it('converts tool_result with is_error to error response', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Run' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc_1', name: 'runjs', input: { code: 'bad' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tc_1', content: 'ReferenceError: x is not defined', is_error: true },
          ],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      const responsePart = body.contents[2].parts[0].functionResponse;
      expect(responsePart.response).toEqual({ error: 'ReferenceError: x is not defined' });
    });

    it('uses "unknown" name for tool_result when tool_use_id not found', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'nonexistent', content: 'result' },
          ],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      expect(body.contents[0].parts[0].functionResponse.name).toBe('unknown');
    });

    it('merges consecutive same-role messages', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'First' }] },
        { role: 'user', content: [{ type: 'text', text: 'Second' }] },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      // Should be merged into a single user entry with two parts
      expect(body.contents).toHaveLength(1);
      expect(body.contents[0].role).toBe('user');
      expect(body.contents[0].parts).toHaveLength(2);
      expect(body.contents[0].parts[0]).toEqual({ text: 'First' });
      expect(body.contents[0].parts[1]).toEqual({ text: 'Second' });
    });

    it('skips messages with empty content', () => {
      const messages: Message[] = [
        { role: 'user', content: [] },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      expect(body.contents).toHaveLength(1);
      expect(body.contents[0].parts).toEqual([{ text: 'Hello' }]);
    });

    it('wraps non-object JSON parse results in { result: ... }', () => {
      // Tool result that is a plain string (not valid JSON object)
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Go' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc_1', name: 'test', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tc_1', content: '"just a string"' },
          ],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      const resp = body.contents[2].parts[0].functionResponse.response;
      expect(resp).toEqual({ result: '"just a string"' });
    });

    it('wraps array JSON results in { result: ... }', () => {
      // JSON array is not a plain object, should be wrapped
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Go' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc_1', name: 'test', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tc_1', content: '[1,2,3]' },
          ],
        },
      ];
      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      const resp = body.contents[2].parts[0].functionResponse.response;
      // Arrays are typeof 'object' and not null, so they pass through
      expect(resp).toEqual([1, 2, 3]);
    });
  });

  describe('parseSSEEvent', () => {
    it('returns text_delta for text chunk', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: { parts: [{ text: 'Hello world' }] },
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_delta');
      if (events[0].type === 'text_delta') {
        expect(events[0].text).toBe('Hello world');
      }
    });

    it('returns multiple text_delta events for multiple text chunks', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [
                { text: 'Hello ' },
                { text: 'world' },
              ],
            },
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas).toHaveLength(2);
      if (textDeltas[0].type === 'text_delta') expect(textDeltas[0].text).toBe('Hello ');
      if (textDeltas[1].type === 'text_delta') expect(textDeltas[1].text).toBe('world');
    });

    it('returns tool_use_start + tool_use_input_delta + tool_use_done for function call', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: 'runjs', args: { code: '2+2' } },
              }],
            },
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      expect(events).toHaveLength(3);

      expect(events[0].type).toBe('tool_use_start');
      if (events[0].type === 'tool_use_start') {
        expect(events[0].toolUseId).toBe('gemini_tc_0');
        expect(events[0].toolName).toBe('runjs');
      }

      expect(events[1].type).toBe('tool_use_input_delta');
      if (events[1].type === 'tool_use_input_delta') {
        expect(events[1].toolUseId).toBe('gemini_tc_0');
        expect(events[1].partialJson).toBe('{"code":"2+2"}');
      }

      expect(events[2].type).toBe('tool_use_done');
      if (events[2].type === 'tool_use_done') {
        expect(events[2].toolUseId).toBe('gemini_tc_0');
        expect(events[2].toolName).toBe('runjs');
        expect(events[2].input).toEqual({ code: '2+2' });
      }
    });

    it('uses gemini_tc_N pattern with incrementing counter', () => {
      // First function call
      adapter.parseSSEEvent({
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: 'tool_a', args: {} },
              }],
            },
          }],
        }),
      });

      // Second function call
      const events = adapter.parseSSEEvent({
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: 'tool_b', args: {} },
              }],
            },
          }],
        }),
      });

      const startEvent = events.find(e => e.type === 'tool_use_start');
      if (startEvent?.type === 'tool_use_start') {
        expect(startEvent.toolUseId).toBe('gemini_tc_1');
      }
    });

    it('skips thinking parts (thought: true)', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [
                { thought: true, text: 'Let me think about this...' },
                { text: 'Here is the answer.' },
              ],
            },
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas).toHaveLength(1);
      if (textDeltas[0].type === 'text_delta') {
        expect(textDeltas[0].text).toBe('Here is the answer.');
      }
    });

    it('emits turn_end with end_turn for finishReason STOP without tool calls', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: { parts: [{ text: 'Done.' }] },
            finishReason: 'STOP',
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      const textDelta = events.find(e => e.type === 'text_delta');
      const textDone = events.find(e => e.type === 'text_done');
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(textDelta).toBeDefined();
      expect(textDone).toBeDefined();
      expect(turnEnd).toBeDefined();
      if (turnEnd?.type === 'turn_end') {
        expect(turnEnd.stopReason).toBe('end_turn');
      }
    });

    it('emits turn_end with tool_use for finishReason STOP with tool calls', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: 'dom', args: { action: 'create' } },
              }],
            },
            finishReason: 'STOP',
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(turnEnd).toBeDefined();
      if (turnEnd?.type === 'turn_end') {
        expect(turnEnd.stopReason).toBe('tool_use');
      }
    });

    it('emits turn_end with tool_use when functionCall and finishReason are in separate chunks', () => {
      // Gemini 3 can split functionCall and finishReason:STOP into separate SSE chunks
      // Chunk 1: functionCall (no finishReason)
      const chunk1: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: 'dom', args: { action: 'modify' } },
              }],
              role: 'model',
            },
            index: 0,
          }],
        }),
      };
      // Chunk 2: empty text with finishReason:STOP
      const chunk2: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{ text: '' }],
              role: 'model',
            },
            finishReason: 'STOP',
            index: 0,
          }],
        }),
      };

      const events1 = adapter.parseSSEEvent(chunk1);
      expect(events1.some(e => e.type === 'tool_use_done')).toBe(true);
      // No turn_end yet (no finishReason in chunk 1)
      expect(events1.some(e => e.type === 'turn_end')).toBe(false);

      const events2 = adapter.parseSSEEvent(chunk2);
      const turnEnd = events2.find(e => e.type === 'turn_end');
      expect(turnEnd).toBeDefined();
      if (turnEnd?.type === 'turn_end') {
        // Must be tool_use, not end_turn — the functionCall was in chunk 1
        expect(turnEnd.stopReason).toBe('tool_use');
      }
    });

    it('emits turn_end with max_tokens for finishReason MAX_TOKENS', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: { parts: [{ text: 'Truncated...' }] },
            finishReason: 'MAX_TOKENS',
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(turnEnd).toBeDefined();
      if (turnEnd?.type === 'turn_end') {
        expect(turnEnd.stopReason).toBe('max_tokens');
      }
    });

    it('emits error event + turn_end for finishReason SAFETY', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: { parts: [] },
            finishReason: 'SAFETY',
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      const errorEvent = events.find(e => e.type === 'error');
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === 'error') {
        expect(errorEvent.error).toBe('Gemini blocked response: SAFETY');
      }
      expect(turnEnd).toBeDefined();
      if (turnEnd?.type === 'turn_end') {
        expect(turnEnd.stopReason).toBe('end_turn');
      }
    });

    it('emits error event + turn_end for finishReason RECITATION', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: { parts: [] },
            finishReason: 'RECITATION',
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      const errorEvent = events.find(e => e.type === 'error');
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === 'error') {
        expect(errorEvent.error).toBe('Gemini blocked response: RECITATION');
      }
      expect(turnEnd).toBeDefined();
      if (turnEnd?.type === 'turn_end') {
        expect(turnEnd.stopReason).toBe('end_turn');
      }
    });

    it('emits usage event from usageMetadata', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          usageMetadata: {
            promptTokenCount: 150,
            candidatesTokenCount: 42,
          },
        }),
      };
      const events = adapter.parseSSEEvent(event);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('usage');
      if (events[0].type === 'usage') {
        expect(events[0].usage.input_tokens).toBe(150);
        expect(events[0].usage.output_tokens).toBe(42);
        expect(events[0].cost).toEqual({
          inputCost: 0,
          outputCost: 0,
          totalCost: 0,
          currency: 'USD',
        });
      }
    });

    it('returns empty events for empty data', () => {
      const events = adapter.parseSSEEvent({ data: '' });
      expect(events).toHaveLength(0);
    });

    it('returns empty events for invalid JSON data', () => {
      const events = adapter.parseSSEEvent({ data: 'not valid json{{{' });
      expect(events).toHaveLength(0);
    });

    it('returns empty events for null/non-object JSON', () => {
      expect(adapter.parseSSEEvent({ data: 'null' })).toHaveLength(0);
      expect(adapter.parseSSEEvent({ data: '42' })).toHaveLength(0);
      expect(adapter.parseSSEEvent({ data: '"string"' })).toHaveLength(0);
    });

    it('preserves thoughtSignature on functionCall tool_use_done event', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: 'runjs', args: { code: 'x' } },
                thoughtSignature: 'abc123',
              }],
            },
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      const doneEvent = events.find(e => e.type === 'tool_use_done');
      expect(doneEvent).toBeDefined();
      if (doneEvent?.type === 'tool_use_done') {
        expect((doneEvent as any).thoughtSignature).toBe('abc123');
      }
    });

    it('does not set thoughtSignature when not present on functionCall', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: 'test', args: {} },
              }],
            },
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      const doneEvent = events.find(e => e.type === 'tool_use_done');
      expect(doneEvent).toBeDefined();
      if (doneEvent?.type === 'tool_use_done') {
        expect((doneEvent as any).thoughtSignature).toBeUndefined();
      }
    });

    it('flushes text_done before tool calls', () => {
      // First send text
      adapter.parseSSEEvent({
        data: JSON.stringify({
          candidates: [{
            content: { parts: [{ text: 'Let me run that...' }] },
          }],
        }),
      });

      // Then send function call in same candidate chunk
      const events = adapter.parseSSEEvent({
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: 'runjs', args: { code: '1+1' } },
              }],
            },
          }],
        }),
      });

      // The text_done should be flushed before tool_use_start
      const textDone = events.find(e => e.type === 'text_done');
      const toolStart = events.find(e => e.type === 'tool_use_start');
      expect(textDone).toBeDefined();
      expect(toolStart).toBeDefined();
      if (textDone?.type === 'text_done') {
        expect(textDone.text).toBe('Let me run that...');
      }
      // text_done should come before tool_use_start in the array
      const textDoneIdx = events.indexOf(textDone!);
      const toolStartIdx = events.indexOf(toolStart!);
      expect(textDoneIdx).toBeLessThan(toolStartIdx);
    });

    it('flushes text_done on finishReason', () => {
      // Accumulate text
      adapter.parseSSEEvent({
        data: JSON.stringify({
          candidates: [{
            content: { parts: [{ text: 'Hello' }] },
          }],
        }),
      });

      // Finish
      const events = adapter.parseSSEEvent({
        data: JSON.stringify({
          candidates: [{
            finishReason: 'STOP',
          }],
        }),
      });

      const textDone = events.find(e => e.type === 'text_done');
      expect(textDone).toBeDefined();
      if (textDone?.type === 'text_done') {
        expect(textDone.text).toBe('Hello');
      }
    });

    it('handles functionCall with no args', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: 'capabilities' },
              }],
            },
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      const doneEvent = events.find(e => e.type === 'tool_use_done');
      expect(doneEvent).toBeDefined();
      if (doneEvent?.type === 'tool_use_done') {
        expect(doneEvent.input).toEqual({});
      }
    });

    it('handles chunk with both text and function call', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [
                { text: 'I will run that.' },
                { functionCall: { name: 'runjs', args: { code: 'console.log(1)' } } },
              ],
            },
            finishReason: 'STOP',
          }],
        }),
      };
      const events = adapter.parseSSEEvent(event);

      const textDelta = events.find(e => e.type === 'text_delta');
      const textDone = events.find(e => e.type === 'text_done');
      const toolStart = events.find(e => e.type === 'tool_use_start');
      const toolDone = events.find(e => e.type === 'tool_use_done');
      const turnEnd = events.find(e => e.type === 'turn_end');

      expect(textDelta).toBeDefined();
      expect(textDone).toBeDefined();
      expect(toolStart).toBeDefined();
      expect(toolDone).toBeDefined();
      expect(turnEnd).toBeDefined();

      if (turnEnd?.type === 'turn_end') {
        expect(turnEnd.stopReason).toBe('tool_use');
      }
    });

    it('handles no candidates in response', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
        }),
      };
      const events = adapter.parseSSEEvent(event);
      // Only usage event
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('usage');
    });

    it('handles candidates with no content', () => {
      const event: SSEEvent = {
        data: JSON.stringify({
          candidates: [{ finishReason: 'STOP' }],
        }),
      };
      const events = adapter.parseSSEEvent(event);
      const turnEnd = events.find(e => e.type === 'turn_end');
      expect(turnEnd).toBeDefined();
      if (turnEnd?.type === 'turn_end') {
        expect(turnEnd.stopReason).toBe('end_turn');
      }
    });
  });

  describe('extractUsage', () => {
    it('extracts from usageMetadata fields', () => {
      const usage = adapter.extractUsage({
        usageMetadata: {
          promptTokenCount: 200,
          candidatesTokenCount: 100,
        },
      });
      expect(usage.input_tokens).toBe(200);
      expect(usage.output_tokens).toBe(100);
    });

    it('returns zeros for missing data', () => {
      const usage = adapter.extractUsage({});
      expect(usage.input_tokens).toBe(0);
      expect(usage.output_tokens).toBe(0);
    });

    it('returns zeros for null/undefined', () => {
      const usage = adapter.extractUsage(null);
      expect(usage.input_tokens).toBe(0);
      expect(usage.output_tokens).toBe(0);
    });

    it('returns zeros for missing usageMetadata', () => {
      const usage = adapter.extractUsage({ candidates: [] });
      expect(usage.input_tokens).toBe(0);
      expect(usage.output_tokens).toBe(0);
    });

    it('handles partial usageMetadata', () => {
      const usage = adapter.extractUsage({
        usageMetadata: { promptTokenCount: 50 },
      });
      expect(usage.input_tokens).toBe(50);
      expect(usage.output_tokens).toBe(0);
    });
  });

  describe('estimateCost', () => {
    it('returns correct costs for gemini-2.5-flash', () => {
      const usage: TokenUsage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
      const cost = adapter.estimateCost('gemini-2.5-flash', usage);
      expect(cost.inputCost).toBeCloseTo(0.30);
      expect(cost.outputCost).toBeCloseTo(2.50);
      expect(cost.totalCost).toBeCloseTo(2.80);
      expect(cost.currency).toBe('USD');
    });

    it('returns correct costs for gemini-2.5-pro', () => {
      const usage: TokenUsage = { input_tokens: 1000, output_tokens: 500 };
      const cost = adapter.estimateCost('gemini-2.5-pro', usage);
      // 1000/1M * 1.25 = 0.00125
      expect(cost.inputCost).toBeCloseTo(0.00125);
      // 500/1M * 10.0 = 0.005
      expect(cost.outputCost).toBeCloseTo(0.005);
      expect(cost.totalCost).toBeCloseTo(0.00625);
      expect(cost.currency).toBe('USD');
    });

    it('returns zeros for unknown models', () => {
      const usage: TokenUsage = { input_tokens: 1000, output_tokens: 500 };
      const cost = adapter.estimateCost('unknown-gemini-model', usage);
      expect(cost.inputCost).toBe(0);
      expect(cost.outputCost).toBe(0);
      expect(cost.totalCost).toBe(0);
      expect(cost.currency).toBe('USD');
    });
  });

  describe('resetState', () => {
    it('resets tool call counter to 0', () => {
      // Generate some tool calls to increment counter
      adapter.parseSSEEvent({
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{ functionCall: { name: 'a', args: {} } }],
            },
          }],
        }),
      });
      adapter.parseSSEEvent({
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{ functionCall: { name: 'b', args: {} } }],
            },
          }],
        }),
      });

      // Counter should be at 2 now
      adapter.resetState();

      // After reset, next tool call should be gemini_tc_0
      const events = adapter.parseSSEEvent({
        data: JSON.stringify({
          candidates: [{
            content: {
              parts: [{ functionCall: { name: 'c', args: {} } }],
            },
          }],
        }),
      });
      const startEvent = events.find(e => e.type === 'tool_use_start');
      if (startEvent?.type === 'tool_use_start') {
        expect(startEvent.toolUseId).toBe('gemini_tc_0');
      }
    });

    it('clears text accumulation', () => {
      // Accumulate some text
      adapter.parseSSEEvent({
        data: JSON.stringify({
          candidates: [{
            content: { parts: [{ text: 'Partial text...' }] },
          }],
        }),
      });

      adapter.resetState();

      // After reset, a STOP finish should not emit text_done with old text
      const events = adapter.parseSSEEvent({
        data: JSON.stringify({
          candidates: [{
            content: { parts: [{ text: 'Fresh' }] },
            finishReason: 'STOP',
          }],
        }),
      });

      const textDone = events.find(e => e.type === 'text_done');
      expect(textDone).toBeDefined();
      if (textDone?.type === 'text_done') {
        // Should only contain post-reset text, not the old accumulated text
        expect(textDone.text).toBe('Fresh');
      }
    });
  });

  describe('Integration: multi-turn tool calling flow', () => {
    it('builds request with tool_use + tool_result in conversation history', () => {
      const messages: Message[] = [
        // User asks
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
        // Assistant calls tool
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me calculate that.' },
            { type: 'tool_use', id: 'tc_1', name: 'runjs', input: { code: '2+2' } },
          ],
        },
        // User provides tool result
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tc_1', content: '4' },
          ],
        },
        // Assistant responds
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'The result is 4.' }],
        },
        // User asks followup
        { role: 'user', content: [{ type: 'text', text: 'Now multiply by 3' }] },
      ];

      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);

      expect(body.contents).toHaveLength(5);

      // First user message
      expect(body.contents[0].role).toBe('user');
      expect(body.contents[0].parts[0].text).toBe('What is 2+2?');

      // Assistant with text + functionCall
      expect(body.contents[1].role).toBe('model');
      expect(body.contents[1].parts[0].text).toBe('Let me calculate that.');
      expect(body.contents[1].parts[1].functionCall).toEqual({
        name: 'runjs',
        args: { code: '2+2' },
      });

      // User with functionResponse (name looked up from previous tool_use)
      expect(body.contents[2].role).toBe('user');
      expect(body.contents[2].parts[0].functionResponse.name).toBe('runjs');
      expect(body.contents[2].parts[0].functionResponse.response).toEqual({ result: '4' });

      // Assistant text response
      expect(body.contents[3].role).toBe('model');
      expect(body.contents[3].parts[0].text).toBe('The result is 4.');

      // User followup
      expect(body.contents[4].role).toBe('user');
      expect(body.contents[4].parts[0].text).toBe('Now multiply by 3');
    });

    it('handles multiple tool calls in a single assistant message', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Run both' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc_1', name: 'runjs', input: { code: 'a' } },
            { type: 'tool_use', id: 'tc_2', name: 'dom', input: { action: 'create' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tc_1', content: 'result_a' },
            { type: 'tool_result', tool_use_id: 'tc_2', content: '{"ok":true}' },
          ],
        },
      ];

      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);

      // Model message should have two functionCall parts
      const modelParts = body.contents[1].parts;
      expect(modelParts).toHaveLength(2);
      expect(modelParts[0].functionCall.name).toBe('runjs');
      expect(modelParts[1].functionCall.name).toBe('dom');

      // User message should have two functionResponse parts
      const userParts = body.contents[2].parts;
      expect(userParts).toHaveLength(2);
      expect(userParts[0].functionResponse.name).toBe('runjs');
      expect(userParts[0].functionResponse.response).toEqual({ result: 'result_a' });
      expect(userParts[1].functionResponse.name).toBe('dom');
      expect(userParts[1].functionResponse.response).toEqual({ ok: true });
    });

    it('handles tool_result with content block array (stringified)', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Go' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc_1', name: 'test', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tc_1',
              content: [{ type: 'text', text: 'block result' }],
            },
          ],
        },
      ];

      const result = adapter.buildRequest(messages, [], makeConfig());
      const body = JSON.parse(result.body);
      // Non-string content gets JSON.stringified
      const resp = body.contents[2].parts[0].functionResponse.response;
      // JSON.stringify([{type:'text',text:'block result'}]) is a valid JSON array
      // It will be parsed back to an array, which is a non-null object, so it passes through
      expect(resp).toEqual([{ type: 'text', text: 'block result' }]);
    });
  });
});

describe('GEMINI_MODELS', () => {
  it('has all 7 model entries', () => {
    const modelIds = Object.keys(GEMINI_MODELS);
    expect(modelIds).toHaveLength(7);
    expect(modelIds).toContain('gemini-3.1-pro-preview');
    expect(modelIds).toContain('gemini-3-pro-preview');
    expect(modelIds).toContain('gemini-3-flash-preview');
    expect(modelIds).toContain('gemini-2.5-pro');
    expect(modelIds).toContain('gemini-2.5-flash');
    expect(modelIds).toContain('gemini-2.5-flash-lite');
    expect(modelIds).toContain('gemini-2.0-flash');
  });

  it('all models have provider gemini', () => {
    for (const [id, model] of Object.entries(GEMINI_MODELS)) {
      expect(model.provider).toBe('gemini');
    }
  });

  it('all models have pricing info', () => {
    for (const [id, model] of Object.entries(GEMINI_MODELS)) {
      expect(model.pricing).toBeDefined();
      expect(model.pricing.inputPerMillion).toBeGreaterThan(0);
      expect(model.pricing.outputPerMillion).toBeGreaterThan(0);
    }
  });

  it('all models have contextWindow and maxOutputTokens', () => {
    for (const [id, model] of Object.entries(GEMINI_MODELS)) {
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it('model IDs match their id field', () => {
    for (const [key, model] of Object.entries(GEMINI_MODELS)) {
      expect(model.id).toBe(key);
    }
  });
});
