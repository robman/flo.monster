import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getBrowserId, getBrowserLabel, setBrowserLabel } from './browser-context.js';

describe('browser-context', () => {
  beforeEach(() => {
    // Clear sessionStorage before each test
    sessionStorage.clear();
  });

  describe('getBrowserId', () => {
    it('should return a string', () => {
      const id = getBrowserId();
      expect(typeof id).toBe('string');
    });

    it('should return a valid UUID format', () => {
      const id = getBrowserId();
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(id).toMatch(uuidRegex);
    });

    it('should persist across calls in same session', () => {
      const id1 = getBrowserId();
      const id2 = getBrowserId();
      expect(id1).toBe(id2);
    });

    it('should store ID in sessionStorage', () => {
      const id = getBrowserId();
      expect(sessionStorage.getItem('flo-browser-id')).toBe(id);
    });

    it('should use existing ID from sessionStorage', () => {
      const existingId = 'existing-test-id-12345678';
      sessionStorage.setItem('flo-browser-id', existingId);

      const id = getBrowserId();
      expect(id).toBe(existingId);
    });
  });

  describe('getBrowserLabel', () => {
    it('should return empty string when not set', () => {
      expect(getBrowserLabel()).toBe('');
    });

    it('should return stored label', () => {
      sessionStorage.setItem('flo-browser-label', 'My Browser');
      expect(getBrowserLabel()).toBe('My Browser');
    });
  });

  describe('setBrowserLabel', () => {
    it('should store label in sessionStorage', () => {
      setBrowserLabel('Test Label');
      expect(sessionStorage.getItem('flo-browser-label')).toBe('Test Label');
    });

    it('should be retrievable with getBrowserLabel', () => {
      setBrowserLabel('My Custom Label');
      expect(getBrowserLabel()).toBe('My Custom Label');
    });

    it('should overwrite existing label', () => {
      setBrowserLabel('First Label');
      setBrowserLabel('Second Label');
      expect(getBrowserLabel()).toBe('Second Label');
    });

    it('should allow empty string', () => {
      setBrowserLabel('Some Label');
      setBrowserLabel('');
      expect(getBrowserLabel()).toBe('');
    });
  });

  describe('ID uniqueness', () => {
    it('should generate different IDs when sessionStorage is cleared', () => {
      const id1 = getBrowserId();
      sessionStorage.clear();
      const id2 = getBrowserId();
      expect(id1).not.toBe(id2);
    });
  });
});
