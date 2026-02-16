/**
 * Generate a unique request ID for request/response correlation.
 *
 * Uses a timestamp + random suffix pattern:
 *   `${prefix}-${Date.now()}-${random}`
 *
 * This is the canonical algorithm for importable TS modules. Self-contained
 * bundles (worker-bundle.js, iframe-template.ts) use equivalent inline
 * implementations:
 * - worker-bundle.js uses a sequential counter: `req-${++nextReqId}`
 * - iframe-template.ts uses the same timestamp+random pattern inline
 *
 * @param prefix - A short string identifying the request type (e.g. "dom", "fetch", "storage")
 * @returns A unique request ID string
 */
export function generateRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
