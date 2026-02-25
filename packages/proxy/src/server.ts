import { createServer, IncomingMessage, ServerResponse, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

const PORT = parseInt(process.env.PORT || '3001', 10);
const UPSTREAM = 'https://api.anthropic.com';

/** Map of provider names to upstream base URLs */
const UPSTREAMS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, anthropic-beta, Authorization, x-goog-api-key',
  'Access-Control-Expose-Headers': '*',
};

/** Headers to forward for Anthropic requests */
const FORWARDED_HEADERS_ANTHROPIC = [
  'content-type',
  'x-api-key',
  'anthropic-version',
  'anthropic-dangerous-direct-browser-access',
  'anthropic-beta',
];

/** Headers to forward for OpenAI-compatible requests (OpenAI) */
const FORWARDED_HEADERS_OPENAI = [
  'content-type',
  'authorization',
];

/** Headers to forward for Gemini native requests */
const FORWARDED_HEADERS_GEMINI = ['content-type', 'x-goog-api-key'];

/**
 * Parse the incoming request URL to determine the provider and upstream path.
 * Returns null if the route is not recognized.
 *
 * Route mapping:
 *   /anthropic/v1/messages                → anthropic, /v1/messages
 *   /openai/v1/chat/completions           → openai, /v1/chat/completions
 *   /gemini/v1beta/openai/chat/completions → gemini, /v1beta/openai/chat/completions
 *   /gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse → gemini, /v1beta/models/...
 *   /v1/messages                          → anthropic, /v1/messages (backwards compat)
 */
export function parseRoute(reqUrl: string): { provider: string; upstreamPath: string } | null {
  if (reqUrl.startsWith('/anthropic/')) {
    return { provider: 'anthropic', upstreamPath: reqUrl.replace(/^\/anthropic/, '') };
  }
  if (reqUrl.startsWith('/openai/')) {
    return { provider: 'openai', upstreamPath: reqUrl.replace(/^\/openai/, '') };
  }
  if (reqUrl.startsWith('/gemini/')) {
    return { provider: 'gemini', upstreamPath: reqUrl.replace(/^\/gemini/, '') };
  }
  // Backwards compat: /v1/messages without prefix
  if (reqUrl === '/v1/messages') {
    return { provider: 'anthropic', upstreamPath: '/v1/messages' };
  }
  return null;
}

function handleCors(res: ServerResponse): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

export function createProxyServer(port: number = PORT, upstream: string = UPSTREAM, upstreamOverrides?: Record<string, string>) {
  // Build the effective upstream map: production defaults merged with overrides.
  // The upstream param always overrides the Anthropic upstream (backwards compatible).
  const effectiveUpstreams: Record<string, string> = { ...UPSTREAMS, anthropic: upstream };
  if (upstreamOverrides) {
    Object.assign(effectiveUpstreams, upstreamOverrides);
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      console.log(`[proxy] ${req.method} ${req.url} -> 204`);
      return;
    }

    const route = parseRoute(req.url || '');
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      console.log(`[proxy] ${req.method} ${req.url} -> 404`);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      console.log(`[proxy] ${req.method} ${req.url} -> 405`);
      return;
    }

    // Determine upstream URL from the effective upstream map
    const upstreamUrl = new URL(effectiveUpstreams[route.provider] || upstream);
    const isHttps = upstreamUrl.protocol === 'https:';
    const makeRequest = isHttps ? httpsRequest : httpRequest;

    // Select the correct header forwarding list
    const headerList = route.provider === 'anthropic'
      ? FORWARDED_HEADERS_ANTHROPIC
      : route.provider === 'gemini'
        ? FORWARDED_HEADERS_GEMINI
        : FORWARDED_HEADERS_OPENAI;

    // Collect request body
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      const body = Buffer.concat(chunks);

      // Build forwarded headers
      const forwardHeaders: Record<string, string> = {};
      for (const header of headerList) {
        const value = req.headers[header];
        if (value !== undefined) {
          forwardHeaders[header] = Array.isArray(value) ? value.join(', ') : value;
        }
      }

      const upstreamReqOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: route.upstreamPath,
        method: 'POST',
        headers: {
          ...forwardHeaders,
          'content-length': Buffer.byteLength(body).toString(),
        },
      };

      const upstreamReq = makeRequest(upstreamReqOptions, (upstreamRes: IncomingMessage) => {
        const statusCode = upstreamRes.statusCode || 502;

        // Copy content-type from upstream
        const contentType = upstreamRes.headers['content-type'];
        const responseHeaders: Record<string, string> = {};
        if (contentType) {
          responseHeaders['Content-Type'] = contentType;
        }

        res.writeHead(statusCode, responseHeaders);
        upstreamRes.pipe(res).on('error', (err: Error) => {
          console.error('[proxy] Pipe error:', err);
          if (!res.writableEnded) {
            res.end();
          }
        });

        console.log(`[proxy] ${req.method} ${req.url} -> ${route.provider} -> ${statusCode}`);
      });

      upstreamReq.on('error', (err: Error & { code?: string }) => {
        console.error(`[proxy] Upstream error: ${err.code || ''} ${err.message}`, err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Bad gateway', message: err.message || err.code || 'Unknown error' }));
        console.log(`[proxy] ${req.method} ${req.url} -> 502`);
      });

      upstreamReq.write(body);
      upstreamReq.end();
    });
  });

  return {
    server,
    start() {
      return new Promise<void>((resolve) => {
        server.listen(port, '0.0.0.0', () => {
          console.log(`[proxy] CORS proxy listening on http://0.0.0.0:${port}`);
          resolve();
        });
      });
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// Auto-start when run directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  createProxyServer().start();
}
