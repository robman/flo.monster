import type { ToolPluginRegistry, ExtensionContext } from '@flo-monster/core';
import { getToolTier } from '@flo-monster/core';
import type { AgentContainer } from '../../agent/agent-container.js';
import type { AgentStorageProvider } from '../../storage/agent-storage.js';
import type { ExtensionLoader } from '../extension-loader.js';
import type { AuditManager } from '../audit-manager.js';
import type { NetworkIndicator } from '../../ui/network-indicator.js';
import { openDB, idbGet, idbPut, idbDelete, idbKeys } from '../../utils/idb-helpers.js';
import { executeFetch, checkNetworkApproval, type FetchContext } from './fetch-handler.js';

export interface SrcdocContext extends FetchContext {
  pluginRegistry: ToolPluginRegistry | null;
  extensionLoader: ExtensionLoader | null;
  getProvider(): Promise<AgentStorageProvider>;
}

export async function handleSrcdocToolCall(
  msg: { type: 'srcdoc_tool_call'; id: string; agentId: string; name: string; input: Record<string, unknown> },
  agent: AgentContainer,
  target: Window,
  ctx: SrcdocContext,
): Promise<void> {
  const tier = getToolTier(msg.name);

  // Blocked tier - return immediate error
  if (tier === 'blocked') {
    target.postMessage({
      type: 'srcdoc_tool_call_result',
      id: msg.id,
      error: `Tool "${msg.name}" is not allowed from srcdoc JavaScript`,
    }, '*');
    return;
  }

  // Prompted tier - check approval
  if (tier === 'prompted') {
    const approved = await checkNetworkApproval(
      agent.id,
      agent.config.name,
      msg.name,
      msg.input,
      ctx,
    );

    // Log to audit
    ctx.auditManager?.append(agent.id, {
      source: 'srcdoc',
      tool: msg.name,
      action: 'approval_check',
      approved,
    });

    if (!approved) {
      target.postMessage({
        type: 'srcdoc_tool_call_result',
        id: msg.id,
        error: `Network access denied by user for tool "${msg.name}"`,
      }, '*');
      return;
    }
  }

  try {
    // Route built-in tools through their dedicated handlers
    const builtinResult = await executeSrcdocBuiltinTool(msg.name, msg.input, agent, ctx);
    if (builtinResult !== undefined) {
      // Log to audit
      ctx.auditManager?.append(agent.id, {
        source: 'srcdoc',
        tool: msg.name,
        action: msg.input.action as string | undefined,
        key: msg.input.key as string | undefined,
        url: msg.input.url as string | undefined,
      });

      target.postMessage({
        type: 'srcdoc_tool_call_result',
        id: msg.id,
        result: typeof builtinResult === 'string' ? builtinResult : JSON.stringify(builtinResult),
      }, '*');
      return;
    }

    // Fall through to plugin registry for non-builtin tools (web_fetch, web_search, audit_log, etc.)
    if (!ctx.pluginRegistry) {
      target.postMessage({
        type: 'srcdoc_tool_call_result',
        id: msg.id,
        error: 'No plugin registry available',
      }, '*');
      return;
    }

    // Get extension context if tool belongs to an extension
    let extensionContext: ExtensionContext | undefined;
    const extensionId = ctx.pluginRegistry.getExtensionId(msg.name);
    if (extensionId && ctx.extensionLoader) {
      extensionContext = await ctx.extensionLoader.getExtensionContext(extensionId);
    }

    const result = await ctx.pluginRegistry.execute(msg.name, msg.input, {
      agentId: agent.id,
      agentConfig: agent.config,
      extensionContext,
    });

    // Log to audit
    ctx.auditManager?.append(agent.id, {
      source: 'srcdoc',
      tool: msg.name,
      ...(msg.name === 'subagent' ? { task: (msg.input.task as string)?.substring(0, 200) } : {}),
    });

    // Record in network indicator for network tools
    if (msg.name === 'web_fetch') {
      const url = msg.input.url as string;
      if (url) ctx.networkIndicator?.recordActivity(url);
    }

    target.postMessage({
      type: 'srcdoc_tool_call_result',
      id: msg.id,
      result: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
    }, '*');
  } catch (err) {
    // Log to audit with error
    ctx.auditManager?.append(agent.id, {
      source: 'srcdoc',
      tool: msg.name,
      error: String(err),
    });

    target.postMessage({
      type: 'srcdoc_tool_call_result',
      id: msg.id,
      error: String(err),
    }, '*');
  }
}

/**
 * Execute a built-in tool directly for srcdoc callTool().
 * Built-in tools (storage, files, fetch) aren't in the plugin registry --
 * they're handled via dedicated message paths. This method routes them
 * through the same logic used by the worker message handlers.
 * Returns undefined if the tool is not a built-in (fall through to plugin registry).
 */
export async function executeSrcdocBuiltinTool(
  name: string,
  input: Record<string, unknown>,
  agent: AgentContainer,
  ctx: SrcdocContext,
): Promise<unknown | undefined> {
  switch (name) {
    case 'storage': {
      const action = input.action as string;
      const key = input.key as string | undefined;
      const value = input.value;
      const dbName = `flo-agent-${agent.id}`;
      const db = await openDB(dbName);
      let result: unknown = null;
      try {
        switch (action) {
          case 'get':
            result = await idbGet(db, 'store', key || '');
            break;
          case 'set':
            await idbPut(db, 'store', key || '', value);
            result = { ok: true };
            break;
          case 'delete':
            await idbDelete(db, 'store', key || '');
            result = { ok: true };
            break;
          case 'list':
            result = await idbKeys(db, 'store');
            break;
          default:
            throw new Error('Unknown storage action: ' + action);
        }
      } finally {
        db.close();
      }
      return result;
    }

    case 'files': {
      const action = input.action as string;
      const path = input.path as string;
      const content = input.content as string | undefined;
      const provider = await ctx.getProvider();
      switch (action) {
        case 'read_file':
          return await provider.readFile(agent.id, path);
        case 'write_file':
          await provider.writeFile(agent.id, path, content || '');
          return 'File written: ' + path;
        case 'delete_file':
          await provider.deleteFile(agent.id, path);
          return 'Deleted: ' + path;
        case 'mkdir':
          await provider.mkdir(agent.id, path);
          return 'Directory created: ' + path;
        case 'list_dir':
        case 'list_files': {
          const entries = await provider.listDir(agent.id, path);
          const names = entries.map(e => e.name + (e.isDirectory ? '/' : ''));
          return names.length > 0 ? names.join('\n') : '(empty directory)';
        }
        default:
          throw new Error('Unknown files action: ' + action);
      }
    }

    case 'fetch': {
      // Route through the shared fetch logic with full policy enforcement
      const url = input.url as string;
      if (!url) throw new Error('fetch requires a url');

      const fetchOptions = {
        method: input.method as string | undefined,
        headers: input.headers as Record<string, string> | undefined,
        body: input.body as string | undefined,
      };

      const result = await executeFetch(url, fetchOptions, agent, 'srcdoc', ctx);
      return { status: result.status, body: result.body };
    }

    case 'view_state': {
      // Delegate to the existing requestViewState mechanism
      const state = input.state as string;
      if (state) {
        const iframe = agent.getIframeElement();
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({
            type: 'request_view_state',
            agentId: agent.id,
            state,
          }, '*');
        }
      }
      return { ok: true };
    }

    default:
      // Not a built-in tool -- return undefined to fall through to plugin registry
      return undefined;
  }
}
