/**
 * Tests for API handler — WS transport branch (Mode 3)
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { handleApiRequest, normalizeOpenAIMessages, canonicalToOpenAIMessages, type HubStreamFn } from './api-handler.js';
import type { IframeToShell } from '@flo-monster/core';

// Mock the context-manager imports (used for terse summaries and turn IDs)
vi.mock('./context-manager.js', () => ({
  extractTerseSummary: vi.fn(() => null),
  appendTerseSummary: vi.fn(),
  generateTurnId: vi.fn(async () => 'turn-1'),
  loadTerseContext: vi.fn(async () => []),
}));

// Mock the buildContextMessages function
vi.mock('@flo-monster/core', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    buildContextMessages: vi.fn(() => []),
  };
});

const originalFetch = globalThis.fetch;

describe('handleApiRequest with hubStream', () => {
  let target: { postMessage: Mock };
  let mockFetch: Mock;
  let mockStorageProvider: any;

  beforeEach(() => {
    target = {
      postMessage: vi.fn(),
    };

    mockStorageProvider = {
      readFile: vi.fn(async () => '[]'),
      writeFile: vi.fn(async () => {}),
    };

    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function createMsg(payload: unknown = { model: 'test', messages: [{ role: 'user', content: 'hi' }] }): Extract<IframeToShell, { type: 'api_request' }> {
    return {
      type: 'api_request',
      id: 'req-1',
      agentId: 'agent-1',
      payload,
    };
  }

  const proxySettings = { useBuiltinProxy: true };

  it('routes through hubStream when provided', async () => {
    const hubStream: HubStreamFn = vi.fn((provider, path, payload, callbacks) => {
      callbacks.onChunk('event: content_block_start\ndata: {}\n\n');
      callbacks.onChunk('event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hello"}}\n\n');
      callbacks.onEnd();
    });

    await handleApiRequest(
      createMsg(),
      target as any,
      'agent-1',
      'anthropic',
      proxySettings,
      async () => mockStorageProvider,
      undefined,
      hubStream,
    );

    // hubStream should have been called
    expect(hubStream).toHaveBeenCalledWith(
      'anthropic',
      '/api/anthropic/v1/messages',
      expect.any(Object),
      expect.objectContaining({
        onChunk: expect.any(Function),
        onEnd: expect.any(Function),
        onError: expect.any(Function),
      }),
    );

    // fetch should NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();

    // Target should receive chunk messages + end
    const chunkMessages = target.postMessage.mock.calls.filter(
      (call: any) => call[0].type === 'api_response_chunk'
    );
    expect(chunkMessages.length).toBe(2);

    const endMessages = target.postMessage.mock.calls.filter(
      (call: any) => call[0].type === 'api_response_end'
    );
    expect(endMessages.length).toBe(1);
  });

  it('uses fetch when hubStream is not provided', async () => {
    // Create a simple streaming response
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: content_block_start\ndata: {"content_block":{"type":"text","text":""}}\n\n'));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue(new Response(stream, { status: 200 }));

    await handleApiRequest(
      createMsg(),
      target as any,
      'agent-1',
      'anthropic',
      proxySettings,
      async () => mockStorageProvider,
    );

    // fetch should have been called
    expect(mockFetch).toHaveBeenCalled();

    // Target should receive end message
    const endMessages = target.postMessage.mock.calls.filter(
      (call: any) => call[0].type === 'api_response_end'
    );
    expect(endMessages.length).toBe(1);
  });

  it('posts api_response_error when hubStream calls onError', async () => {
    const hubStream: HubStreamFn = vi.fn((provider, path, payload, callbacks) => {
      callbacks.onError('Hub connection lost');
    });

    await handleApiRequest(
      createMsg(),
      target as any,
      'agent-1',
      'anthropic',
      proxySettings,
      async () => mockStorageProvider,
      undefined,
      hubStream,
    );

    const errorMessages = target.postMessage.mock.calls.filter(
      (call: any) => call[0].type === 'api_response_error'
    );
    expect(errorMessages.length).toBe(1);
    expect(errorMessages[0][0].error).toContain('Hub connection lost');
  });

  it('passes correct provider path for OpenAI', async () => {
    const hubStream: HubStreamFn = vi.fn((provider, path, payload, callbacks) => {
      callbacks.onEnd();
    });

    await handleApiRequest(
      createMsg(),
      target as any,
      'agent-1',
      'openai',
      proxySettings,
      async () => mockStorageProvider,
      undefined,
      hubStream,
    );

    expect(hubStream).toHaveBeenCalledWith(
      'openai',
      '/api/openai/v1/chat/completions',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('strips type field from context messages in Anthropic payload', async () => {
    // Simulate context.json containing an intervention message
    const { buildContextMessages } = await import('@flo-monster/core');
    (buildContextMessages as any).mockReturnValue([
      { role: 'user', content: [{ type: 'text', text: 'initial msg' }], turnId: 'turn-0' },
      { role: 'user', type: 'intervention', content: [{ type: 'text', text: 'user intervened' }], turnId: 'turn-1' },
      { role: 'assistant', content: [{ type: 'text', text: 'noted' }], turnId: 'turn-1' },
    ]);

    let capturedPayload: any;
    const hubStream: HubStreamFn = vi.fn((provider, path, payload, callbacks) => {
      capturedPayload = payload;
      callbacks.onEnd();
    });

    await handleApiRequest(
      createMsg({ model: 'test', messages: [{ role: 'user', content: 'follow up' }] }),
      target as any,
      'agent-1',
      'anthropic',
      proxySettings,
      async () => mockStorageProvider,
      undefined,
      hubStream,
    );

    // Verify: no message in the payload has type, turnId, or messageType
    for (const msg of capturedPayload.messages) {
      expect(msg).not.toHaveProperty('type');
      expect(msg).not.toHaveProperty('turnId');
      expect(msg).not.toHaveProperty('messageType');
    }
    // Verify the intervention message content is still there
    const interventionMsg = capturedPayload.messages.find(
      (m: any) => Array.isArray(m.content) && m.content[0]?.text === 'user intervened'
    );
    expect(interventionMsg).toBeDefined();
    expect(interventionMsg.role).toBe('user');
  });

  it('strips type field from context messages in OpenAI payload', async () => {
    const { buildContextMessages } = await import('@flo-monster/core');
    (buildContextMessages as any).mockReturnValue([
      { role: 'user', type: 'intervention', content: [{ type: 'text', text: 'intervened' }], turnId: 'turn-1' },
    ]);

    let capturedPayload: any;
    const hubStream: HubStreamFn = vi.fn((provider, path, payload, callbacks) => {
      capturedPayload = payload;
      callbacks.onEnd();
    });

    await handleApiRequest(
      createMsg({ model: 'test', messages: [{ role: 'user', content: 'follow up' }] }),
      target as any,
      'agent-1',
      'openai',
      proxySettings,
      async () => mockStorageProvider,
      undefined,
      hubStream,
    );

    for (const msg of capturedPayload.messages) {
      expect(msg).not.toHaveProperty('type');
      expect(msg).not.toHaveProperty('turnId');
    }
  });

  it('preserves OpenAI tool_calls and tool_call_id through allowlist', async () => {
    const { buildContextMessages } = await import('@flo-monster/core');
    (buildContextMessages as any).mockReturnValue([]);

    let capturedPayload: any;
    const hubStream: HubStreamFn = vi.fn((provider, path, payload, callbacks) => {
      capturedPayload = payload;
      callbacks.onEnd();
    });

    // Simulate OpenAI turn messages with tool_calls
    await handleApiRequest(
      createMsg({
        model: 'test',
        messages: [
          { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'dom', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'tc1', content: 'result' },
          { role: 'user', content: 'thanks' },
        ],
      }),
      target as any,
      'agent-1',
      'openai',
      proxySettings,
      async () => mockStorageProvider,
      undefined,
      hubStream,
    );

    const assistantMsg = capturedPayload.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg.tool_calls).toBeDefined();
    const toolMsg = capturedPayload.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('tc1');
  });

  it('strips _firstUserMessageType from payload before sending to API', async () => {
    const { buildContextMessages } = await import('@flo-monster/core');
    (buildContextMessages as any).mockReturnValue([]);

    let capturedPayload: any;
    const hubStream: HubStreamFn = vi.fn((provider, path, payload, callbacks) => {
      capturedPayload = payload;
      callbacks.onEnd();
    });

    await handleApiRequest(
      createMsg({
        model: 'test',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'intervened' }] }],
        _firstUserMessageType: 'intervention',
      }),
      target as any,
      'agent-1',
      'anthropic',
      proxySettings,
      async () => mockStorageProvider,
      undefined,
      hubStream,
    );

    // _firstUserMessageType must not reach the API
    expect(capturedPayload).not.toHaveProperty('_firstUserMessageType');
    // Messages in the payload must not have type
    for (const msg of capturedPayload.messages) {
      expect(msg).not.toHaveProperty('type');
    }
  });

  it('strips type from Gemini native context messages', async () => {
    const { buildContextMessages } = await import('@flo-monster/core');
    (buildContextMessages as any).mockReturnValue([
      { role: 'user', type: 'intervention', content: [{ type: 'text', text: 'intervened' }], turnId: 'turn-1' },
    ]);

    let capturedPayload: any;
    const hubStream: HubStreamFn = vi.fn((provider, path, payload, callbacks) => {
      capturedPayload = payload;
      callbacks.onEnd();
    });

    // Gemini native uses contents instead of messages
    await handleApiRequest(
      createMsg({
        model: 'test',
        contents: [{ role: 'user', parts: [{ text: 'follow up' }] }],
      }),
      target as any,
      'agent-1',
      'gemini',
      proxySettings,
      async () => mockStorageProvider,
      undefined,
      hubStream,
    );

    // Verify Gemini contents have no internal metadata
    for (const item of capturedPayload.contents) {
      expect(item).not.toHaveProperty('type');
      expect(item).not.toHaveProperty('turnId');
      expect(item).not.toHaveProperty('messageType');
      // Only role and parts allowed
      for (const key of Object.keys(item)) {
        expect(['role', 'parts']).toContain(key);
      }
    }
  });

  it('converts tool_use/tool_result to functionCall/functionResponse in Gemini context', async () => {
    const { buildContextMessages } = await import('@flo-monster/core');
    (buildContextMessages as any).mockReturnValue([
      { role: 'user', content: [{ type: 'text', text: 'browse example.com' }], turnId: 'turn-0' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tc1', name: 'browse', input: { action: 'load', url: 'https://example.com' } }],
        turnId: 'turn-0',
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'Page loaded: Example Domain' }],
        turnId: 'turn-0',
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], turnId: 'turn-0' },
    ]);

    let capturedPayload: any;
    const hubStream: HubStreamFn = vi.fn((provider, path, payload, callbacks) => {
      capturedPayload = payload;
      callbacks.onEnd();
    });

    await handleApiRequest(
      createMsg({
        model: 'test',
        contents: [{ role: 'user', parts: [{ text: 'follow up' }] }],
      }),
      target as any,
      'agent-1',
      'gemini',
      proxySettings,
      async () => mockStorageProvider,
      undefined,
      hubStream,
    );

    const contents = capturedPayload.contents;

    // Should have 5 entries: user text, model functionCall, user functionResponse, model text, user follow-up
    expect(contents.length).toBeGreaterThanOrEqual(4);

    // Find the model message with functionCall
    const modelWithFc = contents.find(
      (c: any) => c.role === 'model' && c.parts.some((p: any) => p.functionCall),
    );
    expect(modelWithFc).toBeDefined();
    expect(modelWithFc.parts[0].functionCall).toEqual({
      name: 'browse',
      args: { action: 'load', url: 'https://example.com' },
    });

    // Find the user message with functionResponse
    const userWithFr = contents.find(
      (c: any) => c.role === 'user' && c.parts.some((p: any) => p.functionResponse),
    );
    expect(userWithFr).toBeDefined();
    expect(userWithFr.parts[0].functionResponse.name).toBe('browse');
    expect(userWithFr.parts[0].functionResponse.response).toEqual({
      result: 'Page loaded: Example Domain',
    });
  });

  it('streams chunks to iframe in order', async () => {
    const hubStream: HubStreamFn = vi.fn((provider, path, payload, callbacks) => {
      callbacks.onChunk('chunk-1');
      callbacks.onChunk('chunk-2');
      callbacks.onChunk('chunk-3');
      callbacks.onEnd();
    });

    await handleApiRequest(
      createMsg(),
      target as any,
      'agent-1',
      'anthropic',
      proxySettings,
      async () => mockStorageProvider,
      undefined,
      hubStream,
    );

    const chunks = target.postMessage.mock.calls
      .filter((call: any) => call[0].type === 'api_response_chunk')
      .map((call: any) => call[0].chunk);

    expect(chunks).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
  });
});

describe('normalizeOpenAIMessages', () => {
  it('converts user message with string content to content blocks', () => {
    const result = normalizeOpenAIMessages([
      { role: 'user', content: 'hello' },
    ]);
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('passes through user message with array content', () => {
    const blocks = [{ type: 'text', text: 'hello' }];
    const result = normalizeOpenAIMessages([
      { role: 'user', content: blocks },
    ]);
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('converts assistant tool_calls to tool_use blocks', () => {
    const result = normalizeOpenAIMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'tc1',
          type: 'function',
          function: { name: 'dom', arguments: '{"action":"read"}' },
        }],
      },
    ]);
    expect(result).toEqual([
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tc1',
          name: 'dom',
          input: { action: 'read' },
        }],
      },
    ]);
  });

  it('merges assistant text + tool_calls into one content array', () => {
    const result = normalizeOpenAIMessages([
      {
        role: 'assistant',
        content: 'thinking...',
        tool_calls: [{
          id: 'tc1',
          type: 'function',
          function: { name: 'dom', arguments: '{}' },
        }],
      },
    ]);
    expect(result[0].content).toEqual([
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', id: 'tc1', name: 'dom', input: {} },
    ]);
  });

  it('converts tool result messages into tool_result blocks on user message', () => {
    const result = normalizeOpenAIMessages([
      { role: 'tool', tool_call_id: 'tc1', content: 'result text' },
    ]);
    expect(result).toEqual([
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tc1',
          content: 'result text',
        }],
      },
    ]);
  });

  it('merges consecutive tool results into same user message', () => {
    const result = normalizeOpenAIMessages([
      { role: 'tool', tool_call_id: 'tc1', content: 'result1' },
      { role: 'tool', tool_call_id: 'tc2', content: 'result2' },
    ]);
    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc1', content: 'result1' },
          { type: 'tool_result', tool_use_id: 'tc2', content: 'result2' },
        ],
      },
    ]);
  });

  it('converts a full OpenAI turn (assistant+tool_calls, tool results, user follow-up)', () => {
    const result = normalizeOpenAIMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'dom', arguments: '{"action":"read"}' } }],
      },
      { role: 'tool', tool_call_id: 'tc1', content: '<html>...</html>' },
      { role: 'user', content: 'thanks' },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tc1', name: 'dom', input: { action: 'read' } }],
    });
    expect(result[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc1', content: '<html>...</html>' }],
    });
    expect(result[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'thanks' }],
    });
  });

  it('skips system messages', () => {
    const result = normalizeOpenAIMessages([
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'hello' },
    ]);
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('handles invalid tool_calls arguments gracefully', () => {
    const result = normalizeOpenAIMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'tc1',
          type: 'function',
          function: { name: 'dom', arguments: 'not-json' },
        }],
      },
    ]);
    // Should fall back to empty input object
    expect((result[0].content as any[])[0].input).toEqual({});
  });
});

describe('canonicalToOpenAIMessages', () => {
  it('converts assistant tool_use blocks to tool_calls array', () => {
    const result = canonicalToOpenAIMessages([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc1', name: 'dom', input: { action: 'read' } },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'tc1',
          type: 'function',
          function: { name: 'dom', arguments: '{"action":"read"}' },
        }],
      },
    ]);
  });

  it('converts assistant text + tool_use to content string + tool_calls', () => {
    const result = canonicalToOpenAIMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tc1', name: 'capabilities', input: {} },
        ],
      },
    ]);
    expect(result[0].content).toBe('Let me check.');
    expect(result[0].tool_calls).toEqual([{
      id: 'tc1',
      type: 'function',
      function: { name: 'capabilities', arguments: '{}' },
    }]);
  });

  it('converts user tool_result blocks to separate role:tool messages', () => {
    const result = canonicalToOpenAIMessages([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc1', content: 'result1' },
          { type: 'tool_result', tool_use_id: 'tc2', content: 'result2' },
        ],
      },
    ]);
    expect(result).toEqual([
      { role: 'tool', tool_call_id: 'tc1', content: 'result1' },
      { role: 'tool', tool_call_id: 'tc2', content: 'result2' },
    ]);
  });

  it('passes through user messages with text content blocks', () => {
    const result = canonicalToOpenAIMessages([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('passes through user messages with string content', () => {
    const result = canonicalToOpenAIMessages([
      { role: 'user', content: 'hello' },
    ]);
    expect(result).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  it('passes through assistant messages with text-only content', () => {
    const result = canonicalToOpenAIMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'Sure!' }] },
    ]);
    expect(result).toEqual([
      { role: 'assistant', content: 'Sure!' },
    ]);
  });

  it('passes through system messages unchanged', () => {
    const result = canonicalToOpenAIMessages([
      { role: 'system', content: 'You are helpful.' },
    ]);
    expect(result).toEqual([
      { role: 'system', content: 'You are helpful.' },
    ]);
  });

  it('round-trips: normalize → canonical → back matches OpenAI wire format', () => {
    const openaiWire = [
      { role: 'user', content: 'browse mob-labs.com' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'capabilities', arguments: '{}' } },
          { id: 'tc2', type: 'function', function: { name: 'browse', arguments: '{"action":"load","url":"https://mob-labs.com"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tc1', content: '{"platform":"Chrome"}' },
      { role: 'tool', tool_call_id: 'tc2', content: 'page loaded' },
      { role: 'assistant', content: 'Here is the page.' },
    ];

    const canonical = normalizeOpenAIMessages(openaiWire);
    const backToWire = canonicalToOpenAIMessages(canonical);

    // Assistant with tool_calls
    expect(backToWire[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'tc1', type: 'function', function: { name: 'capabilities', arguments: '{}' } },
        { id: 'tc2', type: 'function', function: { name: 'browse', arguments: '{"action":"load","url":"https://mob-labs.com"}' } },
      ],
    });

    // Tool results as separate role:'tool' messages
    expect(backToWire[2]).toEqual({ role: 'tool', tool_call_id: 'tc1', content: '{"platform":"Chrome"}' });
    expect(backToWire[3]).toEqual({ role: 'tool', tool_call_id: 'tc2', content: 'page loaded' });

    // Text-only assistant
    expect(backToWire[4]).toEqual({ role: 'assistant', content: 'Here is the page.' });
  });
});

describe('OpenAI context messages in API payload', () => {
  let target: { postMessage: Mock };
  let mockStorageProvider: any;

  beforeEach(() => {
    target = { postMessage: vi.fn() };
    mockStorageProvider = {
      readFile: vi.fn(async () => '[]'),
      writeFile: vi.fn(async () => {}),
    };
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const proxySettings = { useBuiltinProxy: true };

  it('converts canonical context messages to OpenAI wire format', async () => {
    const { buildContextMessages } = await import('@flo-monster/core');
    (buildContextMessages as any).mockReturnValue([
      { role: 'user', content: [{ type: 'text', text: 'hello' }], turnId: 'turn-0' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tc1', name: 'dom', input: { action: 'read' } }],
        turnId: 'turn-0',
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc1', content: '<html>page</html>' }],
        turnId: 'turn-0',
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], turnId: 'turn-0' },
    ]);

    let capturedPayload: any;
    const hubStream: HubStreamFn = vi.fn((provider, path, payload, callbacks) => {
      capturedPayload = payload;
      callbacks.onEnd();
    });

    await handleApiRequest(
      {
        type: 'api_request',
        id: 'req-1',
        agentId: 'agent-1',
        payload: { model: 'gpt-5.2', messages: [{ role: 'user', content: 'follow up' }] },
      },
      target as any,
      'agent-1',
      'openai',
      proxySettings,
      async () => mockStorageProvider,
      undefined,
      hubStream,
    );

    // Assistant context message should have tool_calls, not tool_use content blocks
    const assistantMsg = capturedPayload.messages.find(
      (m: any) => m.role === 'assistant' && m.tool_calls,
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBeNull();
    expect(assistantMsg.tool_calls[0]).toEqual({
      id: 'tc1',
      type: 'function',
      function: { name: 'dom', arguments: '{"action":"read"}' },
    });

    // Tool result should be role:'tool', not role:'user' with tool_result block
    const toolMsg = capturedPayload.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('tc1');
    expect(toolMsg.content).toBe('<html>page</html>');

    // No message should have tool_use or tool_result in content
    for (const msg of capturedPayload.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          expect(block.type).not.toBe('tool_use');
          expect(block.type).not.toBe('tool_result');
        }
      }
    }
  });
});
