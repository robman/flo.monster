import type { ToolDef, ToolResult, ToolPlugin, ShellToolContext } from '@flo-monster/core';
import type { HubClient } from '../../shell/hub-client.js';
import type { NetworkPolicy } from '@flo-monster/core';
import { checkNetworkPolicy } from '../../utils/network-policy.js';

export type WebSearchRouting = 'auto' | 'api' | 'hub';

export interface WebSearchInput {
  query: string;
  routing?: WebSearchRouting;
}

export interface WebSearchContext {
  hubClient?: HubClient;
  defaultRouting?: WebSearchRouting;
  networkPolicy?: NetworkPolicy;
}

export const webSearchToolDef: ToolDef = {
  name: 'web_search',
  description: 'Search the web. Use routing option to control how the search is made: auto (try hub), api (Anthropic native tool - costs extra), hub (fetch search engine and parse results).',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      routing: {
        type: 'string',
        enum: ['auto', 'api', 'hub'],
        description: 'How to route: auto (try hub), api (Anthropic native), hub (fetch search engine and parse)',
      },
    },
    required: ['query'],
  },
};

/**
 * Execute web_search with the specified routing.
 */
export async function executeWebSearch(
  input: WebSearchInput,
  context: WebSearchContext,
): Promise<ToolResult> {
  const query = input.query;
  const routing = input.routing || context.defaultRouting || 'auto';

  if (!query || query.trim().length === 0) {
    return { content: 'Search query cannot be empty', is_error: true };
  }

  // Enforce network policy - web_search uses DuckDuckGo
  try {
    checkNetworkPolicy('https://html.duckduckgo.com/', context.networkPolicy);
  } catch (err) {
    return { content: String(err), is_error: true };
  }

  switch (routing) {
    case 'api':
      return {
        content: 'API routing (Anthropic native web_search tool) is not yet implemented. Use "auto" or "hub" routing instead.',
        is_error: true,
      };

    case 'hub':
      return executeViaHub(query, context);

    case 'auto':
    default:
      // Try hub if available
      if (context.hubClient) {
        const connections = context.hubClient.getConnections();
        if (connections.length > 0 && connections.some(c => c.connected)) {
          return executeViaHub(query, context);
        }
      }
      // No hub available
      return {
        content: 'Web search requires a connected hub or API routing. Connect a hub in settings to enable web search, or use the "api" routing option (not yet implemented).',
        is_error: true,
      };
  }
}

async function executeViaHub(
  query: string,
  context: WebSearchContext,
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

  // Use DuckDuckGo HTML search for simplicity (no API key required)
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  try {
    const response = await context.hubClient.fetch(connectedHub.id, searchUrl);

    if (response.error) {
      return {
        content: `Search failed: ${response.error}`,
        is_error: true,
      };
    }

    if (response.status !== 200) {
      return {
        content: `Search returned status ${response.status}`,
        is_error: true,
      };
    }

    // Parse DuckDuckGo HTML results
    const results = parseDuckDuckGoResults(response.body);

    if (results.length === 0) {
      return { content: `No results found for: ${query}` };
    }

    // Format results
    const formatted = results.map((r, i) =>
      `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
    ).join('\n\n');

    return { content: `Search results for "${query}":\n\n${formatted}` };
  } catch (err) {
    return {
      content: `Search failed: ${String(err)}`,
      is_error: true,
    };
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Parse DuckDuckGo HTML search results.
 * This is a simple parser that extracts links from the results page.
 */
function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results have a specific structure
  // Look for result links with class "result__a"
  const resultPattern = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
  const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([^<]*(?:<[^>]+>[^<]*)*)<\/a>/gi;

  // Extract URLs and titles
  const links: { url: string; title: string }[] = [];
  let match;

  while ((match = resultPattern.exec(html)) !== null) {
    const url = decodeURIComponent(match[1].replace(/.*uddg=/, '').replace(/&.*/, ''));
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    if (url && title && url.startsWith('http')) {
      links.push({ url, title });
    }
  }

  // Extract snippets
  const snippets: string[] = [];
  while ((match = snippetPattern.exec(html)) !== null) {
    const snippet = match[1].replace(/<[^>]+>/g, '').trim();
    snippets.push(snippet);
  }

  // Combine links and snippets
  for (let i = 0; i < links.length && i < 10; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || '',
    });
  }

  return results;
}

/**
 * Create a web_search tool plugin for the shell context.
 */
export function createWebSearchPlugin(context: WebSearchContext): ToolPlugin {
  return {
    definition: webSearchToolDef,
    async execute(input: Record<string, unknown>, shellContext: ShellToolContext): Promise<ToolResult> {
      const ctxWithPolicy = { ...context, networkPolicy: shellContext.agentConfig.networkPolicy };
      return executeWebSearch(input as unknown as WebSearchInput, ctxWithPolicy);
    },
  };
}
