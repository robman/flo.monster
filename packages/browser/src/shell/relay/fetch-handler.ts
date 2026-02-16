import type { IframeToShell, ShellToIframe, NetworkApproval } from '@flo-monster/core';
import type { AgentContainer } from '../../agent/agent-container.js';
import type { HubClient } from '../hub-client.js';
import type { AuditManager } from '../audit-manager.js';
import type { NetworkIndicator } from '../../ui/network-indicator.js';
import { NetworkApprovalDialog } from '../../ui/network-approval-dialog.js';
import { checkNetworkPolicy } from '../../utils/network-policy.js';

/** Maximum number of entries in the network approval cache */
const MAX_NETWORK_APPROVALS = 1000;

export interface FetchContext {
  hubClient: HubClient | null;
  auditManager: AuditManager | null;
  networkIndicator: NetworkIndicator | null;
  networkApprovals: Map<string, NetworkApproval>;
  approvalDialog: NetworkApprovalDialog | null;
  setApprovalDialog(dialog: NetworkApprovalDialog): void;
}

/**
 * Shared fetch logic used by both worker fetch requests and srcdoc builtin tool.
 * Handles URL validation, network policy enforcement, hub proxy routing,
 * header sanitization, audit logging, and network indicator recording.
 * Throws on errors so callers can handle them in their own way.
 */
export async function executeFetch(
  url: string,
  options: { method?: string; headers?: HeadersInit | Record<string, string>; body?: BodyInit | null } | undefined,
  agent: AgentContainer,
  source: 'agent' | 'srcdoc',
  ctx: FetchContext,
  redirectCount = 0,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  // Validate absolute URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Invalid or relative URL: ' + url);
  }

  // Reject non-http(s) protocols
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Blocked protocol: ${parsedUrl.protocol}`);
  }

  // Check network policy (allowlist/blocklist)
  checkNetworkPolicy(url, agent.config.networkPolicy);

  // Route through hub when connected (server-side fetch avoids CORS)
  if (ctx.hubClient) {
    let hubId: string | undefined;
    if (agent.config.hubConnectionId) {
      const conn = ctx.hubClient.getConnection(agent.config.hubConnectionId);
      if (conn && conn.connected) {
        hubId = agent.config.hubConnectionId;
      }
    } else {
      const connections = ctx.hubClient.getConnections();
      if (connections.length > 0) {
        hubId = connections[0].id;
      }
    }

    if (hubId) {
      const result = await ctx.hubClient.fetch(hubId, url, options as RequestInit);

      if (result.error) {
        throw new Error(result.error);
      }

      // Log to audit
      ctx.auditManager?.append(agent.id, {
        source,
        action: 'fetch',
        url,
        size: result.body.length,
      });

      // Record in network indicator
      ctx.networkIndicator?.recordActivity(url);

      return { status: result.status, headers: {}, body: result.body };
    }
  }

  // Sanitize headers - strip sensitive ones
  const FORBIDDEN_HEADERS = ['authorization', 'cookie', 'x-api-key', 'proxy-authorization'];
  const sanitizedHeaders: Record<string, string> = {};
  if (options?.headers) {
    const rawHeaders = options.headers;
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => {
        if (!FORBIDDEN_HEADERS.includes(k.toLowerCase())) {
          sanitizedHeaders[k] = v;
        }
      });
    } else if (Array.isArray(rawHeaders)) {
      for (const [k, v] of rawHeaders as [string, string][]) {
        if (!FORBIDDEN_HEADERS.includes(k.toLowerCase())) {
          sanitizedHeaders[k] = v;
        }
      }
    } else {
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (!FORBIDDEN_HEADERS.includes(k.toLowerCase())) {
          sanitizedHeaders[k] = v as string;
        }
      }
    }
  }

  // Force credentials: 'omit' and use sanitized options
  const sanitizedOptions: RequestInit = {
    method: options?.method || 'GET',
    headers: sanitizedHeaders,
    body: options?.body,
    credentials: 'omit',
    redirect: 'manual',
  };

  const response = await fetch(parsedUrl.href, sanitizedOptions);

  // Handle redirects with policy re-check
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect with no Location header');

    const redirectUrl = new URL(location, parsedUrl.href);
    if (redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:') {
      throw new Error(`Redirect to blocked protocol: ${redirectUrl.protocol}`);
    }

    // Re-check network policy on redirect target
    checkNetworkPolicy(redirectUrl.href, agent.config.networkPolicy);

    // Follow with recursion limit
    if (redirectCount >= 5) throw new Error('Too many redirects');
    return executeFetch(redirectUrl.href, options, agent, source, ctx, redirectCount + 1);
  }

  const body = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => { headers[k] = v; });

  // Log to audit
  ctx.auditManager?.append(agent.id, {
    source,
    action: 'fetch',
    url,
    size: body.length,
  });

  // Record in network indicator
  ctx.networkIndicator?.recordActivity(url);

  return { status: response.status, headers, body };
}

export async function handleFetchRequest(
  msg: Extract<IframeToShell, { type: 'fetch_request' }>,
  agent: AgentContainer,
  target: Window,
  ctx: FetchContext,
): Promise<void> {
  try {
    const result = await executeFetch(msg.url, msg.options, agent, 'agent', ctx);

    target.postMessage({
      type: 'fetch_response',
      id: msg.id,
      status: result.status,
      headers: result.headers,
      body: result.body,
    } satisfies ShellToIframe, '*');
  } catch (err) {
    target.postMessage({
      type: 'fetch_error',
      id: msg.id,
      error: String(err),
    } satisfies ShellToIframe, '*');
  }
}

/**
 * Extract a meaningful detail string from tool input (e.g., URL or query).
 */
export function extractToolDetail(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'fetch' || toolName === 'web_fetch') {
    return (input.url as string) || 'unknown';
  }
  if (toolName === 'web_search') {
    return (input.query as string) || 'unknown';
  }
  return JSON.stringify(input).substring(0, 100);
}

/**
 * Get a cache key for network approvals.
 * For URL-based tools, use the origin. For others, use the tool name.
 */
export function getApprovalKey(agentId: string, toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'fetch' || toolName === 'web_fetch') {
    try {
      const url = new URL(input.url as string);
      return `${agentId}:${toolName}:${url.origin}`;
    } catch {
      return `${agentId}:${toolName}:unknown`;
    }
  }
  // For non-URL tools like web_search, use tool name as key
  return `${agentId}:${toolName}`;
}

/**
 * Check if a prompted-tier tool call is approved.
 * Shows dialog if not cached.
 */
export async function checkNetworkApproval(
  agentId: string,
  agentName: string,
  toolName: string,
  input: Record<string, unknown>,
  ctx: FetchContext,
): Promise<boolean> {
  const key = getApprovalKey(agentId, toolName, input);

  // Check cache
  const cached = ctx.networkApprovals.get(key);
  if (cached) {
    if (cached.persistent) return cached.approved;
    // Non-persistent approval was used, delete it
    ctx.networkApprovals.delete(key);
    return cached.approved;
  }

  // Show dialog
  if (!ctx.approvalDialog) {
    const dialog = new NetworkApprovalDialog();
    ctx.setApprovalDialog(dialog);
  }

  const detail = extractToolDetail(toolName, input);
  const result = await ctx.approvalDialog!.show(agentName, toolName, detail);

  // Cache the result
  if (result.persistent || !result.approved) {
    // Evict oldest entries if cache exceeds max size
    if (ctx.networkApprovals.size >= MAX_NETWORK_APPROVALS) {
      const entriesToDelete = ctx.networkApprovals.size - MAX_NETWORK_APPROVALS + 1;
      const iterator = ctx.networkApprovals.keys();
      for (let i = 0; i < entriesToDelete; i++) {
        const oldest = iterator.next();
        if (!oldest.done) {
          ctx.networkApprovals.delete(oldest.value);
        }
      }
    }
    // Cache persistent approvals and all denials
    ctx.networkApprovals.set(key, {
      origin: detail,
      approved: result.approved,
      approvedAt: Date.now(),
      persistent: result.persistent,
    });
  }

  return result.approved;
}
