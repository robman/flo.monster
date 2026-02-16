import { describe, it, expect } from 'vitest';
import { evaluateSafeCondition } from '../safe-eval.js';

describe('evaluateSafeCondition', () => {
  describe('keywords', () => {
    it('always returns true', () => {
      expect(evaluateSafeCondition('always', undefined)).toBe(true);
      expect(evaluateSafeCondition('always', 0)).toBe(true);
    });

    it('changed returns true', () => {
      expect(evaluateSafeCondition('changed', 'anything')).toBe(true);
    });

    it('true matches boolean true and string "true"', () => {
      expect(evaluateSafeCondition('true', true)).toBe(true);
      expect(evaluateSafeCondition('true', 'true')).toBe(true);
      expect(evaluateSafeCondition('true', false)).toBe(false);
      expect(evaluateSafeCondition('true', 1)).toBe(false);
    });

    it('false matches boolean false and string "false"', () => {
      expect(evaluateSafeCondition('false', false)).toBe(true);
      expect(evaluateSafeCondition('false', 'false')).toBe(true);
      expect(evaluateSafeCondition('false', true)).toBe(false);
    });
  });

  describe('numeric comparisons', () => {
    it('> compares correctly', () => {
      expect(evaluateSafeCondition('> 100', 101)).toBe(true);
      expect(evaluateSafeCondition('> 100', 100)).toBe(false);
      expect(evaluateSafeCondition('> 100', 99)).toBe(false);
    });

    it('>= compares correctly', () => {
      expect(evaluateSafeCondition('>= 100', 100)).toBe(true);
      expect(evaluateSafeCondition('>= 100', 101)).toBe(true);
      expect(evaluateSafeCondition('>= 100', 99)).toBe(false);
    });

    it('< compares correctly', () => {
      expect(evaluateSafeCondition('< 5', 4)).toBe(true);
      expect(evaluateSafeCondition('< 5', 5)).toBe(false);
    });

    it('<= compares correctly', () => {
      expect(evaluateSafeCondition('<= 5', 5)).toBe(true);
      expect(evaluateSafeCondition('<= 5', 6)).toBe(false);
    });

    it('handles numeric strings', () => {
      expect(evaluateSafeCondition('> 10', '15')).toBe(true);
      expect(evaluateSafeCondition('> 10', '5')).toBe(false);
    });

    it('returns false for NaN comparisons', () => {
      expect(evaluateSafeCondition('> 100', 'hello')).toBe(false);
      expect(evaluateSafeCondition('> NaN', 5)).toBe(false);
    });
  });

  describe('equality', () => {
    it('== compares string values', () => {
      expect(evaluateSafeCondition('== done', 'done')).toBe(true);
      expect(evaluateSafeCondition('== done', 'pending')).toBe(false);
    });

    it('!= compares string values', () => {
      expect(evaluateSafeCondition('!= done', 'pending')).toBe(true);
      expect(evaluateSafeCondition('!= done', 'done')).toBe(false);
    });

    it('handles quoted strings', () => {
      expect(evaluateSafeCondition('== "hello world"', 'hello world')).toBe(true);
      expect(evaluateSafeCondition("== 'hello'", 'hello')).toBe(true);
    });

    it('handles numeric equality', () => {
      expect(evaluateSafeCondition('== 42', 42)).toBe(true);
      expect(evaluateSafeCondition('== 42', '42')).toBe(true);
    });
  });

  describe('security — JS injection attempts fail safely', () => {
    it('rejects arbitrary JS expressions', () => {
      expect(evaluateSafeCondition('val > 100', 200)).toBe(false);
      expect(evaluateSafeCondition('process.exit()', undefined)).toBe(false);
      expect(evaluateSafeCondition('require("child_process")', undefined)).toBe(false);
    });

    it('rejects function calls', () => {
      expect(evaluateSafeCondition('console.log("hacked")', undefined)).toBe(false);
    });

    it('rejects constructor access', () => {
      expect(evaluateSafeCondition('this.constructor', undefined)).toBe(false);
    });

    it('rejects template literals', () => {
      expect(evaluateSafeCondition('`${process.env}`', undefined)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles whitespace', () => {
      expect(evaluateSafeCondition('  always  ', undefined)).toBe(true);
      expect(evaluateSafeCondition('  > 5  ', 10)).toBe(true);
    });

    it('handles empty condition', () => {
      expect(evaluateSafeCondition('', 0)).toBe(false);
    });

    it('handles undefined value', () => {
      expect(evaluateSafeCondition('== undefined', undefined)).toBe(true);
    });
  });
});
