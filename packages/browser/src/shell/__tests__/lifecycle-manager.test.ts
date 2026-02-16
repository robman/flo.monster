import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LifecycleManager } from '../lifecycle-manager.js';
import { DirtyTracker } from '../dirty-tracker.js';
import { getStorageProvider } from '../../storage/agent-storage.js';

// Mock the storage module to avoid real filesystem access
vi.mock('../../storage/agent-storage.js', () => ({
  getStorageProvider: vi.fn().mockResolvedValue({
    readFile: vi.fn().mockResolvedValue(null),
    writeFile: vi.fn().mockResolvedValue(undefined),
  }),
}));

/** Create mock dependencies with optional overrides */
function createMockDeps(overrides: Partial<any> = {}) {
  const mockAgentManager = {
    getAllSavedStates: vi.fn().mockReturnValue([]),
    getActiveAgent: vi.fn().mockReturnValue(null),
    getAgent: vi.fn().mockReturnValue(null),
    restoreAgent: vi.fn(),
    restartAgent: vi.fn(),
  };

  const mockPersistence = {
    saveAgentRegistry: vi.fn().mockResolvedValue(undefined),
    loadAgentRegistry: vi.fn().mockResolvedValue([]),
    clearAgentRegistry: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };

  return {
    agentManager: mockAgentManager,
    persistence: mockPersistence,
    hookManager: { getHooksConfig: vi.fn().mockReturnValue({ activeHookTypes: [] }) },
    agentIframesContainer: document.createElement('div'),
    workerCode: 'test-worker',
    getCostTracker: vi.fn().mockReturnValue(null),
    getAgentCosts: vi.fn().mockReturnValue(new Map()),
    updateStatusBar: vi.fn(),
    ...overrides,
  };
}

/** Create a mock agent container */
function createMockAgent(id: string, name: string) {
  return {
    id,
    config: { name },
    state: 'running',
    captureDomState: vi.fn().mockResolvedValue(null),
    getIframeElement: vi.fn().mockReturnValue(null),
    start: vi.fn().mockResolvedValue(undefined),
    restoreDomState: vi.fn().mockResolvedValue(undefined),
    setRestorationContext: vi.fn(),
  };
}

/**
 * Capture the beforeunload handler registered by setupLifecycleHandlers.
 * We spy on window.addEventListener, call setupLifecycleHandlers, then
 * extract the registered handler. This avoids listener accumulation
 * across tests when dispatching real events.
 */
function captureBeforeUnloadHandler(lm: LifecycleManager): (event: BeforeUnloadEvent) => void {
  const addSpy = vi.spyOn(window, 'addEventListener');
  lm.setupLifecycleHandlers();

  const beforeUnloadCall = addSpy.mock.calls.find(
    (call) => call[0] === 'beforeunload'
  );
  addSpy.mockRestore();

  if (!beforeUnloadCall) {
    throw new Error('setupLifecycleHandlers did not register a beforeunload listener');
  }
  return beforeUnloadCall[1] as (event: BeforeUnloadEvent) => void;
}

describe('LifecycleManager — auto-save and dirty tracking', () => {
  let dirtyTracker: DirtyTracker;

  beforeEach(() => {
    dirtyTracker = new DirtyTracker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── startAutoSave / stopAutoSave ─────────────────────────────────

  describe('startAutoSave / stopAutoSave', () => {
    it('creates an interval timer when started', () => {
      const deps = createMockDeps({ dirtyTracker });
      const lm = new LifecycleManager(deps as any);

      const spy = vi.spyOn(globalThis, 'setInterval');
      lm.startAutoSave(5000);

      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 5000);

      lm.stopAutoSave();
    });

    it('clears the timer when stopped', () => {
      const deps = createMockDeps({ dirtyTracker });
      const lm = new LifecycleManager(deps as any);
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');

      lm.startAutoSave(5000);
      lm.stopAutoSave();

      expect(clearSpy).toHaveBeenCalledOnce();
    });

    it('stopAutoSave is a no-op if no timer is running', () => {
      const deps = createMockDeps({ dirtyTracker });
      const lm = new LifecycleManager(deps as any);
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');

      // Calling stop without start should not throw or call clearInterval
      lm.stopAutoSave();
      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('multiple start calls do not create multiple timers (stopAutoSave called internally)', () => {
      const deps = createMockDeps({ dirtyTracker });
      const lm = new LifecycleManager(deps as any);
      const setSpy = vi.spyOn(globalThis, 'setInterval');
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');

      lm.startAutoSave(5000);
      lm.startAutoSave(5000); // second call should stop the first
      lm.startAutoSave(5000); // third call should stop the second

      // setInterval called 3 times, but clearInterval called before the 2nd and 3rd
      expect(setSpy).toHaveBeenCalledTimes(3);
      expect(clearSpy).toHaveBeenCalledTimes(2);

      lm.stopAutoSave();
    });

    it('auto-save timer fires autoSaveIfDirty periodically', async () => {
      const persistHandler = {
        persistAgent: vi.fn().mockResolvedValue({ success: true }),
      };
      const agent = createMockAgent('agent-1', 'Agent One');
      const hubMapping = new Map([
        ['agent-1', { hubConnectionId: 'hub-1', hubAgentId: 'hub-agent-1' }],
      ]);
      const deps = createMockDeps({
        dirtyTracker,
        persistHandler,
        getHubAgentMapping: () => hubMapping,
        agentManager: {
          ...createMockDeps().agentManager,
          getAgent: vi.fn().mockReturnValue(agent),
        },
      });
      const lm = new LifecycleManager(deps as any);

      dirtyTracker.markDirty('agent-1', 'message');

      lm.startAutoSave(1000);

      // Advance past the first interval tick and flush async work
      await vi.advanceTimersByTimeAsync(1000);

      expect(persistHandler.persistAgent).toHaveBeenCalledOnce();

      lm.stopAutoSave();
    });
  });

  // ── autoSaveIfDirty ──────────────────────────────────────────────

  describe('autoSaveIfDirty', () => {
    it('does nothing when no dirtyTracker is provided', async () => {
      const persistHandler = { persistAgent: vi.fn() };
      const deps = createMockDeps({
        // deliberately no dirtyTracker
        persistHandler,
        getHubAgentMapping: () => new Map(),
      });
      const lm = new LifecycleManager(deps as any);

      await lm.autoSaveIfDirty();

      expect(persistHandler.persistAgent).not.toHaveBeenCalled();
    });

    it('does nothing when no persistHandler is provided', async () => {
      const deps = createMockDeps({
        dirtyTracker,
        // deliberately no persistHandler
        getHubAgentMapping: () => new Map(),
      });
      const lm = new LifecycleManager(deps as any);

      dirtyTracker.markDirty('agent-1', 'message');
      await lm.autoSaveIfDirty();

      // Nothing to assert beyond "no error thrown"
    });

    it('does nothing when no getHubAgentMapping is provided', async () => {
      const persistHandler = { persistAgent: vi.fn() };
      const deps = createMockDeps({
        dirtyTracker,
        persistHandler,
        // deliberately no getHubAgentMapping
      });
      const lm = new LifecycleManager(deps as any);

      dirtyTracker.markDirty('agent-1', 'message');
      await lm.autoSaveIfDirty();

      expect(persistHandler.persistAgent).not.toHaveBeenCalled();
    });

    it('does nothing when no agents are dirty', async () => {
      const persistHandler = { persistAgent: vi.fn() };
      const deps = createMockDeps({
        dirtyTracker,
        persistHandler,
        getHubAgentMapping: () => new Map(),
      });
      const lm = new LifecycleManager(deps as any);

      // No agents marked dirty
      await lm.autoSaveIfDirty();

      expect(persistHandler.persistAgent).not.toHaveBeenCalled();
    });

    it('does nothing when dirty agent has no hub mapping', async () => {
      const persistHandler = { persistAgent: vi.fn() };
      const deps = createMockDeps({
        dirtyTracker,
        persistHandler,
        getHubAgentMapping: () => new Map(), // empty mapping
      });
      const lm = new LifecycleManager(deps as any);

      dirtyTracker.markDirty('agent-1', 'message');
      await lm.autoSaveIfDirty();

      expect(persistHandler.persistAgent).not.toHaveBeenCalled();
    });

    it('does nothing when dirty agent with hub mapping is not found in agentManager', async () => {
      const persistHandler = { persistAgent: vi.fn() };
      const hubMapping = new Map([
        ['agent-1', { hubConnectionId: 'hub-1', hubAgentId: 'hub-agent-1' }],
      ]);
      const deps = createMockDeps({
        dirtyTracker,
        persistHandler,
        getHubAgentMapping: () => hubMapping,
        // agentManager.getAgent returns null by default
      });
      const lm = new LifecycleManager(deps as any);

      dirtyTracker.markDirty('agent-1', 'message');
      await lm.autoSaveIfDirty();

      expect(persistHandler.persistAgent).not.toHaveBeenCalled();
    });

    it('saves a dirty agent that has a hub mapping via persistHandler', async () => {
      const persistHandler = {
        persistAgent: vi.fn().mockResolvedValue({ success: true }),
      };
      const agent = createMockAgent('agent-1', 'Agent One');
      const hubMapping = new Map([
        ['agent-1', { hubConnectionId: 'hub-1', hubAgentId: 'hub-agent-1' }],
      ]);
      const mockAgentManager = {
        ...createMockDeps().agentManager,
        getAgent: vi.fn().mockReturnValue(agent),
      };
      const deps = createMockDeps({
        dirtyTracker,
        persistHandler,
        getHubAgentMapping: () => hubMapping,
        agentManager: mockAgentManager,
      });
      const lm = new LifecycleManager(deps as any);

      dirtyTracker.markDirty('agent-1', 'message');
      await lm.autoSaveIfDirty();

      expect(persistHandler.persistAgent).toHaveBeenCalledOnce();
      expect(persistHandler.persistAgent).toHaveBeenCalledWith(agent, {
        hubConnectionId: 'hub-1',
        includeFiles: true,
      });
    });

    it('marks agent clean on successful save', async () => {
      const persistHandler = {
        persistAgent: vi.fn().mockResolvedValue({ success: true }),
      };
      const agent = createMockAgent('agent-1', 'Agent One');
      const hubMapping = new Map([
        ['agent-1', { hubConnectionId: 'hub-1', hubAgentId: 'hub-agent-1' }],
      ]);
      const deps = createMockDeps({
        dirtyTracker,
        persistHandler,
        getHubAgentMapping: () => hubMapping,
        agentManager: {
          ...createMockDeps().agentManager,
          getAgent: vi.fn().mockReturnValue(agent),
        },
      });
      const lm = new LifecycleManager(deps as any);

      dirtyTracker.markDirty('agent-1', 'message');
      expect(dirtyTracker.isDirty('agent-1')).toBe(true);

      await lm.autoSaveIfDirty();

      expect(dirtyTracker.isDirty('agent-1')).toBe(false);
    });

    it('does not mark agent clean on failed save (result.success is false)', async () => {
      const persistHandler = {
        persistAgent: vi.fn().mockResolvedValue({ success: false, error: 'Hub disconnected' }),
      };
      const agent = createMockAgent('agent-1', 'Agent One');
      const hubMapping = new Map([
        ['agent-1', { hubConnectionId: 'hub-1', hubAgentId: 'hub-agent-1' }],
      ]);
      const deps = createMockDeps({
        dirtyTracker,
        persistHandler,
        getHubAgentMapping: () => hubMapping,
        agentManager: {
          ...createMockDeps().agentManager,
          getAgent: vi.fn().mockReturnValue(agent),
        },
      });
      const lm = new LifecycleManager(deps as any);

      dirtyTracker.markDirty('agent-1', 'message');
      await lm.autoSaveIfDirty();

      expect(dirtyTracker.isDirty('agent-1')).toBe(true);
    });

    it('does not mark agent clean when persistAgent throws', async () => {
      const persistHandler = {
        persistAgent: vi.fn().mockRejectedValue(new Error('Network error')),
      };
      const agent = createMockAgent('agent-1', 'Agent One');
      const hubMapping = new Map([
        ['agent-1', { hubConnectionId: 'hub-1', hubAgentId: 'hub-agent-1' }],
      ]);
      const deps = createMockDeps({
        dirtyTracker,
        persistHandler,
        getHubAgentMapping: () => hubMapping,
        agentManager: {
          ...createMockDeps().agentManager,
          getAgent: vi.fn().mockReturnValue(agent),
        },
      });
      const lm = new LifecycleManager(deps as any);

      dirtyTracker.markDirty('agent-1', 'message');
      await lm.autoSaveIfDirty();

      expect(dirtyTracker.isDirty('agent-1')).toBe(true);
    });

    it('handles multiple dirty agents — saves those with hub mappings, skips those without', async () => {
      const persistHandler = {
        persistAgent: vi.fn().mockResolvedValue({ success: true }),
      };
      const agent1 = createMockAgent('agent-1', 'Agent One');
      const agent2 = createMockAgent('agent-2', 'Agent Two');
      const agent3 = createMockAgent('agent-3', 'Agent Three');

      // Only agents 1 and 3 have hub mappings; agent-2 does not
      const hubMapping = new Map([
        ['agent-1', { hubConnectionId: 'hub-1', hubAgentId: 'hub-agent-1' }],
        ['agent-3', { hubConnectionId: 'hub-1', hubAgentId: 'hub-agent-3' }],
      ]);
      const deps = createMockDeps({
        dirtyTracker,
        persistHandler,
        getHubAgentMapping: () => hubMapping,
        agentManager: {
          ...createMockDeps().agentManager,
          getAgent: vi.fn((id: string) => {
            if (id === 'agent-1') return agent1;
            if (id === 'agent-2') return agent2;
            if (id === 'agent-3') return agent3;
            return null;
          }),
        },
      });
      const lm = new LifecycleManager(deps as any);

      dirtyTracker.markDirty('agent-1', 'message');
      dirtyTracker.markDirty('agent-2', 'dom');
      dirtyTracker.markDirty('agent-3', 'file');

      await lm.autoSaveIfDirty();

      // Only agents with hub mappings are persisted
      expect(persistHandler.persistAgent).toHaveBeenCalledTimes(2);
      expect(persistHandler.persistAgent).toHaveBeenCalledWith(agent1, {
        hubConnectionId: 'hub-1',
        includeFiles: true,
      });
      expect(persistHandler.persistAgent).toHaveBeenCalledWith(agent3, {
        hubConnectionId: 'hub-1',
        includeFiles: true,
      });

      // agent-1 and agent-3 should be clean; agent-2 remains dirty
      expect(dirtyTracker.isDirty('agent-1')).toBe(false);
      expect(dirtyTracker.isDirty('agent-2')).toBe(true);
      expect(dirtyTracker.isDirty('agent-3')).toBe(false);
    });
  });

  // ── beforeunload with dirty tracking ─────────────────────────────

  describe('beforeunload with dirty tracking', () => {
    it('sets event.returnValue when dirty tracker has dirty agents', () => {
      const deps = createMockDeps({ dirtyTracker });
      const lm = new LifecycleManager(deps as any);
      const handler = captureBeforeUnloadHandler(lm);

      dirtyTracker.markDirty('agent-1', 'message');

      const event = { preventDefault: vi.fn(), returnValue: '' } as any;
      handler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.returnValue).toBe('You have unsaved changes. Are you sure you want to leave?');
    });

    it('does not set event.returnValue when no dirty agents', () => {
      const deps = createMockDeps({ dirtyTracker });
      const lm = new LifecycleManager(deps as any);
      const handler = captureBeforeUnloadHandler(lm);

      // No agents marked dirty
      const event = { preventDefault: vi.fn(), returnValue: '' } as any;
      handler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.returnValue).toBe('');
    });

    it('does not set event.returnValue when no dirty tracker is provided', () => {
      const deps = createMockDeps();
      // No dirtyTracker in deps
      const lm = new LifecycleManager(deps as any);
      const handler = captureBeforeUnloadHandler(lm);

      const event = { preventDefault: vi.fn(), returnValue: '' } as any;
      handler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.returnValue).toBe('');
    });

    it('does not interfere with normal saves in beforeunload', () => {
      const deps = createMockDeps({ dirtyTracker });
      const lm = new LifecycleManager(deps as any);
      const handler = captureBeforeUnloadHandler(lm);

      // No dirty agents — the beforeunload should still run the sync save logic
      const event = { preventDefault: vi.fn(), returnValue: '' } as any;
      handler(event);

      // The saveAgentRegistrySync path was still called (via getAllSavedStates)
      expect(deps.agentManager.getAllSavedStates).toHaveBeenCalled();
    });
  });

  // ── visibilitychange suspend/resume ──────────────────────────────

  describe('visibilitychange suspend/resume', () => {
    /**
     * Capture the visibilitychange handler registered by setupLifecycleHandlers.
     * Spies on document.addEventListener, calls setupLifecycleHandlers, then
     * extracts the registered handler.
     */
    function captureVisibilityChangeHandler(lm: LifecycleManager): () => void {
      const addSpy = vi.spyOn(document, 'addEventListener');
      lm.setupLifecycleHandlers();

      const visibilityCall = addSpy.mock.calls.find(
        (call) => call[0] === 'visibilitychange'
      );
      addSpy.mockRestore();

      if (!visibilityCall) {
        throw new Error('setupLifecycleHandlers did not register a visibilitychange listener');
      }
      return visibilityCall[1] as () => void;
    }

    it('calls hubClient.suspend() on visibilitychange to hidden', async () => {
      const hubClient = {
        sendDomStateUpdate: vi.fn(),
        suspend: vi.fn(),
        resume: vi.fn().mockResolvedValue(undefined),
      };
      const deps = createMockDeps({ hubClient });
      const lm = new LifecycleManager(deps as any);
      const handler = captureVisibilityChangeHandler(lm);

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        writable: true,
        configurable: true,
      });

      await handler();

      expect(hubClient.suspend).toHaveBeenCalledOnce();
      expect(hubClient.resume).not.toHaveBeenCalled();
    });

    it('calls hubClient.resume() on visibilitychange to visible', async () => {
      const hubClient = {
        sendDomStateUpdate: vi.fn(),
        suspend: vi.fn(),
        resume: vi.fn().mockResolvedValue(undefined),
      };
      const deps = createMockDeps({ hubClient });
      const lm = new LifecycleManager(deps as any);
      const handler = captureVisibilityChangeHandler(lm);

      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      });

      await handler();

      expect(hubClient.resume).toHaveBeenCalledOnce();
      expect(hubClient.suspend).not.toHaveBeenCalled();
    });

    it('does not throw when hubClient has no suspend method', async () => {
      const hubClient = {
        sendDomStateUpdate: vi.fn(),
        // No suspend or resume methods
      };
      const deps = createMockDeps({ hubClient });
      const lm = new LifecycleManager(deps as any);
      const handler = captureVisibilityChangeHandler(lm);

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        writable: true,
        configurable: true,
      });

      // Should not throw
      await handler();
    });

    it('does not throw when hubClient is null', async () => {
      const deps = createMockDeps({ hubClient: null });
      const lm = new LifecycleManager(deps as any);
      const handler = captureVisibilityChangeHandler(lm);

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        writable: true,
        configurable: true,
      });

      // Should not throw
      await handler();
    });
  });

});

// ── DOM capture hub sync ─────────────────────────────────────────

describe('LifecycleManager — DOM capture hub sync', () => {
  beforeEach(() => {
    // Re-setup the storage mock (vi.restoreAllMocks in previous suite clears it)
    vi.mocked(getStorageProvider).mockResolvedValue({
      readFile: vi.fn().mockResolvedValue(null),
      writeFile: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('captureDomStateForAgent hub sync', () => {
    it('sends DOM state update to hub for hub-persisted agents', async () => {
      const mockDomState = { viewportHtml: '<div>test</div>', listeners: [], capturedAt: Date.now() };
      const hubClient = { sendDomStateUpdate: vi.fn() };
      const agent = {
        ...createMockAgent('agent-1', 'Agent One'),
        hubPersistInfo: { hubAgentId: 'hub-agent-1', hubName: 'My Hub', hubConnectionId: 'conn-1' },
        hubConnected: true,
        captureDomState: vi.fn().mockResolvedValue(mockDomState),
      };
      const deps = createMockDeps({
        hubClient,
        agentManager: {
          ...createMockDeps().agentManager,
          getAgent: vi.fn().mockReturnValue(agent),
        },
      });
      const lm = new LifecycleManager(deps as any);

      await lm.captureDomStateForAgent('agent-1');

      expect(hubClient.sendDomStateUpdate).toHaveBeenCalledOnce();
      expect(hubClient.sendDomStateUpdate).toHaveBeenCalledWith(
        'conn-1',
        'hub-agent-1',
        mockDomState,
      );
    });

    it('does not send to hub for non-hub-persisted agents', async () => {
      const mockDomState = { viewportHtml: '<div>test</div>', listeners: [], capturedAt: Date.now() };
      const hubClient = { sendDomStateUpdate: vi.fn() };
      const agent = {
        ...createMockAgent('agent-1', 'Agent One'),
        hubPersistInfo: null,
        captureDomState: vi.fn().mockResolvedValue(mockDomState),
      };
      const deps = createMockDeps({
        hubClient,
        agentManager: {
          ...createMockDeps().agentManager,
          getAgent: vi.fn().mockReturnValue(agent),
        },
      });
      const lm = new LifecycleManager(deps as any);

      await lm.captureDomStateForAgent('agent-1');

      expect(hubClient.sendDomStateUpdate).not.toHaveBeenCalled();
    });

    it('does not send to hub when hubClient is not provided', async () => {
      const mockDomState = { viewportHtml: '<div>test</div>', listeners: [], capturedAt: Date.now() };
      const agent = {
        ...createMockAgent('agent-1', 'Agent One'),
        hubPersistInfo: { hubAgentId: 'hub-agent-1', hubName: 'My Hub', hubConnectionId: 'conn-1' },
        captureDomState: vi.fn().mockResolvedValue(mockDomState),
      };
      const deps = createMockDeps({
        // No hubClient
        agentManager: {
          ...createMockDeps().agentManager,
          getAgent: vi.fn().mockReturnValue(agent),
        },
      });
      const lm = new LifecycleManager(deps as any);

      // Should not throw
      await lm.captureDomStateForAgent('agent-1');
    });

    it('catches errors from sendDomStateUpdate gracefully', async () => {
      const mockDomState = { viewportHtml: '<div>test</div>', listeners: [], capturedAt: Date.now() };
      const hubClient = {
        sendDomStateUpdate: vi.fn().mockImplementation(() => {
          throw new Error('WebSocket closed');
        }),
      };
      const agent = {
        ...createMockAgent('agent-1', 'Agent One'),
        hubPersistInfo: { hubAgentId: 'hub-agent-1', hubName: 'My Hub', hubConnectionId: 'conn-1' },
        hubConnected: true,
        captureDomState: vi.fn().mockResolvedValue(mockDomState),
      };
      const deps = createMockDeps({
        hubClient,
        agentManager: {
          ...createMockDeps().agentManager,
          getAgent: vi.fn().mockReturnValue(agent),
        },
      });
      const lm = new LifecycleManager(deps as any);

      // Should not throw despite hub send error
      await lm.captureDomStateForAgent('agent-1');

      expect(hubClient.sendDomStateUpdate).toHaveBeenCalledOnce();
    });

    it('sends DOM state from captureFocusedAgentDom for hub-persisted agents', async () => {
      const mockDomState = { viewportHtml: '<div>focused</div>', listeners: [], capturedAt: Date.now() };
      const hubClient = { sendDomStateUpdate: vi.fn() };
      const agent = {
        ...createMockAgent('agent-1', 'Agent One'),
        hubPersistInfo: { hubAgentId: 'hub-agent-1', hubName: 'My Hub', hubConnectionId: 'conn-1' },
        hubConnected: true,
        captureDomState: vi.fn().mockResolvedValue(mockDomState),
      };
      const deps = createMockDeps({
        hubClient,
        agentManager: {
          ...createMockDeps().agentManager,
          getActiveAgent: vi.fn().mockReturnValue(agent),
        },
      });
      const lm = new LifecycleManager(deps as any);

      await lm.captureFocusedAgentDom();

      expect(hubClient.sendDomStateUpdate).toHaveBeenCalledOnce();
      expect(hubClient.sendDomStateUpdate).toHaveBeenCalledWith(
        'conn-1',
        'hub-agent-1',
        mockDomState,
      );
    });

    it('does not send from captureFocusedAgentDom when no active agent', async () => {
      const hubClient = { sendDomStateUpdate: vi.fn() };
      const deps = createMockDeps({
        hubClient,
        // getActiveAgent returns null by default
      });
      const lm = new LifecycleManager(deps as any);

      await lm.captureFocusedAgentDom();

      expect(hubClient.sendDomStateUpdate).not.toHaveBeenCalled();
    });

    it('does not send when captureDomState returns null', async () => {
      const hubClient = { sendDomStateUpdate: vi.fn() };
      const agent = {
        ...createMockAgent('agent-1', 'Agent One'),
        hubPersistInfo: { hubAgentId: 'hub-agent-1', hubName: 'My Hub', hubConnectionId: 'conn-1' },
        captureDomState: vi.fn().mockResolvedValue(null),
      };
      const deps = createMockDeps({
        hubClient,
        agentManager: {
          ...createMockDeps().agentManager,
          getAgent: vi.fn().mockReturnValue(agent),
        },
      });
      const lm = new LifecycleManager(deps as any);

      await lm.captureDomStateForAgent('agent-1');

      expect(hubClient.sendDomStateUpdate).not.toHaveBeenCalled();
    });
  });
});
