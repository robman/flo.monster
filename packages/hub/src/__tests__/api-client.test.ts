/**
 * Tests for API client module
 */

import { describe, it, expect } from 'vitest';
import { resolveUpstreamUrl, createSendApiRequest, type ApiClientConfig } from '../api-client.js';
import { getDefaultConfig, type HubConfig } from '../config.js';

const config: HubConfig = { ...getDefaultConfig(), sharedApiKeys: { anthropic: 'sk-test-key' } };

describe('API client', () => {
  describe('resolveUpstreamUrl', () => {
    it('should resolve Anthropic route with explicit prefix', () => {
      const route = resolveUpstreamUrl('/api/anthropic/v1/messages', config);
      expect(route).toEqual({
        upstreamUrl: 'https://api.anthropic.com/v1/messages',
        provider: 'anthropic',
      });
    });

    it('should resolve Anthropic route without prefix (backwards compat)', () => {
      const route = resolveUpstreamUrl('/api/v1/messages', config);
      expect(route).toEqual({
        upstreamUrl: 'https://api.anthropic.com/v1/messages',
        provider: 'anthropic',
      });
    });

    it('should resolve OpenAI route', () => {
      const route = resolveUpstreamUrl('/api/openai/v1/chat/completions', config);
      expect(route).toEqual({
        upstreamUrl: 'https://api.openai.com/v1/chat/completions',
        provider: 'openai',
      });
    });

    it('should resolve Gemini route', () => {
      const route = resolveUpstreamUrl('/api/gemini/v1beta/openai/chat/completions', config);
      expect(route).toEqual({
        upstreamUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        provider: 'gemini',
      });
    });

    it('should resolve Ollama route with default endpoint', () => {
      const route = resolveUpstreamUrl('/api/ollama/v1/chat/completions', config);
      expect(route).toEqual({
        upstreamUrl: 'http://localhost:11434/v1/chat/completions',
        provider: 'ollama',
      });
    });

    it('should resolve Ollama route with custom endpoint', () => {
      const customConfig: HubConfig = {
        ...config,
        providers: {
          ollama: { endpoint: 'http://192.168.1.100:11434' },
        },
      };
      const route = resolveUpstreamUrl('/api/ollama/v1/chat/completions', customConfig);
      expect(route).toEqual({
        upstreamUrl: 'http://192.168.1.100:11434/v1/chat/completions',
        provider: 'ollama',
      });
    });

    it('should return null for unknown routes', () => {
      expect(resolveUpstreamUrl('/api/status', config)).toBeNull();
      expect(resolveUpstreamUrl('/api/unknown/path', config)).toBeNull();
      expect(resolveUpstreamUrl('/other/path', config)).toBeNull();
    });
  });

  describe('createSendApiRequest', () => {
    it('should return a function with correct signature', () => {
      const clientConfig: ApiClientConfig = {
        hubConfig: config,
        provider: 'anthropic',
      };
      const sendApiRequest = createSendApiRequest(clientConfig);
      expect(typeof sendApiRequest).toBe('function');
      expect(sendApiRequest.length).toBe(3); // body, headers, url
    });

    it('should return an async iterable when called with explicit prefix', () => {
      const clientConfig: ApiClientConfig = {
        hubConfig: config,
        provider: 'anthropic',
      };
      const sendApiRequest = createSendApiRequest(clientConfig);
      const result = sendApiRequest('{}', {}, '/api/anthropic/v1/messages');
      // Should be an async iterable (has Symbol.asyncIterator)
      expect(result[Symbol.asyncIterator]).toBeDefined();
      expect(typeof result[Symbol.asyncIterator]).toBe('function');
    });

    it('should return an async iterable when called with legacy path', () => {
      const clientConfig: ApiClientConfig = {
        hubConfig: config,
        provider: 'anthropic',
      };
      const sendApiRequest = createSendApiRequest(clientConfig);
      const result = sendApiRequest('{}', {}, '/api/v1/messages');
      // Should be an async iterable (has Symbol.asyncIterator)
      expect(result[Symbol.asyncIterator]).toBeDefined();
      expect(typeof result[Symbol.asyncIterator]).toBe('function');
    });
  });
});
