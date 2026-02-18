/**
 * Admin WebSocket server for hub management
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { HubConfig } from '../config.js';
import type { HubServer, ConnectedClient } from '../server.js';
import type {
  AdminToHub,
  HubToAdmin,
  AdminAgentInfo,
  AdminConnectionInfo,
  AdminUsageData,
  AdminScheduleInfo,
} from '@flo-monster/core';
import { isLocalhost, timingSafeCompare } from '../auth.js';
import { FailedAuthRateLimiter } from '../rate-limiter.js';
import { parseWsMessage, sendWsMessage } from '../utils/ws-utils.js';

export interface AdminClient {
  ws: WebSocket;
  authenticated: boolean;
  remoteAddress: string | undefined;
  subscribedToLogs: boolean;
  connectedAt: number;
}

export interface AdminServer {
  wss: WebSocketServer;
  clients: Set<AdminClient>;
  close(): Promise<void>;
  broadcastLog(level: string, message: string, source?: string): void;
}

// Log buffer for recent logs (keep last 1000 entries)
const LOG_BUFFER_SIZE = 1000;

interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  source?: string;
}

/** Parse an incoming admin WebSocket message */
function parseMessage(data: RawData): AdminToHub | null {
  return parseWsMessage<AdminToHub>(data);
}

/** Send a message to an admin WebSocket client */
function sendMessage(ws: WebSocket, message: HubToAdmin): void {
  sendWsMessage(ws, message);
}

/**
 * Create the admin server
 */
export function createAdminServer(
  config: HubConfig,
  hubServer: HubServer,
  startTime: number,
): AdminServer {
  const clients = new Set<AdminClient>();
  const logBuffer: LogEntry[] = [];
  let totalRequests = 0;
  const authRateLimiter = new FailedAuthRateLimiter(5, 15); // 5 attempts, 15 min lockout

  const wss = new WebSocketServer({
    port: config.adminPort,
    host: config.host,
  });

  /**
   * Broadcast a log entry to all subscribed admin clients
   */
  function broadcastLog(level: string, message: string, source?: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      source,
    };

    // Add to buffer
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) {
      logBuffer.shift();
    }

    // Send to subscribed clients
    const logMessage: HubToAdmin = {
      type: 'log_entry',
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      source: entry.source,
    };

    for (const client of clients) {
      if (client.subscribedToLogs) {
        sendMessage(client.ws, logMessage);
      }
    }
  }

  /**
   * Get agent info for admin
   */
  function getAgentInfo(agentId: string): AdminAgentInfo | null {
    const runner = hubServer.agents.get(agentId);
    if (!runner) return null;

    const session = runner.serialize();
    const messages = runner.getMessageHistory();
    const lastMessage = messages[messages.length - 1];
    return {
      id: agentId,
      name: runner.config.name || 'Unnamed Agent',
      state: runner.getState(),
      createdAt: session.metadata.createdAt,
      totalTokens: session.metadata.totalTokens,
      totalCost: session.metadata.totalCost,
      messageCount: messages.length,
      model: runner.config.model,
      provider: runner.config.provider,
      busy: runner.busy,
      lastActivity: lastMessage?.timestamp,
    };
  }

  /**
   * Get all agents info
   */
  function getAllAgents(): AdminAgentInfo[] {
    const agents: AdminAgentInfo[] = [];
    for (const [id, runner] of hubServer.agents) {
      const session = runner.serialize();
      agents.push({
        id,
        name: runner.config.name || 'Unnamed Agent',
        state: runner.getState(),
        createdAt: session.metadata.createdAt,
        totalTokens: session.metadata.totalTokens,
        totalCost: session.metadata.totalCost,
        messageCount: runner.getMessageHistory().length,
        model: runner.config.model,
        provider: runner.config.provider,
      });
    }
    return agents;
  }

  /**
   * Get all connections info
   */
  function getAllConnections(): AdminConnectionInfo[] {
    const connections: AdminConnectionInfo[] = [];
    let connectionId = 0;
    for (const client of hubServer.clients) {
      connections.push({
        id: `conn-${connectionId++}`,
        remoteAddress: client.remoteAddress || 'unknown',
        authenticated: client.authenticated,
        connectedAt: Date.now(), // We don't track this currently, so approximate
        subscribedAgents: Array.from(client.subscribedAgents),
      });
    }
    return connections;
  }

  /**
   * Handle admin messages
   */
  async function handleMessage(
    client: AdminClient,
    message: AdminToHub,
  ): Promise<void> {
    totalRequests++;

    // Handle authentication
    if (message.type === 'admin_auth') {
      // Check rate limit first
      const ip = client.remoteAddress || 'unknown';
      const lockStatus = authRateLimiter.isLocked(ip);
      if (lockStatus.locked) {
        sendMessage(client.ws, {
          type: 'auth_result',
          success: false,
          error: `Too many failed attempts. Try again in ${lockStatus.retryAfter} seconds.`,
        });
        client.ws.close(4001, 'Rate limited');
        return;
      }

      const valid = config.adminToken ? timingSafeCompare(message.token, config.adminToken) : false;
      client.authenticated = valid;

      if (valid) {
        authRateLimiter.recordSuccess(ip);
      } else {
        authRateLimiter.recordFailure(ip);
      }

      sendMessage(client.ws, {
        type: 'auth_result',
        success: valid,
        error: valid ? undefined : 'Invalid admin token',
      });
      if (!valid) {
        client.ws.close(4001, 'Authentication failed');
      }
      return;
    }

    // All other messages require authentication
    if (!client.authenticated) {
      sendMessage(client.ws, {
        type: 'error',
        message: 'Not authenticated',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    switch (message.type) {
      case 'list_agents':
        sendMessage(client.ws, {
          type: 'agents_list',
          agents: getAllAgents(),
        });
        break;

      case 'inspect_agent':
        sendMessage(client.ws, {
          type: 'agent_info',
          agent: getAgentInfo(message.agentId),
        });
        break;

      case 'pause_agent': {
        const runner = hubServer.agents.get(message.agentId);
        if (runner) {
          runner.pause();
          sendMessage(client.ws, { type: 'ok', message: `Agent ${message.agentId} paused` });
        } else {
          sendMessage(client.ws, { type: 'error', message: `Agent not found: ${message.agentId}` });
        }
        break;
      }

      case 'stop_agent': {
        const runner = hubServer.agents.get(message.agentId);
        if (runner) {
          runner.stop();
          sendMessage(client.ws, { type: 'ok', message: `Agent ${message.agentId} stopped` });
        } else {
          sendMessage(client.ws, { type: 'error', message: `Agent not found: ${message.agentId}` });
        }
        break;
      }

      case 'kill_agent': {
        const runner = hubServer.agents.get(message.agentId);
        if (runner) {
          runner.kill();
          hubServer.agents.delete(message.agentId);
          sendMessage(client.ws, { type: 'ok', message: `Agent ${message.agentId} killed` });
        } else {
          sendMessage(client.ws, { type: 'error', message: `Agent not found: ${message.agentId}` });
        }
        break;
      }

      case 'remove_agent': {
        const runner = hubServer.agents.get(message.agentId);
        if (runner) {
          runner.kill();
          hubServer.agents.delete(message.agentId);
        }
        await hubServer.agentStore.delete(message.agentId);
        sendMessage(client.ws, { type: 'ok', message: `Agent ${message.agentId} removed` });
        break;
      }

      case 'list_connections':
        sendMessage(client.ws, {
          type: 'connections_list',
          connections: getAllConnections(),
        });
        break;

      case 'disconnect': {
        let found = false;
        let idx = 0;
        for (const c of hubServer.clients) {
          if (`conn-${idx}` === message.connectionId) {
            c.ws.close(1000, 'Disconnected by admin');
            found = true;
            break;
          }
          idx++;
        }
        if (found) {
          sendMessage(client.ws, { type: 'ok', message: `Connection ${message.connectionId} disconnected` });
        } else {
          sendMessage(client.ws, { type: 'error', message: `Connection not found: ${message.connectionId}` });
        }
        break;
      }

      case 'get_config':
        // Return config without sensitive fields
        sendMessage(client.ws, {
          type: 'config',
          config: {
            port: config.port,
            host: config.host,
            name: config.name,
            localhostBypassAuth: config.localhostBypassAuth,
            adminPort: config.adminPort,
            sandboxPath: config.sandboxPath,
            tools: config.tools,
            fetchProxy: {
              enabled: config.fetchProxy.enabled,
              allowedPatterns: config.fetchProxy.allowedPatterns,
              blockedPatterns: config.fetchProxy.blockedPatterns,
            },
          },
        });
        break;

      case 'reload_config':
        // Config reload is not supported at runtime currently
        sendMessage(client.ws, {
          type: 'config_reloaded',
          success: false,
          error: 'Runtime config reload not supported',
        });
        break;

      case 'subscribe_logs':
        client.subscribedToLogs = true;
        sendMessage(client.ws, { type: 'ok', message: 'Subscribed to logs' });
        // Send recent logs if requested
        if (message.follow) {
          for (const entry of logBuffer) {
            sendMessage(client.ws, {
              type: 'log_entry',
              timestamp: entry.timestamp,
              level: entry.level,
              message: entry.message,
              source: entry.source,
            });
          }
        }
        break;

      case 'unsubscribe_logs':
        client.subscribedToLogs = false;
        sendMessage(client.ws, { type: 'ok', message: 'Unsubscribed from logs' });
        break;

      case 'get_stats':
        sendMessage(client.ws, {
          type: 'stats',
          uptime: Date.now() - startTime,
          connections: hubServer.clients.size,
          agents: hubServer.agents.size,
          totalRequests,
        });
        break;

      case 'get_usage': {
        const scope = message.scope || 'global';
        const data: AdminUsageData = {
          scope,
          entries: [],
        };

        if (scope === 'agent' || scope === 'global') {
          for (const [id, runner] of hubServer.agents) {
            const session = runner.serialize();
            data.entries.push({
              id,
              name: runner.config.name,
              tokens: session.metadata.totalTokens,
              cost: session.metadata.totalCost,
              requests: runner.getMessageHistory().length,
            });
          }
        }

        sendMessage(client.ws, { type: 'usage', data });
        break;
      }

      case 'show_token':
        sendMessage(client.ws, {
          type: 'token',
          token: config.authToken || '(not configured)',
        });
        break;

      case 'rotate_token':
        // Token rotation not supported at runtime
        sendMessage(client.ws, {
          type: 'error',
          message: 'Token rotation not supported at runtime. Update config file and restart.',
        });
        break;

      case 'get_agent_schedules': {
        const schedules: AdminScheduleInfo[] = [];
        if (hubServer.scheduler) {
          if (message.agentId) {
            schedules.push(...hubServer.scheduler.getSchedules(message.agentId));
          } else {
            // All schedules across all agents
            schedules.push(...hubServer.scheduler.serialize());
          }
        }
        sendMessage(client.ws, { type: 'agent_schedules', schedules });
        break;
      }

      case 'get_agent_log': {
        const runner = hubServer.agents.get(message.agentId);
        if (!runner) {
          sendMessage(client.ws, { type: 'error', message: `Agent not found: ${message.agentId}` });
          break;
        }
        const allMessages = runner.getMessageHistory();
        const limit = message.limit === 0 ? allMessages.length : (message.limit || 50);
        const sliced = allMessages.slice(-limit);
        sendMessage(client.ws, {
          type: 'agent_log',
          agentId: message.agentId,
          messages: sliced,
        });
        break;
      }

      case 'get_agent_dom': {
        const runner = hubServer.agents.get(message.agentId);
        if (!runner) {
          sendMessage(client.ws, { type: 'error', message: `Agent not found: ${message.agentId}` });
          break;
        }
        const domState = runner.getDomState();
        sendMessage(client.ws, {
          type: 'agent_dom',
          agentId: message.agentId,
          domState: domState || null,
        });
        break;
      }

      case 'get_agent_runjs_log': {
        const agentStorePath = config.agentStorePath || join(homedir(), '.flo-monster', 'agents');
        const logPath = join(agentStorePath, message.agentId, 'runjs.log');
        try {
          const content = await readFile(logPath, 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);
          const rjsLimit = message.limit || 20;
          const entries = lines.slice(-rjsLimit).map(line => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);
          sendMessage(client.ws, {
            type: 'agent_runjs_log',
            agentId: message.agentId,
            entries,
          });
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            sendMessage(client.ws, {
              type: 'agent_runjs_log',
              agentId: message.agentId,
              entries: [],
            });
          } else {
            sendMessage(client.ws, { type: 'error', message: `Failed to read runjs log: ${err.message}` });
          }
        }
        break;
      }

      case 'nuke':
        switch (message.target) {
          case 'agents':
            for (const runner of hubServer.agents.values()) {
              runner.kill();
            }
            hubServer.agents.clear();
            sendMessage(client.ws, { type: 'ok', message: 'All agents killed' });
            break;

          case 'clients':
            for (const c of hubServer.clients) {
              c.ws.close(1000, 'Disconnected by admin');
            }
            sendMessage(client.ws, { type: 'ok', message: 'All clients disconnected' });
            break;

          case 'all':
            for (const runner of hubServer.agents.values()) {
              runner.kill();
            }
            hubServer.agents.clear();
            for (const c of hubServer.clients) {
              c.ws.close(1000, 'Disconnected by admin');
            }
            sendMessage(client.ws, { type: 'ok', message: 'All agents killed and clients disconnected' });
            break;
        }
        break;

      default:
        sendMessage(client.ws, {
          type: 'error',
          message: `Unknown message type: ${(message as { type: string }).type}`,
        });
    }
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const remoteAddress = req.socket.remoteAddress;

    const client: AdminClient = {
      ws,
      authenticated: false,
      remoteAddress,
      subscribedToLogs: false,
      connectedAt: Date.now(),
    };

    // Auto-authenticate localhost if no adminToken is configured
    if (!config.adminToken && isLocalhost(remoteAddress)) {
      client.authenticated = true;
      sendMessage(ws, {
        type: 'auth_result',
        success: true,
      });
    }

    clients.add(client);

    ws.on('message', (data: RawData) => {
      const message = parseMessage(data);
      if (!message) {
        sendMessage(ws, {
          type: 'error',
          message: 'Invalid message format',
        });
        return;
      }

      handleMessage(client, message).catch((err) => {
        console.error('[admin] Error handling message:', err);
        sendMessage(ws, {
          type: 'error',
          message: 'Internal server error',
        });
      });
    });

    ws.on('close', () => {
      clients.delete(client);
    });

    ws.on('error', (err) => {
      console.error('[admin] WebSocket error:', err);
      clients.delete(client);
    });
  });

  return {
    wss,
    clients,
    broadcastLog,
    close(): Promise<void> {
      authRateLimiter.destroy();
      return new Promise((resolve, reject) => {
        for (const client of clients) {
          client.ws.close(1000, 'Admin server shutting down');
        }
        clients.clear();

        wss.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
