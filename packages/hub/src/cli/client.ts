/**
 * Admin CLI WebSocket client
 */

import WebSocket from 'ws';
import type { AdminToHub, HubToAdmin } from '@flo-monster/core';

export interface AdminClientOptions {
  host: string;
  port: number;
  token?: string;
  timeout?: number;
}

export class AdminClientError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'AdminClientError';
  }
}

/**
 * Admin WebSocket client for CLI operations
 */
export class AdminClient {
  private ws: WebSocket | null = null;
  private pendingRequests: Map<
    string,
    { resolve: (msg: HubToAdmin) => void; reject: (err: Error) => void }
  > = new Map();
  private messageListeners: Set<(msg: HubToAdmin) => void> = new Set();
  private requestCounter = 0;

  constructor(private options: AdminClientOptions) {}

  /**
   * Connect to the admin server
   */
  async connect(): Promise<void> {
    const url = `ws://${this.options.host}:${this.options.port}`;

    return new Promise((resolve, reject) => {
      const timeout = this.options.timeout ?? 5000;
      const timer = setTimeout(() => {
        if (this.ws) {
          this.ws.close();
        }
        reject(new AdminClientError('Connection timeout'));
      }, timeout);

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new AdminClientError(`Connection failed: ${err.message}`));
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as HubToAdmin;
          this.handleMessage(msg);
        } catch {
          // Ignore parse errors
        }
      });

      this.ws.on('close', () => {
        this.ws = null;
        // Reject any pending requests
        for (const [, { reject: rej }] of this.pendingRequests) {
          rej(new AdminClientError('Connection closed'));
        }
        this.pendingRequests.clear();
      });
    });
  }

  /**
   * Authenticate with the admin server
   */
  async authenticate(token?: string): Promise<void> {
    const authToken = token ?? this.options.token;
    if (!authToken) {
      // Try connecting without token (localhost bypass)
      const response = await this.waitForMessage('auth_result', 2000);
      if (response.type === 'auth_result' && !response.success) {
        throw new AdminClientError(response.error ?? 'Authentication required');
      }
      return;
    }

    await this.send({ type: 'admin_auth', token: authToken });
    const response = await this.waitForMessage('auth_result');

    if (response.type === 'auth_result' && !response.success) {
      throw new AdminClientError(response.error ?? 'Authentication failed');
    }
  }

  /**
   * Send a message and wait for a response of a specific type
   */
  async request<T extends HubToAdmin['type']>(
    message: AdminToHub,
    expectedType: T,
  ): Promise<Extract<HubToAdmin, { type: T }>> {
    await this.send(message);
    const response = await this.waitForMessage(expectedType);
    return response as Extract<HubToAdmin, { type: T }>;
  }

  /**
   * Send a message without waiting for a response
   */
  async send(message: AdminToHub): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new AdminClientError('Not connected');
    }

    return new Promise((resolve, reject) => {
      this.ws!.send(JSON.stringify(message), (err) => {
        if (err) {
          reject(new AdminClientError(`Send failed: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Wait for a message of a specific type
   */
  async waitForMessage<T extends HubToAdmin['type']>(
    type: T,
    timeout = 10000,
  ): Promise<Extract<HubToAdmin, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AdminClientError(`Timeout waiting for ${type}`));
      }, timeout);

      const handler = (msg: HubToAdmin): void => {
        if (msg.type === type) {
          clearTimeout(timer);
          this.messageListeners.delete(handler);
          resolve(msg as Extract<HubToAdmin, { type: T }>);
        } else if (msg.type === 'error') {
          clearTimeout(timer);
          this.messageListeners.delete(handler);
          reject(new AdminClientError((msg as { message: string }).message));
        }
      };

      this.messageListeners.add(handler);
    });
  }

  /**
   * Subscribe to all messages (for streaming like logs)
   */
  onMessage(handler: (msg: HubToAdmin) => void): () => void {
    this.messageListeners.add(handler);
    return () => this.messageListeners.delete(handler);
  }

  /**
   * Close the connection
   */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private handleMessage(msg: HubToAdmin): void {
    for (const listener of this.messageListeners) {
      try {
        listener(msg);
      } catch {
        // Ignore listener errors
      }
    }
  }
}

/**
 * Create and connect an admin client
 */
export async function createAdminClient(
  options: AdminClientOptions,
): Promise<AdminClient> {
  const client = new AdminClient(options);
  await client.connect();
  await client.authenticate();
  return client;
}
