import { describe, it, expect, beforeEach } from 'vitest';
import { SaveIndicator } from '../save-indicator.js';

describe('SaveIndicator', () => {
  let indicator: SaveIndicator;

  beforeEach(() => {
    indicator = new SaveIndicator();
  });

  describe('initial state', () => {
    it('starts in clean state', () => {
      expect(indicator.getState()).toBe('clean');
    });

    it('has save-indicator class', () => {
      expect(indicator.getElement().className).toContain('save-indicator');
    });

    it('shows clean styling initially', () => {
      expect(indicator.getElement().classList.contains('save-indicator--clean')).toBe(true);
    });

    it('shows checkmark for clean state', () => {
      expect(indicator.getElement().textContent).toBe('\u2713');
    });

    it('has "All changes saved" title', () => {
      expect(indicator.getElement().title).toBe('All changes saved');
    });
  });

  describe('setState', () => {
    it('transitions to dirty state', () => {
      indicator.setState('dirty');
      expect(indicator.getState()).toBe('dirty');
      expect(indicator.getElement().classList.contains('save-indicator--dirty')).toBe(true);
      expect(indicator.getElement().textContent).toBe('\u25CF');
      expect(indicator.getElement().title).toBe('Unsaved changes');
    });

    it('transitions to saving state', () => {
      indicator.setState('saving');
      expect(indicator.getState()).toBe('saving');
      expect(indicator.getElement().classList.contains('save-indicator--saving')).toBe(true);
      expect(indicator.getElement().textContent).toBe('\u23F3');
      expect(indicator.getElement().title).toBe('Saving...');
    });

    it('transitions back to clean', () => {
      indicator.setState('dirty');
      indicator.setState('clean');
      expect(indicator.getState()).toBe('clean');
      expect(indicator.getElement().classList.contains('save-indicator--clean')).toBe(true);
    });

    it('removes old state class on transition', () => {
      indicator.setState('dirty');
      expect(indicator.getElement().classList.contains('save-indicator--dirty')).toBe(true);
      indicator.setState('saving');
      expect(indicator.getElement().classList.contains('save-indicator--dirty')).toBe(false);
      expect(indicator.getElement().classList.contains('save-indicator--saving')).toBe(true);
    });

    it('does nothing if state is the same', () => {
      indicator.setState('dirty');
      const el = indicator.getElement();
      const originalText = el.textContent;
      indicator.setState('dirty');
      // Should not re-render (same state)
      expect(el.textContent).toBe(originalText);
    });
  });

  describe('dispose', () => {
    it('removes element from DOM', () => {
      const parent = document.createElement('div');
      parent.appendChild(indicator.getElement());
      expect(parent.children.length).toBe(1);
      indicator.dispose();
      expect(parent.children.length).toBe(0);
    });
  });

  describe('getElement', () => {
    it('returns a span element', () => {
      expect(indicator.getElement().tagName).toBe('SPAN');
    });

    it('returns the same element on multiple calls', () => {
      expect(indicator.getElement()).toBe(indicator.getElement());
    });
  });
});
