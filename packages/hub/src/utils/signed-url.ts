/**
 * HMAC-SHA256 signed URL utility for serving agent files.
 * Signs URLs with agent ID, file path, and expiry time.
 * Verifies signatures using timing-safe comparison.
 */

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

/** Default URL expiry: 1 hour */
const DEFAULT_EXPIRY_MS = 60 * 60 * 1000;

/**
 * Generate a random 32-byte signing secret.
 * Called once at server startup, held in memory.
 */
export function generateSigningSecret(): Buffer {
  return randomBytes(32);
}

/**
 * Sign a URL for a specific agent file.
 * Returns signature and expiry timestamp as query parameters.
 */
export function signUrl(
  secret: Buffer,
  agentId: string,
  filePath: string,
  expiryMs: number = DEFAULT_EXPIRY_MS,
): { sig: string; exp: number } {
  const exp = Date.now() + expiryMs;
  const message = `${agentId}/${filePath}:${exp}`;
  const sig = createHmac('sha256', secret).update(message).digest('hex');
  return { sig, exp };
}

/**
 * Verify a signed URL.
 * Checks expiry and uses timing-safe comparison for the signature.
 */
export function verifySignedUrl(
  secret: Buffer,
  agentId: string,
  filePath: string,
  sig: string,
  exp: number,
): boolean {
  // Check expiry first
  if (Date.now() > exp) return false;

  // Recompute expected signature
  const message = `${agentId}/${filePath}:${exp}`;
  const expected = createHmac('sha256', secret).update(message).digest('hex');

  // Timing-safe compare
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
