/**
 * Tests for API proxy handler (Mode 3: browser routes API through hub WS)
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

vi.mock('../cli-proxy.js', () => ({
  streamCliEvents: vi.fn(),
}));

import { handleMessage } from '../handlers/message-handler.js';
import { getDefaultConfig, type HubConfig } from '../config.js';
import type { ConnectedClient } from '../server.js';
import type { HeadlessAgentRunner } from '../agent-runner.js';
import { streamCliEvents } from '../cli-proxy.js';

const originalFetch = globalThis.fetch;

describe('API Proxy Handler', () => {
  let config: HubConfig;
  let mockClient: ConnectedClient;
  let sentMessages: any[];
  let mockFetch: Mock;
  let agents: Map<string, HeadlessAgentRunner>;
  let clients: Set<ConnectedClient>;

  beforeEach(() => {
    config = {
      ...getDefaultConfig(),
      authToken: 'test-token',
      sharedApiKeys: {
        anthropic: 'sk-ant-test-key',
        openai: 'sk-openai-test-key',
      },
    };

    sentMessages = [];
    mockClient = {
      ws: {
        send: (data: string) => sentMessages.push(JSON.parse(data)),
        readyState: 1, // OPEN
      } as any,
      authenticated: true,
      remoteAddress: '127.0.0.1',
      subscribedAgents: new Set<string>(),
      messageCount: 0,
      messageWindowStart: Date.now(),
    };

    agents = new Map();
    clients = new Set([mockClient]);

    // Mock fetch for upstream API calls
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Helper to create a streaming response
  function createStreamingResponse(chunks: string[], status = 200, statusText = 'OK') {
    let chunkIndex = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (chunkIndex < chunks.length) {
          controller.enqueue(new TextEncoder().encode(chunks[chunkIndex]));
          chunkIndex++;
        } else {
          controller.close();
        }
      },
    });
    return new Response(stream, { status, statusText });
  }

  it('streams Anthropic API response back as chunks', async () => {
    const chunks = ['event: content_block_start\ndata: {"content_block":{"type":"text","text":""}}\n\n',
                    'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hello"}}\n\n'];
    mockFetch.mockResolvedValue(createStreamingResponse(chunks));

    await handleMessage(mockClient, {
      type: 'api_proxy_request',
      id: 'req-1',
      provider: 'anthropic',
      path: '/api/anthropic/v1/messages',
      payload: { model: 'claude-sonnet-4-5-20250929', messages: [] },
    }, config, agents, clients);

    // Should have stream chunks + end message
    const chunkMessages = sentMessages.filter(m => m.type === 'api_stream_chunk');
    const endMessages = sentMessages.filter(m => m.type === 'api_stream_end');
    expect(chunkMessages.length).toBe(2);
    expect(endMessages.length).toBe(1);
    expect(endMessages[0].id).toBe('req-1');

    // Verify fetch was called with correct upstream URL and headers
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'sk-ant-test-key',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
  });

  it('streams OpenAI API response with Bearer auth', async () => {
    mockFetch.mockResolvedValue(createStreamingResponse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n']));

    await handleMessage(mockClient, {
      type: 'api_proxy_request',
      id: 'req-2',
      provider: 'openai',
      path: '/api/openai/v1/chat/completions',
      payload: { model: 'gpt-4', messages: [] },
    }, config, agents, clients);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer sk-openai-test-key',
        }),
      }),
    );

    const endMessages = sentMessages.filter(m => m.type === 'api_stream_end');
    expect(endMessages.length).toBe(1);
  });

  it('sends api_error for unknown provider path', async () => {
    await handleMessage(mockClient, {
      type: 'api_proxy_request',
      id: 'req-3',
      provider: 'anthropic',
      path: '/api/unknown/v1/messages',
      payload: {},
    }, config, agents, clients);

    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'api_error',
      id: 'req-3',
      error: 'Unknown provider path',
    }));
  });

  it('sends api_error when no shared key configured', async () => {
    // Remove the key for anthropic
    delete config.sharedApiKeys!.anthropic;

    await handleMessage(mockClient, {
      type: 'api_proxy_request',
      id: 'req-4',
      provider: 'anthropic',
      path: '/api/anthropic/v1/messages',
      payload: {},
    }, config, agents, clients);

    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'api_error',
      id: 'req-4',
      error: expect.stringContaining('No shared API key configured'),
    }));
  });

  it('streams CLI proxy response over WebSocket', async () => {
    config.cliProviders = { anthropic: { command: 'claude-cli' } as any };

    // Mock streamCliEvents to yield SSE chunks
    const mockStreamCliEvents = vi.mocked(streamCliEvents);
    mockStreamCliEvents.mockReturnValue((async function*() {
      yield 'event: message_start\ndata: {"type":"message_start"}\n\n';
      yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    })());

    await handleMessage(mockClient, {
      type: 'api_proxy_request',
      id: 'req-5',
      provider: 'anthropic',
      path: '/api/anthropic/v1/messages',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    }, config, agents, clients);

    const chunkMessages = sentMessages.filter(m => m.type === 'api_stream_chunk');
    const endMessages = sentMessages.filter(m => m.type === 'api_stream_end');
    expect(chunkMessages.length).toBe(2);
    expect(chunkMessages[0].chunk).toContain('message_start');
    expect(chunkMessages[1].chunk).toContain('message_stop');
    expect(endMessages.length).toBe(1);
    expect(endMessages[0].id).toBe('req-5');
  });

  it('sends api_error when CLI proxy fails over WebSocket', async () => {
    config.cliProviders = { anthropic: { command: 'claude-cli' } as any };

    const mockStreamCliEvents = vi.mocked(streamCliEvents);
    mockStreamCliEvents.mockReturnValue((async function*() {
      throw new Error('CLI proxy timeout');
    })());

    await handleMessage(mockClient, {
      type: 'api_proxy_request',
      id: 'req-cli-err',
      provider: 'anthropic',
      path: '/api/anthropic/v1/messages',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    }, config, agents, clients);

    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'api_error',
      id: 'req-cli-err',
      error: expect.stringContaining('CLI proxy timeout'),
    }));
  });

  it('sends api_error on upstream HTTP error', async () => {
    mockFetch.mockResolvedValue(new Response('Bad Request', { status: 400, statusText: 'Bad Request' }));

    await handleMessage(mockClient, {
      type: 'api_proxy_request',
      id: 'req-6',
      provider: 'anthropic',
      path: '/api/anthropic/v1/messages',
      payload: { model: 'claude-sonnet-4-5-20250929', messages: [] },
    }, config, agents, clients);

    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'api_error',
      id: 'req-6',
      error: '400 Bad Request',
    }));
  });

  it('sends api_error on fetch network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'));

    await handleMessage(mockClient, {
      type: 'api_proxy_request',
      id: 'req-7',
      provider: 'anthropic',
      path: '/api/anthropic/v1/messages',
      payload: {},
    }, config, agents, clients);

    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'api_error',
      id: 'req-7',
      error: expect.stringContaining('Network failure'),
    }));
  });

  it('blocks unauthenticated clients', async () => {
    mockClient.authenticated = false;

    await handleMessage(mockClient, {
      type: 'api_proxy_request',
      id: 'req-8',
      provider: 'anthropic',
      path: '/api/anthropic/v1/messages',
      payload: {},
    }, config, agents, clients);

    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'error',
      message: 'Not authenticated',
    }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows Ollama without API key', async () => {
    // No ollama key configured
    mockFetch.mockResolvedValue(createStreamingResponse(['data: done\n\n']));

    // Need to set an Ollama endpoint so getProviderRoute returns non-null
    config.providers = { ollama: { endpoint: 'http://localhost:11434' } as any };

    await handleMessage(mockClient, {
      type: 'api_proxy_request',
      id: 'req-9',
      provider: 'ollama',
      path: '/api/ollama/v1/chat/completions',
      payload: {},
    }, config, agents, clients);

    // Should NOT get an api_error about missing key
    const errors = sentMessages.filter(m => m.type === 'api_error');
    expect(errors.length).toBe(0);

    // Fetch should be called with the Ollama endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('localhost:11434'),
      expect.objectContaining({
        method: 'POST',
      }),
    );

    // Verify no Authorization header was set
    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('falls back to providers config for API key', async () => {
    // Clear shared key but set in providers config
    delete config.sharedApiKeys!.anthropic;
    config.providers = { anthropic: { endpoint: 'https://api.anthropic.com', apiKey: 'sk-from-providers' } as any };

    mockFetch.mockResolvedValue(createStreamingResponse(['chunk1']));

    await handleMessage(mockClient, {
      type: 'api_proxy_request',
      id: 'req-10',
      provider: 'anthropic',
      path: '/api/anthropic/v1/messages',
      payload: {},
    }, config, agents, clients);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'sk-from-providers',
        }),
      }),
    );
  });
});
