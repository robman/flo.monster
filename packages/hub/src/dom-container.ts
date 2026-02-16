/**
 * Hub-side DOM container using JSDOM.
 * Provides structural DOM operations (create/modify/query/remove) without a browser.
 * Event operations (listen/unlisten/wait_for/get_listeners) require a connected browser.
 */

import { JSDOM } from 'jsdom';
import type { SerializedDomState } from '@flo-monster/core';

export class HubDomContainer {
  private jsdom: JSDOM;
  private document: Document;

  constructor(initialState?: SerializedDomState) {
    const html = initialState
      ? this.buildHtml(initialState)
      : '<!DOCTYPE html><html><head></head><body></body></html>';

    this.jsdom = new JSDOM(html, { runScripts: 'outside-only' });
    this.document = this.jsdom.window.document;
  }

  /**
   * Create HTML elements in the DOM.
   */
  create(html: string, parentSelector?: string): { description: string; elementCount: number } {
    const parent = parentSelector
      ? this.document.querySelector(parentSelector)
      : this.document.body;

    if (!parent) {
      throw new Error(`Parent selector not found: ${parentSelector}`);
    }

    // Create a temporary container to parse the HTML
    const temp = this.document.createElement('div');
    temp.innerHTML = html;

    const elementCount = temp.children.length || (temp.childNodes.length > 0 ? 1 : 0);

    // Move all child nodes to the parent
    while (temp.firstChild) {
      parent.appendChild(temp.firstChild);
    }

    return {
      description: `Created ${elementCount} element(s)${parentSelector ? ` in ${parentSelector}` : ''}`,
      elementCount,
    };
  }

  /**
   * Modify existing elements.
   */
  modify(
    selector: string,
    attrs?: Record<string, string>,
    textContent?: string,
    innerHTML?: string,
  ): { description: string } {
    const elements = this.document.querySelectorAll(selector);
    if (elements.length === 0) {
      throw new Error(`No elements found matching: ${selector}`);
    }

    for (const el of elements) {
      if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
          (el as Element).setAttribute(key, value);
        }
      }
      if (textContent !== undefined) {
        el.textContent = textContent;
      }
      if (innerHTML !== undefined) {
        (el as Element).innerHTML = innerHTML;
      }
    }

    return {
      description: `Modified ${elements.length} element(s) matching ${selector}`,
    };
  }

  /**
   * Query DOM elements.
   */
  query(selector: string): { outerHTML: string; elementCount: number } {
    const elements = this.document.querySelectorAll(selector);

    if (elements.length === 0) {
      return { outerHTML: '', elementCount: 0 };
    }

    const htmlParts: string[] = [];
    for (const el of elements) {
      htmlParts.push((el as Element).outerHTML);
    }

    return {
      outerHTML: htmlParts.join('\n'),
      elementCount: elements.length,
    };
  }

  /**
   * Remove DOM elements.
   */
  remove(selector: string): { description: string; removedCount: number } {
    const elements = this.document.querySelectorAll(selector);

    let removedCount = 0;
    for (const el of elements) {
      el.parentNode?.removeChild(el);
      removedCount++;
    }

    return {
      description: removedCount > 0
        ? `Removed ${removedCount} element(s) matching ${selector}`
        : `No elements found matching: ${selector}`,
      removedCount,
    };
  }

  /**
   * Get the current DOM state as a serializable object.
   */
  getState(): SerializedDomState {
    const body = this.document.body;
    const head = this.document.head;
    const html = this.document.documentElement;

    // Extract body attributes
    const bodyAttrs: Record<string, string> = {};
    for (const attr of body.attributes) {
      bodyAttrs[attr.name] = attr.value;
    }

    // Extract html attributes
    const htmlAttrs: Record<string, string> = {};
    for (const attr of html.attributes) {
      htmlAttrs[attr.name] = attr.value;
    }

    return {
      viewportHtml: body.innerHTML,
      bodyAttrs,
      headHtml: head.innerHTML,
      htmlAttrs,
      listeners: [],  // No event listeners in hub-only mode
      capturedAt: Date.now(),
    };
  }

  /**
   * Restore DOM state from a serialized object.
   */
  restore(state: SerializedDomState): void {
    const body = this.document.body;
    const head = this.document.head;
    const html = this.document.documentElement;

    // Restore body content
    body.innerHTML = state.viewportHtml || '';

    // Restore body attributes
    // Clear existing non-essential attributes
    for (const attr of [...body.attributes]) {
      body.removeAttribute(attr.name);
    }
    if (state.bodyAttrs) {
      for (const [key, value] of Object.entries(state.bodyAttrs)) {
        body.setAttribute(key, value);
      }
    }

    // Restore head content
    if (state.headHtml !== undefined) {
      head.innerHTML = state.headHtml;
    }

    // Restore html attributes
    if (state.htmlAttrs) {
      for (const attr of [...html.attributes]) {
        html.removeAttribute(attr.name);
      }
      for (const [key, value] of Object.entries(state.htmlAttrs)) {
        html.setAttribute(key, value);
      }
    }
  }

  /**
   * Get the body HTML as a string.
   */
  getBodyHtml(): string {
    return this.document.body.innerHTML;
  }

  /**
   * Destroy the JSDOM instance.
   */
  destroy(): void {
    this.jsdom.window.close();
  }

  /**
   * Build an HTML string from serialized state.
   */
  private buildHtml(state: SerializedDomState): string {
    const htmlAttrs = state.htmlAttrs
      ? Object.entries(state.htmlAttrs).map(([k, v]) => `${k}="${v}"`).join(' ')
      : '';
    const bodyAttrs = state.bodyAttrs
      ? Object.entries(state.bodyAttrs).map(([k, v]) => `${k}="${v}"`).join(' ')
      : '';

    return `<!DOCTYPE html><html${htmlAttrs ? ' ' + htmlAttrs : ''}>` +
      `<head>${state.headHtml || ''}</head>` +
      `<body${bodyAttrs ? ' ' + bodyAttrs : ''}>${state.viewportHtml || ''}</body></html>`;
  }
}
