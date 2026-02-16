import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs BEFORE imports are resolved, so the module-level
// navigator.geolocation usage will capture our mock.
const { mockGetCurrentPosition, mockWatchPosition, mockClearWatch, resetMocks } = vi.hoisted(() => {
  const mockGetCurrentPosition = vi.fn();
  const mockWatchPosition = vi.fn();
  const mockClearWatch = vi.fn();

  // Set up navigator.geolocation mock
  Object.defineProperty(navigator, 'geolocation', {
    value: {
      getCurrentPosition: mockGetCurrentPosition,
      watchPosition: mockWatchPosition,
      clearWatch: mockClearWatch,
    },
    writable: true,
    configurable: true,
  });

  return {
    mockGetCurrentPosition,
    mockWatchPosition,
    mockClearWatch,
    resetMocks: () => {
      mockGetCurrentPosition.mockReset();
      mockWatchPosition.mockReset();
      mockClearWatch.mockReset();
    },
  };
});

import {
  handleGeolocationGet,
  handleGeolocationWatchStart,
  handleGeolocationWatchStop,
  cleanupGeolocationWatches,
} from './geolocation-handler.js';
import type { AgentContainer } from '../../agent/agent-container.js';

// --- Helpers ---

function createMockAgent(overrides: any = {}): AgentContainer {
  return {
    id: 'agent-1',
    config: {
      id: 'agent-1',
      name: 'Test Agent',
      sandboxPermissions: { geolocation: true },
      ...overrides,
    },
    updateConfig: vi.fn(),
  } as unknown as AgentContainer;
}

function createMockTarget() {
  return { postMessage: vi.fn() } as unknown as Window;
}

function createMockGeoCtx(): any {
  return {
    permissionApprovals: new Map(),
    permissionApprovalDialog: null,
    setPermissionApprovalDialog: vi.fn(),
    onPermissionChange: null,
  };
}

const mockPosition = {
  coords: {
    latitude: 37.7749,
    longitude: -122.4194,
    accuracy: 10,
    altitude: 50,
    altitudeAccuracy: 5,
    heading: 90,
    speed: 1.5,
  },
  timestamp: 1700000000000,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
});

// --- Tests ---

describe('handleGeolocationGet', () => {
  it('calls getCurrentPosition when geolocation permission is enabled', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const ctx = createMockGeoCtx();

    mockGetCurrentPosition.mockImplementation((success: any, _error: any, _opts: any) => {
      success(mockPosition);
    });

    await handleGeolocationGet(
      { type: 'geolocation_get', id: 'geo-1', agentId: 'agent-1' },
      agent,
      target,
      ctx,
    );

    expect(mockGetCurrentPosition).toHaveBeenCalledOnce();
    expect(target.postMessage).toHaveBeenCalledOnce();
    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.type).toBe('geolocation_position');
    expect(msg.id).toBe('geo-1');
    expect(msg.coords.latitude).toBe(37.7749);
    expect(msg.coords.longitude).toBe(-122.4194);
    expect(msg.coords.accuracy).toBe(10);
    expect(msg.coords.altitude).toBe(50);
    expect(msg.coords.altitudeAccuracy).toBe(5);
    expect(msg.coords.heading).toBe(90);
    expect(msg.coords.speed).toBe(1.5);
    expect(msg.timestamp).toBe(1700000000000);
  });

  it('posts geolocation_error on position error', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const ctx = createMockGeoCtx();

    mockGetCurrentPosition.mockImplementation((_success: any, error: any, _opts: any) => {
      error({ code: 1, message: 'User denied Geolocation' });
    });

    await handleGeolocationGet(
      { type: 'geolocation_get', id: 'geo-2', agentId: 'agent-1' },
      agent,
      target,
      ctx,
    );

    expect(target.postMessage).toHaveBeenCalledOnce();
    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.type).toBe('geolocation_error');
    expect(msg.id).toBe('geo-2');
    expect(msg.code).toBe(1);
    expect(msg.error).toContain('User denied Geolocation');
  });

  it('posts geolocation_error when permission denied (cached)', async () => {
    const agent = createMockAgent({ sandboxPermissions: { geolocation: false } });
    const target = createMockTarget();
    const ctx = createMockGeoCtx();
    ctx.permissionApprovals.set('agent-1:geolocation', { approved: false, persistent: false });

    await handleGeolocationGet(
      { type: 'geolocation_get', id: 'geo-3', agentId: 'agent-1' },
      agent,
      target,
      ctx,
    );

    expect(target.postMessage).toHaveBeenCalledOnce();
    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.type).toBe('geolocation_error');
    expect(msg.id).toBe('geo-3');
    expect(msg.error).toContain('denied');
  });

  it('forwards position options', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const ctx = createMockGeoCtx();

    mockGetCurrentPosition.mockImplementation((success: any, _error: any, _opts: any) => {
      success(mockPosition);
    });

    await handleGeolocationGet(
      {
        type: 'geolocation_get',
        id: 'geo-4',
        agentId: 'agent-1',
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 10000,
      },
      agent,
      target,
      ctx,
    );

    expect(mockGetCurrentPosition).toHaveBeenCalledOnce();
    const opts = mockGetCurrentPosition.mock.calls[0][2];
    expect(opts.enableHighAccuracy).toBe(true);
    expect(opts.timeout).toBe(5000);
    expect(opts.maximumAge).toBe(10000);
  });
});

describe('handleGeolocationWatchStart', () => {
  it('starts watching and posts position updates', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const ctx = createMockGeoCtx();

    let successCb: (pos: any) => void;
    mockWatchPosition.mockImplementation((success: any, _error: any, _opts: any) => {
      successCb = success;
      return 42;
    });

    await handleGeolocationWatchStart(
      { type: 'geolocation_watch_start', id: 'watch-1', agentId: 'agent-1' },
      agent,
      target,
      ctx,
    );

    // Simulate two position updates
    successCb!(mockPosition);
    successCb!({
      coords: {
        latitude: 37.7750,
        longitude: -122.4195,
        accuracy: 8,
        altitude: 51,
        altitudeAccuracy: 4,
        heading: 91,
        speed: 1.6,
      },
      timestamp: 1700000001000,
    });

    expect(target.postMessage).toHaveBeenCalledTimes(2);

    const msg1 = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg1.type).toBe('geolocation_position');
    expect(msg1.id).toBe('watch-1');
    expect(msg1.coords.latitude).toBe(37.7749);

    const msg2 = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(msg2.type).toBe('geolocation_position');
    expect(msg2.id).toBe('watch-1');
    expect(msg2.coords.latitude).toBe(37.7750);
    expect(msg2.timestamp).toBe(1700000001000);

    // Clean up
    handleGeolocationWatchStop(
      { type: 'geolocation_watch_stop', id: 'watch-1', agentId: 'agent-1' },
      agent,
      target,
    );
  });

  it('posts geolocation_error on watch error', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const ctx = createMockGeoCtx();

    let errorCb: (err: any) => void;
    mockWatchPosition.mockImplementation((_success: any, error: any, _opts: any) => {
      errorCb = error;
      return 43;
    });

    await handleGeolocationWatchStart(
      { type: 'geolocation_watch_start', id: 'watch-2', agentId: 'agent-1' },
      agent,
      target,
      ctx,
    );

    errorCb!({ code: 2, message: 'Position unavailable' });

    expect(target.postMessage).toHaveBeenCalledOnce();
    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.type).toBe('geolocation_error');
    expect(msg.id).toBe('watch-2');
    expect(msg.code).toBe(2);
    expect(msg.error).toContain('Position unavailable');

    // Clean up
    handleGeolocationWatchStop(
      { type: 'geolocation_watch_stop', id: 'watch-2', agentId: 'agent-1' },
      agent,
      target,
    );
  });

  it('posts geolocation_error when permission denied (cached)', async () => {
    const agent = createMockAgent({ sandboxPermissions: { geolocation: false } });
    const target = createMockTarget();
    const ctx = createMockGeoCtx();
    ctx.permissionApprovals.set('agent-1:geolocation', { approved: false, persistent: false });

    await handleGeolocationWatchStart(
      { type: 'geolocation_watch_start', id: 'watch-3', agentId: 'agent-1' },
      agent,
      target,
      ctx,
    );

    expect(target.postMessage).toHaveBeenCalledOnce();
    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.type).toBe('geolocation_error');
    expect(msg.id).toBe('watch-3');
    expect(msg.error).toContain('denied');
  });
});

describe('handleGeolocationWatchStop', () => {
  it('stops watching and posts geolocation_watch_stopped', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const ctx = createMockGeoCtx();

    mockWatchPosition.mockReturnValue(42);

    await handleGeolocationWatchStart(
      { type: 'geolocation_watch_start', id: 'watch-stop-1', agentId: 'agent-1' },
      agent,
      target,
      ctx,
    );

    (target.postMessage as ReturnType<typeof vi.fn>).mockClear();

    handleGeolocationWatchStop(
      { type: 'geolocation_watch_stop', id: 'watch-stop-1', agentId: 'agent-1' },
      agent,
      target,
    );

    expect(mockClearWatch).toHaveBeenCalledWith(42);
    expect(target.postMessage).toHaveBeenCalledOnce();
    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.type).toBe('geolocation_watch_stopped');
    expect(msg.id).toBe('watch-stop-1');
  });

  it('handles stop for unknown watch gracefully', () => {
    const agent = createMockAgent();
    const target = createMockTarget();

    handleGeolocationWatchStop(
      { type: 'geolocation_watch_stop', id: 'watch-unknown', agentId: 'agent-1' },
      agent,
      target,
    );

    expect(target.postMessage).toHaveBeenCalledOnce();
    const msg = (target.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msg.type).toBe('geolocation_watch_stopped');
    expect(msg.id).toBe('watch-unknown');
  });
});

describe('cleanupGeolocationWatches', () => {
  it('clears all watches for specified agentId', async () => {
    const agent = createMockAgent();
    const target = createMockTarget();
    const ctx = createMockGeoCtx();

    // Start two watches for agent-1
    mockWatchPosition.mockReturnValueOnce(100);
    await handleGeolocationWatchStart(
      { type: 'geolocation_watch_start', id: 'cleanup-1', agentId: 'agent-1' },
      agent,
      target,
      ctx,
    );

    mockWatchPosition.mockReturnValueOnce(101);
    await handleGeolocationWatchStart(
      { type: 'geolocation_watch_start', id: 'cleanup-2', agentId: 'agent-1' },
      agent,
      target,
      ctx,
    );

    cleanupGeolocationWatches('agent-1');

    expect(mockClearWatch).toHaveBeenCalledWith(100);
    expect(mockClearWatch).toHaveBeenCalledWith(101);
    expect(mockClearWatch).toHaveBeenCalledTimes(2);
  });

  it('only clears watches for specified agentId', async () => {
    const agent1 = createMockAgent();
    const agent2 = createMockAgent({
      id: 'agent-2',
      name: 'Agent Two',
      sandboxPermissions: { geolocation: true },
    });
    (agent2 as any).id = 'agent-2';
    const target = createMockTarget();
    const ctx = createMockGeoCtx();

    // Start watch for agent-1
    mockWatchPosition.mockReturnValueOnce(200);
    await handleGeolocationWatchStart(
      { type: 'geolocation_watch_start', id: 'cleanup-3', agentId: 'agent-1' },
      agent1,
      target,
      ctx,
    );

    // Start watch for agent-2
    mockWatchPosition.mockReturnValueOnce(201);
    await handleGeolocationWatchStart(
      { type: 'geolocation_watch_start', id: 'cleanup-4', agentId: 'agent-2' },
      agent2,
      target,
      ctx,
    );

    // Only clean up agent-1
    cleanupGeolocationWatches('agent-1');

    expect(mockClearWatch).toHaveBeenCalledWith(200);
    expect(mockClearWatch).not.toHaveBeenCalledWith(201);
    expect(mockClearWatch).toHaveBeenCalledTimes(1);

    // Clean up agent-2
    cleanupGeolocationWatches('agent-2');
  });
});
