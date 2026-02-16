import type { TokenUsage } from '../types/messages.js';
import type { CostEstimate, ModelInfo } from '../types/provider.js';

/**
 * Calculate the cost of a request from token usage and model pricing.
 *
 * Handles the base input/output cost calculation that is shared across
 * all providers. Anthropic-specific cache pricing (cache_creation and
 * cache_read tokens) is also handled here since the ModelInfo pricing
 * type already supports those optional fields.
 */
export function calculateCost(
  usage: TokenUsage,
  pricing: ModelInfo['pricing'],
): CostEstimate {
  const inputCost = (usage.input_tokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.outputPerMillion;

  let cacheCost = 0;
  if (usage.cache_creation_input_tokens && pricing.cacheCreationPerMillion) {
    cacheCost += (usage.cache_creation_input_tokens / 1_000_000) * pricing.cacheCreationPerMillion;
  }
  if (usage.cache_read_input_tokens && pricing.cacheReadPerMillion) {
    cacheCost += (usage.cache_read_input_tokens / 1_000_000) * pricing.cacheReadPerMillion;
  }

  return {
    inputCost: inputCost + cacheCost,
    outputCost,
    totalCost: inputCost + outputCost + cacheCost,
    currency: 'USD',
  };
}
