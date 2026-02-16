/**
 * Tests for failed authentication rate limiter
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FailedAuthRateLimiter } from '../rate-limiter.js';

describe('FailedAuthRateLimiter', () => {
  let limiter: FailedAuthRateLimiter;

  beforeEach(() => {
    limiter = new FailedAuthRateLimiter(3, 5); // 3 attempts, 5 minutes lockout
    vi.useFakeTimers();
  });

  afterEach(() => {
    limiter.destroy(); // Clean up interval
    vi.useRealTimers();
  });

  describe('recordFailure', () => {
    it('should return false for first failure', () => {
      const result = limiter.recordFailure('192.168.1.1');
      expect(result).toBe(false);
    });

    it('should increment count with each failure', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      // Third failure (at threshold) should trigger lockout
      const result = limiter.recordFailure('192.168.1.1');
      expect(result).toBe(true);
    });

    it('should track different IPs independently', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      // Different IP should start fresh
      const result = limiter.recordFailure('192.168.1.2');
      expect(result).toBe(false);
    });

    it('should return true once locked', () => {
      // Trigger lockout
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      // Further attempts should return true (already locked)
      expect(limiter.recordFailure('192.168.1.1')).toBe(true);
      expect(limiter.recordFailure('192.168.1.1')).toBe(true);
    });
  });

  describe('isLocked', () => {
    it('should return locked: false for unknown IP', () => {
      const result = limiter.isLocked('192.168.1.1');
      expect(result.locked).toBe(false);
      expect(result.retryAfter).toBeUndefined();
    });

    it('should return locked: false before threshold', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      const result = limiter.isLocked('192.168.1.1');
      expect(result.locked).toBe(false);
    });

    it('should return locked: true after threshold reached', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      const result = limiter.isLocked('192.168.1.1');
      expect(result.locked).toBe(true);
      expect(result.retryAfter).toBeDefined();
    });

    it('should return correct retryAfter in seconds', () => {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      const result = limiter.isLocked('192.168.1.1');
      expect(result.locked).toBe(true);
      // 5 minutes = 300 seconds
      expect(result.retryAfter).toBe(300);
    });

    it('should return locked: false after lockout expires', () => {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      // Advance time past lockout (5 minutes + 1 second)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

      const result = limiter.isLocked('192.168.1.1');
      expect(result.locked).toBe(false);
    });
  });

  describe('recordSuccess', () => {
    it('should clear failed attempts', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      limiter.recordSuccess('192.168.1.1');

      // Should start fresh again
      const result = limiter.recordFailure('192.168.1.1');
      expect(result).toBe(false);
    });

    it('should clear lockout', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      expect(limiter.isLocked('192.168.1.1').locked).toBe(true);

      limiter.recordSuccess('192.168.1.1');

      expect(limiter.isLocked('192.168.1.1').locked).toBe(false);
    });

    it('should not affect other IPs', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.2');

      limiter.recordSuccess('192.168.1.1');

      // IP2 should still have its failure record
      // Two more failures should trigger lockout
      limiter.recordFailure('192.168.1.2');
      const result = limiter.recordFailure('192.168.1.2');
      expect(result).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should remove expired lockouts', () => {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      // Lock out IP1
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      // Advance time past lockout
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

      limiter.cleanup();

      // After cleanup, IP should be able to start fresh
      // First failure should return false
      expect(limiter.recordFailure('192.168.1.1')).toBe(false);
    });

    it('should not remove active lockouts', () => {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      // Advance time but not past lockout
      vi.advanceTimersByTime(2 * 60 * 1000);

      limiter.cleanup();

      // Should still be locked
      expect(limiter.isLocked('192.168.1.1').locked).toBe(true);
    });

    it('should not remove records without lockouts', () => {
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      limiter.cleanup();

      // Record should still exist - one more failure should trigger lockout
      const result = limiter.recordFailure('192.168.1.1');
      expect(result).toBe(true);
    });
  });

  describe('lockout expiry reset', () => {
    it('should reset count after lockout expires', () => {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      // Trigger lockout
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');
      limiter.recordFailure('192.168.1.1');

      expect(limiter.isLocked('192.168.1.1').locked).toBe(true);

      // Advance time past lockout
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

      // New failure after expiry should reset count
      const result = limiter.recordFailure('192.168.1.1');
      expect(result).toBe(false);

      // Should need full threshold again
      limiter.recordFailure('192.168.1.1');
      expect(limiter.recordFailure('192.168.1.1')).toBe(true);
    });
  });

  describe('constructor defaults', () => {
    it('should use default values when not specified', () => {
      const defaultLimiter = new FailedAuthRateLimiter();

      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      // Default is 5 attempts
      for (let i = 0; i < 4; i++) {
        expect(defaultLimiter.recordFailure('192.168.1.1')).toBe(false);
      }
      expect(defaultLimiter.recordFailure('192.168.1.1')).toBe(true);

      // Default lockout is 15 minutes = 900 seconds
      const result = defaultLimiter.isLocked('192.168.1.1');
      expect(result.retryAfter).toBe(900);

      defaultLimiter.destroy();
    });
  });

  describe('destroy', () => {
    it('should stop the cleanup interval', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      limiter.destroy();

      expect(clearIntervalSpy).toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
    });

    it('should be safe to call multiple times', () => {
      limiter.destroy();
      limiter.destroy(); // Should not throw
    });
  });

  describe('maxEntries limit', () => {
    it('should evict oldest entry when at capacity', () => {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      // Create limiter with max 3 entries
      const smallLimiter = new FailedAuthRateLimiter(3, 5, 3);

      // Add 3 IPs (at capacity)
      smallLimiter.recordFailure('192.168.1.1');
      vi.advanceTimersByTime(1000);
      smallLimiter.recordFailure('192.168.1.2');
      vi.advanceTimersByTime(1000);
      smallLimiter.recordFailure('192.168.1.3');

      expect(smallLimiter.getEntryCount()).toBe(3);

      // Add 4th IP - should evict oldest (192.168.1.1)
      smallLimiter.recordFailure('192.168.1.4');

      expect(smallLimiter.getEntryCount()).toBe(3);

      // IP1 was evicted, so it should start fresh (needs 3 failures to lock)
      expect(smallLimiter.recordFailure('192.168.1.1')).toBe(false);

      smallLimiter.destroy();
    });

    it('should not evict active lockouts', () => {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      // Create limiter with max 2 entries
      const smallLimiter = new FailedAuthRateLimiter(3, 5, 2);

      // Lock out first IP
      smallLimiter.recordFailure('192.168.1.1');
      smallLimiter.recordFailure('192.168.1.1');
      smallLimiter.recordFailure('192.168.1.1');
      expect(smallLimiter.isLocked('192.168.1.1').locked).toBe(true);

      vi.advanceTimersByTime(1000);

      // Add second IP
      smallLimiter.recordFailure('192.168.1.2');

      expect(smallLimiter.getEntryCount()).toBe(2);

      // Add third IP - should evict 192.168.1.2, not the locked 192.168.1.1
      smallLimiter.recordFailure('192.168.1.3');

      // IP1 should still be locked
      expect(smallLimiter.isLocked('192.168.1.1').locked).toBe(true);

      smallLimiter.destroy();
    });
  });

  describe('auto-cleanup interval', () => {
    it('should automatically run cleanup every 5 minutes', () => {
      // Need to create the limiter after fake timers are set up
      limiter.destroy(); // Destroy the one created in beforeEach

      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      // Create a new limiter with fake timers active
      const testLimiter = new FailedAuthRateLimiter(3, 5);

      // Trigger lockout
      testLimiter.recordFailure('192.168.1.1');
      testLimiter.recordFailure('192.168.1.1');
      testLimiter.recordFailure('192.168.1.1');

      expect(testLimiter.getEntryCount()).toBe(1);

      // Advance time past lockout (5 minutes + 1 second)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

      // Advance 5 more minutes to trigger auto-cleanup interval
      vi.advanceTimersByTime(5 * 60 * 1000);

      // Entry should be cleaned up
      expect(testLimiter.getEntryCount()).toBe(0);

      testLimiter.destroy();
    });
  });
});
