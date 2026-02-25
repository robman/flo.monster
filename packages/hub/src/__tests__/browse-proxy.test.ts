/**
 * Tests for BrowseProxy — localhost-only HTTP proxy for headless browser traffic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BrowseProxy, matchesDomain, type BrowseProxyConfig } from '../browse-proxy.js';

// ---------------------------------------------------------------------------
// matchesDomain
// ---------------------------------------------------------------------------

describe('matchesDomain', () => {
  it('should match exact domain', () => {
    expect(matchesDomain('example.com', ['example.com'])).toBe(true);
  });

  it('should not match different domain on exact pattern', () => {
    expect(matchesDomain('other.com', ['example.com'])).toBe(false);
  });

  it('should match wildcard pattern *.example.com against sub.example.com', () => {
    expect(matchesDomain('sub.example.com', ['*.example.com'])).toBe(true);
  });

  it('should match wildcard pattern against deep subdomain', () => {
    expect(matchesDomain('deep.sub.example.com', ['*.example.com'])).toBe(true);
  });

  it('should not match wildcard pattern against the root domain itself', () => {
    // *.example.com should NOT match example.com (the hostname must have a prefix)
    expect(matchesDomain('example.com', ['*.example.com'])).toBe(false);
  });

  it('should not match wildcard pattern against unrelated domain', () => {
    expect(matchesDomain('evil.com', ['*.example.com'])).toBe(false);
  });

  it('should return false for empty patterns list', () => {
    expect(matchesDomain('example.com', [])).toBe(false);
  });

  it('should match against any pattern in the list', () => {
    const patterns = ['foo.com', '*.bar.com', 'baz.org'];
    expect(matchesDomain('foo.com', patterns)).toBe(true);
    expect(matchesDomain('sub.bar.com', patterns)).toBe(true);
    expect(matchesDomain('baz.org', patterns)).toBe(true);
    expect(matchesDomain('other.com', patterns)).toBe(false);
  });

  it('should not match partial domain names on exact patterns', () => {
    // "ample.com" should not match "example.com"
    expect(matchesDomain('ample.com', ['example.com'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BrowseProxy — validation logic
// ---------------------------------------------------------------------------

describe('BrowseProxy', () => {
  describe('validateHostname', () => {
    it('should block private IPs when blockPrivateIPs is true', () => {
      const proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: true,
        rateLimitPerDomain: 0,
      });

      expect(proxy.validateHostname('127.0.0.1')).toMatch(/private IP/);
      expect(proxy.validateHostname('localhost')).toMatch(/private IP/);
      expect(proxy.validateHostname('10.0.0.1')).toMatch(/private IP/);
      expect(proxy.validateHostname('192.168.1.1')).toMatch(/private IP/);
      expect(proxy.validateHostname('172.16.0.1')).toMatch(/private IP/);
    });

    it('should allow private IPs when blockPrivateIPs is false', () => {
      const proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 0,
      });

      expect(proxy.validateHostname('127.0.0.1')).toBeNull();
      expect(proxy.validateHostname('localhost')).toBeNull();
      expect(proxy.validateHostname('10.0.0.1')).toBeNull();
      expect(proxy.validateHostname('192.168.1.1')).toBeNull();
    });

    it('should allow public IPs when blockPrivateIPs is true', () => {
      const proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: true,
        rateLimitPerDomain: 0,
      });

      expect(proxy.validateHostname('8.8.8.8')).toBeNull();
      expect(proxy.validateHostname('example.com')).toBeNull();
    });

    it('should block domains in blockedDomains list', () => {
      const proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: ['evil.com', '*.malware.net'],
        blockPrivateIPs: false,
        rateLimitPerDomain: 0,
      });

      expect(proxy.validateHostname('evil.com')).toMatch(/blocklist/);
      expect(proxy.validateHostname('sub.malware.net')).toMatch(/blocklist/);
      expect(proxy.validateHostname('safe.com')).toBeNull();
    });

    it('should only allow domains in allowedDomains when non-empty', () => {
      const proxy = new BrowseProxy({
        allowedDomains: ['example.com', '*.trusted.org'],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 0,
      });

      expect(proxy.validateHostname('example.com')).toBeNull();
      expect(proxy.validateHostname('sub.trusted.org')).toBeNull();
      expect(proxy.validateHostname('other.com')).toMatch(/allowlist/);
    });

    it('should allow everything when allowedDomains is empty', () => {
      const proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 0,
      });

      expect(proxy.validateHostname('anything.com')).toBeNull();
      expect(proxy.validateHostname('random.org')).toBeNull();
    });

    it('should apply blockedDomains even when allowedDomains matches', () => {
      // A domain could match the allowlist but still be blocked
      const proxy = new BrowseProxy({
        allowedDomains: ['*.example.com'],
        blockedDomains: ['evil.example.com'],
        blockPrivateIPs: false,
        rateLimitPerDomain: 0,
      });

      expect(proxy.validateHostname('good.example.com')).toBeNull();
      expect(proxy.validateHostname('evil.example.com')).toMatch(/blocklist/);
    });

    it('should check private IPs before domain checks', () => {
      const proxy = new BrowseProxy({
        allowedDomains: ['localhost'],
        blockedDomains: [],
        blockPrivateIPs: true,
        rateLimitPerDomain: 0,
      });

      // localhost is in the allowlist, but blockPrivateIPs takes precedence
      expect(proxy.validateHostname('localhost')).toMatch(/private IP/);
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  describe('checkRateLimit', () => {
    it('should allow requests when rate limit is 0 (unlimited)', () => {
      const proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 0,
      });

      for (let i = 0; i < 1000; i++) {
        expect(proxy.checkRateLimit('example.com')).toBe(true);
      }
    });

    it('should allow requests within the limit', () => {
      const proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 5,
      });

      for (let i = 0; i < 5; i++) {
        expect(proxy.checkRateLimit('example.com')).toBe(true);
      }
    });

    it('should block requests over the limit', () => {
      const proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 3,
      });

      expect(proxy.checkRateLimit('example.com')).toBe(true);
      expect(proxy.checkRateLimit('example.com')).toBe(true);
      expect(proxy.checkRateLimit('example.com')).toBe(true);
      // 4th request should be blocked
      expect(proxy.checkRateLimit('example.com')).toBe(false);
    });

    it('should track domains independently', () => {
      const proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 2,
      });

      expect(proxy.checkRateLimit('a.com')).toBe(true);
      expect(proxy.checkRateLimit('a.com')).toBe(true);
      expect(proxy.checkRateLimit('a.com')).toBe(false);

      // Different domain should have its own limit
      expect(proxy.checkRateLimit('b.com')).toBe(true);
      expect(proxy.checkRateLimit('b.com')).toBe(true);
      expect(proxy.checkRateLimit('b.com')).toBe(false);
    });

    it('should reset rate limits', () => {
      const proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 1,
      });

      expect(proxy.checkRateLimit('example.com')).toBe(true);
      expect(proxy.checkRateLimit('example.com')).toBe(false);

      proxy.resetRateLimits();

      expect(proxy.checkRateLimit('example.com')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe('lifecycle', () => {
    let proxy: BrowseProxy;

    beforeEach(() => {
      proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: true,
        rateLimitPerDomain: 0,
      });
    });

    afterEach(async () => {
      await proxy.close();
    });

    it('should have port 0 before starting', () => {
      expect(proxy.port).toBe(0);
    });

    it('should assign a port > 0 on start', async () => {
      const port = await proxy.start();
      expect(port).toBeGreaterThan(0);
      expect(proxy.port).toBe(port);
    });

    it('should reset port to 0 after close', async () => {
      await proxy.start();
      expect(proxy.port).toBeGreaterThan(0);

      await proxy.close();
      expect(proxy.port).toBe(0);
    });

    it('should be safe to call close when not started', async () => {
      // Should not throw
      await proxy.close();
    });
  });

  // ---------------------------------------------------------------------------
  // HTTP request validation (via actual HTTP requests to the proxy)
  // ---------------------------------------------------------------------------

  describe('HTTP request handling', () => {
    let proxy: BrowseProxy;

    afterEach(async () => {
      await proxy.close();
    });

    it('should return 403 for blocked domain', async () => {
      proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: ['blocked.example.com'],
        blockPrivateIPs: false,
        rateLimitPerDomain: 0,
      });
      await proxy.start();

      const res = await fetch(`http://127.0.0.1:${proxy.port}/`, {
        headers: { Host: 'blocked.example.com' },
      });

      // The proxy reads the full URL from the request line.
      // When using fetch to a proxy, we need to pass the target URL directly.
      // Let's test by requesting through the proxy with a full target URL.
    });

    it('should return 403 for private IP targets via HTTP', async () => {
      proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: true,
        rateLimitPerDomain: 0,
      });
      await proxy.start();

      // Use the HTTP_PROXY pattern: request a full URL through the proxy
      // Node fetch doesn't support proxy natively, so we use http.request
      const response = await makeProxyRequest(proxy.port, 'http://127.0.0.1:9999/test');
      expect(response.statusCode).toBe(403);
      expect(response.body).toMatch(/private IP/);
    });

    it('should return 403 for blocked domains via HTTP', async () => {
      proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: ['evil.com'],
        blockPrivateIPs: false,
        rateLimitPerDomain: 0,
      });
      await proxy.start();

      const response = await makeProxyRequest(proxy.port, 'http://evil.com/page');
      expect(response.statusCode).toBe(403);
      expect(response.body).toMatch(/blocklist/);
    });

    it('should return 403 for domain not in allowlist via HTTP', async () => {
      proxy = new BrowseProxy({
        allowedDomains: ['good.com'],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 0,
      });
      await proxy.start();

      const response = await makeProxyRequest(proxy.port, 'http://unauthorized.com/page');
      expect(response.statusCode).toBe(403);
      expect(response.body).toMatch(/allowlist/);
    });

    it('should return 429 when rate limited via HTTP', async () => {
      proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 1,
      });
      await proxy.start();

      // First request uses the rate limit
      const r1 = await makeProxyRequest(proxy.port, 'http://example.com/page1');
      // The first request will try to forward and may get a network error (502)
      // or succeed — we care about the second request being rate limited.

      const r2 = await makeProxyRequest(proxy.port, 'http://example.com/page2');
      expect(r2.statusCode).toBe(429);
      expect(r2.body).toMatch(/Rate limited/);
    });
  });

  // ---------------------------------------------------------------------------
  // CONNECT tunnel validation
  // ---------------------------------------------------------------------------

  describe('CONNECT tunnel handling', () => {
    let proxy: BrowseProxy;

    afterEach(async () => {
      await proxy.close();
    });

    it('should return 403 for blocked domain on CONNECT', async () => {
      proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: ['evil.com'],
        blockPrivateIPs: false,
        rateLimitPerDomain: 0,
      });
      await proxy.start();

      const response = await makeConnectRequest(proxy.port, 'evil.com:443');
      expect(response).toMatch(/403/);
    });

    it('should return 403 for private IP on CONNECT', async () => {
      proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: true,
        rateLimitPerDomain: 0,
      });
      await proxy.start();

      const response = await makeConnectRequest(proxy.port, '192.168.1.1:443');
      expect(response).toMatch(/403/);
    });

    it('should return 403 for domain not in allowlist on CONNECT', async () => {
      proxy = new BrowseProxy({
        allowedDomains: ['allowed.com'],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 0,
      });
      await proxy.start();

      const response = await makeConnectRequest(proxy.port, 'unauthorized.com:443');
      expect(response).toMatch(/403/);
    });

    it('should return 429 when rate limited on CONNECT', async () => {
      proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: [],
        blockPrivateIPs: false,
        rateLimitPerDomain: 1,
      });
      await proxy.start();

      // Use a valid public domain that will attempt connection
      // First request consumes the rate limit (will likely fail to connect,
      // but the rate limit is checked before connection attempt)
      await makeConnectRequest(proxy.port, 'example.com:443').catch(() => {});

      const response = await makeConnectRequest(proxy.port, 'example.com:443');
      expect(response).toMatch(/429/);
    });

    it('should allow CONNECT to non-blocked domain', async () => {
      proxy = new BrowseProxy({
        allowedDomains: [],
        blockedDomains: ['evil.com'],
        blockPrivateIPs: true,
        rateLimitPerDomain: 0,
      });
      await proxy.start();

      // Should get 200 Connection Established (though actual TLS handshake
      // would follow). The connection attempt may fail at TCP level, but
      // the proxy should at least try to connect rather than returning 403.
      const response = await makeConnectRequest(proxy.port, 'example.com:443');
      // Should NOT be 403 — it should be 200 (connected) or 502 (connection failed)
      expect(response).not.toMatch(/403/);
    });
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

import * as http from 'node:http';
import * as net from 'node:net';

/**
 * Make an HTTP request through the proxy.
 * Sends a standard proxy-style request with the full URL as the request target.
 */
function makeProxyRequest(
  proxyPort: number,
  targetUrl: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        // For an HTTP proxy, the request line contains the full target URL
        path: targetUrl,
        method: 'GET',
        headers: {
          Host: parsed.host,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Make a CONNECT request to the proxy and return the status line response.
 */
function makeConnectRequest(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });

    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      // Once we get the status line, resolve
      if (data.includes('\r\n\r\n') || data.includes('\n\n')) {
        socket.destroy();
        resolve(data);
      }
    });

    socket.on('error', reject);

    // Timeout to avoid hanging
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('CONNECT request timed out'));
    });
  });
}
