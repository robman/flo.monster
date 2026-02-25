/**
 * Screencast manager — wraps CDP's Page.startScreencast for per-client viewport streaming.
 *
 * Each client that wants to watch an agent's headless browser gets a ScreencastSession.
 * CDP sends JPEG frames via the screencastFrame event. We encode them into our binary
 * frame format and call the sendFrame callback. The client sends acks, which we forward
 * back to CDP via screencastFrameAck to request the next frame.
 *
 * Adaptive quality: we track ack round-trip time and adjust JPEG quality + resolution
 * to maintain smooth streaming even on slow connections.
 */

import type { BrowseSessionManager } from './browse-session.js';
import type { CDPSession } from 'playwright-core';
import { encodeFrame } from './utils/viewport-frame.js';

export interface ScreencastSession {
  clientId: string;
  agentId: string;
  cdpSession: CDPSession;
  quality: number;
  frameNum: number;
  lastAckTime: number;
  lastAckFrameNum: number;
  active: boolean;
  sendFrame: (buf: Buffer) => void;
  // Track pending frames for RTT calculation
  frameSendTimes: Map<number, number>;
  // CDP screencast sessionId for acking
  pendingSessionIds: Map<number, number>;
}

interface ScreencastConfig {
  initialQuality?: number;  // default 40
  maxQuality?: number;      // default 80
  minQuality?: number;      // default 20
  maxWidth?: number;        // default from viewport
  maxHeight?: number;       // default from viewport
}

export class ScreencastManager {
  private sessions = new Map<string, ScreencastSession>(); // clientId -> session

  constructor(
    private browseSessionManager: BrowseSessionManager,
    private config: ScreencastConfig = {},
  ) {}

  /**
   * Start a screencast for a specific client watching a specific agent.
   * Returns viewport dimensions.
   * Throws if no browse session exists for the agent.
   */
  async startScreencast(
    clientId: string,
    agentId: string,
    sendFrame: (buf: Buffer) => void,
  ): Promise<{ width: number; height: number }> {
    // Stop any existing screencast for this client
    await this.stopScreencast(clientId);

    // Get the existing browse session (must already exist)
    const browseSession = this.browseSessionManager.getSession(agentId);
    if (!browseSession) {
      throw new Error(`No browse session exists for agent ${agentId}`);
    }

    const page = browseSession.page;
    const viewportSize = page.viewportSize() || { width: 1419, height: 813 };

    // Create a CDP session from the page's browser context
    const cdpSession = await page.context().newCDPSession(page);

    const quality = this.config.initialQuality ?? 40;

    const session: ScreencastSession = {
      clientId,
      agentId,
      cdpSession,
      quality,
      frameNum: 0,
      lastAckTime: Date.now(),
      lastAckFrameNum: 0,
      active: true,
      sendFrame,
      frameSendTimes: new Map(),
      pendingSessionIds: new Map(),
    };

    this.sessions.set(clientId, session);

    // Listen for screencast frames from CDP
    cdpSession.on('Page.screencastFrame', (params: {
      data: string;       // base64 JPEG
      metadata: { offsetTop: number; pageScaleFactor: number; deviceWidth: number; deviceHeight: number; scrollOffsetX: number; scrollOffsetY: number; timestamp?: number };
      sessionId: number;  // must be passed back in ack
    }) => {
      if (!session.active) return;

      session.frameNum++;
      const frameNum = session.frameNum;

      // Decode base64 JPEG data
      const jpegData = Buffer.from(params.data, 'base64');

      // Encode binary frame
      const width = params.metadata.deviceWidth || viewportSize.width;
      const height = params.metadata.deviceHeight || viewportSize.height;
      const frame = encodeFrame(frameNum, width, height, session.quality, jpegData);

      // Track for RTT calculation
      session.frameSendTimes.set(frameNum, Date.now());
      session.pendingSessionIds.set(frameNum, params.sessionId);

      // Limit pending frame tracking to avoid memory leaks
      if (session.frameSendTimes.size > 100) {
        // Clean up old entries
        const oldestToKeep = frameNum - 50;
        for (const [fn] of session.frameSendTimes) {
          if (fn < oldestToKeep) {
            session.frameSendTimes.delete(fn);
            session.pendingSessionIds.delete(fn);
          }
        }
      }

      // Send to client
      try {
        sendFrame(frame);
      } catch {
        // Client disconnected — will be cleaned up
      }
    });

    // Start the screencast
    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: session.quality,
      maxWidth: this.config.maxWidth ?? viewportSize.width,
      maxHeight: this.config.maxHeight ?? viewportSize.height,
      everyNthFrame: 1,
    });

    return viewportSize;
  }

  /**
   * Stop a screencast for a specific client.
   */
  async stopScreencast(clientId: string): Promise<void> {
    const session = this.sessions.get(clientId);
    if (!session) return;

    session.active = false;
    this.sessions.delete(clientId);

    try {
      await session.cdpSession.send('Page.stopScreencast');
      await session.cdpSession.detach();
    } catch {
      // CDP session may already be closed
    }
  }

  /**
   * Handle an ack from a client (they received a frame and are ready for the next).
   * We forward the ack to CDP and adjust quality based on RTT.
   */
  handleAck(clientId: string, frameNum: number): void {
    const session = this.sessions.get(clientId);
    if (!session || !session.active) return;

    const now = Date.now();

    // Forward ack to CDP using the stored sessionId
    const sessionId = session.pendingSessionIds.get(frameNum);
    if (sessionId) {
      session.cdpSession.send('Page.screencastFrameAck', { sessionId }).catch(() => {
        // CDP session may be closed
      });
      session.pendingSessionIds.delete(frameNum);
    }

    // Calculate RTT for adaptive quality
    const sendTime = session.frameSendTimes.get(frameNum);
    if (sendTime) {
      const rtt = now - sendTime;
      session.frameSendTimes.delete(frameNum);

      session.lastAckTime = now;
      session.lastAckFrameNum = frameNum;

      // Adaptive quality: adjust based on RTT
      this.adjustQuality(session, rtt);
    }
  }

  /**
   * Stop all screencasts for a specific client (cleanup on disconnect).
   */
  async stopAllForClient(clientId: string): Promise<void> {
    await this.stopScreencast(clientId);
  }

  /**
   * Check if a client has an active screencast.
   */
  hasScreencast(clientId: string): boolean {
    const session = this.sessions.get(clientId);
    return session?.active ?? false;
  }

  /**
   * Get the number of active screencasts.
   */
  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Adjust quality based on ack RTT.
   * Low RTT (fast client) -> increase quality.
   * High RTT (slow client) -> decrease quality.
   */
  private adjustQuality(session: ScreencastSession, rtt: number): void {
    const minQuality = this.config.minQuality ?? 20;
    const maxQuality = this.config.maxQuality ?? 80;

    // Target RTT: ~100ms for good quality
    if (rtt < 50 && session.quality < maxQuality) {
      // Very fast — increase quality
      session.quality = Math.min(maxQuality, session.quality + 5);
    } else if (rtt < 100 && session.quality < maxQuality) {
      // Fast — increase quality slowly
      session.quality = Math.min(maxQuality, session.quality + 2);
    } else if (rtt > 300 && session.quality > minQuality) {
      // Slow — decrease quality
      session.quality = Math.max(minQuality, session.quality - 10);
    } else if (rtt > 200 && session.quality > minQuality) {
      // Somewhat slow — decrease quality slightly
      session.quality = Math.max(minQuality, session.quality - 5);
    }

    // Note: CDP's startScreencast quality param controls its JPEG compression.
    // We'd need to restart the screencast to change CDP's compression quality.
    // The quality value is tracked in the session and included in frame headers
    // so the client knows the current quality level.
  }
}
