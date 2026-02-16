/**
 * Tests for proxy error handling scenarios
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createProxyServer } from '../server.js';

describe('Proxy Error Handling', () => {
  describe('connection errors', () => {
    let proxy: ReturnType<typeof createProxyServer>;
    let proxyPort: number;

    beforeAll(async () => {
      // Start proxy pointing to a non-existent upstream (nothing listening)
      proxyPort = 39001;
      proxy = createProxyServer(proxyPort, 'http://localhost:39999');
      await proxy.start();
    });

    afterAll(async () => {
      await proxy.stop();
    });

    it('should return 502 when upstream connection refused', async () => {
      const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] }),
      });

      expect(res.status).toBe(502);

      const body = await res.json() as { error?: string; message?: string };
      expect(body.error).toBe('Bad gateway');
      expect(body.message).toBeDefined();
    });

    it('should include CORS headers on error response', async () => {
      const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(502);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  describe('upstream error responses', () => {
    let proxy: ReturnType<typeof createProxyServer>;
    let mockUpstream: ReturnType<typeof createHttpServer>;
    let mockPort: number;
    let proxyPort: number;
    let upstreamBehavior: 'error' | 'invalid' | 'partial' | 'normal';

    beforeAll(async () => {
      mockPort = 39004;
      upstreamBehavior = 'normal';

      mockUpstream = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          switch (upstreamBehavior) {
            case 'error':
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal Server Error' }));
              break;

            case 'invalid':
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid request' }));
              break;

            case 'partial':
              // Write partial response then close
              res.writeHead(200, { 'Content-Type': 'text/event-stream' });
              res.write('event: start\n');
              res.destroy();
              break;

            case 'normal':
            default:
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
          }
        });
      });

      await new Promise<void>((resolve) => {
        mockUpstream.listen(mockPort, () => resolve());
      });

      proxyPort = 39005;
      proxy = createProxyServer(proxyPort, `http://localhost:${mockPort}`);
      await proxy.start();
    });

    afterEach(() => {
      upstreamBehavior = 'normal';
    });

    afterAll(async () => {
      await proxy.stop();
      await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
    });

    it('should pass through 500 errors from upstream', async () => {
      upstreamBehavior = 'error';

      const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(500);
      const body = await res.json() as { error?: string };
      expect(body.error).toBe('Internal Server Error');
    });

    it('should pass through 400 errors from upstream', async () => {
      upstreamBehavior = 'invalid';

      const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error?: string };
      expect(body.error).toBe('Invalid request');
    });

    it('should handle partial responses from upstream', async () => {
      upstreamBehavior = 'partial';

      try {
        const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });

        // Response may be partial or error - either is acceptable
        if (res.ok) {
          const text = await res.text();
          // Should have whatever was sent before close
          expect(text).toContain('event: start');
        }
      } catch {
        // Connection reset is also acceptable
      }
    });
  });

  describe('invalid requests', () => {
    let proxy: ReturnType<typeof createProxyServer>;
    let proxyPort: number;

    beforeAll(async () => {
      proxyPort = 39006;
      proxy = createProxyServer(proxyPort, 'http://localhost:39999');
      await proxy.start();
    });

    afterAll(async () => {
      await proxy.stop();
    });

    it('should return 404 for non-existent paths', async () => {
      const res = await fetch(`http://localhost:${proxyPort}/v1/unknown`);
      expect(res.status).toBe(404);

      const body = await res.json() as { error?: string };
      expect(body.error).toBe('Not found');
    });

    it('should return 404 for root path', async () => {
      const res = await fetch(`http://localhost:${proxyPort}/`);
      expect(res.status).toBe(404);
    });

    it('should return 404 for v1 root', async () => {
      const res = await fetch(`http://localhost:${proxyPort}/v1`);
      expect(res.status).toBe(404);
    });

    it('should return 405 for GET on /v1/messages', async () => {
      const res = await fetch(`http://localhost:${proxyPort}/v1/messages`);
      expect(res.status).toBe(405);

      const body = await res.json() as { error?: string };
      expect(body.error).toBe('Method not allowed');
    });

    it('should return 405 for PUT on /v1/messages', async () => {
      const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'PUT',
        body: '{}',
      });
      expect(res.status).toBe(405);
    });

    it('should return 405 for DELETE on /v1/messages', async () => {
      const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(405);
    });

    it('should handle OPTIONS preflight for any path', async () => {
      const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'OPTIONS',
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  describe('header handling', () => {
    let proxy: ReturnType<typeof createProxyServer>;
    let mockUpstream: ReturnType<typeof createHttpServer>;
    let mockPort: number;
    let proxyPort: number;
    let lastReceivedHeaders: Record<string, string>;

    beforeAll(async () => {
      mockPort = 39007;
      lastReceivedHeaders = {};

      mockUpstream = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
        lastReceivedHeaders = req.headers as Record<string, string>;
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
      });

      await new Promise<void>((resolve) => {
        mockUpstream.listen(mockPort, () => resolve());
      });

      proxyPort = 39008;
      proxy = createProxyServer(proxyPort, `http://localhost:${mockPort}`);
      await proxy.start();
    });

    afterEach(() => {
      lastReceivedHeaders = {};
    });

    afterAll(async () => {
      await proxy.stop();
      await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
    });

    it('should forward x-api-key header', async () => {
      await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'sk-test-123',
        },
        body: '{}',
      });

      expect(lastReceivedHeaders['x-api-key']).toBe('sk-test-123');
    });

    it('should forward anthropic-version header', async () => {
      await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: '{}',
      });

      expect(lastReceivedHeaders['anthropic-version']).toBe('2023-06-01');
    });

    it('should forward anthropic-dangerous-direct-browser-access header', async () => {
      await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: '{}',
      });

      expect(lastReceivedHeaders['anthropic-dangerous-direct-browser-access']).toBe('true');
    });

    it('should forward anthropic-beta header', async () => {
      await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-beta': 'extended-context-window',
        },
        body: '{}',
      });

      expect(lastReceivedHeaders['anthropic-beta']).toBe('extended-context-window');
    });

    it('should not forward arbitrary headers', async () => {
      await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-custom-header': 'should-not-forward',
        },
        body: '{}',
      });

      expect(lastReceivedHeaders['x-custom-header']).toBeUndefined();
    });
  });

  describe('large request body', () => {
    let proxy: ReturnType<typeof createProxyServer>;
    let mockUpstream: ReturnType<typeof createHttpServer>;
    let mockPort: number;
    let proxyPort: number;
    let receivedBodySize: number;

    beforeAll(async () => {
      mockPort = 39009;
      receivedBodySize = 0;

      mockUpstream = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          receivedBodySize = Buffer.concat(chunks).length;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: receivedBodySize }));
        });
      });

      await new Promise<void>((resolve) => {
        mockUpstream.listen(mockPort, () => resolve());
      });

      proxyPort = 39010;
      proxy = createProxyServer(proxyPort, `http://localhost:${mockPort}`);
      await proxy.start();
    });

    afterEach(() => {
      receivedBodySize = 0;
    });

    afterAll(async () => {
      await proxy.stop();
      await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
    });

    it('should handle moderately large request body', async () => {
      // Create a ~100KB body
      const largeBody = JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'x'.repeat(100000) }],
      });

      const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: largeBody,
      });

      expect(res.status).toBe(200);
      expect(receivedBodySize).toBe(Buffer.byteLength(largeBody));
    });
  });
});
