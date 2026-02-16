/**
 * Rate limiter for failed authentication attempts
 * Tracks failed auth by IP address and enforces lockout after threshold
 */

/** Maximum number of tracked IPs to prevent memory exhaustion */
const DEFAULT_MAX_ENTRIES = 10000;

interface AttemptRecord {
  count: number;
  lockedUntil?: number;
  lastAttempt: number;
}

export class FailedAuthRateLimiter {
  private attempts = new Map<string, AttemptRecord>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private maxAttempts: number = 5,
    private lockoutMinutes: number = 15,
    private maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {
    // Auto-cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Stop the auto-cleanup interval (call when shutting down)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Record a failed auth attempt
   * @returns true if the IP is now locked out
   */
  recordFailure(ip: string): boolean {
    const now = Date.now();

    // Check if we need to evict old entries
    if (this.attempts.size >= this.maxEntries) {
      this.evictOldest();
    }

    const record = this.attempts.get(ip);

    if (record) {
      record.lastAttempt = now;

      // If already locked and still within lockout period, don't increment
      if (record.lockedUntil && record.lockedUntil > now) {
        return true;
      }

      // If lockout has expired, reset the record
      if (record.lockedUntil && record.lockedUntil <= now) {
        this.attempts.set(ip, { count: 1, lastAttempt: now });
        return false;
      }

      // Increment existing count
      record.count += 1;

      // Check if threshold reached
      if (record.count >= this.maxAttempts) {
        record.lockedUntil = now + this.lockoutMinutes * 60 * 1000;
        return true;
      }

      return false;
    }

    // First failure for this IP
    this.attempts.set(ip, { count: 1, lastAttempt: now });
    return false;
  }

  /**
   * Check if an IP is currently locked out
   * @returns { locked: boolean, retryAfter?: number } - retryAfter is seconds until unlock
   */
  isLocked(ip: string): { locked: boolean; retryAfter?: number } {
    const record = this.attempts.get(ip);

    if (!record || !record.lockedUntil) {
      return { locked: false };
    }

    const now = Date.now();
    if (record.lockedUntil > now) {
      const retryAfter = Math.ceil((record.lockedUntil - now) / 1000);
      return { locked: true, retryAfter };
    }

    // Lockout has expired
    return { locked: false };
  }

  /**
   * Record a successful auth (clear failed attempts)
   */
  recordSuccess(ip: string): void {
    this.attempts.delete(ip);
  }

  /**
   * Evict the oldest entry when at capacity
   */
  private evictOldest(): void {
    let oldestIp: string | null = null;
    let oldestTime = Infinity;

    for (const [ip, record] of this.attempts.entries()) {
      // Don't evict active lockouts
      if (record.lockedUntil && record.lockedUntil > Date.now()) {
        continue;
      }
      if (record.lastAttempt < oldestTime) {
        oldestTime = record.lastAttempt;
        oldestIp = ip;
      }
    }

    if (oldestIp) {
      this.attempts.delete(oldestIp);
    }
  }

  /**
   * Clean up expired lockouts (call periodically)
   */
  cleanup(): void {
    const now = Date.now();
    for (const [ip, record] of this.attempts.entries()) {
      // Remove records with expired lockouts
      if (record.lockedUntil && record.lockedUntil <= now) {
        this.attempts.delete(ip);
      }
    }
  }

  /**
   * Get current entry count (for testing)
   */
  getEntryCount(): number {
    return this.attempts.size;
  }
}
