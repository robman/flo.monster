/**
 * Node.js streaming API client for hub agent runners.
 * Resolves adapter-relative URLs to upstream provider endpoints and injects API keys.
 */

import type { HubConfig } from './config.js';
import { buildCliArgs, formatMessagesAsPrompt, parseStreamLine, formatSSE, type CliProxyConfig } from './cli-proxy.js';
import { spawn } from 'node:child_process';

export interface ApiClientConfig {
  hubConfig: HubConfig;
  provider: string;  // e.g. 'anthropic', 'openai', 'gemini', 'ollama'
  perAgentApiKey?: string;  // Per-agent API key (from persist transfer)
}

/**
 * Resolve adapter-relative URL to upstream provider URL.
 * Maps the same routes as http-server.ts getProviderRoute.
 */
export function resolveUpstreamUrl(relativeUrl: string, config: HubConfig): { upstreamUrl: string; provider: string } | null {
  if (relativeUrl.startsWith('/api/anthropic/')) {
    const rest = relativeUrl.replace(/^\/api\/anthropic/, '');
    return { upstreamUrl: `https://api.anthropic.com${rest}`, provider: 'anthropic' };
  }
  if (relativeUrl.startsWith('/api/openai/')) {
    const rest = relativeUrl.replace(/^\/api\/openai/, '');
    return { upstreamUrl: `https://api.openai.com${rest}`, provider: 'openai' };
  }
  if (relativeUrl.startsWith('/api/gemini/')) {
    const rest = relativeUrl.replace(/^\/api\/gemini/, '');
    return { upstreamUrl: `https://generativelanguage.googleapis.com${rest}`, provider: 'gemini' };
  }
  if (relativeUrl.startsWith('/api/ollama/')) {
    const rest = relativeUrl.replace(/^\/api\/ollama/, '');
    const ollamaEndpoint = config.providers?.ollama?.endpoint || 'http://localhost:11434';
    return { upstreamUrl: `${ollamaEndpoint}${rest}`, provider: 'ollama' };
  }
  // Backwards compat: /api/v1/messages without /anthropic/ prefix
  if (relativeUrl === '/api/v1/messages') {
    return { upstreamUrl: 'https://api.anthropic.com/v1/messages', provider: 'anthropic' };
  }
  return null;
}

/**
 * Create a sendApiRequest function for use in LoopDeps.
 * This closes over the hub config and provider.
 */
export function createSendApiRequest(clientConfig: ApiClientConfig): (body: string, headers: Record<string, string>, url: string) => AsyncIterable<string> {
  return (body: string, headers: Record<string, string>, url: string) => {
    return sendApiRequest(body, headers, url, clientConfig);
  };
}

/**
 * Send an API request to the upstream provider, yielding raw SSE chunks.
 */
async function* sendApiRequest(
  body: string,
  headers: Record<string, string>,
  url: string,
  config: ApiClientConfig,
): AsyncGenerator<string> {
  // Resolve URL
  const route = resolveUpstreamUrl(url, config.hubConfig);
  if (!route) {
    throw new Error(`Unknown API route: ${url}`);
  }

  // Check if CLI proxy configured for this provider
  const cliConfig = config.hubConfig.cliProviders?.[route.provider];
  if (cliConfig) {
    yield* sendCliProxyApiRequest(body, cliConfig);
    return;
  }

  // Get API key — per-agent key takes priority over shared keys
  let apiKey = config.perAgentApiKey;
  if (!apiKey) {
    apiKey = config.hubConfig.sharedApiKeys?.[route.provider];
  }
  if (!apiKey && config.hubConfig.providers?.[route.provider]) {
    apiKey = config.hubConfig.providers[route.provider].apiKey;
  }

  // Build upstream headers
  const upstreamHeaders: Record<string, string> = { ...headers };
  if (route.provider === 'anthropic') {
    if (apiKey) upstreamHeaders['x-api-key'] = apiKey;
    upstreamHeaders['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    upstreamHeaders['Authorization'] = `Bearer ${apiKey}`;
  }

  // Make streaming fetch
  const response = await fetch(route.upstreamUrl, {
    method: 'POST',
    headers: upstreamHeaders,
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`API request failed (${response.status}): ${errorBody.slice(0, 500)}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  // Yield response chunks
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Send an API request through CLI proxy, yielding SSE-formatted strings.
 * Adapts cli-proxy.ts for use as an AsyncGenerator instead of ServerResponse.
 */
async function* sendCliProxyApiRequest(
  body: string,
  config: CliProxyConfig,
): AsyncGenerator<string> {
  const req = JSON.parse(body);
  const command = config.command || 'claude';
  const timeout = config.timeout || 120000;
  const args = buildCliArgs(req, config);
  const prompt = formatMessagesAsPrompt(req.messages);

  const result = await new Promise<string>((resolve, reject) => {
    let proc;
    try {
      proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err) {
      reject(new Error(`Failed to spawn CLI: ${(err as Error).message}`));
      return;
    }

    const timeoutHandle = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('CLI proxy timeout'));
    }, timeout);

    if (proc.stdin) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }

    let stdoutBuffer = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
    });

    let stderrOutput = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (code !== 0 && stderrOutput) {
        console.error(`[api-client] CLI process exited with code ${code}: ${stderrOutput.slice(0, 500)}`);
      }
      resolve(stdoutBuffer);
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`CLI proxy error: ${err.message}`));
    });
  });

  // Parse CLI output and yield as SSE strings
  const lines = result.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const events = parseStreamLine(line);
    for (const event of events) {
      yield formatSSE(event);
    }
  }
}
