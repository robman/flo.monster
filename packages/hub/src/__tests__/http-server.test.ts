/**
 * Tests for HTTP server API endpoints
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createServer, type Server, type IncomingMessage, request as httpRequest } from 'node:http';
import { createHttpRequestHandler, getProviderRoute, type HttpHandlerContext } from '../http-server.js';
import { FailedAuthRateLimiter } from '../rate-limiter.js';
import { getDefaultConfig, type HubConfig } from '../config.js';

// Store original fetch
const originalFetch = globalThis.fetch;

describe('HTTP Server', () => {
  let server: Server;
  let config: HubConfig;
  let rateLimiter: FailedAuthRateLimiter;
  let context: HttpHandlerContext;
  let serverPort: number;
  let mockFetch: Mock;

  // Helper to make HTTP requests to test server
  function makeRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: serverPort,
          path,
          method,
          headers: {
            ...headers,
            ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === 'string') {
                responseHeaders[key] = value;
              } else if (Array.isArray(value)) {
                responseHeaders[key] = value[0];
              }
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: responseHeaders,
              body: data,
            });
          });
        },
      );

      req.on('error', reject);

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  beforeEach(async () => {
    config = {
      ...getDefaultConfig(),
      authToken: 'test-hub-token',
      sharedApiKeys: {
        anthropic: 'sk-ant-test-key-123',
        openai: 'sk-openai-test-key-456',
        gemini: 'gemini-test-key-789',
      },
    };

    rateLimiter = new FailedAuthRateLimiter(3, 5); // 3 attempts, 5 min lockout
    context = { config, rateLimiter };

    // Create mock for fetch used by http-server for proxying
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    const handler = createHttpRequestHandler(context);
    server = createServer(handler);

    // Listen on random available port
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          serverPort = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    // Restore original fetch
    globalThis.fetch = originalFetch;

    // Clean up rate limiter
    rateLimiter.destroy();

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  describe('CORS preflight (OPTIONS)', () => {
    it('should return CORS headers for OPTIONS /api/*', async () => {
      const response = await makeRequest('OPTIONS', '/api/status');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-methods']).toBe('POST, OPTIONS');
      expect(response.headers['access-control-allow-headers']).toContain('x-hub-token');
      expect(response.headers['access-control-allow-private-network']).toBe('true');
      expect(response.headers['access-control-max-age']).toBe('86400');
    });

    it('should return CORS headers for OPTIONS /api/v1/messages', async () => {
      const response = await makeRequest('OPTIONS', '/api/v1/messages');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('GET /api/status', () => {
    it('should return { ok: true }', async () => {
      const response = await makeRequest('GET', '/api/status');

      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data).toEqual({ ok: true });
    });

    it('should include CORS headers', async () => {
      const response = await makeRequest('GET', '/api/status');

      expect(response.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('POST /api/v1/messages', () => {
    it('should return 401 without x-hub-token', async () => {
      const response = await makeRequest(
        'POST',
        '/api/v1/messages',
        { 'Content-Type': 'application/json' },
        JSON.stringify({ model: 'claude-3-opus-20240229', messages: [] }),
      );

      expect(response.status).toBe(401);
      const data = JSON.parse(response.body);
      expect(data.error).toContain('Invalid or missing hub token');
    });

    it('should return 401 with invalid token and record failure', async () => {
      const response = await makeRequest(
        'POST',
        '/api/v1/messages',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'wrong-token',
        },
        JSON.stringify({ model: 'claude-3-opus-20240229', messages: [] }),
      );

      expect(response.status).toBe(401);

      // The failure should have been recorded
      // After 3 failures, IP should be locked
      await makeRequest('POST', '/api/v1/messages', { 'x-hub-token': 'wrong-token' }, '{}');
      await makeRequest('POST', '/api/v1/messages', { 'x-hub-token': 'wrong-token' }, '{}');

      // 4th attempt should be rate limited
      const lockedResponse = await makeRequest(
        'POST',
        '/api/v1/messages',
        { 'x-hub-token': 'wrong-token' },
        '{}',
      );

      expect(lockedResponse.status).toBe(429);
    });

    it('should return 429 with Retry-After header when IP is locked', async () => {
      // Trigger lockout
      for (let i = 0; i < 3; i++) {
        await makeRequest('POST', '/api/v1/messages', { 'x-hub-token': 'wrong-token' }, '{}');
      }

      const response = await makeRequest(
        'POST',
        '/api/v1/messages',
        { 'x-hub-token': 'test-hub-token' },
        '{}',
      );

      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toBeDefined();
      expect(parseInt(response.headers['retry-after'], 10)).toBeGreaterThan(0);
    });

    it('should return 503 for provider without shared key', async () => {
      const response = await makeRequest(
        'POST',
        '/api/v1/messages',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
          'x-api-provider': 'unknown-provider',
        },
        JSON.stringify({ model: 'some-model', messages: [] }),
      );

      expect(response.status).toBe(503);
      const data = JSON.parse(response.body);
      expect(data.error).toContain('No shared API key configured');
      expect(data.error).toContain('unknown-provider');
    });

    it('should proxy to Anthropic API with valid token (legacy path)', async () => {
      // Mock successful Anthropic response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null, // Use text() fallback path
        text: async () =>
          JSON.stringify({
            id: 'msg_123',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello!' }],
          }),
      });

      const response = await makeRequest(
        'POST',
        '/api/v1/messages',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        JSON.stringify({
          model: 'claude-3-opus-20240229',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      );

      expect(response.status).toBe(200);

      // Verify fetch was called with correct parameters
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(options.method).toBe('POST');
      expect(options.headers['x-api-key']).toBe('sk-ant-test-key-123');
      expect(options.headers['anthropic-version']).toBe('2023-06-01');
    });

    it('should proxy to Anthropic API via /api/anthropic/ prefix', async () => {
      // Mock successful Anthropic response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: async () =>
          JSON.stringify({
            id: 'msg_456',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi!' }],
          }),
      });

      const response = await makeRequest(
        'POST',
        '/api/anthropic/v1/messages',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        JSON.stringify({
          model: 'claude-3-opus-20240229',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      );

      expect(response.status).toBe(200);

      // Verify fetch was called with correct parameters
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(options.method).toBe('POST');
      expect(options.headers['x-api-key']).toBe('sk-ant-test-key-123');
      expect(options.headers['anthropic-version']).toBe('2023-06-01');
    });

    it('should NOT forward sensitive headers to Anthropic API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: async () => '{"ok":true}',
      });

      await makeRequest(
        'POST',
        '/api/v1/messages',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
          'x-api-provider': 'anthropic',
          'x-custom-header': 'should-not-be-forwarded',
          'authorization': 'Bearer malicious-token',
          'cookie': 'session=abc123',
        },
        JSON.stringify({ model: 'claude-3-opus-20240229', messages: [] }),
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockFetch.mock.calls[0];

      // Verify sensitive headers are NOT forwarded
      expect(options.headers['x-hub-token']).toBeUndefined();
      expect(options.headers['x-api-provider']).toBeUndefined();
      expect(options.headers['x-custom-header']).toBeUndefined();
      expect(options.headers['authorization']).toBeUndefined();
      expect(options.headers['cookie']).toBeUndefined();

      // Verify only expected headers are present
      expect(Object.keys(options.headers)).toEqual([
        'Content-Type',
        'x-api-key',
        'anthropic-version',
      ]);
    });

    it('should use default anthropic provider when x-api-provider not specified', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: async () => '{"ok":true}',
      });

      await makeRequest(
        'POST',
        '/api/v1/messages',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
          // No x-api-provider header
        },
        '{}',
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['x-api-key']).toBe('sk-ant-test-key-123');
    });

    it('should return 502 when Anthropic API request fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const response = await makeRequest(
        'POST',
        '/api/v1/messages',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        '{}',
      );

      expect(response.status).toBe(502);
      const data = JSON.parse(response.body);
      expect(data.error).toContain('Failed to proxy request');
    });

    it('should clear rate limit record on successful auth', async () => {
      // Record some failures first
      await makeRequest('POST', '/api/v1/messages', { 'x-hub-token': 'wrong-token' }, '{}');
      await makeRequest('POST', '/api/v1/messages', { 'x-hub-token': 'wrong-token' }, '{}');

      // Mock successful response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: async () => '{}',
      });

      // Successful auth should clear failures
      await makeRequest(
        'POST',
        '/api/v1/messages',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        '{}',
      );

      // Now we should be able to fail again without being immediately locked
      // (failures were cleared by successful auth)
      const response = await makeRequest(
        'POST',
        '/api/v1/messages',
        { 'x-hub-token': 'wrong-token' },
        '{}',
      );

      // Should be 401, not 429
      expect(response.status).toBe(401);
    });
  });

  describe('Unknown routes', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await makeRequest('GET', '/unknown');

      expect(response.status).toBe(404);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('Not found');
    });

    it('should return 404 for unknown API routes', async () => {
      const response = await makeRequest('GET', '/api/unknown');

      expect(response.status).toBe(404);
    });

    it('should include CORS headers on 404', async () => {
      const response = await makeRequest('GET', '/unknown');

      expect(response.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('Request body size limit', () => {
    it('should reject request body exceeding 10MB', async () => {
      // Create a body larger than 10MB (10 * 1024 * 1024 bytes)
      // We'll create a 11MB string
      const largeBody = 'x'.repeat(11 * 1024 * 1024);

      // When the server destroys the connection, we may get either:
      // 1. A 413 response if it's sent before connection closes
      // 2. An ECONNRESET error if connection is closed first
      try {
        const response = await makeRequest(
          'POST',
          '/api/v1/messages',
          {
            'Content-Type': 'application/json',
            'x-hub-token': 'test-hub-token',
          },
          largeBody,
        );

        // If we get a response, it should be 413
        expect(response.status).toBe(413);
        const data = JSON.parse(response.body);
        expect(data.error).toBe('Request body too large');
      } catch (err) {
        // ECONNRESET is expected when the server destroys the socket
        // This is valid behavior - the server is protecting itself from large payloads
        const error = err as NodeJS.ErrnoException;
        expect(error.code).toBe('ECONNRESET');
      }
    });

    it('should accept request body under 10MB', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: async () => '{"ok":true}',
      });

      // Create a body under 10MB (9MB)
      const body = 'x'.repeat(9 * 1024 * 1024);

      const response = await makeRequest(
        'POST',
        '/api/v1/messages',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        body,
      );

      expect(response.status).toBe(200);
    });
  });

  describe('X-Forwarded-For handling', () => {
    it('should not trust X-Forwarded-For by default', async () => {
      // Default config has trustProxy undefined/false
      // Make a request and verify the rate limiter uses socket IP, not forwarded IP
      await makeRequest(
        'POST',
        '/api/v1/messages',
        {
          'x-hub-token': 'wrong-token',
          'x-forwarded-for': '10.0.0.1',
        },
        '{}',
      );

      // The rate limit should be recorded against 127.0.0.1 (socket IP), not 10.0.0.1
      // To verify, we need to lock out the socket IP
      await makeRequest('POST', '/api/v1/messages', { 'x-hub-token': 'wrong-token' }, '{}');
      await makeRequest('POST', '/api/v1/messages', { 'x-hub-token': 'wrong-token' }, '{}');

      // Should be locked now (3 attempts)
      const response = await makeRequest(
        'POST',
        '/api/v1/messages',
        { 'x-hub-token': 'wrong-token' },
        '{}',
      );
      expect(response.status).toBe(429);
    });

    it('should trust X-Forwarded-For when trustProxy is enabled', async () => {
      // Create a new server with trustProxy enabled
      const proxyConfig = { ...config, trustProxy: true };
      const proxyRateLimiter = new FailedAuthRateLimiter(3, 5);
      const proxyContext = { config: proxyConfig, rateLimiter: proxyRateLimiter };
      const handler = createHttpRequestHandler(proxyContext);

      const tempServer = createServer(handler);
      let tempPort: number;

      await new Promise<void>((resolve) => {
        tempServer.listen(0, '127.0.0.1', () => {
          const addr = tempServer.address();
          if (addr && typeof addr === 'object') {
            tempPort = addr.port;
          }
          resolve();
        });
      });

      try {
        // Make requests with X-Forwarded-For header
        // First 3 requests from "10.0.0.1" should fail with 401
        for (let i = 0; i < 3; i++) {
          await new Promise<void>((resolve, reject) => {
            const req = httpRequest(
              {
                hostname: '127.0.0.1',
                port: tempPort,
                path: '/api/v1/messages',
                method: 'POST',
                headers: {
                  'x-hub-token': 'wrong-token',
                  'x-forwarded-for': '10.0.0.1',
                  'Content-Length': '2',
                },
              },
              (res) => {
                res.on('data', () => {});
                res.on('end', () => resolve());
              },
            );
            req.on('error', reject);
            req.write('{}');
            req.end();
          });
        }

        // 4th request from "10.0.0.1" should be rate limited (429)
        const lockedResponse = await new Promise<{ status: number }>((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: '127.0.0.1',
              port: tempPort,
              path: '/api/v1/messages',
              method: 'POST',
              headers: {
                'x-hub-token': 'wrong-token',
                'x-forwarded-for': '10.0.0.1',
                'Content-Length': '2',
              },
            },
            (res) => {
              res.on('data', () => {});
              res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
            },
          );
          req.on('error', reject);
          req.write('{}');
          req.end();
        });

        expect(lockedResponse.status).toBe(429);

        // Request from different forwarded IP should not be rate limited
        const differentIpResponse = await new Promise<{ status: number }>((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: '127.0.0.1',
              port: tempPort,
              path: '/api/v1/messages',
              method: 'POST',
              headers: {
                'x-hub-token': 'wrong-token',
                'x-forwarded-for': '10.0.0.2',
                'Content-Length': '2',
              },
            },
            (res) => {
              res.on('data', () => {});
              res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
            },
          );
          req.on('error', reject);
          req.write('{}');
          req.end();
        });

        expect(differentIpResponse.status).toBe(401); // Not 429
      } finally {
        proxyRateLimiter.destroy();
        await new Promise<void>((resolve) => tempServer.close(() => resolve()));
      }
    });
  });

  describe('getProviderRoute', () => {
    it('should route /api/anthropic/v1/messages to Anthropic (explicit prefix)', () => {
      const route = getProviderRoute('/api/anthropic/v1/messages', config);
      expect(route).toEqual({
        provider: 'anthropic',
        upstreamUrl: 'https://api.anthropic.com/v1/messages',
      });
    });

    it('should route /api/v1/messages to Anthropic (backwards compat)', () => {
      const route = getProviderRoute('/api/v1/messages', config);
      expect(route).toEqual({
        provider: 'anthropic',
        upstreamUrl: 'https://api.anthropic.com/v1/messages',
      });
    });

    it('should route /api/openai/* to OpenAI', () => {
      const route = getProviderRoute('/api/openai/v1/chat/completions', config);
      expect(route).toEqual({
        provider: 'openai',
        upstreamUrl: 'https://api.openai.com/v1/chat/completions',
      });
    });

    it('should route /api/gemini/* to Google', () => {
      const route = getProviderRoute('/api/gemini/v1beta/openai/chat/completions', config);
      expect(route).toEqual({
        provider: 'gemini',
        upstreamUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      });
    });

    it('should route /api/ollama/* to default localhost endpoint', () => {
      const route = getProviderRoute('/api/ollama/v1/chat/completions', config);
      expect(route).toEqual({
        provider: 'ollama',
        upstreamUrl: 'http://localhost:11434/v1/chat/completions',
      });
    });

    it('should route /api/ollama/* to configured custom endpoint', () => {
      const customConfig = {
        ...config,
        providers: {
          ollama: { endpoint: 'http://192.168.1.100:11434' },
        },
      };
      const route = getProviderRoute('/api/ollama/v1/chat/completions', customConfig);
      expect(route).toEqual({
        provider: 'ollama',
        upstreamUrl: 'http://192.168.1.100:11434/v1/chat/completions',
      });
    });

    it('should return null for unknown routes', () => {
      expect(getProviderRoute('/api/status', config)).toBeNull();
      expect(getProviderRoute('/api/unknown/path', config)).toBeNull();
      expect(getProviderRoute('/other/path', config)).toBeNull();
    });
  });

  describe('Multi-provider proxy routing', () => {
    it('should proxy OpenAI requests with Bearer auth', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: async () => JSON.stringify({ id: 'chatcmpl-123', choices: [] }),
      });

      const response = await makeRequest(
        'POST',
        '/api/openai/v1/chat/completions',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] }),
      );

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect(options.method).toBe('POST');
      expect(options.headers['Authorization']).toBe('Bearer sk-openai-test-key-456');
      // Must NOT have Anthropic-specific headers
      expect(options.headers['x-api-key']).toBeUndefined();
      expect(options.headers['anthropic-version']).toBeUndefined();
    });

    it('should proxy Gemini requests with x-goog-api-key auth', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: async () => JSON.stringify({ candidates: [] }),
      });

      const response = await makeRequest(
        'POST',
        '/api/gemini/v1beta/openai/chat/completions',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        JSON.stringify({ model: 'gemini-pro', contents: [] }),
      );

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
      expect(options.headers['x-goog-api-key']).toBe('gemini-test-key-789');
      // Must NOT have Anthropic-specific or OpenAI-style headers
      expect(options.headers['Authorization']).toBeUndefined();
      expect(options.headers['x-api-key']).toBeUndefined();
      expect(options.headers['anthropic-version']).toBeUndefined();
    });

    it('should proxy Ollama requests without auth when no key configured', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: async () => JSON.stringify({ message: { role: 'assistant', content: 'Hi' } }),
      });

      const response = await makeRequest(
        'POST',
        '/api/ollama/v1/chat/completions',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        JSON.stringify({ model: 'llama2', messages: [{ role: 'user', content: 'Hi' }] }),
      );

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:11434/v1/chat/completions');
      // No auth headers for Ollama without key
      expect(options.headers['Authorization']).toBeUndefined();
      expect(options.headers['x-api-key']).toBeUndefined();
      expect(options.headers['anthropic-version']).toBeUndefined();
      // Only Content-Type should be present
      expect(Object.keys(options.headers)).toEqual(['Content-Type']);
    });

    it('should proxy Ollama requests with Bearer auth when key is configured', async () => {
      // Add Ollama key to config
      config.sharedApiKeys!.ollama = 'ollama-test-key';

      // Recreate server with updated config
      await new Promise<void>((resolve, reject) => {
        server.close((err) => { if (err) reject(err); else resolve(); });
      });
      rateLimiter.destroy();
      rateLimiter = new FailedAuthRateLimiter(3, 5);
      context = { config, rateLimiter };
      const handler = createHttpRequestHandler(context);
      server = createServer(handler);
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            serverPort = addr.port;
          }
          resolve();
        });
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: async () => '{"ok":true}',
      });

      const response = await makeRequest(
        'POST',
        '/api/ollama/v1/chat/completions',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        JSON.stringify({ model: 'llama2', messages: [] }),
      );

      expect(response.status).toBe(200);
      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Authorization']).toBe('Bearer ollama-test-key');
    });

    it('should return 503 for provider path without configured key (not Ollama)', async () => {
      // Remove OpenAI key
      delete config.sharedApiKeys!.openai;

      // Recreate server with updated config
      await new Promise<void>((resolve, reject) => {
        server.close((err) => { if (err) reject(err); else resolve(); });
      });
      rateLimiter.destroy();
      rateLimiter = new FailedAuthRateLimiter(3, 5);
      context = { config, rateLimiter };
      const handler = createHttpRequestHandler(context);
      server = createServer(handler);
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            serverPort = addr.port;
          }
          resolve();
        });
      });

      const response = await makeRequest(
        'POST',
        '/api/openai/v1/chat/completions',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        JSON.stringify({ model: 'gpt-4', messages: [] }),
      );

      expect(response.status).toBe(503);
      const data = JSON.parse(response.body);
      expect(data.error).toContain('No shared API key configured');
      expect(data.error).toContain('openai');
    });

    it('should return 401 for provider paths without hub token', async () => {
      const response = await makeRequest(
        'POST',
        '/api/openai/v1/chat/completions',
        { 'Content-Type': 'application/json' },
        JSON.stringify({ model: 'gpt-4', messages: [] }),
      );

      expect(response.status).toBe(401);
    });

    it('should return 502 when upstream provider fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const response = await makeRequest(
        'POST',
        '/api/openai/v1/chat/completions',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        JSON.stringify({ model: 'gpt-4', messages: [] }),
      );

      expect(response.status).toBe(502);
      const data = JSON.parse(response.body);
      expect(data.error).toContain('Failed to proxy request');
    });

    it('should not cross-contaminate auth headers between providers', async () => {
      // Test Anthropic headers
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null, text: async () => '{"ok":true}',
      });
      await makeRequest(
        'POST', '/api/v1/messages',
        { 'Content-Type': 'application/json', 'x-hub-token': 'test-hub-token' },
        '{"test":true}',
      );
      const [, anthropicOpts] = mockFetch.mock.calls[0];
      expect(anthropicOpts.headers['x-api-key']).toBe('sk-ant-test-key-123');
      expect(anthropicOpts.headers['anthropic-version']).toBe('2023-06-01');
      expect(anthropicOpts.headers['Authorization']).toBeUndefined();

      // Test OpenAI headers
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null, text: async () => '{"ok":true}',
      });
      await makeRequest(
        'POST', '/api/openai/v1/chat/completions',
        { 'Content-Type': 'application/json', 'x-hub-token': 'test-hub-token' },
        '{"test":true}',
      );
      const [, openaiOpts] = mockFetch.mock.calls[1];
      expect(openaiOpts.headers['Authorization']).toBe('Bearer sk-openai-test-key-456');
      expect(openaiOpts.headers['x-api-key']).toBeUndefined();
      expect(openaiOpts.headers['anthropic-version']).toBeUndefined();
    });

    it('should use provider config apiKey as fallback', async () => {
      // Configure a provider API key (not in sharedApiKeys)
      delete config.sharedApiKeys!.openai;
      config.providers = {
        openai: { endpoint: 'https://api.openai.com', apiKey: 'sk-provider-config-key' },
      };

      // Recreate server with updated config
      await new Promise<void>((resolve, reject) => {
        server.close((err) => { if (err) reject(err); else resolve(); });
      });
      rateLimiter.destroy();
      rateLimiter = new FailedAuthRateLimiter(3, 5);
      context = { config, rateLimiter };
      const handler = createHttpRequestHandler(context);
      server = createServer(handler);
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            serverPort = addr.port;
          }
          resolve();
        });
      });

      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null, text: async () => '{"ok":true}',
      });

      const response = await makeRequest(
        'POST',
        '/api/openai/v1/chat/completions',
        {
          'Content-Type': 'application/json',
          'x-hub-token': 'test-hub-token',
        },
        JSON.stringify({ model: 'gpt-4', messages: [] }),
      );

      expect(response.status).toBe(200);
      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Authorization']).toBe('Bearer sk-provider-config-key');
    });
  });

  describe('CORS preflight for provider paths', () => {
    it('should return CORS headers for OPTIONS /api/openai/*', async () => {
      const response = await makeRequest('OPTIONS', '/api/openai/v1/chat/completions');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-headers']).toContain('Authorization');
    });

    it('should return CORS headers for OPTIONS /api/gemini/*', async () => {
      const response = await makeRequest('OPTIONS', '/api/gemini/v1beta/openai/chat/completions');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    it('should return CORS headers for OPTIONS /api/ollama/*', async () => {
      const response = await makeRequest('OPTIONS', '/api/ollama/v1/chat/completions');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('Edge cases', () => {
    it('should handle missing config.authToken', async () => {
      // Create a new server with no authToken
      const noAuthConfig = { ...config, authToken: undefined };
      const noAuthContext = { config: noAuthConfig, rateLimiter: new FailedAuthRateLimiter() };
      const handler = createHttpRequestHandler(noAuthContext);

      const tempServer = createServer(handler);
      let tempPort: number;

      await new Promise<void>((resolve) => {
        tempServer.listen(0, '127.0.0.1', () => {
          const addr = tempServer.address();
          if (addr && typeof addr === 'object') {
            tempPort = addr.port;
          }
          resolve();
        });
      });

      try {
        const response = await new Promise<{ status: number }>((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: '127.0.0.1',
              port: tempPort,
              path: '/api/v1/messages',
              method: 'POST',
              headers: { 'x-hub-token': 'any-token', 'Content-Length': '2' },
            },
            (res) => {
              res.on('data', () => {});
              res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
            },
          );
          req.on('error', reject);
          req.write('{}');
          req.end();
        });

        // Should fail because there's no authToken to compare against
        expect(response.status).toBe(401);
      } finally {
        await new Promise<void>((resolve) => tempServer.close(() => resolve()));
      }
    });

    it('should handle empty sharedApiKeys', async () => {
      // Create server with empty sharedApiKeys
      const emptyKeysConfig = { ...config, sharedApiKeys: {} };
      const emptyKeysContext = { config: emptyKeysConfig, rateLimiter: new FailedAuthRateLimiter() };
      const handler = createHttpRequestHandler(emptyKeysContext);

      const tempServer = createServer(handler);
      let tempPort: number;

      await new Promise<void>((resolve) => {
        tempServer.listen(0, '127.0.0.1', () => {
          const addr = tempServer.address();
          if (addr && typeof addr === 'object') {
            tempPort = addr.port;
          }
          resolve();
        });
      });

      try {
        const response = await new Promise<{ status: number }>((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: '127.0.0.1',
              port: tempPort,
              path: '/api/v1/messages',
              method: 'POST',
              headers: { 'x-hub-token': 'test-hub-token', 'Content-Length': '2' },
            },
            (res) => {
              res.on('data', () => {});
              res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
            },
          );
          req.on('error', reject);
          req.write('{}');
          req.end();
        });

        expect(response.status).toBe(503);
      } finally {
        await new Promise<void>((resolve) => tempServer.close(() => resolve()));
      }
    });
  });
});
