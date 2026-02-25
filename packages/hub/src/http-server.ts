/**
 * HTTP request handlers for hub API endpoints
 * Handles API proxying for browsers using the hub's shared API key
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import type { HubConfig } from './config.js';
import { timingSafeCompare } from './auth.js';
import { FailedAuthRateLimiter } from './rate-limiter.js';
import { handleCliProxy } from './cli-proxy.js';
import { verifySignedUrl } from './utils/signed-url.js';
import { validateFilePath } from './tools/hub-files.js';

export interface HttpHandlerContext {
  config: HubConfig;
  rateLimiter: FailedAuthRateLimiter;
  signingSecret?: Buffer;
  agentStorePath?: string;
}

/**
 * CORS headers to set on all responses
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-hub-token, x-api-provider, anthropic-version, Authorization',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '86400',
};

/** Maximum request body size (10MB) */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * Set CORS headers on a response
 */
function setCorsHeaders(res: ServerResponse, requestOrigin?: string, allowedOrigins?: string[]): void {
  // Set the standard CORS headers (methods, allowed headers, PNA, max-age)
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }

  // Set Access-Control-Allow-Origin based on config
  if (!allowedOrigins || allowedOrigins.length === 0) {
    // No restriction — allow all
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    // Reflect the matching origin
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  } else {
    // No match — use the first allowed origin (browser will block mismatched)
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
    res.setHeader('Vary', 'Origin');
  }
}

/**
 * Get client IP from request
 * Only trusts X-Forwarded-For if trustProxy is true
 */
function getClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0].split(',')[0].trim();
    }
  }

  // Fall back to socket address
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Read request body as string with size limit
 */
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown, requestOrigin?: string, allowedOrigins?: string[]): void {
  setCorsHeaders(res, requestOrigin, allowedOrigins);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Send error response
 */
function sendError(res: ServerResponse, statusCode: number, message: string, headers?: Record<string, string>, requestOrigin?: string, allowedOrigins?: string[]): void {
  setCorsHeaders(res, requestOrigin, allowedOrigins);

  const allHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  res.writeHead(statusCode, allHeaders);
  res.end(JSON.stringify({ error: message }));
}

/**
 * Validate hub token
 */
function validateHubToken(token: string | undefined, config: HubConfig): boolean {
  // Hub token must be provided and match config.authToken
  if (!token || !config.authToken) {
    return false;
  }
  return timingSafeCompare(token, config.authToken);
}

/**
 * Handle OPTIONS preflight request
 */
function handleOptions(res: ServerResponse, requestOrigin?: string, allowedOrigins?: string[]): void {
  setCorsHeaders(res, requestOrigin, allowedOrigins);
  res.writeHead(204);
  res.end();
}

/**
 * Handle GET /api/status
 */
function handleStatus(res: ServerResponse, requestOrigin?: string, allowedOrigins?: string[]): void {
  sendJson(res, 200, { ok: true }, requestOrigin, allowedOrigins);
}

/**
 * Handle GET /tls-setup — landing page after accepting self-signed cert
 */
function handleTlsSetup(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flo.monster Hub — TLS Setup Complete</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e0e0e0; }
  .card { text-align: center; max-width: 480px; padding: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  .check { font-size: 3rem; margin-bottom: 1rem; }
  p { color: #999; line-height: 1.6; }
  a { color: #6ee7b7; text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="card">
  <div class="check">&#x2705;</div>
  <h1>Certificate Accepted</h1>
  <p>Your browser now trusts this hub's self-signed certificate.</p>
  <p>Open <a href="https://flo.monster">flo.monster</a> to connect your hub.</p>
</div>
</body>
</html>`);
}

/**
 * Provider route information
 */
interface ProviderRoute {
  provider: string;
  upstreamUrl: string;
}

/**
 * Determine provider and upstream URL from request path
 */
function getProviderRoute(pathname: string, config: HubConfig): ProviderRoute | null {
  // Anthropic: /api/anthropic/* -> https://api.anthropic.com/*
  if (pathname.startsWith('/api/anthropic/')) {
    const rest = pathname.replace(/^\/api\/anthropic/, '');
    return { provider: 'anthropic', upstreamUrl: `https://api.anthropic.com${rest}` };
  }
  // OpenAI: /api/openai/* -> https://api.openai.com/*
  if (pathname.startsWith('/api/openai/')) {
    const rest = pathname.replace(/^\/api\/openai/, '');
    return { provider: 'openai', upstreamUrl: `https://api.openai.com${rest}` };
  }
  // Gemini: /api/gemini/* -> https://generativelanguage.googleapis.com/*
  if (pathname.startsWith('/api/gemini/')) {
    const rest = pathname.replace(/^\/api\/gemini/, '');
    return { provider: 'gemini', upstreamUrl: `https://generativelanguage.googleapis.com${rest}` };
  }
  // Ollama: /api/ollama/* -> configurable endpoint (default localhost:11434)
  if (pathname.startsWith('/api/ollama/')) {
    const rest = pathname.replace(/^\/api\/ollama/, '');
    const ollamaEndpoint = config.providers?.ollama?.endpoint || 'http://localhost:11434';
    return { provider: 'ollama', upstreamUrl: `${ollamaEndpoint}${rest}` };
  }
  // Backwards compat: /api/v1/messages without /anthropic/ prefix
  if (pathname === '/api/v1/messages') {
    return { provider: 'anthropic', upstreamUrl: 'https://api.anthropic.com/v1/messages' };
  }
  return null;
}

// Export for testing
export { getProviderRoute, type ProviderRoute };

/**
 * Handle provider proxy requests (POST /api/anthropic/*, /api/openai/*, /api/gemini/*, /api/ollama/*, /api/v1/messages)
 */
async function handleProviderProxy(
  req: IncomingMessage,
  res: ServerResponse,
  context: HttpHandlerContext,
  route: ProviderRoute,
  requestOrigin?: string,
  allowedOrigins?: string[],
): Promise<void> {
  const { config, rateLimiter } = context;
  const clientIp = getClientIp(req, config.trustProxy ?? false);

  // 1. Check rate limiting
  const lockStatus = rateLimiter.isLocked(clientIp);
  if (lockStatus.locked) {
    sendError(res, 429, 'Too many failed authentication attempts', {
      'Retry-After': String(lockStatus.retryAfter || 60),
    }, requestOrigin, allowedOrigins);
    return;
  }

  // 2. Validate hub token
  const token = req.headers['x-hub-token'];
  const tokenStr = Array.isArray(token) ? token[0] : token;

  if (!validateHubToken(tokenStr, config)) {
    rateLimiter.recordFailure(clientIp);
    sendError(res, 401, 'Invalid or missing hub token', undefined, requestOrigin, allowedOrigins);
    return;
  }

  // 3. Determine effective provider
  // For /api/v1/messages, allow x-api-provider header override for key lookup (legacy compat)
  let effectiveProvider = route.provider;
  if (route.upstreamUrl === 'https://api.anthropic.com/v1/messages') {
    const providerHeader = req.headers['x-api-provider'];
    const headerProvider = (Array.isArray(providerHeader) ? providerHeader[0] : providerHeader);
    if (headerProvider) {
      effectiveProvider = headerProvider;
    }
  }

  // 4. Check if this provider is configured for CLI proxy
  const cliConfig = config.cliProviders?.[effectiveProvider];
  if (cliConfig) {
    // Route through CLI proxy instead of upstream API
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'Request body too large') {
        sendError(res, 413, 'Request body too large', undefined, requestOrigin, allowedOrigins);
      } else {
        sendError(res, 400, 'Failed to read request body', undefined, requestOrigin, allowedOrigins);
      }
      return;
    }
    try {
      const parsed = JSON.parse(body);
      await handleCliProxy(parsed, res, cliConfig);
      rateLimiter.recordSuccess(clientIp);
    } catch (err) {
      console.error(`[http-server] CLI proxy error:`, (err as Error).message);
      sendError(res, 502, `CLI proxy error: ${(err as Error).message}`, undefined, requestOrigin, allowedOrigins);
    }
    return;
  }

  // 5. Look up API key for provider
  // Check sharedApiKeys first, then providers config
  let apiKey = config.sharedApiKeys?.[effectiveProvider];
  if (!apiKey && config.providers?.[effectiveProvider]) {
    apiKey = config.providers[effectiveProvider].apiKey;
  }

  // Ollama doesn't necessarily need an API key
  if (!apiKey && effectiveProvider !== 'ollama') {
    sendError(res, 503, `No shared API key configured for provider: ${effectiveProvider}`, undefined, requestOrigin, allowedOrigins);
    return;
  }

  // 6. Read request body
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'Request body too large') {
      sendError(res, 413, 'Request body too large', undefined, requestOrigin, allowedOrigins);
    } else {
      sendError(res, 400, 'Failed to read request body', undefined, requestOrigin, allowedOrigins);
    }
    return;
  }

  if (!body || body.length === 0) {
    sendError(res, 400, 'Empty request body', undefined, requestOrigin, allowedOrigins);
    return;
  }

  // 7. Build provider-specific upstream headers
  const upstreamHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (route.provider === 'anthropic') {
    // Anthropic uses x-api-key header
    if (apiKey) upstreamHeaders['x-api-key'] = apiKey;
    upstreamHeaders['anthropic-version'] = '2023-06-01';
  } else if (route.provider === 'gemini' && apiKey) {
    // Gemini uses x-goog-api-key header
    upstreamHeaders['x-goog-api-key'] = apiKey;
  } else if (apiKey) {
    // OpenAI, Ollama (when key exists) use Bearer token
    upstreamHeaders['Authorization'] = `Bearer ${apiKey}`;
  }

  // 8. Proxy to upstream
  try {
    const upstreamResponse = await fetch(route.upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body,
    });

    // Record successful auth on 2xx response
    if (upstreamResponse.ok) {
      rateLimiter.recordSuccess(clientIp);
    }

    // Stream response back to client
    setCorsHeaders(res, requestOrigin, allowedOrigins);
    res.writeHead(upstreamResponse.status, {
      'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json',
    });

    // Check if response body exists and is streamable
    if (upstreamResponse.body) {
      const reader = upstreamResponse.body.getReader();

      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        res.write(value);
        return pump();
      };

      await pump();
    } else {
      // Fallback for non-streaming response
      const text = await upstreamResponse.text();
      res.end(text);
    }
  } catch (err) {
    sendError(res, 502, `Failed to proxy request: ${(err as Error).message}`, undefined, requestOrigin, allowedOrigins);
  }
}

/** Content-Type map for common file extensions */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.pdf': 'application/pdf',
};

/**
 * Handle GET /agents/:agentId/files/* — serve agent files via signed URL
 */
async function handleAgentFile(
  res: ServerResponse,
  agentId: string,
  filePath: string,
  sig: string,
  exp: number,
  context: HttpHandlerContext,
  requestOrigin?: string,
  allowedOrigins?: string[],
): Promise<void> {
  const { signingSecret, agentStorePath } = context;

  if (!signingSecret || !agentStorePath) {
    sendError(res, 503, 'File serving not configured', undefined, requestOrigin, allowedOrigins);
    return;
  }

  // Verify signed URL
  if (!verifySignedUrl(signingSecret, agentId, filePath, sig, exp)) {
    sendError(res, 403, 'Invalid or expired signature', undefined, requestOrigin, allowedOrigins);
    return;
  }

  // Resolve file within agent's files directory
  const filesRoot = resolve(agentStorePath, agentId, 'files');
  const resolvedPath = await validateFilePath(filePath, filesRoot);
  if (!resolvedPath) {
    sendError(res, 404, 'File not found', undefined, requestOrigin, allowedOrigins);
    return;
  }

  try {
    const data = await readFile(resolvedPath);
    const ext = extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    setCorsHeaders(res, requestOrigin, allowedOrigins);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(data);
  } catch {
    sendError(res, 404, 'File not found', undefined, requestOrigin, allowedOrigins);
  }
}

/** Parse /agents/:agentId/files/* route */
const AGENT_FILE_ROUTE = /^\/agents\/([^/]+)\/files\/(.+)$/;

/**
 * Create HTTP request handler for hub API endpoints
 */
export function createHttpRequestHandler(
  context: HttpHandlerContext,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url || '/';
    const method = req.method || 'GET';
    const requestOrigin = req.headers.origin as string | undefined;
    const allowedOrigins = context.config.allowedOrigins;

    // Handle CORS preflight
    if (method === 'OPTIONS' && (url.startsWith('/api/') || url.startsWith('/agents/'))) {
      handleOptions(res, requestOrigin, allowedOrigins);
      return;
    }

    // Handle GET /api/status
    if (method === 'GET' && url === '/api/status') {
      handleStatus(res, requestOrigin, allowedOrigins);
      return;
    }

    // Handle GET /tls-setup — landing page for self-signed cert acceptance
    if (method === 'GET' && url === '/tls-setup') {
      handleTlsSetup(res);
      return;
    }

    // Handle GET /agents/:agentId/files/* — signed URL file serving
    if (method === 'GET' && url.startsWith('/agents/')) {
      // Parse URL and query string
      const [pathname, queryString] = url.split('?');
      const match = pathname.match(AGENT_FILE_ROUTE);
      if (match) {
        const agentId = decodeURIComponent(match[1]);
        const filePath = decodeURIComponent(match[2]);
        const params = new URLSearchParams(queryString || '');
        const sig = params.get('sig') || '';
        const exp = parseInt(params.get('exp') || '0', 10);

        handleAgentFile(res, agentId, filePath, sig, exp, context, requestOrigin, allowedOrigins).catch((err) => {
          console.error('[http-server] Error serving agent file:', err);
          sendError(res, 500, 'Internal server error', undefined, requestOrigin, allowedOrigins);
        });
        return;
      }
    }

    // Handle POST /api/* (provider proxy)
    if (method === 'POST' && url.startsWith('/api/')) {
      const route = getProviderRoute(url, context.config);
      if (route) {
        handleProviderProxy(req, res, context, route, requestOrigin, allowedOrigins).catch((err) => {
          console.error('[http-server] Error handling provider proxy:', err);
          sendError(res, 500, 'Internal server error', undefined, requestOrigin, allowedOrigins);
        });
        return;
      }
    }

    // 404 for unknown routes
    sendError(res, 404, 'Not found', undefined, requestOrigin, allowedOrigins);
  };
}
