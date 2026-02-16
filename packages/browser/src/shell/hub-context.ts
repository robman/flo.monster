import type { AgentConfig } from '@flo-monster/core';
import type { HubClient, HubConnection } from './hub-client.js';

/**
 * Generates system prompt context describing hub capabilities available to an agent.
 *
 * @param agentConfig - The agent configuration
 * @param hubClient - The hub client (may be null if no hub is connected)
 * @returns Markdown-formatted text describing the hub environment, or empty string if no hub
 */
export function generateHubContext(
  agentConfig: AgentConfig,
  hubClient: HubClient | null,
  hubPersistInfo?: { hubAgentId: string; hubName: string; hubConnectionId: string },
): string {
  if (!hubClient) {
    return '';
  }

  // Get the relevant hub connection
  const connection = getAgentHubConnection(agentConfig, hubClient);
  if (!connection || !connection.connected) {
    return '';
  }

  // Check if there are any tools available
  if (connection.tools.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('## Hub Environment');
  lines.push('');
  if (hubPersistInfo) {
    lines.push(`You are persisted to hub "${hubPersistInfo.hubName}" (agent ID: ${hubPersistInfo.hubAgentId}). You can run autonomously without a browser — the hub maintains your state, files, and DOM. When a browser connects, it becomes your display surface. Load the \`flo-hub\` skill for hub-specific patterns.`);
  } else {
    lines.push('You have access to a local hub server. You are running in browser-only mode — persist to the hub to gain autonomous execution.');
  }
  lines.push('');

  // Add available tools section
  lines.push('### Available Hub Tools');
  for (const tool of connection.tools) {
    const description = tool.description ? `: ${tool.description}` : '';
    lines.push(`- ${tool.name}${description}`);
  }
  lines.push('');

  // Add working directory section
  const sandboxPath = getSandboxPath(agentConfig, connection);
  lines.push('### Working Directory');
  lines.push(`Your working directory is: ${sandboxPath}`);

  return lines.join('\n');
}

/**
 * Gets the hub connection for an agent based on its config.
 * If agent has a specific hubConnectionId, uses that.
 * Otherwise returns the first available connection.
 */
function getAgentHubConnection(
  agentConfig: AgentConfig,
  hubClient: HubClient
): HubConnection | undefined {
  const connections = hubClient.getConnections();

  if (agentConfig.hubConnectionId) {
    return hubClient.getConnection(agentConfig.hubConnectionId);
  }

  // Return first available connection
  return connections.find(c => c.connected);
}

/**
 * Gets the sandbox path for an agent.
 * Priority: agent config > default
 */
function getSandboxPath(
  agentConfig: AgentConfig,
  _connection: HubConnection
): string {
  // Check agent-specific sandbox path first
  if (agentConfig.hubSandboxPath) {
    return agentConfig.hubSandboxPath;
  }

  // Default sandbox path
  return '~/.flo-monster/sandbox';
}
