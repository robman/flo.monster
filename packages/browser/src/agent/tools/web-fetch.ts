import type { ToolDef, ToolResult, ToolPlugin, ShellToolContext } from '@flo-monster/core';
import type { HubClient } from '../../shell/hub-client.js';
import type { NetworkPolicy } from '@flo-monster/core';
import { checkNetworkPolicy } from '../../utils/network-policy.js';

export type WebFetchRouting = 'auto' | 'api' | 'hub' | 'browser';

export interface WebFetchInput {
  url: string;
  routing?: WebFetchRouting;
}

export interface WebFetchContext {
  hubClient?: HubClient;
  defaultRouting?: WebFetchRouting;
  networkPolicy?: NetworkPolicy;
}

export const webFetchToolDef: ToolDef = {
  name: 'web_fetch',
  description: 'Fetch web page content. Use routing option to control how the request is made: auto (try hub then browser), api (Anthropic native tool - costs extra), hub (through hub proxy), browser (direct fetch, CORS limited).',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      routing: {
        type: 'string',
        enum: ['auto', 'api', 'hub', 'browser'],
        description: 'How to route the request: auto (try hub then browser), api (Anthropic native tool), hub (through hub proxy), browser (direct fetch, CORS limited)',
      },
    },
    required: ['url'],
  },
};

/**
 * Execute web_fetch with the specified routing.
 */
export async function executeWebFetch(
  input: WebFetchInput,
  context: WebFetchContext,
): Promise<ToolResult> {
  const url = input.url;
  const routing = input.routing || context.defaultRouting || 'auto';

  // Validate URL
  try {
    new URL(url);
  } catch {
    return { content: `Invalid URL: ${url}`, is_error: true };
  }

  // Enforce network policy
  try {
    checkNetworkPolicy(url, context.networkPolicy);
  } catch (err) {
    return { content: String(err), is_error: true };
  }

  switch (routing) {
    case 'api':
      return {
        content: 'API routing (Anthropic native web_fetch tool) is not yet implemented. Use "auto" or "hub" routing instead.',
        is_error: true,
      };

    case 'hub':
      return executeViaHub(url, context);

    case 'browser':
      return executeViaBrowser(url);

    case 'auto':
    default:
      // Try hub first if available
      if (context.hubClient) {
        const connections = context.hubClient.getConnections();
        if (connections.length > 0 && connections.some(c => c.connected)) {
          const result = await executeViaHub(url, context);
          if (!result.is_error) {
            return result;
          }
          // Fall through to browser on hub error
        }
      }
      // Fall back to browser
      return executeViaBrowser(url);
  }
}

async function executeViaHub(
  url: string,
  context: WebFetchContext,
): Promise<ToolResult> {
  if (!context.hubClient) {
    return {
      content: 'Hub routing requested but no hub client available. Connect a hub in settings first.',
      is_error: true,
    };
  }

  const connections = context.hubClient.getConnections();
  const connectedHub = connections.find(c => c.connected);

  if (!connectedHub) {
    return {
      content: 'Hub routing requested but no hub is connected. Connect a hub in settings first.',
      is_error: true,
    };
  }

  try {
    const response = await context.hubClient.fetch(connectedHub.id, url);

    if (response.error) {
      return {
        content: `Hub fetch error: ${response.error}`,
        is_error: true,
      };
    }

    const parts = [`Status: ${response.status}`];
    if (response.body) {
      // Truncate very large responses
      const maxLength = 100000;
      if (response.body.length > maxLength) {
        parts.push(`Body (truncated to ${maxLength} chars):\n${response.body.slice(0, maxLength)}...`);
      } else {
        parts.push(`Body:\n${response.body}`);
      }
    }

    return { content: parts.join('\n') };
  } catch (err) {
    return {
      content: `Hub fetch failed: ${String(err)}`,
      is_error: true,
    };
  }
}

async function executeViaBrowser(url: string): Promise<ToolResult> {
  try {
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
    });

    const text = await response.text();
    const parts = [`Status: ${response.status}`];

    // Truncate very large responses
    const maxLength = 100000;
    if (text.length > maxLength) {
      parts.push(`Body (truncated to ${maxLength} chars):\n${text.slice(0, maxLength)}...`);
    } else {
      parts.push(`Body:\n${text}`);
    }

    return { content: parts.join('\n') };
  } catch (err) {
    const errorMsg = String(err);
    // Check for common CORS-related errors
    if (errorMsg.includes('CORS') || errorMsg.includes('blocked') || errorMsg.includes('cross-origin')) {
      return {
        content: `Browser fetch failed due to CORS restrictions: ${errorMsg}. Try using "hub" routing to bypass CORS.`,
        is_error: true,
      };
    }
    return {
      content: `Browser fetch failed: ${errorMsg}`,
      is_error: true,
    };
  }
}

/**
 * Create a web_fetch tool plugin for the shell context.
 */
export function createWebFetchPlugin(context: WebFetchContext): ToolPlugin {
  return {
    definition: webFetchToolDef,
    async execute(input: Record<string, unknown>, shellContext: ShellToolContext): Promise<ToolResult> {
      const ctxWithPolicy = { ...context, networkPolicy: shellContext.agentConfig.networkPolicy };
      return executeWebFetch(input as unknown as WebFetchInput, ctxWithPolicy);
    },
  };
}
