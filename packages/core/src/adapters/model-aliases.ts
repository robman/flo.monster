/**
 * Aliases for old/incorrect model IDs that may exist in saved agent configs.
 * Maps old ID → canonical ID so existing agents continue to work.
 *
 * This is in a separate module to avoid circular imports between
 * models.ts ↔ anthropic.ts/openai.ts.
 */
export const MODEL_ALIASES: Record<string, string> = {
  'claude-sonnet-4-5-20251101': 'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251101': 'claude-haiku-4-5-20251001',
};

/**
 * Resolve a model ID through the alias map.
 * Returns the canonical ID if an alias exists, or the input unchanged.
 */
export function resolveModelId(modelId: string): string {
  return MODEL_ALIASES[modelId] ?? modelId;
}
