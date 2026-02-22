import type { ProviderAdapter, ModelInfo } from '../types/provider.js';
import { MODEL_PRICING } from '../data/model-pricing.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createOpenAIChatAdapter } from './openai.js';
import { createGeminiAdapter } from './gemini.js';
export { MODEL_ALIASES, resolveModelId } from './model-aliases.js';
import { resolveModelId } from './model-aliases.js';

/**
 * Combined model registry across all providers.
 * Single source of truth — loaded from data/model-pricing.ts.
 */
export const ALL_MODELS: Record<string, ModelInfo> = MODEL_PRICING;

/**
 * Get all models for a specific provider.
 */
export function getModelsForProvider(provider: string): ModelInfo[] {
  return Object.values(ALL_MODELS).filter(m => m.provider === provider);
}

/**
 * Get a model by its ID. Resolves aliases first.
 */
export function getModelInfo(modelId: string): ModelInfo | undefined {
  return ALL_MODELS[resolveModelId(modelId)];
}

/**
 * Get the provider for a model ID. Resolves aliases first.
 * Returns 'anthropic' for unknown models (backward compatibility).
 */
export function getProviderForModel(modelId: string): string {
  const model = ALL_MODELS[resolveModelId(modelId)];
  return model?.provider || 'anthropic';
}

/**
 * Get the correct adapter for a given provider.
 */
export function getAdapter(provider: string): ProviderAdapter {
  switch (provider) {
    case 'gemini':
      return createGeminiAdapter();
    case 'openai':
    case 'ollama':
      return createOpenAIChatAdapter();
    case 'anthropic':
    default:
      return createAnthropicAdapter();
  }
}

/**
 * Get all available provider IDs.
 */
export function getAvailableProviders(): string[] {
  const providers = new Set<string>();
  for (const model of Object.values(ALL_MODELS)) {
    providers.add(model.provider);
  }
  // Ollama is always available (models are user-installed, not in registry)
  providers.add('ollama');
  return Array.from(providers);
}
