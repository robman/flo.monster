/**
 * Tests for HubDomContainer — hub-side JSDOM-based DOM container.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { HubDomContainer } from '../dom-container.js';
import type { SerializedDomState } from '@flo-monster/core';

describe('HubDomContainer', () => {
  let container: HubDomContainer;

  afterEach(() => {
    container?.destroy();
  });

  describe('constructor', () => {
    it('creates empty DOM by default', () => {
      container = new HubDomContainer();
      const html = container.getBodyHtml();
      expect(html).toBe('');
    });

    it('creates DOM from initial state', () => {
      const state: SerializedDomState = {
        viewportHtml: '<div id="app">Hello</div>',
        listeners: [],
        capturedAt: Date.now(),
      };
      container = new HubDomContainer(state);
      const html = container.getBodyHtml();
      expect(html).toBe('<div id="app">Hello</div>');
    });

    it('restores body attributes from initial state', () => {
      const state: SerializedDomState = {
        viewportHtml: '<p>content</p>',
        bodyAttrs: { class: 'dark-mode', 'data-theme': 'night' },
        listeners: [],
        capturedAt: Date.now(),
      };
      container = new HubDomContainer(state);
      // Query the body element to verify attributes were applied
      const result = container.query('body');
      expect(result.outerHTML).toContain('class="dark-mode"');
      expect(result.outerHTML).toContain('data-theme="night"');
    });

    it('restores head HTML from initial state', () => {
      const state: SerializedDomState = {
        viewportHtml: '',
        headHtml: '<title>Test Page</title><style>body { color: red; }</style>',
        listeners: [],
        capturedAt: Date.now(),
      };
      container = new HubDomContainer(state);
      // getState should reflect the head content
      const currentState = container.getState();
      expect(currentState.headHtml).toContain('<title>Test Page</title>');
      expect(currentState.headHtml).toContain('<style>body { color: red; }</style>');
    });
  });

  describe('create', () => {
    it('creates elements in body by default', () => {
      container = new HubDomContainer();
      container.create('<div id="main">Content</div>');
      const html = container.getBodyHtml();
      expect(html).toBe('<div id="main">Content</div>');
    });

    it('creates elements in specified parent', () => {
      container = new HubDomContainer();
      container.create('<div id="wrapper"></div>');
      container.create('<span>child</span>', '#wrapper');
      const result = container.query('#wrapper');
      expect(result.outerHTML).toContain('<span>child</span>');
    });

    it('returns element count', () => {
      container = new HubDomContainer();
      const result = container.create('<div>a</div><div>b</div><div>c</div>');
      expect(result.elementCount).toBe(3);
      expect(result.description).toContain('3 element(s)');
    });

    it('throws for non-existent parent selector', () => {
      container = new HubDomContainer();
      expect(() => container.create('<p>hi</p>', '#no-such-parent')).toThrow(
        'Parent selector not found: #no-such-parent',
      );
    });
  });

  describe('modify', () => {
    it('modifies element attributes', () => {
      container = new HubDomContainer();
      container.create('<div id="box">Box</div>');
      container.modify('#box', { class: 'highlight', 'data-value': '42' });
      const result = container.query('#box');
      expect(result.outerHTML).toContain('class="highlight"');
      expect(result.outerHTML).toContain('data-value="42"');
    });

    it('modifies textContent', () => {
      container = new HubDomContainer();
      container.create('<p id="msg">old text</p>');
      container.modify('#msg', undefined, 'new text');
      const result = container.query('#msg');
      expect(result.outerHTML).toContain('new text');
      expect(result.outerHTML).not.toContain('old text');
    });

    it('modifies innerHTML', () => {
      container = new HubDomContainer();
      container.create('<div id="target">old</div>');
      container.modify('#target', undefined, undefined, '<strong>bold</strong>');
      const result = container.query('#target');
      expect(result.outerHTML).toContain('<strong>bold</strong>');
    });

    it('throws for non-existent selector', () => {
      container = new HubDomContainer();
      expect(() => container.modify('#ghost', { class: 'x' })).toThrow(
        'No elements found matching: #ghost',
      );
    });
  });

  describe('query', () => {
    it('returns matching elements', () => {
      container = new HubDomContainer();
      container.create('<div class="item" id="first">A</div>');
      const result = container.query('#first');
      expect(result.elementCount).toBe(1);
      expect(result.outerHTML).toContain('id="first"');
      expect(result.outerHTML).toContain('A');
    });

    it('returns empty for non-existent selector', () => {
      container = new HubDomContainer();
      const result = container.query('.nothing');
      expect(result.elementCount).toBe(0);
      expect(result.outerHTML).toBe('');
    });

    it('returns multiple elements', () => {
      container = new HubDomContainer();
      container.create('<li class="row">one</li><li class="row">two</li><li class="row">three</li>');
      const result = container.query('.row');
      expect(result.elementCount).toBe(3);
      expect(result.outerHTML).toContain('one');
      expect(result.outerHTML).toContain('two');
      expect(result.outerHTML).toContain('three');
    });
  });

  describe('remove', () => {
    it('removes matching elements', () => {
      container = new HubDomContainer();
      container.create('<div id="keep">stay</div><div id="remove-me">go</div>');
      const result = container.remove('#remove-me');
      expect(result.removedCount).toBe(1);
      expect(result.description).toContain('Removed 1 element(s)');
      // Verify it's gone
      expect(container.query('#remove-me').elementCount).toBe(0);
      // Verify the other element remains
      expect(container.query('#keep').elementCount).toBe(1);
    });

    it('returns 0 for non-existent selector', () => {
      container = new HubDomContainer();
      const result = container.remove('.phantom');
      expect(result.removedCount).toBe(0);
      expect(result.description).toContain('No elements found');
    });
  });

  describe('serialization', () => {
    it('getState returns current DOM state', () => {
      container = new HubDomContainer();
      container.create('<section>content</section>');
      const state = container.getState();
      expect(state.viewportHtml).toBe('<section>content</section>');
      expect(state.listeners).toEqual([]);
      expect(state.capturedAt).toBeGreaterThan(0);
      expect(typeof state.capturedAt).toBe('number');
    });

    it('restore replaces DOM content', () => {
      container = new HubDomContainer();
      container.create('<div>original</div>');

      const newState: SerializedDomState = {
        viewportHtml: '<p>replaced</p>',
        bodyAttrs: { class: 'restored' },
        listeners: [],
        capturedAt: Date.now(),
      };
      container.restore(newState);

      expect(container.getBodyHtml()).toBe('<p>replaced</p>');
      const bodyQuery = container.query('body');
      expect(bodyQuery.outerHTML).toContain('class="restored"');
    });

    it('getState/restore roundtrip', () => {
      container = new HubDomContainer();
      container.create('<div id="app"><h1>Title</h1><p>Paragraph</p></div>');
      container.modify('body', { class: 'themed', 'data-version': '2' });

      const saved = container.getState();

      // Destroy and create a new container, then restore
      container.destroy();
      container = new HubDomContainer();
      container.restore(saved);

      expect(container.getBodyHtml()).toContain('<h1>Title</h1>');
      expect(container.getBodyHtml()).toContain('<p>Paragraph</p>');
      const bodyResult = container.query('body');
      expect(bodyResult.outerHTML).toContain('class="themed"');
      expect(bodyResult.outerHTML).toContain('data-version="2"');
    });

    it('getBodyHtml returns body innerHTML', () => {
      container = new HubDomContainer();
      container.create('<span>alpha</span><span>beta</span>');
      const html = container.getBodyHtml();
      expect(html).toBe('<span>alpha</span><span>beta</span>');
    });
  });

  describe('destroy', () => {
    it('closes the JSDOM window', () => {
      container = new HubDomContainer();
      container.create('<div>test</div>');
      // destroy should not throw
      container.destroy();

      // After destroy, further operations should fail or be undefined
      // Re-assign to prevent afterEach from double-destroying
      // Create a fresh one for the afterEach cleanup
      container = new HubDomContainer();
    });
  });
});
