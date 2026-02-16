import type { TokenUsage } from '../types/messages.js';

/**
 * Accumulate token usage from a delta into a current total.
 *
 * For required fields (input_tokens, output_tokens), values are always summed.
 * For optional cache fields, the result is undefined only if both current and
 * delta are undefined; otherwise they are summed (treating undefined as 0).
 */
export function accumulateUsage(current: TokenUsage, delta: TokenUsage): TokenUsage {
  return {
    input_tokens: current.input_tokens + delta.input_tokens,
    output_tokens: current.output_tokens + delta.output_tokens,
    cache_creation_input_tokens:
      (current.cache_creation_input_tokens !== undefined || delta.cache_creation_input_tokens !== undefined)
        ? (current.cache_creation_input_tokens ?? 0) + (delta.cache_creation_input_tokens ?? 0)
        : undefined,
    cache_read_input_tokens:
      (current.cache_read_input_tokens !== undefined || delta.cache_read_input_tokens !== undefined)
        ? (current.cache_read_input_tokens ?? 0) + (delta.cache_read_input_tokens ?? 0)
        : undefined,
  };
}
