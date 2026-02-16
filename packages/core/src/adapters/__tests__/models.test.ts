import { describe, it, expect } from 'vitest';
import { ALL_MODELS, getModelsForProvider, getModelInfo, getProviderForModel, getAdapter, getAvailableProviders } from '../models.js';

describe('Model Registry', () => {
  describe('ALL_MODELS', () => {
    it('includes Anthropic models', () => {
      expect(ALL_MODELS['claude-sonnet-4-20250514']).toBeDefined();
      expect(ALL_MODELS['claude-sonnet-4-20250514'].provider).toBe('anthropic');
    });

    it('includes OpenAI models', () => {
      expect(ALL_MODELS['gpt-4o']).toBeDefined();
      expect(ALL_MODELS['gpt-4o'].provider).toBe('openai');
    });

    it('includes Gemini models', () => {
      expect(ALL_MODELS['gemini-2.0-flash']).toBeDefined();
      expect(ALL_MODELS['gemini-2.0-flash'].provider).toBe('gemini');
    });
  });

  describe('getModelsForProvider', () => {
    it('returns only Anthropic models', () => {
      const models = getModelsForProvider('anthropic');
      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.provider === 'anthropic')).toBe(true);
    });

    it('returns only OpenAI models', () => {
      const models = getModelsForProvider('openai');
      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.provider === 'openai')).toBe(true);
    });

    it('returns only Gemini models', () => {
      const models = getModelsForProvider('gemini');
      expect(models.length).toBeGreaterThan(0);
      expect(models.every(m => m.provider === 'gemini')).toBe(true);
    });

    it('returns empty for unknown provider', () => {
      const models = getModelsForProvider('unknown');
      expect(models).toHaveLength(0);
    });
  });

  describe('getModelInfo', () => {
    it('returns model info for known model', () => {
      const info = getModelInfo('gpt-4o');
      expect(info).toBeDefined();
      expect(info!.displayName).toBe('GPT-4o');
    });

    it('returns undefined for unknown model', () => {
      const info = getModelInfo('unknown-model');
      expect(info).toBeUndefined();
    });
  });

  describe('getProviderForModel', () => {
    it('returns correct provider for known models', () => {
      expect(getProviderForModel('claude-sonnet-4-20250514')).toBe('anthropic');
      expect(getProviderForModel('gpt-4o')).toBe('openai');
      expect(getProviderForModel('gemini-2.0-flash')).toBe('gemini');
    });

    it('defaults to anthropic for unknown models', () => {
      expect(getProviderForModel('unknown')).toBe('anthropic');
    });
  });

  describe('getAdapter', () => {
    it('returns anthropic adapter for anthropic', () => {
      const adapter = getAdapter('anthropic');
      expect(adapter.id).toBe('anthropic');
    });

    it('returns openai-chat adapter for openai', () => {
      const adapter = getAdapter('openai');
      expect(adapter.id).toBe('openai-chat');
    });

    it('returns openai-chat adapter for gemini', () => {
      const adapter = getAdapter('gemini');
      expect(adapter.id).toBe('openai-chat');
    });

    it('returns openai-chat adapter for ollama', () => {
      const adapter = getAdapter('ollama');
      expect(adapter.id).toBe('openai-chat');
    });

    it('defaults to anthropic for unknown provider', () => {
      const adapter = getAdapter('unknown');
      expect(adapter.id).toBe('anthropic');
    });
  });

  describe('getAvailableProviders', () => {
    it('returns all providers', () => {
      const providers = getAvailableProviders();
      expect(providers).toContain('anthropic');
      expect(providers).toContain('openai');
      expect(providers).toContain('gemini');
    });

    it('always includes ollama even though it has no models in the registry', () => {
      const providers = getAvailableProviders();
      expect(providers).toContain('ollama');
    });
  });
});
