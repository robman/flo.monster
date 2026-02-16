import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import type { ConnectedClient } from '../server.js';
import { handleMessage } from '../handlers/message-handler.js';
import { getDefaultConfig, type HubConfig } from '../config.js';

function createMockClient(authenticated = true): ConnectedClient {
  return {
    ws: { send: vi.fn(), readyState: WebSocket.OPEN } as any,
    authenticated,
    remoteAddress: '127.0.0.1',
    subscribedAgents: new Set(),
    messageCount: 0,
    messageWindowStart: Date.now(),
  };
}

function parseSentMessages(client: ConnectedClient): any[] {
  const sendMock = client.ws.send as ReturnType<typeof vi.fn>;
  return sendMock.mock.calls.map((call: any[]) => JSON.parse(call[0]));
}

describe('fetch proxy security', () => {
  let config: HubConfig;

  beforeEach(() => {
    config = {
      ...getDefaultConfig(),
      fetchProxy: {
        enabled: true,
        allowedPatterns: [],
        blockedPatterns: ['*.internal.corp'],
      },
    };
  });

  it('strips sensitive headers from agent fetch requests', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    // We can't easily test the actual fetch without mocking global fetch,
    // but we can verify the function processes the message
    // This test verifies the code path executes without error
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-1',
          url: 'https://example.com/api',
          options: {
            headers: {
              'Authorization': 'Bearer secret',
              'Cookie': 'session=abc',
              'X-Api-Key': 'key123',
              'Content-Type': 'application/json',
            },
          },
        } as any,
        config,
        new Map(),
        clients,
      );

      // Verify fetch was called
      expect(global.fetch).toHaveBeenCalled();

      // Check that sensitive headers were stripped
      const fetchCall = (global.fetch as any).mock.calls[0];
      const fetchOpts = fetchCall[1];
      const headers = fetchOpts.headers;

      // Headers should not include sensitive ones
      if (headers instanceof Headers) {
        expect(headers.has('authorization')).toBe(false);
        expect(headers.has('cookie')).toBe(false);
        expect(headers.has('x-api-key')).toBe(false);
        expect(headers.has('content-type')).toBe(true);
      } else {
        expect(headers['authorization']).toBeUndefined();
        expect(headers['cookie']).toBeUndefined();
        expect(headers['x-api-key']).toBeUndefined();
        expect(headers['content-type']).toBe('application/json');
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('strips proxy-authorization and set-cookie headers', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-headers-2',
          url: 'https://example.com/api',
          options: {
            headers: {
              'Proxy-Authorization': 'Basic abc',
              'Set-Cookie': 'track=me',
              'Accept': 'text/html',
            },
          },
        } as any,
        config,
        new Map(),
        clients,
      );

      expect(global.fetch).toHaveBeenCalled();

      const fetchCall = (global.fetch as any).mock.calls[0];
      const fetchOpts = fetchCall[1];
      const headers = fetchOpts.headers;

      if (headers instanceof Headers) {
        expect(headers.has('proxy-authorization')).toBe(false);
        expect(headers.has('set-cookie')).toBe(false);
        expect(headers.has('accept')).toBe(true);
      } else {
        expect(headers['proxy-authorization']).toBeUndefined();
        expect(headers['set-cookie']).toBeUndefined();
        expect(headers['accept']).toBe('text/html');
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('blocks redirects to private IPs', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { Location: 'http://127.0.0.1:8080/admin' },
      })
    );

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-2',
          url: 'https://evil.com/redirect',
        } as any,
        config,
        new Map(),
        clients,
      );

      const messages = parseSentMessages(client);
      const result = messages.find((m: any) => m.type === 'fetch_result');
      expect(result).toBeDefined();
      expect(result.error).toContain('private IP');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('blocks redirects to 10.x.x.x private range', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { Location: 'http://10.0.0.1:9200/elasticsearch' },
      })
    );

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-private-10',
          url: 'https://evil.com/redirect',
        } as any,
        config,
        new Map(),
        clients,
      );

      const messages = parseSentMessages(client);
      const result = messages.find((m: any) => m.type === 'fetch_result');
      expect(result).toBeDefined();
      expect(result.error).toContain('private IP');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('blocks redirects to 192.168.x.x private range', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { Location: 'http://192.168.1.1/router' },
      })
    );

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-private-192',
          url: 'https://evil.com/redirect',
        } as any,
        config,
        new Map(),
        clients,
      );

      const messages = parseSentMessages(client);
      const result = messages.find((m: any) => m.type === 'fetch_result');
      expect(result).toBeDefined();
      expect(result.error).toContain('private IP');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('blocks redirects to 172.16-31.x.x private range', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { Location: 'http://172.20.0.5/internal' },
      })
    );

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-private-172',
          url: 'https://evil.com/redirect',
        } as any,
        config,
        new Map(),
        clients,
      );

      const messages = parseSentMessages(client);
      const result = messages.find((m: any) => m.type === 'fetch_result');
      expect(result).toBeDefined();
      expect(result.error).toContain('private IP');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('blocks redirects to localhost', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 301,
        headers: { Location: 'http://localhost:3000/secret' },
      })
    );

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-localhost',
          url: 'https://evil.com/redirect',
        } as any,
        config,
        new Map(),
        clients,
      );

      const messages = parseSentMessages(client);
      const result = messages.find((m: any) => m.type === 'fetch_result');
      expect(result).toBeDefined();
      expect(result.error).toContain('private IP');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('blocks redirects to blocked domains', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 301,
        headers: { Location: 'https://admin.internal.corp/secret' },
      })
    );

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-3',
          url: 'https://example.com/go',
        } as any,
        config,
        new Map(),
        clients,
      );

      const messages = parseSentMessages(client);
      const result = messages.find((m: any) => m.type === 'fetch_result');
      expect(result).toBeDefined();
      expect(result.error).toContain('blocked');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('follows safe redirects and returns final response', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response('', {
          status: 302,
          headers: { Location: 'https://safe.example.com/page' },
        }));
      }
      return Promise.resolve(new Response('Final content', { status: 200 }));
    });

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-safe-redirect',
          url: 'https://example.com/start',
        } as any,
        config,
        new Map(),
        clients,
      );

      const messages = parseSentMessages(client);
      const result = messages.find((m: any) => m.type === 'fetch_result');
      expect(result).toBeDefined();
      expect(result.status).toBe(200);
      expect(result.body).toBe('Final content');
      expect(result.error).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('uses manual redirect following (redirect: manual)', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-manual',
          url: 'https://example.com/api',
        } as any,
        config,
        new Map(),
        clients,
      );

      expect(global.fetch).toHaveBeenCalled();
      const fetchCall = (global.fetch as any).mock.calls[0];
      const fetchOpts = fetchCall[1];
      expect(fetchOpts.redirect).toBe('manual');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not send body on redirect (POST->GET downgrade)', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    let secondCallOpts: any = null;
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response('', {
          status: 302,
          headers: { Location: 'https://safe.example.com/page' },
        }));
      }
      secondCallOpts = opts;
      return Promise.resolve(new Response('OK', { status: 200 }));
    });

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-post-redirect',
          url: 'https://example.com/submit',
          options: {
            method: 'POST',
            body: '{"data":"secret"}',
          },
        } as any,
        config,
        new Map(),
        clients,
      );

      expect(callCount).toBe(2);
      // Body should be stripped on redirect
      expect(secondCallOpts.body).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('handles requests with no headers gracefully (no stripping needed)', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-no-headers',
          url: 'https://example.com/api',
        } as any,
        config,
        new Map(),
        clients,
      );

      expect(global.fetch).toHaveBeenCalled();
      const messages = parseSentMessages(client);
      const result = messages.find((m: any) => m.type === 'fetch_result');
      expect(result).toBeDefined();
      expect(result.status).toBe(200);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('blocks redirects to 0.0.0.0', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { Location: 'http://0.0.0.0:8080/internal' },
      })
    );

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-zero',
          url: 'https://evil.com/redirect',
        } as any,
        config,
        new Map(),
        clients,
      );

      const messages = parseSentMessages(client);
      const result = messages.find((m: any) => m.type === 'fetch_result');
      expect(result).toBeDefined();
      expect(result.error).toContain('private IP');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('blocks redirects to IPv6 loopback', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { Location: 'http://[::1]:8080/internal' },
      })
    );

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-ipv6-loopback',
          url: 'https://evil.com/redirect',
        } as any,
        config,
        new Map(),
        clients,
      );

      const messages = parseSentMessages(client);
      const result = messages.find((m: any) => m.type === 'fetch_result');
      expect(result).toBeDefined();
      expect(result.error).toContain('private IP');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects unauthenticated fetch requests', async () => {
    const client = createMockClient(false);
    const clients = new Set([client]);

    await handleMessage(
      client,
      {
        type: 'fetch_request',
        id: 'fetch-unauth',
        url: 'https://example.com/api',
      } as any,
      config,
      new Map(),
      clients,
    );

    const messages = parseSentMessages(client);
    const error = messages.find((m: any) => m.type === 'error');
    expect(error).toBeDefined();
    expect(error.message).toContain('Not authenticated');
  });

  it('rejects requests when fetch proxy is disabled', async () => {
    const client = createMockClient();
    const clients = new Set([client]);
    config.fetchProxy.enabled = false;

    const originalFetch = global.fetch;
    global.fetch = vi.fn();

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-disabled',
          url: 'https://example.com/api',
        } as any,
        config,
        new Map(),
        clients,
      );

      // fetch should NOT have been called
      expect(global.fetch).not.toHaveBeenCalled();

      const messages = parseSentMessages(client);
      const result = messages.find((m: any) => m.type === 'fetch_result');
      expect(result).toBeDefined();
      expect(result.error).toContain('disabled');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
