import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createProxyServer, parseRoute } from '../server.js';

describe('CORS Proxy', () => {
  let proxy: ReturnType<typeof createProxyServer>;
  let mockUpstream: ReturnType<typeof createHttpServer>;
  let mockPort: number;
  let proxyPort: number;
  let lastMockRequest: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  } | null;

  beforeAll(async () => {
    lastMockRequest = null;

    // Start mock upstream server that simulates Anthropic and OpenAI-compatible APIs
    mockUpstream = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastMockRequest = {
          method: req.method || '',
          url: req.url || '',
          headers: req.headers as Record<string, string>,
          body: Buffer.concat(chunks).toString(),
        };

        if (req.url === '/v1/messages') {
          // Simulate Anthropic SSE streaming response
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
          res.write(
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hello"}}\n\n',
          );
          res.end();
        } else if (req.url === '/v1/chat/completions') {
          // Simulate OpenAI SSE streaming response
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else if (req.url === '/v1beta/openai/chat/completions') {
          // Simulate Gemini OpenAI-compatible response
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"Hey"},"finish_reason":null}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockUpstream.listen(0, () => {
        const addr = mockUpstream.address();
        mockPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    // Start proxy pointing to mock upstream for all providers (use http for testing)
    proxyPort = mockPort + 1;
    const mockUrl = `http://localhost:${mockPort}`;
    proxy = createProxyServer(proxyPort, mockUrl, {
      openai: mockUrl,
      gemini: mockUrl,
    });
    await proxy.start();
  });

  afterEach(() => {
    lastMockRequest = null;
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
  });

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('x-api-key');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
  });

  it('POST /anthropic/v1/messages forwards to upstream (Anthropic, explicit prefix)', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [],
      max_tokens: 100,
    });
    const res = await fetch(`http://localhost:${proxyPort}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test-key-123',
        'anthropic-version': '2023-06-01',
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(lastMockRequest).not.toBeNull();
    expect(lastMockRequest!.url).toBe('/v1/messages');
    expect(lastMockRequest!.headers['x-api-key']).toBe('test-key-123');
    expect(lastMockRequest!.headers['anthropic-version']).toBe('2023-06-01');
    expect(lastMockRequest!.body).toBe(body);
  });

  it('POST /v1/messages forwards to upstream (Anthropic, backwards compat)', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [],
      max_tokens: 100,
    });
    const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test-key-123',
        'anthropic-version': '2023-06-01',
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(lastMockRequest).not.toBeNull();
    expect(lastMockRequest!.url).toBe('/v1/messages');
    expect(lastMockRequest!.headers['x-api-key']).toBe('test-key-123');
    expect(lastMockRequest!.headers['anthropic-version']).toBe('2023-06-01');
    expect(lastMockRequest!.body).toBe(body);
  });

  it('POST /openai/v1/chat/completions forwards to upstream (OpenAI)', async () => {
    const body = JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const res = await fetch(`http://localhost:${proxyPort}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-openai-test',
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(lastMockRequest).not.toBeNull();
    expect(lastMockRequest!.url).toBe('/v1/chat/completions');
    expect(lastMockRequest!.headers['authorization']).toBe('Bearer sk-openai-test');
    // Anthropic-specific headers should NOT be forwarded for OpenAI
    expect(lastMockRequest!.headers['x-api-key']).toBeUndefined();
    const text = await res.text();
    expect(text).toContain('Hi');
  });

  it('POST /gemini/v1beta/openai/chat/completions forwards to upstream (Gemini)', async () => {
    const body = JSON.stringify({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const res = await fetch(`http://localhost:${proxyPort}/gemini/v1beta/openai/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': 'gemini-key-test',
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(lastMockRequest).not.toBeNull();
    expect(lastMockRequest!.url).toBe('/v1beta/openai/chat/completions');
    expect(lastMockRequest!.headers['x-goog-api-key']).toBe('gemini-key-test');
    const text = await res.text();
    expect(text).toContain('Hey');
  });

  it('response includes CORS headers', async () => {
    const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('streaming response body is piped through', async () => {
    const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const text = await res.text();
    expect(text).toContain('message_start');
    expect(text).toContain('Hello');
  });

  it('unknown paths return 404', async () => {
    const res = await fetch(`http://localhost:${proxyPort}/unknown`);
    expect(res.status).toBe(404);
  });

  it('GET returns 405 for /v1/messages', async () => {
    const res = await fetch(`http://localhost:${proxyPort}/v1/messages`);
    expect(res.status).toBe(405);
  });

  it('GET returns 405 for /anthropic/v1/messages', async () => {
    const res = await fetch(`http://localhost:${proxyPort}/anthropic/v1/messages`);
    expect(res.status).toBe(405);
  });

  it('GET returns 405 for OpenAI path', async () => {
    const res = await fetch(`http://localhost:${proxyPort}/openai/v1/chat/completions`);
    expect(res.status).toBe(405);
  });
});

describe('parseRoute', () => {
  it('should parse Anthropic route with explicit prefix', () => {
    const route = parseRoute('/anthropic/v1/messages');
    expect(route).toEqual({ provider: 'anthropic', upstreamPath: '/v1/messages' });
  });

  it('should parse Anthropic route without prefix (backwards compat)', () => {
    const route = parseRoute('/v1/messages');
    expect(route).toEqual({ provider: 'anthropic', upstreamPath: '/v1/messages' });
  });

  it('should parse OpenAI route', () => {
    const route = parseRoute('/openai/v1/chat/completions');
    expect(route).toEqual({ provider: 'openai', upstreamPath: '/v1/chat/completions' });
  });

  it('should parse Gemini route', () => {
    const route = parseRoute('/gemini/v1beta/openai/chat/completions');
    expect(route).toEqual({ provider: 'gemini', upstreamPath: '/v1beta/openai/chat/completions' });
  });

  it('should return null for unknown routes', () => {
    expect(parseRoute('/unknown')).toBeNull();
    expect(parseRoute('/')).toBeNull();
    expect(parseRoute('/v1')).toBeNull();
    expect(parseRoute('/v1/unknown')).toBeNull();
  });
});
