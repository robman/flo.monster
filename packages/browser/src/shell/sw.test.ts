import { describe, it, expect, beforeEach } from 'vitest';

describe('Service Worker logic', () => {
  let apiKey: string;
  let apiKeys: Record<string, string>;
  let hubMode: boolean;
  let hubHttpUrl: string;
  let hubToken: string;
  let apiBaseUrl: string;

  function handleMessage(data: { type: string; apiKey?: string; keys?: Record<string, string>; enabled?: boolean; httpUrl?: string; token?: string; apiBaseUrl?: string }) {
    switch (data.type) {
      case 'configure':
        apiKey = data.apiKey || '';
        apiKeys.anthropic = data.apiKey || '';
        break;
      case 'update_key':
        apiKey = data.apiKey || '';
        apiKeys.anthropic = data.apiKey || '';
        break;
      case 'configure_keys':
        apiKeys = { ...data.keys };
        break;
      case 'configure_hub':
        hubMode = data.enabled ?? false;
        if (data.httpUrl) {
          try {
            const parsed = new URL(data.httpUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              break;
            }
            hubHttpUrl = data.httpUrl;
          } catch {
            break;
          }
        } else {
          hubHttpUrl = '';
        }
        hubToken = data.token || '';
        break;
      case 'configure_api_base':
        apiBaseUrl = data.apiBaseUrl || '';
        break;
    }
  }

  function getProviderFromPath(pathname: string): string {
    if (pathname.startsWith('/api/anthropic/')) return 'anthropic';
    if (pathname.startsWith('/api/openai/')) return 'openai';
    if (pathname.startsWith('/api/gemini/')) return 'gemini';
    if (pathname.startsWith('/api/ollama/')) return 'ollama';
    return 'anthropic';
  }

  function shouldIntercept(pathname: string): boolean {
    return pathname.startsWith('/api/');
  }

  /**
   * Check if a provider key is missing (not in hub mode).
   * Returns an error message string if missing, null if key exists or hub mode.
   */
  function getMissingKeyError(requestUrl: string): string | null {
    const url = new URL(requestUrl);
    const provider = getProviderFromPath(url.pathname);

    // Hub mode handles keys server-side
    if (hubMode && hubHttpUrl) return null;

    if (!apiKeys[provider]) {
      const providerNames: Record<string, string> = {
        anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini', ollama: 'Ollama',
      };
      const name = providerNames[provider] || provider;
      return `No ${name} API key configured. Open Settings and add your API key, or connect to a hub with shared keys.`;
    }
    return null;
  }

  function buildHeaders(original: Record<string, string>, requestUrl: string): { headers: Record<string, string>; targetUrl: string } {
    const headers = { ...original };
    const url = new URL(requestUrl);
    const provider = getProviderFromPath(url.pathname);

    // Hub mode routing (takes priority — user explicitly chose hub)
    if (hubMode && hubHttpUrl) {
      const targetUrl = hubHttpUrl + url.pathname;
      headers['x-hub-token'] = hubToken;
      headers['x-api-provider'] = provider;
      if (provider === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
      }
      return { headers, targetUrl };
    }

    // API base URL routing (hosted deployments)
    if (apiBaseUrl) {
      const externalUrl = apiBaseUrl + url.pathname.replace(/^\/api/, '');
      const key = apiKeys[provider];
      if (key) {
        if (provider === 'anthropic') {
          headers['x-api-key'] = key;
          headers['anthropic-version'] = '2023-06-01';
        } else {
          headers['Authorization'] = `Bearer ${key}`;
        }
      } else if (provider === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
      }
      return { headers, targetUrl: externalUrl };
    }

    // Local key mode
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }
    headers['anthropic-version'] = '2023-06-01';
    return { headers, targetUrl: requestUrl };
  }

  beforeEach(() => {
    apiKey = '';
    apiKeys = {};
    hubMode = false;
    hubHttpUrl = '';
    hubToken = '';
    apiBaseUrl = '';
  });

  describe('configure message', () => {
    it('sets apiKey', () => {
      handleMessage({ type: 'configure', apiKey: 'sk-test' });
      expect(apiKey).toBe('sk-test');
    });
  });

  describe('update_key message', () => {
    it('changes the key for subsequent requests', () => {
      handleMessage({ type: 'configure', apiKey: 'old-key' });
      handleMessage({ type: 'update_key', apiKey: 'new-key' });
      expect(apiKey).toBe('new-key');
    });
  });

  describe('fetch interception', () => {
    it('/api/v1/messages is intercepted', () => {
      expect(shouldIntercept('/api/v1/messages')).toBe(true);
    });

    it('/api/anthropic/v1/messages is intercepted', () => {
      expect(shouldIntercept('/api/anthropic/v1/messages')).toBe(true);
    });

    it('/api/v1/other is intercepted', () => {
      expect(shouldIntercept('/api/v1/other')).toBe(true);
    });

    it('non /api/ fetches pass through', () => {
      expect(shouldIntercept('/index.html')).toBe(false);
      expect(shouldIntercept('/src/main.ts')).toBe(false);
      expect(shouldIntercept('/other/api/thing')).toBe(false);
    });
  });

  describe('header injection (local mode)', () => {
    it('injects x-api-key when configured', () => {
      handleMessage({ type: 'configure', apiKey: 'sk-ant-test' });
      const { headers } = buildHeaders({ 'content-type': 'application/json' }, 'https://localhost:5173/api/v1/messages');
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['content-type']).toBe('application/json');
    });

    it('does not inject x-api-key when empty', () => {
      handleMessage({ type: 'configure', apiKey: '' });
      const { headers } = buildHeaders({}, 'https://localhost:5173/api/v1/messages');
      expect(headers['x-api-key']).toBeUndefined();
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('always sets anthropic-version', () => {
      handleMessage({ type: 'configure', apiKey: '' });
      const { headers } = buildHeaders({}, 'https://localhost:5173/api/v1/messages');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('does not rewrite URLs — passes request.url unchanged', () => {
      // The SW now only injects headers. URL rewriting is handled by Vite's
      // server proxy to avoid mixed content (HTTPS page → HTTP proxy).
      handleMessage({ type: 'configure', apiKey: 'sk-test' });
      const originalUrl = 'https://localhost:5173/api/v1/messages';
      const { targetUrl } = buildHeaders({}, originalUrl);
      // The SW creates a new Request with the same URL, just different headers
      expect(targetUrl).toBe('https://localhost:5173/api/v1/messages');
    });
  });

  describe('configure_hub message', () => {
    it('sets hub mode state', () => {
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'http://localhost:8765', token: 'test-token' });
      expect(hubMode).toBe(true);
      expect(hubHttpUrl).toBe('http://localhost:8765');
      expect(hubToken).toBe('test-token');
    });

    it('disables hub mode when enabled is false', () => {
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'http://localhost:8765', token: 'test-token' });
      handleMessage({ type: 'configure_hub', enabled: false });
      expect(hubMode).toBe(false);
      expect(hubHttpUrl).toBe('');
      expect(hubToken).toBe('');
    });

    it('handles missing optional fields', () => {
      handleMessage({ type: 'configure_hub', enabled: true });
      expect(hubMode).toBe(true);
      expect(hubHttpUrl).toBe('');
      expect(hubToken).toBe('');
    });
  });

  describe('configure_hub URL validation', () => {
    it('accepts valid http URL', () => {
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'http://localhost:8765', token: 'token' });
      expect(hubHttpUrl).toBe('http://localhost:8765');
    });

    it('accepts valid https URL', () => {
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'https://hub.example.com', token: 'token' });
      expect(hubHttpUrl).toBe('https://hub.example.com');
    });

    it('rejects javascript: protocol URL', () => {
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'javascript:alert(1)', token: 'token' });
      expect(hubHttpUrl).toBe('');
    });

    it('rejects data: protocol URL', () => {
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'data:text/html,<h1>test</h1>', token: 'token' });
      expect(hubHttpUrl).toBe('');
    });

    it('rejects invalid URL format', () => {
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'not a url at all', token: 'token' });
      expect(hubHttpUrl).toBe('');
    });

    it('clears URL when httpUrl is empty', () => {
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'http://localhost:8765', token: 'token' });
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: '' });
      expect(hubHttpUrl).toBe('');
    });
  });

  describe('hub mode routing', () => {
    it('routes requests to hub URL with x-hub-token header', () => {
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'http://localhost:8765', token: 'my-hub-token' });
      const { headers, targetUrl } = buildHeaders({ 'content-type': 'application/json' }, 'https://localhost:5173/api/v1/messages');

      expect(targetUrl).toBe('http://localhost:8765/api/v1/messages');
      expect(headers['x-hub-token']).toBe('my-hub-token');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['content-type']).toBe('application/json');
    });

    it('does NOT include x-api-key in hub mode (hub injects it)', () => {
      handleMessage({ type: 'configure', apiKey: 'sk-local-key' });
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'http://localhost:8765', token: 'my-hub-token' });
      const { headers } = buildHeaders({}, 'https://localhost:5173/api/v1/messages');

      expect(headers['x-api-key']).toBeUndefined();
      expect(headers['x-hub-token']).toBe('my-hub-token');
    });

    it('falls back to local mode when hub mode is disabled', () => {
      handleMessage({ type: 'configure', apiKey: 'sk-local-key' });
      handleMessage({ type: 'configure_hub', enabled: false, httpUrl: 'http://localhost:8765', token: 'my-hub-token' });
      const { headers, targetUrl } = buildHeaders({}, 'https://localhost:5173/api/v1/messages');

      expect(targetUrl).toBe('https://localhost:5173/api/v1/messages');
      expect(headers['x-api-key']).toBe('sk-local-key');
      expect(headers['x-hub-token']).toBeUndefined();
    });

    it('falls back to local mode when hubHttpUrl is empty', () => {
      handleMessage({ type: 'configure', apiKey: 'sk-local-key' });
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: '', token: 'my-hub-token' });
      const { headers, targetUrl } = buildHeaders({}, 'https://localhost:5173/api/v1/messages');

      expect(targetUrl).toBe('https://localhost:5173/api/v1/messages');
      expect(headers['x-api-key']).toBe('sk-local-key');
      expect(headers['x-hub-token']).toBeUndefined();
    });

    it('preserves path from original request when routing to hub', () => {
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'http://localhost:8765', token: 'token' });
      const { targetUrl } = buildHeaders({}, 'https://localhost:5173/api/anthropic/v1/messages');
      expect(targetUrl).toBe('http://localhost:8765/api/anthropic/v1/messages');

      const { targetUrl: targetUrl2 } = buildHeaders({}, 'https://localhost:5173/api/v1/other/endpoint');
      expect(targetUrl2).toBe('http://localhost:8765/api/v1/other/endpoint');
    });
  });

  describe('getProviderFromPath', () => {
    it('detects anthropic from /api/anthropic/ prefix', () => {
      expect(getProviderFromPath('/api/anthropic/v1/messages')).toBe('anthropic');
    });

    it('detects openai from /api/openai/ prefix', () => {
      expect(getProviderFromPath('/api/openai/v1/chat/completions')).toBe('openai');
    });

    it('detects gemini from /api/gemini/ prefix', () => {
      expect(getProviderFromPath('/api/gemini/v1beta/openai/chat/completions')).toBe('gemini');
    });

    it('detects ollama from /api/ollama/ prefix', () => {
      expect(getProviderFromPath('/api/ollama/v1/chat/completions')).toBe('ollama');
    });

    it('defaults to anthropic for /api/v1/messages (backwards compat)', () => {
      expect(getProviderFromPath('/api/v1/messages')).toBe('anthropic');
    });

    it('defaults to anthropic for unknown /api/ paths', () => {
      expect(getProviderFromPath('/api/unknown/path')).toBe('anthropic');
    });
  });

  describe('configure_api_base message', () => {
    it('sets apiBaseUrl', () => {
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });
      expect(apiBaseUrl).toBe('https://api.flo.monster');
    });

    it('clears apiBaseUrl with empty string', () => {
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });
      handleMessage({ type: 'configure_api_base', apiBaseUrl: '' });
      expect(apiBaseUrl).toBe('');
    });

    it('clears apiBaseUrl when apiBaseUrl is undefined', () => {
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });
      handleMessage({ type: 'configure_api_base' });
      expect(apiBaseUrl).toBe('');
    });
  });

  describe('apiBaseUrl routing', () => {
    it('rewrites anthropic API requests to external URL', () => {
      handleMessage({ type: 'configure_keys', keys: { anthropic: 'sk-ant-test' } });
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });

      const { headers, targetUrl } = buildHeaders(
        { 'content-type': 'application/json' },
        'https://localhost:5173/api/anthropic/v1/messages',
      );

      expect(targetUrl).toBe('https://api.flo.monster/anthropic/v1/messages');
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['content-type']).toBe('application/json');
    });

    it('rewrites openai API requests to external URL', () => {
      handleMessage({ type: 'configure_keys', keys: { openai: 'sk-openai-test' } });
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });

      const { headers, targetUrl } = buildHeaders(
        {},
        'https://localhost:5173/api/openai/v1/chat/completions',
      );

      expect(targetUrl).toBe('https://api.flo.monster/openai/v1/chat/completions');
      expect(headers['Authorization']).toBe('Bearer sk-openai-test');
      expect(headers['x-api-key']).toBeUndefined();
    });

    it('rewrites gemini API requests to external URL', () => {
      handleMessage({ type: 'configure_keys', keys: { gemini: 'AIza-test' } });
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });

      const { headers, targetUrl } = buildHeaders(
        {},
        'https://localhost:5173/api/gemini/v1beta/openai/chat/completions',
      );

      expect(targetUrl).toBe('https://api.flo.monster/gemini/v1beta/openai/chat/completions');
      expect(headers['Authorization']).toBe('Bearer AIza-test');
    });

    it('strips /api prefix from path', () => {
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });

      const { targetUrl } = buildHeaders(
        {},
        'https://localhost:5173/api/anthropic/v1/messages',
      );

      // /api/anthropic/v1/messages → /anthropic/v1/messages
      expect(targetUrl).toBe('https://api.flo.monster/anthropic/v1/messages');
    });

    it('handles backwards-compat /api/v1/messages path', () => {
      handleMessage({ type: 'configure_keys', keys: { anthropic: 'sk-ant-test' } });
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });

      const { headers, targetUrl } = buildHeaders(
        {},
        'https://localhost:5173/api/v1/messages',
      );

      // /api/v1/messages → /v1/messages (provider defaults to anthropic)
      expect(targetUrl).toBe('https://api.flo.monster/v1/messages');
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('sets anthropic-version even without key for anthropic provider', () => {
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });

      const { headers } = buildHeaders(
        {},
        'https://localhost:5173/api/anthropic/v1/messages',
      );

      expect(headers['x-api-key']).toBeUndefined();
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('hub mode takes precedence over apiBaseUrl', () => {
      handleMessage({ type: 'configure_keys', keys: { anthropic: 'sk-ant-test' } });
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'http://localhost:8765', token: 'hub-token' });
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });

      const { headers, targetUrl } = buildHeaders(
        {},
        'https://localhost:5173/api/anthropic/v1/messages',
      );

      // hubMode should win over apiBaseUrl
      expect(targetUrl).toBe('http://localhost:8765/api/anthropic/v1/messages');
      expect(headers['x-hub-token']).toBe('hub-token');
      expect(headers['x-api-key']).toBeUndefined();
    });

    it('uses apiBaseUrl when hub mode is disabled', () => {
      handleMessage({ type: 'configure_keys', keys: { anthropic: 'sk-ant-test' } });
      handleMessage({ type: 'configure_hub', enabled: false });
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });

      const { headers, targetUrl } = buildHeaders(
        {},
        'https://localhost:5173/api/anthropic/v1/messages',
      );

      expect(targetUrl).toBe('https://api.flo.monster/anthropic/v1/messages');
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers['x-hub-token']).toBeUndefined();
    });

    it('falls back to local mode when apiBaseUrl is empty', () => {
      handleMessage({ type: 'configure', apiKey: 'sk-local-key' });
      handleMessage({ type: 'configure_api_base', apiBaseUrl: '' });

      const { headers, targetUrl } = buildHeaders(
        {},
        'https://localhost:5173/api/v1/messages',
      );

      expect(targetUrl).toBe('https://localhost:5173/api/v1/messages');
      expect(headers['x-api-key']).toBe('sk-local-key');
    });

    it('does not add Authorization for providers without a key', () => {
      handleMessage({ type: 'configure_keys', keys: { anthropic: 'sk-ant-test' } });
      handleMessage({ type: 'configure_api_base', apiBaseUrl: 'https://api.flo.monster' });

      const { headers } = buildHeaders(
        {},
        'https://localhost:5173/api/openai/v1/chat/completions',
      );

      // No openai key configured — buildHeaders still works (for test helper)
      // but the SW would return a 401 error before reaching buildHeaders
      expect(headers['Authorization']).toBeUndefined();
      expect(headers['x-api-key']).toBeUndefined();
    });
  });

  describe('missing API key check', () => {
    it('returns error when no key for requested provider', () => {
      handleMessage({ type: 'configure_keys', keys: { anthropic: 'sk-ant-test' } });

      const error = getMissingKeyError('https://localhost:5173/api/openai/v1/chat/completions');
      expect(error).toContain('No OpenAI API key configured');
      expect(error).toContain('Settings');
    });

    it('returns null when key exists for provider', () => {
      handleMessage({ type: 'configure_keys', keys: { openai: 'sk-openai-test' } });

      const error = getMissingKeyError('https://localhost:5173/api/openai/v1/chat/completions');
      expect(error).toBeNull();
    });

    it('returns null when in hub mode (hub handles keys)', () => {
      // No local keys configured, but hub mode is on
      handleMessage({ type: 'configure_hub', enabled: true, httpUrl: 'https://hub.example.com:8765', token: 'tok' });

      const error = getMissingKeyError('https://localhost:5173/api/openai/v1/chat/completions');
      expect(error).toBeNull();
    });

    it('returns error for each provider without a key', () => {
      const anthropicErr = getMissingKeyError('https://localhost:5173/api/anthropic/v1/messages');
      expect(anthropicErr).toContain('No Anthropic API key configured');

      const geminiErr = getMissingKeyError('https://localhost:5173/api/gemini/v1beta/openai/chat/completions');
      expect(geminiErr).toContain('No Gemini API key configured');

      const ollamaErr = getMissingKeyError('https://localhost:5173/api/ollama/v1/chat/completions');
      expect(ollamaErr).toContain('No Ollama API key configured');
    });

    it('returns null when all requested providers have keys', () => {
      handleMessage({ type: 'configure_keys', keys: { anthropic: 'sk-ant', openai: 'sk-oai', gemini: 'AIza' } });

      expect(getMissingKeyError('https://localhost:5173/api/anthropic/v1/messages')).toBeNull();
      expect(getMissingKeyError('https://localhost:5173/api/openai/v1/chat/completions')).toBeNull();
      expect(getMissingKeyError('https://localhost:5173/api/gemini/v1beta/openai/chat/completions')).toBeNull();
    });
  });
});
