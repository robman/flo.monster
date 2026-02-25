/**
 * Dedicated WebSocket server for viewport frame streaming.
 *
 * Runs on a separate port (primary + 1) to keep the main WSS clean for
 * agent signaling. Carries binary JPEG frames + acks only.
 *
 * Auth flow:
 * 1. Client obtains a short-lived token via primary WSS (browse_stream_request)
 * 2. Client connects to stream WSS port
 * 3. Client sends { type: 'stream_auth', token: '...' } (text)
 * 4. Server validates token → responds { type: 'stream_auth_result', success: true/false }
 * 5. On success: server starts sending binary frames via ScreencastManager
 * 6. Client sends binary acks (4-byte frameNum)
 * 7. On close: stop screencast for this connection
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import type { ScreencastManager } from './screencast-manager.js';
import { decodeAck, ACK_SIZE } from './utils/viewport-frame.js';

export interface StreamServerConfig {
  host: string;
  port?: number;             // Fixed port. Default: 0 (OS-assigned)
  tls?: { cert: Buffer; key: Buffer };
  maxConnections: number;   // default 5
  tokenTTLSeconds: number;  // default 30
}

export interface InputEvent {
  kind: string;
  [key: string]: unknown;
}

interface PendingToken {
  agentId: string;
  clientId: string;
  expiresAt: number;
}

interface StreamConnection {
  ws: WebSocket;
  clientId: string;
  agentId: string;
}

export class StreamServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | HttpsServer | null = null;
  private tokens = new Map<string, PendingToken>();    // token → pending auth
  private connections = new Map<WebSocket, StreamConnection>();
  private tokenCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private _port = 0;
  private onInputEvent: ((clientId: string, agentId: string, event: InputEvent) => void) | null = null;

  constructor(
    private config: StreamServerConfig,
    private screencastManager: ScreencastManager,
  ) {}

  /** The port the stream server is listening on. 0 if not started. */
  get port(): number {
    return this._port;
  }

  /**
   * Start the stream WebSocket server.
   * Uses port 0 (OS-assigned) to avoid conflicts with the admin server.
   * Returns the actual port assigned.
   */
  start(): Promise<number> {
    if (this.config.tls) {
      this.httpServer = createHttpsServer({
        cert: this.config.tls.cert,
        key: this.config.tls.key,
      });
    } else {
      this.httpServer = createHttpServer();
    }

    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: 5 * 1024 * 1024, // 5MB max (frames are typically < 100KB)
    });

    this.wss.on('connection', (ws: WebSocket) => {
      // Enforce max connections
      if (this.connections.size >= this.config.maxConnections) {
        ws.close(1013, 'Max stream connections reached');
        return;
      }

      // Set binary type
      ws.binaryType = 'nodebuffer';

      // Set auth timeout — must authenticate within 10 seconds
      const authTimeout = setTimeout(() => {
        if (!this.connections.has(ws)) {
          ws.close(4001, 'Authentication timeout');
        }
      }, 10000);

      ws.on('message', (data: RawData) => {
        const conn = this.connections.get(ws);

        if (!conn) {
          // Not authenticated yet — expect text auth message
          clearTimeout(authTimeout);
          this.handleAuth(ws, data);
          return;
        }

        // Authenticated — handle binary acks and text input events
        if (Buffer.isBuffer(data) && data.length === ACK_SIZE) {
          // Binary ack (4 bytes)
          const frameNum = decodeAck(data);
          this.screencastManager.handleAck(conn.clientId, frameNum);
          return;
        }

        // Text message — try to parse as input event
        this.handleInputMessage(conn, data);
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        const conn = this.connections.get(ws);
        if (conn) {
          this.connections.delete(ws);
          // Stop the screencast for this client
          this.screencastManager.stopScreencast(conn.clientId).catch(() => {});
        }
      });

      ws.on('error', () => {
        clearTimeout(authTimeout);
        const conn = this.connections.get(ws);
        if (conn) {
          this.connections.delete(ws);
          this.screencastManager.stopScreencast(conn.clientId).catch(() => {});
        }
      });
    });

    // Periodic cleanup of expired tokens
    this.tokenCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [token, pending] of this.tokens) {
        if (now > pending.expiresAt) {
          this.tokens.delete(token);
        }
      }
    }, 10000);

    return new Promise<number>((resolve, reject) => {
      this.httpServer!.on('error', reject);
      this.httpServer!.listen(this.config.port ?? 0, this.config.host, () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
          resolve(addr.port);
        } else {
          reject(new Error('Failed to get stream server address'));
        }
      });
    });
  }

  /**
   * Handle authentication for a new stream connection.
   */
  private handleAuth(ws: WebSocket, data: RawData): void {
    try {
      const text = data.toString();
      const msg = JSON.parse(text) as { type?: string; token?: string };

      if (msg.type !== 'stream_auth' || typeof msg.token !== 'string') {
        ws.send(JSON.stringify({ type: 'stream_auth_result', success: false, error: 'Invalid auth message' }));
        ws.close(4001, 'Invalid auth message');
        return;
      }

      const pending = this.tokens.get(msg.token);

      // Validate token: exists, not expired, single-use
      if (!pending) {
        ws.send(JSON.stringify({ type: 'stream_auth_result', success: false, error: 'Invalid or expired token' }));
        ws.close(4001, 'Invalid token');
        return;
      }

      if (Date.now() > pending.expiresAt) {
        this.tokens.delete(msg.token);
        ws.send(JSON.stringify({ type: 'stream_auth_result', success: false, error: 'Token expired' }));
        ws.close(4001, 'Token expired');
        return;
      }

      // Single-use: consume the token
      this.tokens.delete(msg.token);

      const conn: StreamConnection = {
        ws,
        clientId: pending.clientId,
        agentId: pending.agentId,
      };
      this.connections.set(ws, conn);

      // Send auth success
      ws.send(JSON.stringify({ type: 'stream_auth_result', success: true }));

      // Start the screencast — frames will be sent via the sendFrame callback
      const sendFrame = (buf: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(buf);
        }
      };

      this.screencastManager.startScreencast(conn.clientId, conn.agentId, sendFrame).catch((err) => {
        ws.send(JSON.stringify({ type: 'stream_auth_result', success: false, error: `Screencast error: ${(err as Error).message}` }));
        ws.close(4002, 'Screencast start failed');
        this.connections.delete(ws);
      });

    } catch {
      ws.send(JSON.stringify({ type: 'stream_auth_result', success: false, error: 'Parse error' }));
      ws.close(4001, 'Parse error');
    }
  }

  /**
   * Generate a short-lived, single-use authentication token.
   * Called from the primary WSS message handler when a client requests a stream.
   */
  generateToken(agentId: string, clientId: string): string {
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, {
      agentId,
      clientId,
      expiresAt: Date.now() + this.config.tokenTTLSeconds * 1000,
    });
    return token;
  }

  /**
   * Close a stream connection for a specific client (called when primary WSS receives browse_stream_stop).
   */
  closeConnectionForClient(clientId: string): void {
    for (const [ws, conn] of this.connections) {
      if (conn.clientId === clientId) {
        ws.close(1000, 'Stream stopped');
        this.connections.delete(ws);
        this.screencastManager.stopScreencast(clientId).catch(() => {});
        break;
      }
    }
  }

  /**
   * Handle a text message from an authenticated stream connection.
   * Expected format: { type: 'input_event', event: { kind: string, ... } }
   */
  private handleInputMessage(conn: StreamConnection, data: RawData): void {
    try {
      const text = data.toString();
      const msg = JSON.parse(text) as { type?: string; event?: InputEvent };

      if (msg.type !== 'input_event' || !msg.event || typeof msg.event.kind !== 'string') {
        return; // Silently ignore malformed messages
      }

      this.onInputEvent?.(conn.clientId, conn.agentId, msg.event);
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Set the callback for input events from stream connections.
   */
  setInputEventHandler(handler: (clientId: string, agentId: string, event: InputEvent) => void): void {
    this.onInputEvent = handler;
  }

  /**
   * Get the agentId associated with a client's stream connection.
   */
  getAgentIdForClient(clientId: string): string | undefined {
    for (const conn of this.connections.values()) {
      if (conn.clientId === clientId) {
        return conn.agentId;
      }
    }
    return undefined;
  }

  /**
   * Send a control message to a specific client's stream connection.
   * Used for server→client notifications (e.g., remote_focus).
   */
  sendToClient(clientId: string, message: Record<string, unknown>): void {
    for (const [ws, conn] of this.connections) {
      if (conn.clientId === clientId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
        break;
      }
    }
  }

  /**
   * Get the number of active stream connections.
   */
  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Shut down the stream server.
   */
  async close(): Promise<void> {
    if (this.tokenCleanupInterval) {
      clearInterval(this.tokenCleanupInterval);
      this.tokenCleanupInterval = null;
    }

    // Close all stream connections
    for (const [ws, conn] of this.connections) {
      await this.screencastManager.stopScreencast(conn.clientId).catch(() => {});
      ws.close(1000, 'Server shutting down');
    }
    this.connections.clear();
    this.tokens.clear();

    // Close the WSS and HTTP server
    return new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          if (this.httpServer) {
            this.httpServer.close(() => resolve());
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}
