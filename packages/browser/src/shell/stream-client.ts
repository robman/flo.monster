/**
 * Stream client — connects to the hub's dedicated stream WSS port
 * for binary viewport frame reception.
 *
 * Connection flow:
 * 1. Connect to stream WSS port
 * 2. Send { type: 'stream_auth', token } (text)
 * 3. Wait for { type: 'stream_auth_result', success: true }
 * 4. On binary message: decode header, invoke frame callback, send 4-byte ack
 * 5. On close/error: clean up
 */

import { decodeFrameHeader, encodeAck } from '@flo-monster/core/utils/viewport-frame';

export class StreamClient {
  private ws: WebSocket | null = null;
  private onFrame: ((data: ArrayBuffer, frameNum: number) => void) | null = null;
  private onError: ((error: string) => void) | null = null;
  private onClose: (() => void) | null = null;
  private onControlMessage: ((message: Record<string, unknown>) => void) | null = null;

  constructor(
    private streamUrl: string,
    private token: string,
  ) {}

  /**
   * Connect to the stream server, authenticate, and start receiving frames.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.streamUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Stream connection timeout'));
      }, 10000);

      ws.onopen = () => {
        // Send auth message
        ws.send(JSON.stringify({ type: 'stream_auth', token: this.token }));
      };

      ws.onmessage = (event) => {
        // Binary data = viewport frame
        if (event.data instanceof ArrayBuffer) {
          this.handleFrame(event.data);
          return;
        }

        // Text data = auth result or control message
        try {
          const msg = JSON.parse(event.data as string) as { type: string; success?: boolean; error?: string };
          if (msg.type === 'stream_auth_result') {
            clearTimeout(timeout);
            if (msg.success) {
              resolve();
            } else {
              ws.close();
              reject(new Error(msg.error || 'Stream auth failed'));
            }
          } else {
            this.onControlMessage?.(msg);
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        this.ws = null;
        this.onClose?.();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        this.ws = null;
        this.onError?.('Stream connection error');
        reject(new Error('Stream connection error'));
      };
    });
  }

  /**
   * Handle an incoming binary frame.
   */
  private handleFrame(data: ArrayBuffer): void {
    try {
      const header = decodeFrameHeader(data);

      // Invoke frame callback
      if (this.onFrame) {
        this.onFrame(data, header.frameNum);
      }

      // Send ack back to server
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const ack = encodeAck(header.frameNum);
        this.ws.send(ack);
      }
    } catch {
      // Malformed frame — ignore
    }
  }

  /**
   * Set the callback for incoming frames.
   */
  setFrameHandler(cb: (data: ArrayBuffer, frameNum: number) => void): void {
    this.onFrame = cb;
  }

  /**
   * Set the callback for errors.
   */
  setErrorHandler(cb: (error: string) => void): void {
    this.onError = cb;
  }

  /**
   * Set the callback for connection close.
   */
  setCloseHandler(cb: () => void): void {
    this.onClose = cb;
  }

  /**
   * Set the callback for server→client control messages (e.g., remote_focus).
   */
  setControlMessageHandler(cb: (message: Record<string, unknown>) => void): void {
    this.onControlMessage = cb;
  }

  /**
   * Close the stream connection.
   */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Send an input event as a JSON text message over the stream connection.
   * Used during intervention mode to relay user interactions.
   */
  sendInputEvent(event: { kind: string; [key: string]: unknown }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'input_event',
        event,
      }));
    }
  }

  /**
   * Check if connected.
   */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
