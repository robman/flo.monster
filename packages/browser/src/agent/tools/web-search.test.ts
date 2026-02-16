import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webSearchToolDef, executeWebSearch, createWebSearchPlugin } from './web-search.js';
import type { HubClient, HubConnection } from '../../shell/hub-client.js';

// Sample DuckDuckGo HTML response for testing
const MOCK_DUCKDUCKGO_HTML = `
<!DOCTYPE html>
<html>
<body>
<div class="results">
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&rut=abc">Example Page 1</a>
    <a class="result__snippet">This is the first result snippet text</a>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage2&rut=def">Example Page 2</a>
    <a class="result__snippet">This is the second result snippet text</a>
  </div>
</div>
</body>
</html>
`;

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
      return fetchResponse || { status: 200, body: MOCK_DUCKDUCKGO_HTML };
    }),
  } as unknown as HubClient;
}

describe('webSearchToolDef', () => {
  it('should have correct name', () => {
    expect(webSearchToolDef.name).toBe('web_search');
  });

  it('should have valid input_schema', () => {
    expect(webSearchToolDef.input_schema).toBeDefined();
    expect(webSearchToolDef.input_schema.type).toBe('object');
    expect(webSearchToolDef.input_schema.properties).toHaveProperty('query');
    expect(webSearchToolDef.input_schema.properties).toHaveProperty('routing');
    expect(webSearchToolDef.input_schema.required).toContain('query');
  });

  it('should have routing enum with correct values', () => {
    const routingProp = webSearchToolDef.input_schema.properties!.routing;
    expect(routingProp.enum).toEqual(['auto', 'api', 'hub']);
  });

  it('should have a description', () => {
    expect(webSearchToolDef.description).toBeTruthy();
    expect(webSearchToolDef.description.length).toBeGreaterThan(10);
  });
});

describe('executeWebSearch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should return error for empty query', async () => {
    const result = await executeWebSearch({ query: '' }, {});
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('cannot be empty');
  });

  it('should return error for whitespace-only query', async () => {
    const result = await executeWebSearch({ query: '   ' }, {});
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('cannot be empty');
  });

  it('should return not implemented error for api routing', async () => {
    const result = await executeWebSearch(
      { query: 'test search', routing: 'api' },
      {}
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('not yet implemented');
  });

  it('should use hub routing when specified', async () => {
    const hubClient = createMockHubClient({
      connected: true,
      fetchResponse: { status: 200, body: MOCK_DUCKDUCKGO_HTML },
    });

    const result = await executeWebSearch(
      { query: 'test search', routing: 'hub' },
      { hubClient }
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('Search results');
    expect(hubClient.fetch).toHaveBeenCalled();
    // Check that the URL contains the encoded query
    const fetchCall = (hubClient.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1]).toContain('test%20search');
  });

  it('should return error when hub routing requested but no hub connected', async () => {
    const hubClient = createMockHubClient({ connected: false });

    const result = await executeWebSearch(
      { query: 'test search', routing: 'hub' },
      { hubClient }
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('no hub is connected');
  });

  it('should return error when hub routing requested but no client', async () => {
    const result = await executeWebSearch(
      { query: 'test search', routing: 'hub' },
      {}
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('no hub client available');
  });

  it('should return helpful error with auto routing when no hub available', async () => {
    const result = await executeWebSearch(
      { query: 'test search', routing: 'auto' },
      {}
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('requires a connected hub');
  });

  it('should use hub with auto routing when hub available', async () => {
    const hubClient = createMockHubClient({
      connected: true,
      fetchResponse: { status: 200, body: MOCK_DUCKDUCKGO_HTML },
    });

    const result = await executeWebSearch(
      { query: 'test search', routing: 'auto' },
      { hubClient }
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('Search results');
    expect(hubClient.fetch).toHaveBeenCalled();
  });

  it('should handle search returning no results', async () => {
    const hubClient = createMockHubClient({
      connected: true,
      fetchResponse: { status: 200, body: '<html><body></body></html>' },
    });

    const result = await executeWebSearch(
      { query: 'xyzabc123nonexistent', routing: 'hub' },
      { hubClient }
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('No results found');
  });

  it('should handle search error response', async () => {
    const hubClient = createMockHubClient({
      connected: true,
      fetchResponse: { status: 500, body: '', error: 'Server error' },
    });

    const result = await executeWebSearch(
      { query: 'test search', routing: 'hub' },
      { hubClient }
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Search failed');
  });

  it('should handle non-200 status codes', async () => {
    const hubClient = createMockHubClient({
      connected: true,
      fetchResponse: { status: 403, body: 'Forbidden' },
    });

    const result = await executeWebSearch(
      { query: 'test search', routing: 'hub' },
      { hubClient }
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('status 403');
  });

  describe('network policy enforcement', () => {
    it('should reject search when duckduckgo.com is not in allowlist', async () => {
      const hubClient = createMockHubClient({ connected: true });
      const result = await executeWebSearch(
        { query: 'test', routing: 'hub' },
        { hubClient, networkPolicy: { mode: 'allowlist', allowedDomains: ['example.com'] } }
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not allowed');
    });

    it('should allow search when duckduckgo.com is in allowlist', async () => {
      const hubClient = createMockHubClient({
        connected: true,
        fetchResponse: { status: 200, body: MOCK_DUCKDUCKGO_HTML },
      });
      const result = await executeWebSearch(
        { query: 'test', routing: 'hub' },
        { hubClient, networkPolicy: { mode: 'allowlist', allowedDomains: ['html.duckduckgo.com'] } }
      );
      expect(result.is_error).toBeUndefined();
    });

    it('should reject search when duckduckgo.com is in blocklist', async () => {
      const hubClient = createMockHubClient({ connected: true });
      const result = await executeWebSearch(
        { query: 'test', routing: 'hub' },
        { hubClient, networkPolicy: { mode: 'blocklist', blockedDomains: ['html.duckduckgo.com'] } }
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('blocked');
    });

    it('should allow search with allow-all policy', async () => {
      const hubClient = createMockHubClient({
        connected: true,
        fetchResponse: { status: 200, body: MOCK_DUCKDUCKGO_HTML },
      });
      const result = await executeWebSearch(
        { query: 'test', routing: 'hub' },
        { hubClient, networkPolicy: { mode: 'allow-all' } }
      );
      expect(result.is_error).toBeUndefined();
    });
  });
});

describe('createWebSearchPlugin', () => {
  it('should create a valid plugin', () => {
    const plugin = createWebSearchPlugin({});
    expect(plugin.definition).toBe(webSearchToolDef);
    expect(typeof plugin.execute).toBe('function');
  });

  it('should execute with context', async () => {
    const hubClient = createMockHubClient({
      connected: true,
      fetchResponse: { status: 200, body: MOCK_DUCKDUCKGO_HTML },
    });

    const plugin = createWebSearchPlugin({ hubClient });
    const result = await plugin.execute(
      { query: 'plugin test', routing: 'hub' },
      { agentId: 'test', agentConfig: { id: 'test-agent', name: 'Test', model: 'test', tools: [], maxTokens: 1000 } }
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('Search results');
  });
});
