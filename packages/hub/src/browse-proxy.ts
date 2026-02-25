/**
 * Localhost-only HTTP proxy for headless browser traffic.
 *
 * When Playwright launches Chromium with `--proxy-server=http://127.0.0.1:PORT`,
 * ALL browser traffic (HTTP requests AND HTTPS CONNECT tunnels) flows through
 * this proxy. The proxy validates every request for SSRF, domain policy, and
 * rate limits before forwarding.
 *
 * This is the single enforcement point for network policy on headless browser
 * traffic — the browser literally cannot reach the network except through here.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import { isPrivateIP } from './utils/safe-fetch.js';

/** Configuration for the browse proxy */
export interface BrowseProxyConfig {
  /** Glob patterns for allowed domains. Empty array = allow all. */
  allowedDomains: string[];
  /** Glob patterns for blocked domains. Checked after allowed. */
  blockedDomains: string[];
  /** Whether to block requests to private/internal IP ranges */
  blockPrivateIPs: boolean;
  /** Maximum requests per minute per domain. 0 = unlimited. */
  rateLimitPerDomain: number;
}

/** Rate limit tracking entry for a single domain */
interface RateLimitEntry {
  timestamps: number[];
}

/**
 * Check if a hostname matches any of the given glob patterns.
 *
 * Supports two pattern forms:
 * - Exact match: `example.com` matches only `example.com`
 * - Wildcard: `*.example.com` matches `sub.example.com`, `deep.sub.example.com`, etc.
 */
export function matchesDomain(hostname: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === hostname) {
      return true;
    }
    // Handle wildcard patterns like *.example.com
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // e.g., ".example.com"
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Localhost-only HTTP proxy that validates and forwards headless browser traffic.
 *
 * Handles both regular HTTP requests and HTTPS CONNECT tunnels. All traffic
 * is validated against domain policy, private IP blocking, and rate limits
 * before being forwarded.
 */
export class BrowseProxy {
  private server: http.Server | null = null;
  private _port = 0;
  private config: BrowseProxyConfig;
  private rateLimits: Map<string, RateLimitEntry> = new Map();

  constructor(config: BrowseProxyConfig) {
    this.config = config;
  }

  /** The port the proxy is listening on. 0 if not started. */
  get port(): number {
    return this._port;
  }

  /** Start the proxy server, returns the port it is listening on. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // CONNECT tunneling for HTTPS traffic
      this.server.on('connect', (req, clientSocket, head) => {
        this.handleConnect(req.url || '', clientSocket as net.Socket, head);
      });

      this.server.on('error', reject);

      // Bind to localhost only, auto-assign port
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }
        resolve(this._port);
      });
    });
  }

  /** Stop the proxy server. */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        this._port = 0;
        resolve();
      });
    });
  }

  /**
   * Validate a hostname against the configured policy.
   * Returns null if valid, or an error message string if blocked.
   */
  validateHostname(hostname: string): string | null {
    // Check private IP blocking
    if (this.config.blockPrivateIPs && isPrivateIP(hostname)) {
      return `Blocked: private IP (${hostname})`;
    }

    // Check allowed domains (if non-empty, only listed domains pass)
    if (this.config.allowedDomains.length > 0) {
      if (!matchesDomain(hostname, this.config.allowedDomains)) {
        return `Blocked: domain not in allowlist (${hostname})`;
      }
    }

    // Check blocked domains
    if (matchesDomain(hostname, this.config.blockedDomains)) {
      return `Blocked: domain in blocklist (${hostname})`;
    }

    return null;
  }

  /**
   * Check rate limit for a domain.
   * Returns true if the request is within limits, false if rate-limited.
   */
  checkRateLimit(domain: string): boolean {
    if (this.config.rateLimitPerDomain <= 0) {
      return true;
    }

    const now = Date.now();
    const windowMs = 60_000; // 1 minute sliding window
    let entry = this.rateLimits.get(domain);

    if (!entry) {
      entry = { timestamps: [] };
      this.rateLimits.set(domain, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= this.config.rateLimitPerDomain) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /** Clear all rate limit tracking data. Useful for testing. */
  resetRateLimits(): void {
    this.rateLimits.clear();
  }

  /**
   * Handle a regular HTTP proxy request.
   * Validates the target, then forwards using fetch and pipes the response back.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = req.url;
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: missing URL');
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: invalid URL');
      return;
    }

    const hostname = parsedUrl.hostname;

    // Validate hostname
    const blockReason = this.validateHostname(hostname);
    if (blockReason) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(blockReason);
      return;
    }

    // Check rate limit
    if (!this.checkRateLimit(hostname)) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end(`Rate limited: too many requests to ${hostname}`);
      return;
    }

    // Forward the request
    try {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value && key.toLowerCase() !== 'proxy-connection' && key.toLowerCase() !== 'proxy-authorization') {
          headers[key] = Array.isArray(value) ? value.join(', ') : value;
        }
      }
      // Remove hop-by-hop proxy headers
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];

      // Collect request body
      const bodyChunks: Buffer[] = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk as Buffer);
      }
      const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;

      const fetchResponse = await fetch(parsedUrl.href, {
        method: req.method || 'GET',
        headers,
        body,
        redirect: 'manual',
      });

      // Write status and headers back to client
      const responseHeaders: Record<string, string> = {};
      fetchResponse.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      res.writeHead(fetchResponse.status, responseHeaders);

      if (fetchResponse.body) {
        const reader = fetchResponse.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
      }

      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(`Proxy error: ${(err as Error).message}`);
    }
  }

  /**
   * Handle an HTTP CONNECT tunnel (used for HTTPS traffic).
   * Validates the target hostname, then establishes a raw TCP tunnel.
   */
  private handleConnect(
    target: string,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    // CONNECT target format: hostname:port
    const colonIndex = target.lastIndexOf(':');
    if (colonIndex === -1) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.end();
      return;
    }

    const hostname = target.slice(0, colonIndex);
    const port = parseInt(target.slice(colonIndex + 1), 10);

    if (isNaN(port) || port <= 0 || port > 65535) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.end();
      return;
    }

    // Validate hostname
    const blockReason = this.validateHostname(hostname);
    if (blockReason) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.end();
      return;
    }

    // Check rate limit
    if (!this.checkRateLimit(hostname)) {
      clientSocket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      clientSocket.end();
      return;
    }

    // Establish TCP tunnel to the target
    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      // Send any buffered data from the initial request
      if (head.length > 0) {
        serverSocket.write(head);
      }

      // Pipe data bidirectionally
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', () => {
      if (clientSocket.writable) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      }
    });

    clientSocket.on('error', () => {
      serverSocket.destroy();
    });
  }
}
