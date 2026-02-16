/**
 * Tests for setup command
 */

import { describe, it, expect } from 'vitest';

describe('setup command', () => {
  describe('username validation', () => {
    const VALID_USERNAME = /^[a-z_][a-z0-9_-]*$/;

    it('should accept valid usernames', () => {
      expect(VALID_USERNAME.test('flo-agent')).toBe(true);
      expect(VALID_USERNAME.test('_www')).toBe(true);
      expect(VALID_USERNAME.test('agent')).toBe(true);
      expect(VALID_USERNAME.test('flo_agent_2')).toBe(true);
    });

    it('should reject invalid usernames', () => {
      expect(VALID_USERNAME.test('FLO')).toBe(false);
      expect(VALID_USERNAME.test('123user')).toBe(false);
      expect(VALID_USERNAME.test('has spaces')).toBe(false);
      expect(VALID_USERNAME.test('')).toBe(false);
      expect(VALID_USERNAME.test('user@name')).toBe(false);
      expect(VALID_USERNAME.test('-start')).toBe(false);
    });
  });

  describe('command structure', () => {
    it('setup module should be importable', async () => {
      const mod = await import('../cli/commands/setup.js');
      expect(typeof mod.setupCommand).toBe('function');
    });
  });
});
