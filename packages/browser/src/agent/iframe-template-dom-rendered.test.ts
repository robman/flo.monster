import { describe, it, expect } from 'vitest';
import { generateBootstrapScript } from './iframe-template.js';

describe('iframe-template DOM rendered info', () => {
  const script = generateBootstrapScript('test-agent');

  describe('getRenderedInfo helper', () => {
    it('has getRenderedInfo function', () => {
      expect(script).toContain('function getRenderedInfo(el)');
    });

    it('returns null for missing elements', () => {
      expect(script).toContain('if (!el || !el.getBoundingClientRect) return null');
    });

    it('uses getBoundingClientRect for dimensions', () => {
      expect(script).toContain('el.getBoundingClientRect()');
    });

    it('uses getComputedStyle for visibility', () => {
      expect(script).toContain('window.getComputedStyle(el)');
    });

    it('rounds width and height', () => {
      expect(script).toContain('Math.round(rect.width)');
      expect(script).toContain('Math.round(rect.height)');
    });

    it('checks display, visibility, and opacity for visible flag', () => {
      expect(script).toContain("cs.display !== 'none'");
      expect(script).toContain("cs.visibility !== 'hidden'");
      expect(script).toContain("cs.opacity !== '0'");
    });

    it('includes computed display value', () => {
      expect(script).toContain('display: cs.display');
    });

    it('includes childCount', () => {
      expect(script).toContain('childCount: el.children ? el.children.length : 0');
    });
  });

  describe('create action', () => {
    it('adds rendered info for created element', () => {
      expect(script).toContain('result.rendered = getRenderedInfo(container.lastElementChild)');
    });
  });

  describe('query action', () => {
    it('adds rendered info when element is found', () => {
      expect(script).toContain('if (el) result.rendered = getRenderedInfo(el)');
    });
  });

  describe('modify action', () => {
    it('adds rendered info for modified element', () => {
      expect(script).toContain('result.rendered = getRenderedInfo(el)');
    });
  });

  describe('remove action', () => {
    it('does not add rendered info (element is removed)', () => {
      // The remove action should NOT call getRenderedInfo
      // We verify by checking that getRenderedInfo is only called in create, query, modify contexts
      const removeSection = script.slice(
        script.indexOf("case 'remove':"),
        script.indexOf("case 'listen':")
      );
      expect(removeSection).not.toContain('getRenderedInfo');
    });
  });
});
