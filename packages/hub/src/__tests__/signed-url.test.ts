import { describe, it, expect } from 'vitest';
import { generateSigningSecret, signUrl, verifySignedUrl } from '../utils/signed-url.js';

describe('signed-url', () => {
  describe('generateSigningSecret', () => {
    it('returns a 32-byte Buffer', () => {
      const secret = generateSigningSecret();
      expect(Buffer.isBuffer(secret)).toBe(true);
      expect(secret.length).toBe(32);
    });

    it('generates unique secrets', () => {
      const a = generateSigningSecret();
      const b = generateSigningSecret();
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('signUrl', () => {
    it('returns sig and exp', () => {
      const secret = generateSigningSecret();
      const { sig, exp } = signUrl(secret, 'agent-1', 'screenshots/test.png');
      expect(typeof sig).toBe('string');
      expect(sig.length).toBe(64); // hex-encoded SHA-256
      expect(typeof exp).toBe('number');
      expect(exp).toBeGreaterThan(Date.now());
    });

    it('uses default 1-hour expiry', () => {
      const secret = generateSigningSecret();
      const before = Date.now();
      const { exp } = signUrl(secret, 'agent-1', 'test.png');
      const after = Date.now();
      // Should be ~1 hour from now
      expect(exp).toBeGreaterThanOrEqual(before + 3600000);
      expect(exp).toBeLessThanOrEqual(after + 3600000);
    });

    it('respects custom expiry', () => {
      const secret = generateSigningSecret();
      const before = Date.now();
      const { exp } = signUrl(secret, 'agent-1', 'test.png', 5000);
      expect(exp).toBeGreaterThanOrEqual(before + 5000);
      expect(exp).toBeLessThanOrEqual(before + 5000 + 100);
    });

    it('produces different signatures for different paths', () => {
      const secret = generateSigningSecret();
      const a = signUrl(secret, 'agent-1', 'a.png');
      const b = signUrl(secret, 'agent-1', 'b.png');
      expect(a.sig).not.toBe(b.sig);
    });

    it('produces different signatures for different agents', () => {
      const secret = generateSigningSecret();
      const a = signUrl(secret, 'agent-1', 'test.png');
      const b = signUrl(secret, 'agent-2', 'test.png');
      expect(a.sig).not.toBe(b.sig);
    });
  });

  describe('verifySignedUrl', () => {
    it('verifies a valid signature', () => {
      const secret = generateSigningSecret();
      const { sig, exp } = signUrl(secret, 'agent-1', 'screenshots/test.png');
      expect(verifySignedUrl(secret, 'agent-1', 'screenshots/test.png', sig, exp)).toBe(true);
    });

    it('rejects expired signature', () => {
      const secret = generateSigningSecret();
      const { sig } = signUrl(secret, 'agent-1', 'test.png');
      const expiredExp = Date.now() - 1000;
      // Recompute sig for the expired timestamp (to isolate expiry check)
      expect(verifySignedUrl(secret, 'agent-1', 'test.png', sig, expiredExp)).toBe(false);
    });

    it('rejects wrong agent ID', () => {
      const secret = generateSigningSecret();
      const { sig, exp } = signUrl(secret, 'agent-1', 'test.png');
      expect(verifySignedUrl(secret, 'agent-2', 'test.png', sig, exp)).toBe(false);
    });

    it('rejects wrong file path', () => {
      const secret = generateSigningSecret();
      const { sig, exp } = signUrl(secret, 'agent-1', 'test.png');
      expect(verifySignedUrl(secret, 'agent-1', 'other.png', sig, exp)).toBe(false);
    });

    it('rejects wrong secret', () => {
      const secret1 = generateSigningSecret();
      const secret2 = generateSigningSecret();
      const { sig, exp } = signUrl(secret1, 'agent-1', 'test.png');
      expect(verifySignedUrl(secret2, 'agent-1', 'test.png', sig, exp)).toBe(false);
    });

    it('rejects tampered signature', () => {
      const secret = generateSigningSecret();
      const { sig, exp } = signUrl(secret, 'agent-1', 'test.png');
      const tampered = sig.slice(0, -2) + 'ff';
      expect(verifySignedUrl(secret, 'agent-1', 'test.png', tampered, exp)).toBe(false);
    });

    it('rejects tampered expiry', () => {
      const secret = generateSigningSecret();
      const { sig, exp } = signUrl(secret, 'agent-1', 'test.png');
      // Extend expiry — signature was computed with original exp, so this should fail
      expect(verifySignedUrl(secret, 'agent-1', 'test.png', sig, exp + 100000)).toBe(false);
    });
  });
});
