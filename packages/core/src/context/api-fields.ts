/**
 * Allowlisted fields for API message bodies.
 *
 * Only these fields are sent to LLM providers. Everything else
 * (turnId, type, messageType, timestamp, etc.) is internal metadata
 * for context tracking and UI rendering.
 *
 * Used by both hub (buildContextForLoop) and browser (api-handler)
 * to ensure conversation metadata never reaches LLM providers.
 */

/** Anthropic / OpenAI / Ollama message fields. */
export const MESSAGE_API_FIELDS: ReadonlySet<string> = new Set([
  'role', 'content',                      // All providers
  'tool_calls', 'tool_call_id', 'name',   // OpenAI/Ollama
]);

/** Gemini native content fields. */
export const GEMINI_API_FIELDS: ReadonlySet<string> = new Set([
  'role', 'parts',
]);

/**
 * Strip internal metadata from a message, keeping only API-allowed fields.
 */
export function toApiMessage(
  msg: Record<string, unknown>,
  allowedFields: ReadonlySet<string> = MESSAGE_API_FIELDS,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(msg)) {
    if (allowedFields.has(key)) {
      result[key] = msg[key];
    }
  }
  return result;
}
