/**
 * Hub server authentication
 */

import { timingSafeEqual } from 'node:crypto';
import type { HubConfig } from './config.js';

/**
 * Timing-safe string comparison to prevent timing attacks
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do the comparison to maintain constant time for same-length strings
    // but return false for different lengths
    const dummy = Buffer.alloc(a.length);
    timingSafeEqual(Buffer.from(a), dummy);
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Check if a connection is from localhost
 */
export function isLocalhost(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return false;
  }

  // Normalize IPv6-mapped IPv4 addresses
  const normalized = remoteAddress.replace(/^::ffff:/, '');

  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === 'localhost' ||
    normalized.startsWith('127.')
  );
}

/**
 * Validate an authentication token
 */
export function validateToken(
  token: string | undefined,
  config: HubConfig,
  remoteAddress: string | undefined
): boolean {
  // If localhost bypass is enabled and connection is from localhost, allow
  if (config.localhostBypassAuth && isLocalhost(remoteAddress)) {
    return true;
  }

  // If no auth token is configured and not localhost, reject
  if (!config.authToken) {
    return false;
  }

  // If no token provided, reject
  if (!token) {
    return false;
  }

  // Validate token using timing-safe comparison
  return timingSafeCompare(token, config.authToken);
}

/**
 * Generate a secure random token
 */
export function generateToken(length: number = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}
