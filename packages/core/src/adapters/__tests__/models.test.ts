import { describe, it, expect } from 'vitest';
import { ALL_MODELS, MODEL_ALIASES, resolveModelId, getModelsForProvider, getModelInfo, getProviderForModel, getAdapter, getAvailableProviders } from '../models.js';

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

    it('includes new Claude 4.6 models', () => {
      expect(ALL_MODELS['claude-opus-4-6']).toBeDefined();
      expect(ALL_MODELS['claude-opus-4-6'].displayName).toBe('Claude Opus 4.6');
      expect(ALL_MODELS['claude-sonnet-4-6']).toBeDefined();
      expect(ALL_MODELS['claude-sonnet-4-6'].displayName).toBe('Claude Sonnet 4.6');
    });

    it('includes new OpenAI models', () => {
      expect(ALL_MODELS['gpt-5.2']).toBeDefined();
      expect(ALL_MODELS['gpt-5.2'].displayName).toBe('GPT-5.2');
      expect(ALL_MODELS['gpt-5.2-pro']).toBeDefined();
      expect(ALL_MODELS['gpt-5-mini']).toBeDefined();
      expect(ALL_MODELS['gpt-4.1']).toBeDefined();
      expect(ALL_MODELS['gpt-4.1-mini']).toBeDefined();
      expect(ALL_MODELS['gpt-4.1-nano']).toBeDefined();
      expect(ALL_MODELS['o3']).toBeDefined();
      expect(ALL_MODELS['o4-mini']).toBeDefined();
    });

    it('includes new Gemini models', () => {
      expect(ALL_MODELS['gemini-3-flash-preview']).toBeDefined();
      expect(ALL_MODELS['gemini-3-flash-preview'].displayName).toBe('Gemini 3 Flash Preview');
      expect(ALL_MODELS['gemini-3.1-pro-preview']).toBeDefined();
      expect(ALL_MODELS['gemini-3.1-pro-preview'].displayName).toBe('Gemini 3.1 Pro Preview');
    });

    it('has correct corrected model IDs for Claude 4.5', () => {
      expect(ALL_MODELS['claude-sonnet-4-5-20250929']).toBeDefined();
      expect(ALL_MODELS['claude-haiku-4-5-20251001']).toBeDefined();
      // Old wrong IDs should NOT be in the registry
      expect(ALL_MODELS['claude-sonnet-4-5-20251101']).toBeUndefined();
      expect(ALL_MODELS['claude-haiku-4-5-20251101']).toBeUndefined();
    });
  });

  describe('resolveModelId', () => {
    it('resolves aliased model IDs to canonical IDs', () => {
      expect(resolveModelId('claude-sonnet-4-5-20251101')).toBe('claude-sonnet-4-5-20250929');
      expect(resolveModelId('claude-haiku-4-5-20251101')).toBe('claude-haiku-4-5-20251001');
    });

    it('passes through unknown model IDs unchanged', () => {
      expect(resolveModelId('gpt-4o')).toBe('gpt-4o');
      expect(resolveModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
      expect(resolveModelId('some-future-model')).toBe('some-future-model');
    });

    it('passes through canonical IDs unchanged', () => {
      expect(resolveModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
      expect(resolveModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
    });
  });

  describe('MODEL_ALIASES', () => {
    it('maps old wrong IDs to correct IDs', () => {
      expect(MODEL_ALIASES['claude-sonnet-4-5-20251101']).toBe('claude-sonnet-4-5-20250929');
      expect(MODEL_ALIASES['claude-haiku-4-5-20251101']).toBe('claude-haiku-4-5-20251001');
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

    it('resolves aliased model IDs', () => {
      const info = getModelInfo('claude-sonnet-4-5-20251101');
      expect(info).toBeDefined();
      expect(info!.id).toBe('claude-sonnet-4-5-20250929');
      expect(info!.displayName).toBe('Claude Sonnet 4.5');
    });

    it('resolves aliased haiku model ID', () => {
      const info = getModelInfo('claude-haiku-4-5-20251101');
      expect(info).toBeDefined();
      expect(info!.id).toBe('claude-haiku-4-5-20251001');
      expect(info!.displayName).toBe('Claude Haiku 4.5');
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

    it('resolves aliased model IDs', () => {
      expect(getProviderForModel('claude-sonnet-4-5-20251101')).toBe('anthropic');
      expect(getProviderForModel('claude-haiku-4-5-20251101')).toBe('anthropic');
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

    it('returns gemini adapter for gemini', () => {
      const adapter = getAdapter('gemini');
      expect(adapter.id).toBe('gemini');
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
