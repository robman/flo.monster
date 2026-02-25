/**
 * InterveneManager — tracks per-agent intervention state.
 *
 * One intervention per agentId at a time. Enforces visible vs private logging.
 * Handles inactivity timeout (5 min default) with periodic sweep.
 */

export interface InterveneSession {
  agentId: string;
  clientId: string;
  mode: 'visible' | 'private';
  startedAt: number;
  lastActivity: number;
  eventLog: Array<{ timestamp: number; kind: string; details: Record<string, unknown> }>;
}

export interface InterveneManagerConfig {
  /** Inactivity timeout in ms (default 5 minutes) */
  inactivityTimeoutMs?: number;
  /** Callback when a session times out */
  onTimeout?: (session: InterveneSession) => void;
}

export class InterveneManager {
  private sessions = new Map<string, InterveneSession>(); // agentId -> session
  private sweepInterval: ReturnType<typeof setInterval> | null = null;
  private config: Required<Pick<InterveneManagerConfig, 'inactivityTimeoutMs'>> & InterveneManagerConfig;

  constructor(config: InterveneManagerConfig = {}) {
    this.config = {
      inactivityTimeoutMs: config.inactivityTimeoutMs ?? 5 * 60 * 1000,
      ...config,
    };
  }

  /**
   * Request intervention for an agent.
   * Returns the session if granted, null if someone else is already intervening.
   */
  requestIntervene(agentId: string, clientId: string, mode: 'visible' | 'private'): InterveneSession | null {
    const existing = this.sessions.get(agentId);
    if (existing) {
      // Already someone intervening
      return null;
    }

    const session: InterveneSession = {
      agentId,
      clientId,
      mode,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      eventLog: [],
    };
    this.sessions.set(agentId, session);
    return session;
  }

  /**
   * Release an intervention.
   * Only the client who started it (or system) can release.
   * Returns the session that was released, or null if not found/unauthorized.
   */
  release(agentId: string, clientId?: string): InterveneSession | null {
    const session = this.sessions.get(agentId);
    if (!session) return null;
    if (clientId && session.clientId !== clientId) return null;

    this.sessions.delete(agentId);
    return session;
  }

  /**
   * Get the current intervention session for an agent (if any).
   */
  getSession(agentId: string): InterveneSession | undefined {
    return this.sessions.get(agentId);
  }

  /**
   * Check if an agent is currently being intervened.
   */
  isIntervening(agentId: string): boolean {
    return this.sessions.has(agentId);
  }

  /**
   * Log an input event for the intervention session.
   * Only logs in 'visible' mode — private mode skips logging.
   */
  logEvent(agentId: string, kind: string, details: Record<string, unknown> = {}): void {
    const session = this.sessions.get(agentId);
    if (!session) return;

    // Private mode: never log events
    if (session.mode === 'private') return;

    session.eventLog.push({
      timestamp: Date.now(),
      kind,
      details,
    });
  }

  /**
   * Touch the session (reset inactivity timer).
   */
  touch(agentId: string): void {
    const session = this.sessions.get(agentId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  /**
   * Release all sessions for a specific client (used on disconnect).
   * Returns the list of released sessions.
   */
  releaseAllForClient(clientId: string): InterveneSession[] {
    const released: InterveneSession[] = [];
    for (const [agentId, session] of this.sessions) {
      if (session.clientId === clientId) {
        this.sessions.delete(agentId);
        released.push(session);
      }
    }
    return released;
  }

  /**
   * Sweep for timed-out sessions.
   * Returns the list of timed-out sessions (already removed from the map).
   */
  sweepTimeouts(): InterveneSession[] {
    const now = Date.now();
    const timedOut: InterveneSession[] = [];

    for (const [agentId, session] of this.sessions) {
      if (now - session.lastActivity > this.config.inactivityTimeoutMs) {
        this.sessions.delete(agentId);
        timedOut.push(session);
        this.config.onTimeout?.(session);
      }
    }

    return timedOut;
  }

  /**
   * Start periodic timeout sweep (every 30 seconds).
   */
  startSweep(): void {
    if (this.sweepInterval) return;
    this.sweepInterval = setInterval(() => {
      this.sweepTimeouts();
    }, 30_000);
  }

  /**
   * Stop periodic timeout sweep.
   */
  stopSweep(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  /**
   * Get the number of active intervention sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
