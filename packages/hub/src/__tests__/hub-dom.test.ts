/**
 * Tests for executeHubDom — hub-side DOM tool executor.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { HubDomContainer } from '../dom-container.js';
import { executeHubDom } from '../tools/hub-dom.js';

describe('executeHubDom', () => {
  let container: HubDomContainer;

  afterEach(() => {
    container?.destroy();
  });

  it('create action creates elements', () => {
    container = new HubDomContainer();
    const result = executeHubDom(
      { action: 'create', html: '<div id="root">Hello</div>' },
      container,
    );
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.elementCount).toBe(1);
    expect(parsed.description).toContain('Created 1 element(s)');
    // Verify DOM actually has the element
    expect(container.getBodyHtml()).toContain('<div id="root">Hello</div>');
  });

  it('create action with missing html returns error', () => {
    container = new HubDomContainer();
    const result = executeHubDom({ action: 'create' }, container);
    expect(result.is_error).toBe(true);
    expect(result.content).toBe('Missing required parameter: html');
  });

  it('modify action modifies elements', () => {
    container = new HubDomContainer();
    container.create('<p id="text">old</p>');
    const result = executeHubDom(
      {
        action: 'modify',
        selector: '#text',
        attributes: { class: 'updated' },
        textContent: 'new',
      },
      container,
    );
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.description).toContain('Modified 1 element(s)');
    // Verify the modification
    const query = container.query('#text');
    expect(query.outerHTML).toContain('class="updated"');
    expect(query.outerHTML).toContain('new');
  });

  it('modify action with missing selector returns error', () => {
    container = new HubDomContainer();
    const result = executeHubDom(
      { action: 'modify', attributes: { class: 'x' } },
      container,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toBe('Missing required parameter: selector');
  });

  it('query action returns matching elements', () => {
    container = new HubDomContainer();
    container.create('<div class="item">A</div><div class="item">B</div>');
    const result = executeHubDom(
      { action: 'query', selector: '.item' },
      container,
    );
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.elementCount).toBe(2);
    expect(parsed.outerHTML).toContain('A');
    expect(parsed.outerHTML).toContain('B');
  });

  it('query action with missing selector returns error', () => {
    container = new HubDomContainer();
    const result = executeHubDom({ action: 'query' }, container);
    expect(result.is_error).toBe(true);
    expect(result.content).toBe('Missing required parameter: selector');
  });

  it('remove action removes elements', () => {
    container = new HubDomContainer();
    container.create('<div id="a">keep</div><div id="b">remove</div>');
    const result = executeHubDom(
      { action: 'remove', selector: '#b' },
      container,
    );
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.removedCount).toBe(1);
    // Verify removal
    expect(container.query('#b').elementCount).toBe(0);
    expect(container.query('#a').elementCount).toBe(1);
  });

  it('remove action with missing selector returns error', () => {
    container = new HubDomContainer();
    const result = executeHubDom({ action: 'remove' }, container);
    expect(result.is_error).toBe(true);
    expect(result.content).toBe('Missing required parameter: selector');
  });

  it('listen action returns browser-required error', () => {
    container = new HubDomContainer();
    const result = executeHubDom(
      { action: 'listen', selector: '#btn', events: ['click'] },
      container,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('requires a connected browser');
    expect(result.content).toContain('listen');
  });

  it('unlisten action returns browser-required error', () => {
    container = new HubDomContainer();
    const result = executeHubDom(
      { action: 'unlisten', selector: '#btn', event: 'click' },
      container,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('requires a connected browser');
    expect(result.content).toContain('unlisten');
  });

  it('wait_for action returns browser-required error', () => {
    container = new HubDomContainer();
    const result = executeHubDom(
      { action: 'wait_for', selector: '#btn', event: 'click', timeout: 5000 },
      container,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('requires a connected browser');
    expect(result.content).toContain('wait_for');
  });

  it('get_listeners action returns browser-required error', () => {
    container = new HubDomContainer();
    const result = executeHubDom(
      { action: 'get_listeners' },
      container,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('requires a connected browser');
    expect(result.content).toContain('get_listeners');
  });

  it('unknown action returns error', () => {
    container = new HubDomContainer();
    const result = executeHubDom(
      { action: 'teleport' },
      container,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toBe('Unknown DOM action: teleport');
  });
});
