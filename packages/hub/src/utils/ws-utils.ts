/**
 * Shared WebSocket message utilities for hub and admin servers.
 */

import { WebSocket, type RawData } from 'ws';

/**
 * Parse an incoming WebSocket message as JSON.
 * Returns null if the message cannot be parsed.
 */
export function parseWsMessage<T>(data: RawData): T | null {
  try {
    const str = data.toString();
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}

/**
 * Send a JSON-serialized message to a WebSocket client.
 * Only sends if the connection is open.
 */
export function sendWsMessage<T extends { type: string }>(ws: WebSocket, message: T): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
