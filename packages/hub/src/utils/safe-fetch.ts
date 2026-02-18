/**
 * SSRF-safe fetch utility.
 * Validates URLs against private IP ranges and blocked patterns,
 * follows redirects manually checking each hop, strips sensitive headers.
 */

/** Sensitive headers stripped from outgoing requests */
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'x-api-key', 'proxy-authorization', 'set-cookie'];

/** Maximum redirect hops */
const MAX_REDIRECTS = 5;

/**
 * Check if a hostname resolves to a private/internal IP range.
 * Used to prevent SSRF via redirect to internal services.
 */
export function isPrivateIP(hostname: string): boolean {
  // Strip IPv6 brackets if present (URL.hostname returns [::1] for IPv6)
  const h = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  // Check common private IP patterns
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (h.startsWith('127.')) return true;
  if (h.startsWith('10.')) return true;
  if (h.startsWith('192.168.')) return true;
  if (h.startsWith('0.')) return true;
  if (h === '0.0.0.0') return true;
  // 172.16.0.0 - 172.31.255.255
  if (h.startsWith('172.')) {
    const second = parseInt(h.split('.')[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  // Link-local
  if (h.startsWith('169.254.')) return true;
  // IPv6
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  // IPv4-mapped IPv6 addresses — two forms:
  // 1. Dotted-decimal: ::ffff:192.168.1.1
  // 2. Hex (Node.js URL normalization): ::ffff:c0a8:101
  const v4mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4mappedDotted) return isPrivateIP(v4mappedDotted[1]);
  const v4mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4mappedHex) {
    const hi = parseInt(v4mappedHex[1], 16);
    const lo = parseInt(v4mappedHex[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIP(ipv4);
  }
  return false;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  blockedPatterns?: string[];
}

export interface SafeFetchResult {
  status: number;
  body: string;
  error?: string;
}

/**
 * Execute a fetch with SSRF protections:
 * - Checks initial URL against private IPs and blocked patterns
 * - Strips sensitive headers
 * - Follows redirects manually, validating each hop
 * - Enforces timeout
 */
export async function executeSafeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const blockedPatterns = options.blockedPatterns || [];

  // Check initial URL against blocked patterns
  const isBlocked = blockedPatterns.some(pattern => {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(url) || regex.test(new URL(url).hostname);
  });

  if (isBlocked) {
    return { status: 0, body: '', error: 'URL is blocked by fetch proxy policy' };
  }

  // Check initial URL for private IPs
  try {
    const hostname = new URL(url).hostname;
    if (isPrivateIP(hostname)) {
      return { status: 0, body: '', error: 'Fetch to private IP blocked' };
    }
  } catch {
    return { status: 0, body: '', error: 'Invalid URL' };
  }

  // Build fetch options, stripping sensitive headers
  const fetchOptions: RequestInit = {
    method: options.method || 'GET',
    headers: options.headers ? { ...options.headers } : undefined,
    body: options.body,
  };

  if (fetchOptions.headers) {
    const headers = new Headers(fetchOptions.headers as HeadersInit);
    for (const header of SENSITIVE_HEADERS) {
      headers.delete(header);
    }
    fetchOptions.headers = Object.fromEntries(headers.entries());
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);

  try {
    let currentUrl = url;
    let fetchResponse: Response | undefined;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      fetchResponse = await fetch(currentUrl, {
        ...fetchOptions,
        signal: controller.signal,
        redirect: 'manual',
      });

      const status = fetchResponse.status;
      if (status >= 300 && status < 400) {
        const location = fetchResponse.headers.get('location');
        if (!location) break;

        const redirectUrl = new URL(location, currentUrl).href;

        // Validate redirect target against blocked patterns
        const isRedirectBlocked = blockedPatterns.some(pattern => {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
          return regex.test(redirectUrl) || regex.test(new URL(redirectUrl).hostname);
        });

        if (isRedirectBlocked) {
          clearTimeout(timeout);
          return { status: 0, body: '', error: 'Redirect target blocked by fetch proxy policy' };
        }

        // Check redirect for private/internal IPs
        try {
          const redirectHostname = new URL(redirectUrl).hostname;
          if (isPrivateIP(redirectHostname)) {
            clearTimeout(timeout);
            return { status: 0, body: '', error: 'Redirect to private IP blocked' };
          }
        } catch {
          clearTimeout(timeout);
          return { status: 0, body: '', error: 'Invalid redirect URL' };
        }

        currentUrl = redirectUrl;
        // Don't send body on redirects (POST->GET)
        fetchOptions.body = undefined;
        continue;
      }

      // Not a redirect — we have the final response
      break;
    }

    clearTimeout(timeout);

    const body = await fetchResponse!.text();
    return { status: fetchResponse!.status, body };
  } catch (fetchError) {
    clearTimeout(timeout);
    return { status: 0, body: '', error: `Fetch failed: ${(fetchError as Error).message}` };
  }
}
