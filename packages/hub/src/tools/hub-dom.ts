/**
 * Hub-side DOM tool executor.
 * Routes structural operations (create/modify/query/remove) to HubDomContainer.
 * Event operations (listen/unlisten/wait_for/get_listeners) require a connected browser.
 */

import type { HubDomContainer } from '../dom-container.js';
import type { ToolResult } from './index.js';

const EVENT_ACTIONS = new Set(['listen', 'unlisten', 'wait_for', 'get_listeners']);

export function executeHubDom(
  input: {
    action: string;
    html?: string;
    selector?: string;
    attributes?: Record<string, string>;
    textContent?: string;
    innerHTML?: string;
    parentSelector?: string;
    events?: string[];
    event?: string;
    timeout?: number;
  },
  container: HubDomContainer,
): ToolResult {
  // Event actions require a connected browser
  if (EVENT_ACTIONS.has(input.action)) {
    return {
      content: `Action "${input.action}" requires a connected browser. Available actions in hub-only mode: create, modify, query, remove.`,
      is_error: true,
    };
  }

  try {
    switch (input.action) {
      case 'create': {
        if (!input.html) {
          return { content: 'Missing required parameter: html', is_error: true };
        }
        const result = container.create(input.html, input.parentSelector);
        return { content: JSON.stringify(result) };
      }

      case 'modify': {
        if (!input.selector) {
          return { content: 'Missing required parameter: selector', is_error: true };
        }
        const result = container.modify(
          input.selector,
          input.attributes,
          input.textContent,
          input.innerHTML,
        );
        return { content: JSON.stringify(result) };
      }

      case 'query': {
        if (!input.selector) {
          return { content: 'Missing required parameter: selector', is_error: true };
        }
        const result = container.query(input.selector);
        return { content: JSON.stringify(result) };
      }

      case 'remove': {
        if (!input.selector) {
          return { content: 'Missing required parameter: selector', is_error: true };
        }
        const result = container.remove(input.selector);
        return { content: JSON.stringify(result) };
      }

      default:
        return { content: `Unknown DOM action: ${input.action}`, is_error: true };
    }
  } catch (err) {
    return { content: `DOM error: ${(err as Error).message}`, is_error: true };
  }
}
