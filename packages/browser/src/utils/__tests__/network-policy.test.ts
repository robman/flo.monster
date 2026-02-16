import { describe, it, expect } from 'vitest';
import { checkNetworkPolicy } from '../network-policy.js';

describe('checkNetworkPolicy', () => {
  it('passes when no policy is set', () => {
    expect(() => checkNetworkPolicy('https://example.com')).not.toThrow();
  });

  it('passes when policy is allow-all', () => {
    expect(() => checkNetworkPolicy('https://example.com', { mode: 'allow-all' })).not.toThrow();
  });

  describe('allowlist mode', () => {
    const policy = { mode: 'allowlist' as const, allowedDomains: ['example.com', 'api.test.org'] };

    it('allows listed domains', () => {
      expect(() => checkNetworkPolicy('https://example.com/path', policy)).not.toThrow();
    });

    it('allows subdomains of listed domains', () => {
      expect(() => checkNetworkPolicy('https://sub.example.com/path', policy)).not.toThrow();
    });

    it('blocks unlisted domains', () => {
      expect(() => checkNetworkPolicy('https://evil.com', policy)).toThrow('not allowed');
    });

    it('blocks partial domain matches', () => {
      expect(() => checkNetworkPolicy('https://notexample.com', policy)).toThrow('not allowed');
    });
  });

  describe('blocklist mode', () => {
    const policy = { mode: 'blocklist' as const, blockedDomains: ['evil.com', 'malware.org'] };

    it('blocks listed domains', () => {
      expect(() => checkNetworkPolicy('https://evil.com/path', policy)).toThrow('blocked');
    });

    it('blocks subdomains of listed domains', () => {
      expect(() => checkNetworkPolicy('https://sub.evil.com', policy)).toThrow('blocked');
    });

    it('allows unlisted domains', () => {
      expect(() => checkNetworkPolicy('https://example.com', policy)).not.toThrow();
    });

    it('allows partial domain name matches', () => {
      expect(() => checkNetworkPolicy('https://notevil.com', policy)).not.toThrow();
    });
  });
});
