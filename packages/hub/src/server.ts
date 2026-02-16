/**
 * WebSocket hub server — connection management and WebSocket setup.
 *
 * Message routing is handled by ./handlers/message-handler.ts
 * Agent-related operations are in ./handlers/agent-handler.ts
 * Message types are defined in ./handlers/types.ts
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HookRulesConfig } from '@flo-monster/core';
import type { HubConfig } from './config.js';
import { isLocalhost } from './auth.js';
import { getToolDefinitions } from './tools/index.js';
import { HeadlessAgentRunner } from './agent-runner.js';
import { AgentStore } from './agent-store.js';
import { HookExecutor } from './hook-executor.js';
import { HubSkillManager } from './skill-manager.js';
import { BrowserToolRouter } from './browser-tool-router.js';
import { Scheduler } from './scheduler.js';
import { FailedAuthRateLimiter } from './rate-limiter.js';
import { PushManager } from './push-manager.js';
import { createHttpRequestHandler } from './http-server.js';
import { parseWsMessage, sendWsMessage } from './utils/ws-utils.js';
import { handleMessage } from './handlers/message-handler.js';
import { createRunnerDeps, setupEventForwarding } from './handlers/agent-handler.js';

// Re-export all message types so existing imports from './server.js' continue to work
export type {
  HubMessage,
  ToolCallMessage,
  ToolResultMessage,
  FetchResultMessage,
  PersistResultMessage,
  SubscribeAgentMessage,
  UnsubscribeAgentMessage,
  AgentActionMessage,
  SendMessageToAgentMessage,
  RestoreAgentMessage,
  FetchRequestMessage,
  AuthMessage,
  ErrorMessage,
  PersistAgentMessage,
  AgentEventMessage,
  AgentLoopEventMessage,
  AgentStateMessage,
  RestoreSessionMessage,
} from './handlers/types.js';

// Re-export requestSkillApproval so existing imports continue to work
export { requestSkillApproval } from './handlers/message-handler.js';

export interface ConnectedClient {
  ws: WebSocket;
  authenticated: boolean;
  remoteAddress: string | undefined;
  subscribedAgents: Set<string>;  // Agent IDs this client is subscribed to
  messageCount: number;       // Messages in current window
  messageWindowStart: number; // Start of current window
  deviceId?: string;          // Device ID for push notification tracking
}

export interface HubServer {
  wss: WebSocketServer;
  httpServer?: HttpServer;
  httpsServer?: HttpsServer;
  clients: Set<ConnectedClient>;
  agents: Map<string, HeadlessAgentRunner>;
  agentStore: AgentStore;
  scheduler?: Scheduler;
  pushManager?: PushManager;
  close(): Promise<void>;
}

/**
 * Create and start the hub server
 */
export function createHubServer(config: HubConfig): HubServer {
  // Validate: publicHost is required when sharedApiKeys or cliProviders is configured
  const hasSharedKeys = config.sharedApiKeys && Object.keys(config.sharedApiKeys).length > 0;
  const hasCliProviders = config.cliProviders && Object.keys(config.cliProviders).length > 0;
  if ((hasSharedKeys || hasCliProviders) && !config.publicHost) {
    throw new Error(
      'publicHost must be configured when sharedApiKeys or cliProviders is set. ' +
      'The publicHost is needed for browsers to reach the hub HTTP API.',
    );
  }

  // Ensure sandbox directory exists
  if (config.sandboxPath) {
    if (!existsSync(config.sandboxPath)) {
      try {
        mkdirSync(config.sandboxPath, { recursive: true });
        console.log(`[hub] Created sandbox directory: ${config.sandboxPath}`);
      } catch (err) {
        console.error(`[hub] Failed to create sandbox directory: ${err}`);
      }
    }
  }

  const clients = new Set<ConnectedClient>();
  const agents = new Map<string, HeadlessAgentRunner>();
  const browserToolRouter = new BrowserToolRouter(clients);

  // Create scheduler for autonomous execution
  const scheduler = new Scheduler({
    getRunner: (hubAgentId: string) => agents.get(hubAgentId),
  });

  // Create push manager if configured
  const pushDataDir = join(homedir(), '.flo-monster');
  const pushManager = config.pushConfig
    ? new PushManager(pushDataDir, config.pushConfig)
    : undefined;

  // Initialize agent store for disk persistence
  const agentStorePath = config.agentStorePath || join(homedir(), '.flo-monster', 'agents');
  const agentStore = new AgentStore(agentStorePath);

  // Create hook executor and skill manager before agent restore
  // (so restored agents can use them for agentic loop execution)
  const hookExecutor = config.hooks ? new HookExecutor(config.hooks) : undefined;
  const skillManager = new HubSkillManager();
  skillManager.load();

  // Load persisted agents from disk on startup
  (async () => {
    // Initialize push manager
    if (pushManager) {
      try {
        await pushManager.init();
        console.log('[hub] Push notifications enabled');
      } catch (err) {
        console.warn('[hub] Failed to initialize push manager:', err);
      }
    }

    // Verify runAsUser configuration
    if (config.tools.bash.runAsUser) {
      const user = config.tools.bash.runAsUser;
      try {
        const { executeProcess: execProc } = await import('./utils/process-utils.js');
        // Check user exists
        const idCheck = await execProc(`id ${user}`, { cwd: '/tmp', timeout: 5000 });
        if (idCheck.exitCode !== 0) {
          console.warn(`[hub] WARNING: runAsUser '${user}' does not exist. Bash user isolation will fail.`);
        } else {
          // Verify sudo works
          const sudoCheck = await execProc(`sudo -n -u ${user} true`, { cwd: '/tmp', timeout: 5000 });
          if (sudoCheck.exitCode !== 0) {
            console.warn(`[hub] WARNING: sudo -n -u ${user} failed. Configure sudoers for bash user isolation. Run: hub-admin setup`);
          } else {
            console.log(`[hub] Bash user isolation enabled: commands run as '${user}'`);
          }
        }
      } catch (err) {
        console.warn(`[hub] WARNING: Failed to verify runAsUser '${user}':`, err);
      }
    }

    try {
      await agentStore.init();
      const persisted = await agentStore.list();
      for (const summary of persisted) {
        try {
          const data = await agentStore.load(summary.hubAgentId);
          if (!data) continue;

          // Load per-agent API key if saved
          let perAgentApiKey: string | undefined;
          if (agentStorePath) {
            try {
              const keyPath = join(agentStorePath, summary.hubAgentId, 'api-key.json');
              const keyData = readFileSync(keyPath, 'utf-8');
              const parsed = JSON.parse(keyData);
              if (parsed && typeof parsed.key === 'string') {
                perAgentApiKey = parsed.key;
              }
            } catch {
              // No per-agent API key saved — that's fine
            }
          }

          // Create runner first (inert) so it can initialize its state store
          const runner = new HeadlessAgentRunner(data.session);

          // Extract hooks from session dependencies for declarative hook evaluation
          const sessionHooks = data.session.dependencies?.hooks;

          // Create runner deps with runner's state store and files root
          const runnerDeps = createRunnerDeps(data.session, summary.hubAgentId, {
            hubConfig: config,
            hookExecutor,
            skillManager,
            agentStore,
            agentStorePath,
            clients,
            browserToolRouter,
            scheduler,
          }, runner, perAgentApiKey, sessionHooks as HookRulesConfig | undefined);
          runner.setDeps(runnerDeps);

          // Set up event forwarding (both RunnerEvents and AgentEvents)
          setupEventForwarding(runner, summary.hubAgentId, clients, pushManager);

          agents.set(summary.hubAgentId, runner);

          // Ensure per-agent sandbox directory exists
          if (config.sandboxPath) {
            const agentSandbox = join(config.sandboxPath, summary.hubAgentId);
            if (!existsSync(agentSandbox)) {
              try {
                mkdirSync(agentSandbox, { recursive: true });
              } catch (err) {
                console.warn(`[hub] Failed to create agent sandbox for ${summary.hubAgentId}:`, err);
              }
            }
          }

          // Start in paused state (not auto-run on restart)
          await runner.start();
          runner.pause();
          console.log(`[hub] Restored agent: ${summary.agentName} (${summary.hubAgentId})`);
        } catch (err) {
          console.warn(`[hub] Failed to restore agent ${summary.hubAgentId}:`, err);
        }
      }
      if (persisted.length > 0) {
        console.log(`[hub] Restored ${persisted.length} persisted agent(s)`);
      }
    } catch (err) {
      console.warn('[hub] Failed to load persisted agents:', err);
    }

    // Start scheduler for cron jobs
    scheduler.start();
  })();

  // Create rate limiter for HTTP API failed auth attempts
  const authRateLimiter = new FailedAuthRateLimiter(
    config.failedAuthConfig?.maxAttempts ?? 5,
    config.failedAuthConfig?.lockoutMinutes ?? 15,
  );

  // Create HTTP request handler for API endpoints
  const httpHandler = createHttpRequestHandler({
    config,
    rateLimiter: authRateLimiter,
  });

  let httpServer: HttpServer | undefined;
  let httpsServer: HttpsServer | undefined;
  let wss: WebSocketServer;

  // Rate limiting for new connections
  const connectionAttempts = new Map<string, { count: number; resetTime: number }>();
  const MAX_CONNECTIONS_PER_MINUTE = 10;
  const RATE_LIMIT_WINDOW_MS = 60000;

  // Clean up stale rate limit entries every 5 minutes
  const rateLimitCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of connectionAttempts) {
      if (now > record.resetTime) {
        connectionAttempts.delete(ip);
      }
    }
  }, 5 * 60 * 1000);

  function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const record = connectionAttempts.get(ip);

    if (!record || now > record.resetTime) {
      connectionAttempts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }

    if (record.count >= MAX_CONNECTIONS_PER_MINUTE) {
      return false;
    }

    record.count++;
    return true;
  }

  if (config.tls) {
    // TLS mode: create HTTPS server and attach WebSocket to it
    const cert = readFileSync(config.tls.certFile);
    const key = readFileSync(config.tls.keyFile);

    httpsServer = createHttpsServer({ cert, key }, httpHandler);
    wss = new WebSocketServer({ server: httpsServer, maxPayload: 10 * 1024 * 1024 });

    httpsServer.listen(config.port, config.host);
  } else {
    // HTTP + WebSocket mode (no TLS)
    // Both HTTP API endpoints and WebSocket run on the same port
    httpServer = createHttpServer(httpHandler);
    wss = new WebSocketServer({ server: httpServer, maxPayload: 10 * 1024 * 1024 });

    httpServer.listen(config.port, config.host);
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const remoteAddress = req.socket.remoteAddress;

    // Rate limit check
    if (remoteAddress && !checkRateLimit(remoteAddress)) {
      console.log(`[hub] Rate limit exceeded for ${remoteAddress}`);
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    console.log(`[hub] New connection from ${remoteAddress}`);

    const client: ConnectedClient = {
      ws,
      authenticated: false,
      remoteAddress,
      subscribedAgents: new Set(),
      messageCount: 0,
      messageWindowStart: Date.now(),
    };

    clients.add(client);

    // Check if localhost bypass allows auto-authentication
    if (config.localhostBypassAuth && isLocalhost(remoteAddress)) {
      console.log(`[hub] Localhost bypass - auto-authenticating`);
      client.authenticated = true;

      // Generate a hub ID from config
      const hubId = config.name.toLowerCase().replace(/\s+/g, '-') + '-' + config.port;

      // Build the HTTP API URL (use publicHost if set, for TLS cert hostname matching)
      const httpHost = config.publicHost || config.host;
      const httpApiUrl = config.tls
        ? `https://${httpHost}:${config.port}`
        : `http://${httpHost}:${config.port}`;

      // Send auth_result first
      const authResult = {
        type: 'auth_result',
        success: true,
        hubId,
        hubName: config.name,
        sharedProviders: [
          ...Object.keys(config.sharedApiKeys || {}),
          ...Object.keys(config.cliProviders || {}),
        ],
        httpApiUrl,
      };
      sendWsMessage(ws, authResult);

      // Then announce available tools
      const tools = getToolDefinitions(config);
      const announceTools = {
        type: 'announce_tools',
        tools,
      };
      sendWsMessage(ws, announceTools);

      // Send VAPID public key if push is enabled
      if (pushManager?.isEnabled) {
        const vapidKey = pushManager.getVapidPublicKey();
        if (vapidKey) {
          sendWsMessage(ws, {
            type: 'vapid_public_key',
            key: vapidKey,
          });
        }
      }
    }

    ws.on('message', (data: RawData) => {
      // Per-client message rate limiting (HUB-WS-09)
      const now = Date.now();
      if (now - client.messageWindowStart > 1000) {
        // Reset window
        client.messageCount = 0;
        client.messageWindowStart = now;
      }
      client.messageCount++;
      if (client.messageCount > 100) {
        sendWsMessage(ws, {
          type: 'error',
          message: 'Rate limit exceeded: too many messages per second',
        });
        return;
      }

      console.log(`[hub] Received message: ${data.toString().slice(0, 200)}`);
      const message = parseWsMessage<{ type: string; id?: string; [key: string]: unknown }>(data);
      if (!message) {
        sendWsMessage(ws, {
          type: 'error',
          message: 'Invalid message format',
        });
        return;
      }

      // Track deviceId from push-related messages
      if (message.type === 'push_subscribe' || message.type === 'visibility_state') {
        const deviceId = (message as { deviceId?: string }).deviceId;
        if (deviceId) {
          client.deviceId = deviceId;
          if (pushManager) {
            pushManager.setDeviceConnected(deviceId, true);
          }
        }
      }

      // Handle message asynchronously
      handleMessage(client, message, config, agents, clients, hookExecutor, skillManager, agentStore, browserToolRouter, agentStorePath, scheduler, pushManager).catch((err) => {
        console.error('Error handling message:', err);
        sendWsMessage(ws, {
          type: 'error',
          id: message.id,
          message: 'Internal server error',
        });
      });
    });

    ws.on('close', () => {
      // Mark device as disconnected for push notification tracking
      if (client.deviceId && pushManager) {
        pushManager.setDeviceConnected(client.deviceId, false);
      }

      // Clean up last-active tracking for this client
      browserToolRouter.removeClient(client);

      // Notify about browser disconnect for subscribed agents
      for (const hubAgentId of client.subscribedAgents) {
        // Send context_change to remaining subscribers
        for (const c of clients) {
          if (c !== client && c.subscribedAgents.has(hubAgentId)) {
            sendWsMessage(c.ws, {
              type: 'context_change',
              hubAgentId,
              change: 'browser_disconnected',
              availableTools: ['bash', 'filesystem', 'list_skills', 'load_skill', 'context_search'],
            });
          }
        }
      }
      clients.delete(client);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      browserToolRouter.removeClient(client);
      clients.delete(client);
    });
  });

  return {
    wss,
    httpServer,
    httpsServer,
    clients,
    agents,
    agentStore,
    scheduler,
    pushManager,
    async close(): Promise<void> {
      clearInterval(rateLimitCleanupInterval);
      // Stop the scheduler
      scheduler.stop();

      // Save all agents to disk before killing
      for (const [hubAgentId, runner] of agents) {
        try {
          await agentStore.save(hubAgentId, runner.serialize(), {
            state: runner.getState(),
            totalTokens: 0,
            totalCost: 0,
            savedAt: Date.now(),
          });
        } catch (err) {
          console.warn(`[hub] Failed to save agent ${hubAgentId} on shutdown:`, err);
        }
      }

      return new Promise((resolve, reject) => {
        // Kill all running agents
        for (const runner of agents.values()) {
          runner.kill();
        }
        agents.clear();

        // Close all client connections
        for (const client of clients) {
          client.ws.close(1000, 'Server shutting down');
        }
        clients.clear();

        // Close the WebSocket server
        wss.close((wssErr) => {
          if (wssErr) {
            reject(wssErr);
            return;
          }

          // Close the HTTP/HTTPS server if present
          if (httpsServer) {
            httpsServer.close((httpsErr) => {
              if (httpsErr) {
                reject(httpsErr);
              } else {
                resolve();
              }
            });
          } else if (httpServer) {
            httpServer.close((httpErr) => {
              if (httpErr) {
                reject(httpErr);
              } else {
                resolve();
              }
            });
          } else {
            resolve();
          }
        });
      });
    },
  };
}
