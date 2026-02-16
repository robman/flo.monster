import { describe, it, expect } from 'vitest';
import { checkNetworkPolicy } from '../../utils/network-policy.js';

// We test the redirect protection logic via the shared checkNetworkPolicy utility
// since executeFetch requires complex mocking of fetch, AgentContainer, etc.
// The key security property is: redirects are re-checked against network policy.

describe('fetch redirect protection logic', () => {
  it('re-checks redirect target against allowlist policy', () => {
    const policy = { mode: 'allowlist' as const, allowedDomains: ['safe.com'] };

    // Original URL is allowed
    expect(() => checkNetworkPolicy('https://safe.com/page', policy)).not.toThrow();

    // Redirect target is not allowed
    expect(() => checkNetworkPolicy('https://evil.com/steal', policy)).toThrow('not allowed');
  });

  it('re-checks redirect target against blocklist policy', () => {
    const policy = { mode: 'blocklist' as const, blockedDomains: ['evil.com'] };

    // Original URL is allowed
    expect(() => checkNetworkPolicy('https://safe.com/page', policy)).not.toThrow();

    // Redirect target is blocked
    expect(() => checkNetworkPolicy('https://evil.com/steal', policy)).toThrow('blocked');
  });

  it('allows redirect to safe domain with policy', () => {
    const policy = { mode: 'allowlist' as const, allowedDomains: ['safe.com', 'also-safe.com'] };
    expect(() => checkNetworkPolicy('https://safe.com/page', policy)).not.toThrow();
    expect(() => checkNetworkPolicy('https://also-safe.com/redirect', policy)).not.toThrow();
  });
});
