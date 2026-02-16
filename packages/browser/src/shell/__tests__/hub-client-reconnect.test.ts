/**
 * Tests for HubClient reconnection with exponential backoff.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HubClient } from '../hub-client.js';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose({});
  });

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  simulateMessage(data: any) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  simulateError() {
    this.onerror?.({});
  }
}

// Track all created WebSocket instances
let wsInstances: MockWebSocket[] = [];

// Mock crypto.subtle for generateConnectionId — deterministic based on input
const mockDigest = vi.fn().mockImplementation(async (_algo: string, data: ArrayBuffer) => {
  const buf = new ArrayBuffer(32);
  const view = new Uint8Array(buf);
  // Simple deterministic hash: use first few bytes of input
  const inputView = new Uint8Array(data);
  for (let i = 0; i < Math.min(inputView.length, 32); i++) {
    view[i] = inputView[i];
  }
  return buf;
});

vi.stubGlobal('WebSocket', class extends MockWebSocket {
  constructor(_url: string) {
    super();
    wsInstances.push(this);
  }
});

vi.stubGlobal('crypto', {
  subtle: {
    digest: mockDigest,
  },
});

describe('HubClient reconnection', () => {
  let client: HubClient;

  beforeEach(() => {
    vi.useFakeTimers();
    wsInstances = [];
    client = new HubClient();
  });

  afterEach(() => {
    // Stop all reconnections to prevent timers leaking between tests
    client.stopAllReconnections();
    vi.useRealTimers();
  });

  // Helper: flush microtasks so the async connect() reaches WebSocket constructor
  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  // Helper to connect successfully
  async function connectSuccessfully(): Promise<{ ws: MockWebSocket; connId: string }> {
    const connectPromise = client.connect('ws://localhost:3002', 'Test Hub', 'token');
    // Flush microtasks so generateConnectionId resolves and WebSocket is created
    await flushMicrotasks();
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen();
    // After open, client sends auth. Simulate auth_result success.
    ws.simulateMessage({ type: 'auth_result', success: true });
    const conn = await connectPromise;
    return { ws, connId: conn.id };
  }

  // Helper: advance timer and flush microtasks so reconnect attempt creates WebSocket
  async function advanceAndFlush(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await flushMicrotasks();
  }

  // Helper: simulate a failed reconnect attempt (error + close on latest ws)
  function failLatestWs(): void {
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateError();
    ws.simulateClose();
  }

  // Helper: simulate a successful reconnect (open + auth on latest ws)
  function succeedLatestWs(): void {
    const ws = wsInstances[wsInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage({ type: 'auth_result', success: true });
  }

  it('schedules reconnection on unexpected disconnect', async () => {
    const { ws, connId } = await connectSuccessfully();

    const disconnectCb = vi.fn();
    client.onDisconnect(disconnectCb);

    // Simulate unexpected close
    ws.simulateClose();

    expect(disconnectCb).toHaveBeenCalledWith(connId);
    expect(client.isReconnecting(connId)).toBe(true);
  });

  it('does not reconnect on intentional disconnect', async () => {
    const { ws, connId } = await connectSuccessfully();

    client.disconnect(connId);

    expect(client.isReconnecting(connId)).toBe(false);
  });

  it('uses exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s cap', async () => {
    const { ws, connId } = await connectSuccessfully();

    // Unexpected disconnect
    ws.simulateClose();
    expect(client.isReconnecting(connId)).toBe(true);

    // First attempt after 1s
    const ws1Count = wsInstances.length;
    await advanceAndFlush(1000);
    expect(wsInstances.length).toBe(ws1Count + 1);

    // Fail the reconnect attempt
    failLatestWs();
    await flushMicrotasks();

    // Second attempt after 2s
    const ws2Count = wsInstances.length;
    await advanceAndFlush(2000);
    expect(wsInstances.length).toBe(ws2Count + 1);

    // Fail again
    failLatestWs();
    await flushMicrotasks();

    // Third attempt after 4s
    const ws3Count = wsInstances.length;
    await advanceAndFlush(4000);
    expect(wsInstances.length).toBe(ws3Count + 1);

    // Fail again
    failLatestWs();
    await flushMicrotasks();

    // 4th: 8s
    await advanceAndFlush(8000);
    failLatestWs();
    await flushMicrotasks();

    // 5th: 16s
    await advanceAndFlush(16000);
    failLatestWs();
    await flushMicrotasks();

    // 6th: 30s (capped from 32s)
    const wsBeforeCap = wsInstances.length;
    await advanceAndFlush(30000);
    expect(wsInstances.length).toBe(wsBeforeCap + 1);

    // 7th should also be 30s (still capped)
    failLatestWs();
    await flushMicrotasks();

    const wsBeforeCap2 = wsInstances.length;
    await advanceAndFlush(29999);
    expect(wsInstances.length).toBe(wsBeforeCap2); // Not yet
    await advanceAndFlush(1);
    expect(wsInstances.length).toBe(wsBeforeCap2 + 1);
  });

  it('clears state on successful reconnect', async () => {
    const { ws, connId } = await connectSuccessfully();

    ws.simulateClose();
    expect(client.isReconnecting(connId)).toBe(true);

    // Advance to trigger reconnect attempt
    await advanceAndFlush(1000);

    // Succeed the reconnection
    succeedLatestWs();
    await flushMicrotasks();

    expect(client.isReconnecting(connId)).toBe(false);
  });

  it('fires connectCallbacks on reconnect', async () => {
    const connectCb = vi.fn();
    client.onConnect(connectCb);

    const { ws } = await connectSuccessfully();
    expect(connectCb).toHaveBeenCalledTimes(1);

    ws.simulateClose();
    await advanceAndFlush(1000);

    succeedLatestWs();
    await flushMicrotasks();

    expect(connectCb).toHaveBeenCalledTimes(2);
  });

  it('isReconnecting returns correct state', async () => {
    const { ws, connId } = await connectSuccessfully();

    expect(client.isReconnecting(connId)).toBe(false);

    ws.simulateClose();
    expect(client.isReconnecting(connId)).toBe(true);

    // Advance to attempt
    await advanceAndFlush(1000);

    succeedLatestWs();
    await flushMicrotasks();

    expect(client.isReconnecting(connId)).toBe(false);
  });

  it('does not double-schedule from onerror+onclose during reconnect', async () => {
    const { ws, connId } = await connectSuccessfully();

    ws.simulateClose();

    // First reconnect fires
    await advanceAndFlush(1000);
    const countBefore = wsInstances.length;

    // onerror fires, then onclose fires
    failLatestWs();
    await flushMicrotasks();

    // Only ONE more reconnect should be scheduled (the reschedule from attemptReconnect catch)
    await advanceAndFlush(2000);
    expect(wsInstances.length).toBe(countBefore + 1); // Exactly one more
  });

  it('stopAllReconnections cancels all timers', async () => {
    const { ws, connId } = await connectSuccessfully();

    ws.simulateClose();
    expect(client.isReconnecting(connId)).toBe(true);

    client.stopAllReconnections();
    expect(client.isReconnecting(connId)).toBe(false);

    // No reconnect attempt should happen
    const countBefore = wsInstances.length;
    await advanceAndFlush(60000);
    expect(wsInstances.length).toBe(countBefore);
  });

  it('does not reconnect failed initial connections', async () => {
    const connectPromise = client.connect('ws://localhost:3002', 'Test Hub', 'token').catch(() => {});
    await flushMicrotasks();
    const ws = wsInstances[wsInstances.length - 1];

    // Connection fails before auth (e.g., connection refused)
    ws.simulateError();

    await connectPromise;

    // Should NOT schedule reconnection (wasConnected is false)
    const countBefore = wsInstances.length;
    await advanceAndFlush(60000);
    expect(wsInstances.length).toBe(countBefore);
  });

  it('reconnect preserves connection params', async () => {
    const { ws, connId } = await connectSuccessfully();

    ws.simulateClose();
    await advanceAndFlush(1000);

    // New WebSocket should have been created (proving params were preserved)
    expect(wsInstances.length).toBeGreaterThan(1);

    // Succeed
    succeedLatestWs();
    await flushMicrotasks();

    // Should be connected again with same connection ID since same URL+token
    const conn = client.getConnection(connId);
    expect(conn).toBeDefined();
    expect(conn!.connected).toBe(true);
  });

  describe('suspend / resume', () => {
    it('suspend() closes all WebSockets and preserves connectionParams', async () => {
      const { ws, connId } = await connectSuccessfully();

      const disconnectCb = vi.fn();
      client.onDisconnect(disconnectCb);

      client.suspend();

      // WebSocket should have been closed
      expect(ws.close).toHaveBeenCalled();

      // The onclose handler fires the disconnect callback (wasConnected is true),
      // but no reconnection is scheduled because intentionalDisconnects blocks it
      expect(disconnectCb).toHaveBeenCalledWith(connId);
      expect(client.isReconnecting(connId)).toBe(false);

      // Connection should be suspended
      expect(client.isSuspended()).toBe(true);

      // connectionParams are preserved — verify by successfully resuming
      const resumePromise = client.resume();
      await flushMicrotasks();
      succeedLatestWs();
      await resumePromise;

      const conn = client.getConnection(connId);
      expect(conn).toBeDefined();
      expect(conn!.connected).toBe(true);
    });

    it('suspend() prevents reconnection', async () => {
      const { ws, connId } = await connectSuccessfully();

      client.suspend();

      // Should not be in reconnecting state (cancelReconnect was called)
      expect(client.isReconnecting(connId)).toBe(false);

      // No reconnect should be scheduled even after time passes
      const countBefore = wsInstances.length;
      await advanceAndFlush(60000);
      expect(wsInstances.length).toBe(countBefore);
    });

    it('resume() reconnects suspended connections', async () => {
      const { ws, connId } = await connectSuccessfully();

      client.suspend();
      expect(client.isSuspended()).toBe(true);

      // Resume — starts reconnection
      const resumePromise = client.resume();
      await flushMicrotasks();

      // A new WebSocket should have been created
      expect(wsInstances.length).toBeGreaterThan(1);

      // Complete the new connection
      succeedLatestWs();
      await resumePromise;

      // Connection should be live again with same connection ID
      const conn = client.getConnection(connId);
      expect(conn).toBeDefined();
      expect(conn!.connected).toBe(true);

      // No longer suspended
      expect(client.isSuspended()).toBe(false);
    });

    it('resume() handles stale WebSocket still in connections map', async () => {
      const { ws, connId } = await connectSuccessfully();

      client.suspend();

      // Simulate iOS behavior: onclose never fired, so the connection
      // is still in the connections map. We can verify this by noting
      // that suspend() calls ws.close() which in our mock DOES fire onclose
      // and removes from map. To simulate "stale", we manually re-add.
      // Instead, let's override close() to NOT fire onclose before suspend.
      // We need a fresh connection for this test.
      client.stopAllReconnections();

      // Create a new client to control close behavior precisely
      const client2 = new HubClient();
      const connectPromise = client2.connect('ws://localhost:3002', 'Test Hub', 'token');
      await flushMicrotasks();
      const ws2 = wsInstances[wsInstances.length - 1];
      ws2.simulateOpen();
      ws2.simulateMessage({ type: 'auth_result', success: true });
      const conn2 = await connectPromise;

      // Override close() to NOT fire onclose (simulating iOS stale WS)
      ws2.close = vi.fn(() => {
        ws2.readyState = MockWebSocket.CLOSED;
        // Deliberately do NOT call onclose — simulating iOS behavior
      });

      client2.suspend();

      // The WS close was called but onclose didn't fire, so the connection
      // may still be in the map. Now resume should force-close and reconnect.
      const resumePromise = client2.resume();
      await flushMicrotasks();

      // A new WebSocket should have been created
      const latestWs = wsInstances[wsInstances.length - 1];
      expect(latestWs).not.toBe(ws2);

      // Complete the new connection
      succeedLatestWs();
      await resumePromise;

      const connAfter = client2.getConnection(conn2.id);
      expect(connAfter).toBeDefined();
      expect(connAfter!.connected).toBe(true);

      client2.stopAllReconnections();
    });

    it('resume() falls back to scheduleReconnect on failure', async () => {
      const { ws, connId } = await connectSuccessfully();

      client.suspend();

      // Resume — but make the new connection fail
      const resumePromise = client.resume();
      await flushMicrotasks();

      // Fail the reconnect attempt
      failLatestWs();
      await resumePromise;

      // Should have fallen back to scheduleReconnect
      expect(client.isReconnecting(connId)).toBe(true);
    });

    it('suspend() does nothing when no connections', () => {
      // Fresh client with no connections — should not throw
      expect(() => client.suspend()).not.toThrow();
      // isSuspended should be false since there were no connections to suspend
      expect(client.isSuspended()).toBe(false);
    });

    it('isSuspended() returns correct state through lifecycle', async () => {
      // Initially not suspended
      expect(client.isSuspended()).toBe(false);

      await connectSuccessfully();

      // Still not suspended after connecting
      expect(client.isSuspended()).toBe(false);

      // After suspend
      client.suspend();
      expect(client.isSuspended()).toBe(true);

      // After resume
      const resumePromise = client.resume();
      await flushMicrotasks();

      // isSuspended is false immediately after resume() starts
      // (suspendedIds are cleared at the beginning of resume)
      expect(client.isSuspended()).toBe(false);

      // Complete the connection
      succeedLatestWs();
      await resumePromise;

      // Still not suspended
      expect(client.isSuspended()).toBe(false);
    });
  });
});
