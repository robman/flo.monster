/**
 * Tests for API handler — WS transport branch (Mode 3)
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { handleApiRequest, type HubStreamFn } from './api-handler.js';
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
