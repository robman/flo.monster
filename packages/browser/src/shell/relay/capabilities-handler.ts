import type { AgentContainer } from '../../agent/agent-container.js';
import type { HubClient } from '../hub-client.js';
import type { ExtensionLoader } from '../extension-loader.js';

export interface CapabilitiesContext {
  hubClient: HubClient | null;
  extensionLoader: ExtensionLoader | null;
}

export function handleCapabilitiesRequest(
  msg: { type: 'capabilities_request'; id: string; agentId: string; iframeData: Record<string, unknown> },
  agent: AgentContainer,
  target: Window,
  ctx: CapabilitiesContext,
): void {
  // Collect shell-side data
  const builtinTools = agent.config.tools.map(t => t.name);

  // Hub tools
  let hubTools: string[] = [];
  let hubConnected = false;
  if (ctx.hubClient) {
    // Check agent-specific hub connection or find any with tools
    const hubConnectionId = agent.config.hubConnectionId;
    if (hubConnectionId) {
      const conn = ctx.hubClient.getConnection(hubConnectionId);
      if (conn) {
        hubConnected = true;
        hubTools = conn.tools.map(t => t.name);
      }
    } else {
      // Check if any hub connection exists
      const connections = ctx.hubClient.getConnections?.() || [];
      if (connections.length > 0) {
        hubConnected = true;
        // Collect all hub tools from all connections
        for (const conn of connections) {
          for (const tool of conn.tools || []) {
            if (!hubTools.includes(tool.name)) {
              hubTools.push(tool.name);
            }
          }
        }
      }
    }
  }

  // Extension tools
  const extTools: string[] = [];
  const extensions: Array<{ name: string; version?: string; tools: string[] }> = [];
  if (ctx.extensionLoader) {
    const loaded = ctx.extensionLoader.getLoaded();
    for (const ext of loaded) {
      const tools = ext.tools?.map(t => t.definition.name) || [];
      extTools.push(...tools);
      extensions.push({ name: ext.name, version: ext.version, tools });
    }
  }

  // Permissions
  const sp = agent.config.sandboxPermissions || {};
  const permissions: Record<string, boolean | string> = {
    camera: sp.camera === true ? true : 'prompt',
    microphone: sp.microphone === true ? true : 'prompt',
    geolocation: sp.geolocation === true ? true : 'prompt',
  };

  // Hub persistence info
  const hubPersist = agent.hubPersistInfo;

  // Merge with iframe data
  const result = {
    ...msg.iframeData,  // platform, viewport
    runtime: hubPersist ? 'hub' as const : 'browser' as const,
    executionMode: hubPersist
      ? 'hub-with-browser' as const
      : hubConnected
        ? 'browser-with-hub' as const
        : 'browser-only' as const,
    hubConnected,
    ...(hubPersist ? { hubAgentId: hubPersist.hubAgentId, hubName: hubPersist.hubName } : {}),
    provider: agent.config.provider || 'anthropic',
    model: agent.config.model,
    tools: { builtin: builtinTools, hub: hubTools, extension: extTools },
    networkPolicy: agent.config.networkPolicy || { mode: 'allow-all' },
    permissions,
    agent: { id: agent.id, name: agent.config.name },
    extensions,
    skills: [] as string[],
    limits: {
      maxSubagentDepth: 3,
      subagentTimeout: 300000,
      tokenBudget: agent.config.tokenBudget || null,
      costBudget: agent.config.costBudgetUsd || null,
    },
  };

  target.postMessage({ type: 'capabilities_result', id: msg.id, result }, '*');
}
