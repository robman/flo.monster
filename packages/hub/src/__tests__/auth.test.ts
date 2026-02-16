/**
 * Tests for hub authentication
 */

import { describe, it, expect } from 'vitest';
import { isLocalhost, validateToken, generateToken } from '../auth.js';
import { getDefaultConfig } from '../config.js';

describe('auth', () => {
  describe('isLocalhost', () => {
    it('should return true for 127.0.0.1', () => {
      expect(isLocalhost('127.0.0.1')).toBe(true);
    });

    it('should return true for ::1', () => {
      expect(isLocalhost('::1')).toBe(true);
    });

    it('should return true for IPv6-mapped localhost', () => {
      expect(isLocalhost('::ffff:127.0.0.1')).toBe(true);
    });

    it('should return true for 127.x.x.x addresses', () => {
      expect(isLocalhost('127.0.0.2')).toBe(true);
      expect(isLocalhost('127.255.255.255')).toBe(true);
    });

    it('should return false for external IPs', () => {
      expect(isLocalhost('192.168.1.1')).toBe(false);
      expect(isLocalhost('10.0.0.1')).toBe(false);
      expect(isLocalhost('8.8.8.8')).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isLocalhost(undefined)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isLocalhost('')).toBe(false);
    });
  });

  describe('validateToken', () => {
    it('should allow localhost when bypass is enabled', () => {
      const config = { ...getDefaultConfig(), localhostBypassAuth: true };

      expect(validateToken(undefined, config, '127.0.0.1')).toBe(true);
      expect(validateToken('wrong-token', config, '127.0.0.1')).toBe(true);
    });

    it('should require token when bypass is disabled', () => {
      const config = {
        ...getDefaultConfig(),
        localhostBypassAuth: false,
        authToken: 'secret',
      };

      expect(validateToken(undefined, config, '127.0.0.1')).toBe(false);
      expect(validateToken('wrong', config, '127.0.0.1')).toBe(false);
      expect(validateToken('secret', config, '127.0.0.1')).toBe(true);
    });

    it('should reject when no token configured and not localhost', () => {
      const config = { ...getDefaultConfig(), authToken: undefined };

      expect(validateToken(undefined, config, '192.168.1.1')).toBe(false);
    });

    it('should validate token for remote connections', () => {
      const config = { ...getDefaultConfig(), authToken: 'my-token' };

      expect(validateToken('my-token', config, '192.168.1.1')).toBe(true);
      expect(validateToken('wrong-token', config, '192.168.1.1')).toBe(false);
    });

    it('should use timing-safe comparison (different length tokens)', () => {
      const config = { ...getDefaultConfig(), authToken: 'correct-token-here' };

      // Different length should fail
      expect(validateToken('short', config, '192.168.1.1')).toBe(false);
      expect(validateToken('this-is-a-much-longer-token-than-the-correct-one', config, '192.168.1.1')).toBe(false);
    });

    it('should use timing-safe comparison (same length tokens)', () => {
      const config = { ...getDefaultConfig(), authToken: 'secret-token-123' };

      // Same length but different content should fail
      expect(validateToken('wrong--token-123', config, '192.168.1.1')).toBe(false);
      expect(validateToken('secret-token-124', config, '192.168.1.1')).toBe(false);

      // Exact match should pass
      expect(validateToken('secret-token-123', config, '192.168.1.1')).toBe(true);
    });
  });

  describe('generateToken', () => {
    it('should generate token of specified length', () => {
      const token = generateToken(16);
      expect(token.length).toBe(16);
    });

    it('should generate default length of 32', () => {
      const token = generateToken();
      expect(token.length).toBe(32);
    });

    it('should generate unique tokens', () => {
      const token1 = generateToken();
      const token2 = generateToken();
      expect(token1).not.toBe(token2);
    });

    it('should only contain alphanumeric characters', () => {
      const token = generateToken(100);
      expect(token).toMatch(/^[A-Za-z0-9]+$/);
    });
  });
});
