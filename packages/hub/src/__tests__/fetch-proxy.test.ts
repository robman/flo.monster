import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import type { ConnectedClient } from '../server.js';
import { handleMessage } from '../handlers/message-handler.js';
import { getDefaultConfig, type HubConfig } from '../config.js';
import { isPrivateIP } from '../utils/safe-fetch.js';

function createMockClient(authenticated = true): ConnectedClient {
  return {
    id: 'test-client-id',
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

  it('blocks redirects to IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { Location: 'http://[::ffff:127.0.0.1]:8080/admin' },
      })
    );

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-v4mapped-loopback',
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

  it('blocks redirects to IPv4-mapped IPv6 private (::ffff:192.168.1.1)', async () => {
    const client = createMockClient();
    const clients = new Set([client]);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { Location: 'http://[::ffff:192.168.1.1]/router' },
      })
    );

    try {
      await handleMessage(
        client,
        {
          type: 'fetch_request',
          id: 'fetch-v4mapped-private',
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

describe('isPrivateIP', () => {
  it('detects localhost', () => {
    expect(isPrivateIP('localhost')).toBe(true);
  });

  it('detects 127.0.0.1 loopback', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('127.0.0.2')).toBe(true);
    expect(isPrivateIP('127.255.255.255')).toBe(true);
  });

  it('detects 10.x.x.x private range', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('10.255.255.255')).toBe(true);
  });

  it('detects 192.168.x.x private range', () => {
    expect(isPrivateIP('192.168.0.1')).toBe(true);
    expect(isPrivateIP('192.168.255.255')).toBe(true);
  });

  it('detects 172.16-31.x.x private range', () => {
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('172.31.255.255')).toBe(true);
    expect(isPrivateIP('172.15.0.1')).toBe(false);
    expect(isPrivateIP('172.32.0.1')).toBe(false);
  });

  it('detects 0.0.0.0 and 0.x addresses', () => {
    expect(isPrivateIP('0.0.0.0')).toBe(true);
    expect(isPrivateIP('0.1.2.3')).toBe(true);
  });

  it('detects 169.254.x.x link-local', () => {
    expect(isPrivateIP('169.254.0.1')).toBe(true);
    expect(isPrivateIP('169.254.255.255')).toBe(true);
  });

  it('detects IPv6 loopback ::1', () => {
    expect(isPrivateIP('::1')).toBe(true);
    expect(isPrivateIP('[::1]')).toBe(true);
  });

  it('detects IPv6 link-local fe80:', () => {
    expect(isPrivateIP('fe80::1')).toBe(true);
  });

  it('detects IPv6 ULA fc/fd', () => {
    expect(isPrivateIP('fc00::1')).toBe(true);
    expect(isPrivateIP('fd12:3456::1')).toBe(true);
  });

  it('detects IPv4-mapped IPv6 loopback — dotted-decimal form', () => {
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
  });

  it('detects IPv4-mapped IPv6 loopback — hex form (Node.js URL normalization)', () => {
    // Node.js normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1
    expect(isPrivateIP('::ffff:7f00:1')).toBe(true);
  });

  it('detects IPv4-mapped IPv6 private ranges — dotted-decimal form', () => {
    expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIP('::ffff:172.16.0.1')).toBe(true);
    expect(isPrivateIP('::ffff:169.254.0.1')).toBe(true);
  });

  it('detects IPv4-mapped IPv6 private ranges — hex form (Node.js URL normalization)', () => {
    // ::ffff:10.0.0.1 → ::ffff:a00:1
    expect(isPrivateIP('::ffff:a00:1')).toBe(true);
    // ::ffff:192.168.1.1 → ::ffff:c0a8:101
    expect(isPrivateIP('::ffff:c0a8:101')).toBe(true);
    // ::ffff:172.16.0.1 → ::ffff:ac10:1
    expect(isPrivateIP('::ffff:ac10:1')).toBe(true);
    // ::ffff:169.254.0.1 → ::ffff:a9fe:1
    expect(isPrivateIP('::ffff:a9fe:1')).toBe(true);
  });

  it('allows IPv4-mapped IPv6 public IPs — dotted-decimal form', () => {
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIP('::ffff:1.1.1.1')).toBe(false);
  });

  it('allows IPv4-mapped IPv6 public IPs — hex form', () => {
    // ::ffff:8.8.8.8 → ::ffff:808:808
    expect(isPrivateIP('::ffff:808:808')).toBe(false);
    // ::ffff:1.1.1.1 → ::ffff:101:101
    expect(isPrivateIP('::ffff:101:101')).toBe(false);
  });

  it('allows public IPs', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('1.1.1.1')).toBe(false);
    expect(isPrivateIP('93.184.216.34')).toBe(false);
  });
});
