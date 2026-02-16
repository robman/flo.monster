import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webFetchToolDef, executeWebFetch, createWebFetchPlugin } from './web-fetch.js';
import type { HubClient, HubConnection } from '../../shell/hub-client.js';

// Mock HubClient
function createMockHubClient(options: {
  connected?: boolean;
  fetchResponse?: { status: number; body: string; error?: string };
  fetchError?: Error;
} = {}): HubClient {
  const { connected = true, fetchResponse, fetchError } = options;

  const mockConnection: HubConnection = {
    id: 'test-hub-1',
    name: 'Test Hub',
    url: 'ws://localhost:8765',
    connected,
    tools: [],
  };

  return {
    getConnections: vi.fn(() => connected ? [mockConnection] : []),
    fetch: vi.fn(async () => {
      if (fetchError) throw fetchError;
      return fetchResponse || { status: 200, body: '<html>Test</html>' };
    }),
  } as unknown as HubClient;
}

describe('webFetchToolDef', () => {
  it('should have correct name', () => {
    expect(webFetchToolDef.name).toBe('web_fetch');
  });

  it('should have valid input_schema', () => {
    expect(webFetchToolDef.input_schema).toBeDefined();
    expect(webFetchToolDef.input_schema.type).toBe('object');
    expect(webFetchToolDef.input_schema.properties).toHaveProperty('url');
    expect(webFetchToolDef.input_schema.properties).toHaveProperty('routing');
    expect(webFetchToolDef.input_schema.required).toContain('url');
  });

  it('should have routing enum with correct values', () => {
    const routingProp = webFetchToolDef.input_schema.properties!.routing;
    expect(routingProp.enum).toEqual(['auto', 'api', 'hub', 'browser']);
  });

  it('should have a description', () => {
    expect(webFetchToolDef.description).toBeTruthy();
    expect(webFetchToolDef.description.length).toBeGreaterThan(10);
  });
});

describe('executeWebFetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should return error for invalid URL', async () => {
    const result = await executeWebFetch({ url: 'not-a-url' }, {});
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Invalid URL');
  });

  it('should return not implemented error for api routing', async () => {
    const result = await executeWebFetch(
      { url: 'https://example.com', routing: 'api' },
      {}
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('not yet implemented');
  });

  it('should use hub routing when specified', async () => {
    const hubClient = createMockHubClient({
      connected: true,
      fetchResponse: { status: 200, body: '<html>Hub Response</html>' },
    });

    const result = await executeWebFetch(
      { url: 'https://example.com', routing: 'hub' },
      { hubClient }
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('Status: 200');
    expect(result.content).toContain('Hub Response');
    expect(hubClient.fetch).toHaveBeenCalledWith('test-hub-1', 'https://example.com');
  });

  it('should return error when hub routing requested but no hub connected', async () => {
    const hubClient = createMockHubClient({ connected: false });

    const result = await executeWebFetch(
      { url: 'https://example.com', routing: 'hub' },
      { hubClient }
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('no hub is connected');
  });

  it('should return error when hub routing requested but no client', async () => {
    const result = await executeWebFetch(
      { url: 'https://example.com', routing: 'hub' },
      {}
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('no hub client available');
  });

  it('should try hub first with auto routing when hub available', async () => {
    const hubClient = createMockHubClient({
      connected: true,
      fetchResponse: { status: 200, body: 'Hub Content' },
    });

    const result = await executeWebFetch(
      { url: 'https://example.com', routing: 'auto' },
      { hubClient }
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('Hub Content');
    expect(hubClient.fetch).toHaveBeenCalled();
  });

  it('should handle hub fetch errors', async () => {
    const hubClient = createMockHubClient({
      connected: true,
      fetchResponse: { status: 500, body: '', error: 'Internal server error' },
    });

    const result = await executeWebFetch(
      { url: 'https://example.com', routing: 'hub' },
      { hubClient }
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Hub fetch error');
  });

  it('should truncate very large responses', async () => {
    const largeBody = 'x'.repeat(150000);
    const hubClient = createMockHubClient({
      connected: true,
      fetchResponse: { status: 200, body: largeBody },
    });

    const result = await executeWebFetch(
      { url: 'https://example.com', routing: 'hub' },
      { hubClient }
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('truncated');
    expect(result.content.length).toBeLessThan(largeBody.length);
  });

  describe('network policy enforcement', () => {
    it('should reject fetch when URL is not in allowlist', async () => {
      const result = await executeWebFetch(
        { url: 'https://evil.com/data' },
        { networkPolicy: { mode: 'allowlist', allowedDomains: ['example.com'] } }
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not allowed');
    });

    it('should allow fetch when URL is in allowlist', async () => {
      const hubClient = createMockHubClient({
        connected: true,
        fetchResponse: { status: 200, body: 'OK' },
      });
      const result = await executeWebFetch(
        { url: 'https://example.com/data', routing: 'hub' },
        { hubClient, networkPolicy: { mode: 'allowlist', allowedDomains: ['example.com'] } }
      );
      expect(result.is_error).toBeUndefined();
    });

    it('should reject fetch when URL is in blocklist', async () => {
      const result = await executeWebFetch(
        { url: 'https://evil.com/data' },
        { networkPolicy: { mode: 'blocklist', blockedDomains: ['evil.com'] } }
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('blocked');
    });

    it('should allow fetch with allow-all policy', async () => {
      const hubClient = createMockHubClient({
        connected: true,
        fetchResponse: { status: 200, body: 'OK' },
      });
      const result = await executeWebFetch(
        { url: 'https://anything.com', routing: 'hub' },
        { hubClient, networkPolicy: { mode: 'allow-all' } }
      );
      expect(result.is_error).toBeUndefined();
    });
  });
});

describe('createWebFetchPlugin', () => {
  it('should create a valid plugin', () => {
    const plugin = createWebFetchPlugin({});
    expect(plugin.definition).toBe(webFetchToolDef);
    expect(typeof plugin.execute).toBe('function');
  });

  it('should execute with context', async () => {
    const hubClient = createMockHubClient({
      connected: true,
      fetchResponse: { status: 200, body: 'Plugin Test' },
    });

    const plugin = createWebFetchPlugin({ hubClient });
    const result = await plugin.execute(
      { url: 'https://example.com', routing: 'hub' },
      { agentId: 'test', agentConfig: { id: 'test-agent', name: 'Test', model: 'test', tools: [], maxTokens: 1000 } }
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('Plugin Test');
  });
});
