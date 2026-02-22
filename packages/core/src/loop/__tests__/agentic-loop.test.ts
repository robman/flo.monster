import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgenticLoop, parseTextToolCalls } from '../agentic-loop.js';
import type { LoopDeps } from '../agentic-loop.js';
import { createAnthropicAdapter } from '../../adapters/anthropic.js';
import type { AgentConfig } from '../../types/agent.js';
import type { AgentEvent } from '../../types/events.js';
import type { ToolResult } from '../../types/tools.js';
import type { Message } from '../../types/messages.js';

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'test',
    name: 'Test',
    model: 'claude-sonnet-4-20250514',
    tools: [{
      name: 'runjs',
      description: 'Run JavaScript code',
      input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    }],
    maxTokens: 4096,
    ...overrides,
  };
}

// Helper to create an SSE stream from response data
function makeSSEStream(events: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

// Simple text response SSE
function textResponseSSE(text: string): string[] {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    ...text.split('').map((c) =>
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${c.replace(/"/g, '\\"')}"}}\n\n`
    ),
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

// Tool use response SSE
function toolUseResponseSSE(toolName: string, toolId: string, inputJson: string): string[] {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2"}}\n\n',
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"${toolId}","name":"${toolName}"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(inputJson)}}}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

describe('Agentic Loop', () => {
  let events: AgentEvent[];
  let toolCallLog: { name: string; input: Record<string, unknown> }[];
  let apiCallCount: number;
  let apiResponses: string[][];

  function makeDeps(overrides?: Partial<LoopDeps>): LoopDeps {
    return {
      sendApiRequest: vi.fn(async function* () {
        const response = apiResponses[apiCallCount++] || [];
        for (const chunk of response) {
          yield chunk;
        }
      }),
      executeToolCall: vi.fn(async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
        toolCallLog.push({ name, input });
        return { content: 'tool result: 4' };
      }),
      emit: vi.fn((event: AgentEvent) => {
        events.push(event);
      }),
      adapter: createAnthropicAdapter(),
      ...overrides,
    };
  }

  beforeEach(() => {
    events = [];
    toolCallLog = [];
    apiCallCount = 0;
    apiResponses = [];
  });

  it('simple text response: sends request, parses response, emits text events, ends', async () => {
    apiResponses = [textResponseSSE('Hello!')];
    const deps = makeDeps();

    const result = await runAgenticLoop(makeConfig(), 'Hi', deps);

    expect(apiCallCount).toBe(1);
    expect(events.some((e) => e.type === 'message_start')).toBe(true);
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.some((e) => e.type === 'text_done')).toBe(true);
    expect(events.some((e) => e.type === 'turn_end')).toBe(true);
    const textDone = events.find((e) => e.type === 'text_done');
    if (textDone?.type === 'text_done') {
      expect(textDone.text).toBe('Hello!');
    }

    // Verify returned messages
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toEqual([{ type: 'text', text: 'Hi' }]);
    expect(result[1].role).toBe('assistant');
    expect(result[1].content.some((b) => b.type === 'text' && b.text === 'Hello!')).toBe(true);
  });

  it('tool use response: detects tool_use, calls executeToolCall, sends tool_result', async () => {
    apiResponses = [
      toolUseResponseSSE('runjs', 'tu_1', '{"code":"2+2"}'),
      textResponseSSE('The answer is 4'),
    ];
    const deps = makeDeps();

    const result = await runAgenticLoop(makeConfig(), 'Calculate 2+2', deps);

    expect(apiCallCount).toBe(2);
    expect(toolCallLog).toHaveLength(1);
    expect(toolCallLog[0].name).toBe('runjs');
    expect(toolCallLog[0].input).toEqual({ code: '2+2' });
    expect(events.some((e) => e.type === 'tool_use_start')).toBe(true);
    expect(events.some((e) => e.type === 'tool_use_done')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);

    // Verify returned messages: user, assistant (tool_use), user (tool_result), assistant (text)
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toEqual([{ type: 'text', text: 'Calculate 2+2' }]);
    // Assistant message should contain tool_use block
    expect(result[1].role).toBe('assistant');
    const toolUseBlock = result[1].content.find((b) => b.type === 'tool_use');
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock!.type).toBe('tool_use');
    if (toolUseBlock?.type === 'tool_use') {
      expect(toolUseBlock.name).toBe('runjs');
      expect(toolUseBlock.id).toBe('tu_1');
      expect(toolUseBlock.input).toEqual({ code: '2+2' });
    }
    // Tool result message should contain tool_result block
    expect(result[2].role).toBe('user');
    const toolResultBlock = result[2].content.find((b) => b.type === 'tool_result');
    expect(toolResultBlock).toBeDefined();
    if (toolResultBlock?.type === 'tool_result') {
      expect(toolResultBlock.tool_use_id).toBe('tu_1');
      expect(toolResultBlock.content).toBe('tool result: 4');
    }
    // Final assistant message should contain text
    expect(result[3].role).toBe('assistant');
    expect(result[3].content.some((b) => b.type === 'text' && b.text === 'The answer is 4')).toBe(true);
  });

  it('multi-turn tool use: multiple tool calls in sequence', async () => {
    apiResponses = [
      toolUseResponseSSE('runjs', 'tu_1', '{"code":"1+1"}'),
      toolUseResponseSSE('runjs', 'tu_2', '{"code":"2+2"}'),
      textResponseSSE('Done'),
    ];
    const deps = makeDeps();

    await runAgenticLoop(makeConfig(), 'Do two calculations', deps);

    expect(apiCallCount).toBe(3);
    expect(toolCallLog).toHaveLength(2);
  });

  it('error from API: emits error event', async () => {
    const deps = makeDeps({
      sendApiRequest: async function* () {
        throw new Error('Network error');
      },
    });

    const result = await runAgenticLoop(makeConfig(), 'Hello', deps);

    expect(events.some((e) => e.type === 'error')).toBe(true);
    const errorEvent = events.find((e) => e.type === 'error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error).toContain('Network error');
    }

    // Verify returned messages: should have at least the initial user message
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('error from tool: sends tool_result with isError, continues', async () => {
    apiResponses = [
      toolUseResponseSSE('runjs', 'tu_1', '{"code":"bad"}'),
      textResponseSSE('Tool failed'),
    ];
    const deps = makeDeps({
      executeToolCall: vi.fn(async () => {
        throw new Error('Execution error');
      }),
      sendApiRequest: vi.fn(async function* () {
        const response = apiResponses[apiCallCount++] || [];
        for (const chunk of response) {
          yield chunk;
        }
      }),
      emit: vi.fn((e: AgentEvent) => events.push(e)),
      adapter: createAnthropicAdapter(),
    });

    await runAgenticLoop(makeConfig(), 'Try something', deps);

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.result.is_error).toBe(true);
      expect(toolResult.result.content).toContain('Execution error');
    }
    expect(apiCallCount).toBe(2); // Continued after error
  });

  it('tracks usage across turns', async () => {
    apiResponses = [
      toolUseResponseSSE('runjs', 'tu_1', '{"code":"1"}'),
      textResponseSSE('Done'),
    ];
    const deps = makeDeps();

    await runAgenticLoop(makeConfig(), 'Go', deps);

    const usageEvents = events.filter((e) => e.type === 'usage');
    expect(usageEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('emits only one merged usage event per API call (no double-counting)', async () => {
    // message_start has input usage, message_delta has output usage
    // Adapter merges them and emits ONE usage event at message_delta time
    apiResponses = [[
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":100,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]];
    const deps = makeDeps();

    await runAgenticLoop(makeConfig(), 'Hi', deps);

    const usageEvents = events.filter((e) => e.type === 'usage');
    // Should have exactly 1 usage event (merged at message_delta time)
    expect(usageEvents).toHaveLength(1);
    if (usageEvents[0].type === 'usage') {
      expect(usageEvents[0].usage.input_tokens).toBe(100);
      expect(usageEvents[0].usage.output_tokens).toBe(10);
    }
  });

  it('includes input tokens in usage', async () => {
    apiResponses = [[
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":200,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]];
    const deps = makeDeps();

    await runAgenticLoop(makeConfig(), 'Test', deps);

    const usageEvents = events.filter((e) => e.type === 'usage');
    const lastUsage = usageEvents[usageEvents.length - 1];
    if (lastUsage?.type === 'usage') {
      expect(lastUsage.usage.input_tokens).toBe(200);
      expect(lastUsage.usage.output_tokens).toBe(5);
    }
  });

  it('stops when token budget is exceeded', async () => {
    // Use a very small token budget
    apiResponses = [
      // message_start with 100 input tokens + message_delta with 50 output = 150 total
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":100,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"runjs"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"code\\":\\"1+1\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":50}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
    ];
    const deps = makeDeps();
    const config = makeConfig({ tokenBudget: 100 });

    await runAgenticLoop(config, 'Calculate', deps);

    const budgetEvents = events.filter((e) => e.type === 'budget_exceeded');
    expect(budgetEvents.length).toBe(1);
    if (budgetEvents[0].type === 'budget_exceeded') {
      expect(budgetEvents[0].reason).toBe('token_limit');
    }
    // Should NOT have made a second API call
    expect(apiCallCount).toBe(1);
  });

  it('stops when cost budget is exceeded', async () => {
    // Sonnet: $3/M in, $15/M out
    // 1M input tokens = $3.00 cost
    apiResponses = [[
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1000000,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]];
    const deps = makeDeps();
    const config = makeConfig({ costBudgetUsd: 0.01 });

    await runAgenticLoop(config, 'Hello', deps);

    const budgetEvents = events.filter((e) => e.type === 'budget_exceeded');
    expect(budgetEvents.length).toBe(1);
    if (budgetEvents[0].type === 'budget_exceeded') {
      expect(budgetEvents[0].reason).toBe('cost_limit');
    }
  });

  it('stops at iteration limit', async () => {
    // Create a loop that would run forever (tool use always triggers another turn)
    let callNum = 0;
    const deps = makeDeps({
      sendApiRequest: vi.fn(async function* () {
        callNum++;
        // Always return a tool use response
        const response = toolUseResponseSSE('runjs', `tu_${callNum}`, '{"code":"1"}');
        for (const chunk of response) {
          yield chunk;
        }
      }),
      executeToolCall: vi.fn(async () => ({ content: 'result' })),
      emit: vi.fn((e: AgentEvent) => events.push(e)),
      adapter: createAnthropicAdapter(),
    });

    await runAgenticLoop(makeConfig(), 'Loop forever', deps);

    const budgetEvents = events.filter((e) => e.type === 'budget_exceeded');
    expect(budgetEvents.length).toBe(1);
    if (budgetEvents[0].type === 'budget_exceeded') {
      expect(budgetEvents[0].reason).toBe('iteration_limit');
    }
    // Should have stopped at 200
    expect(callNum).toBe(200);
  });

  it('existingMessages: includes prior conversation history before new user message', async () => {
    apiResponses = [textResponseSSE('Continuing conversation')];
    let capturedBody = '';
    const deps = makeDeps({
      sendApiRequest: vi.fn(async function* (_body: string) {
        capturedBody = _body;
        const response = apiResponses[apiCallCount++] || [];
        for (const chunk of response) {
          yield chunk;
        }
      }),
      emit: vi.fn((e: AgentEvent) => events.push(e)),
      adapter: createAnthropicAdapter(),
    });

    const existingMessages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
    ];

    const result = await runAgenticLoop(makeConfig(), 'Follow up question', deps, existingMessages);

    expect(apiCallCount).toBe(1);
    const parsed = JSON.parse(capturedBody);
    // Should have 3 messages: 2 existing + 1 new user message
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
    expect(parsed.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] });
    expect(parsed.messages[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Follow up question' }] });

    // Verify returned messages: 2 existing + 1 new user + 1 new assistant = 4
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual(existingMessages[0]);
    expect(result[1]).toEqual(existingMessages[1]);
    expect(result[2].role).toBe('user');
    expect(result[2].content).toEqual([{ type: 'text', text: 'Follow up question' }]);
    expect(result[3].role).toBe('assistant');
    expect(result[3].content.some((b) => b.type === 'text' && b.text === 'Continuing conversation')).toBe(true);
  });
});

describe('parseTextToolCalls', () => {
  const toolNames = new Set(['dom', 'capabilities', 'runjs']);

  it('parses "toolname\\n{json}" pattern', () => {
    const content = [{ type: 'text' as const, text: 'dom\n{"action":"create","html":"<h1>Hello</h1>"}' }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_use');
    expect(result[0].name).toBe('dom');
    expect(result[0].input).toEqual({ action: 'create', html: '<h1>Hello</h1>' });
    expect(result[0].id).toMatch(/^text_tool_/);
  });

  it('parses tool call with leading text before tool name', () => {
    const content = [{ type: 'text' as const, text: 'Let me update the page.\ndom\n{"action":"update","html":"<p>New</p>"}' }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('dom');
    expect(result[0].input).toEqual({ action: 'update', html: '<p>New</p>' });
  });

  it('parses tool call with trailing text after JSON', () => {
    const content = [{ type: 'text' as const, text: 'dom\n{"action":"create","html":"<h1>Hi</h1>"}\nSome trailing text' }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('dom');
    expect(result[0].input).toEqual({ action: 'create', html: '<h1>Hi</h1>' });
  });

  it('handles empty JSON object', () => {
    const content = [{ type: 'text' as const, text: 'capabilities\n{}' }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('capabilities');
    expect(result[0].input).toEqual({});
  });

  it('handles nested JSON objects', () => {
    const content = [{ type: 'text' as const, text: 'dom\n{"action":"create","html":"<div>","styles":{"color":"red"}}' }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(1);
    expect(result[0].input).toEqual({ action: 'create', html: '<div>', styles: { color: 'red' } });
  });

  it('handles JSON with escaped characters', () => {
    const content = [{ type: 'text' as const, text: 'dom\n{"html":"<p class=\\"big\\">text</p>"}' }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(1);
    expect(result[0].input).toEqual({ html: '<p class="big">text</p>' });
  });

  it('returns empty array for non-text blocks', () => {
    const content = [{ type: 'tool_use' as const, id: 'tu_1', name: 'dom', input: {} }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when no tool names match', () => {
    const content = [{ type: 'text' as const, text: 'unknown_tool\n{"key":"value"}' }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for plain text with no tool pattern', () => {
    const content = [{ type: 'text' as const, text: 'Hello! How can I help you today?' }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when JSON is invalid', () => {
    const content = [{ type: 'text' as const, text: 'dom\n{not valid json}' }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(0);
  });

  it('returns empty array when JSON is an array (not object)', () => {
    const content = [{ type: 'text' as const, text: 'dom\n[1, 2, 3]' }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(0);
  });

  it('handles real Gemini output pattern: capabilities{}dom{json}', () => {
    // Real pattern seen: "capabilities\n{}{"html":"...","action":"create"}"
    // The capabilities call should be detected
    const content = [{ type: 'text' as const, text: 'capabilities\n{}' }];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('capabilities');
  });

  it('handles multiple text blocks, finds tool call in each', () => {
    const content = [
      { type: 'text' as const, text: 'Just some chat text' },
      { type: 'text' as const, text: 'dom\n{"action":"create","html":"<h1>Page</h1>"}' },
    ];
    const result = parseTextToolCalls(content, toolNames);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('dom');
  });
});
