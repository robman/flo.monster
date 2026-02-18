import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeHubRunJs, hubRunJsToolDef, type HubRunJsDeps } from '../tools/hub-runjs.js';
import { HubAgentStateStore } from '../tools/hub-state.js';
import { HubAgentStorageStore } from '../tools/hub-storage.js';
import { getDefaultConfig } from '../config.js';

// --- Mock worker_threads ---

const { MockWorker } = vi.hoisted(() => {
  let _lastInstance: InstanceType<typeof MockWorker> | null = null;

  class MockWorker {
    onMessageCallback: ((msg: any) => void) | null = null;
    onErrorCallback: ((err: Error) => void) | null = null;
    terminated = false;
    postMessageSpy = vi.fn();

    constructor(public path: string, public options: any) {
      _lastInstance = this;
    }

    on(event: string, cb: any) {
      if (event === 'message') this.onMessageCallback = cb;
      if (event === 'error') this.onErrorCallback = cb;
      return this;
    }

    postMessage(msg: any) {
      this.postMessageSpy(msg);
    }

    terminate() {
      this.terminated = true;
      return Promise.resolve(0);
    }

    static getLastInstance(): InstanceType<typeof MockWorker> | null {
      return _lastInstance;
    }

    static reset() {
      _lastInstance = null;
    }
  }

  return { MockWorker };
});

vi.mock('node:worker_threads', () => ({
  Worker: MockWorker,
}));

// --- Helpers ---

function createDeps(overrides?: Partial<HubRunJsDeps>): HubRunJsDeps {
  return {
    agentId: 'hub-test-agent',
    stateStore: new HubAgentStateStore(),
    storageStore: new HubAgentStorageStore(),
    hubConfig: getDefaultConfig(),
    ...overrides,
  };
}

/** Wait a tick so the MockWorker is constructed inside executeHubRunJs */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function getWorker(): InstanceType<typeof MockWorker> {
  const w = MockWorker.getLastInstance();
  if (!w) throw new Error('MockWorker not created yet');
  return w;
}

// --- Tests ---

describe('hub-runjs', () => {
  beforeEach(() => {
    MockWorker.reset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Tool definition ----

  describe('hubRunJsToolDef', () => {
    it('has correct name and schema', () => {
      expect(hubRunJsToolDef.name).toBe('runjs');
      expect(hubRunJsToolDef.input_schema.type).toBe('object');
      expect(hubRunJsToolDef.input_schema.properties).toHaveProperty('code');
      expect(hubRunJsToolDef.input_schema.properties).toHaveProperty('context');
      expect(hubRunJsToolDef.input_schema.required).toContain('code');
    });
  });

  // ---- Context validation ----

  describe('context validation', () => {
    it('silently ignores iframe context and runs as worker', async () => {
      const deps = createDeps();
      const promise = executeHubRunJs({ code: '1+1', context: 'iframe' }, deps);

      await tick();
      const worker = getWorker();

      // Worker should be created (not rejected)
      expect(worker).toBeTruthy();

      // Complete execution
      worker.onMessageCallback!({ type: 'done', result: 2, consoleOutput: [] });
      const result = await promise;
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('Result: 2');
    });
  });

  // ---- Worker lifecycle ----

  describe('worker execution', () => {
    it('executes code and returns done result', async () => {
      const deps = createDeps();
      const promise = executeHubRunJs({ code: '21 * 2' }, deps);

      await tick();
      const worker = getWorker();

      // Simulate worker completing
      worker.onMessageCallback!({
        type: 'done',
        result: 42,
        consoleOutput: [],
      });

      const result = await promise;
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('Result: 42');
      expect(worker.terminated).toBe(true);
    });

    it('captures console output', async () => {
      const deps = createDeps();
      const promise = executeHubRunJs({ code: 'console.log("hello")' }, deps);

      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'done',
        result: null,
        consoleOutput: ['hello', 'world'],
      });

      const result = await promise;
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('Console output:');
      expect(result.content).toContain('hello');
      expect(result.content).toContain('world');
    });

    it('handles worker error message', async () => {
      const deps = createDeps();
      const promise = executeHubRunJs({ code: 'bad()' }, deps);

      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'error',
        error: 'ReferenceError: bad is not defined',
        consoleOutput: [],
      });

      const result = await promise;
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('ReferenceError');
      expect(worker.terminated).toBe(true);
    });

    it('handles worker on error event', async () => {
      const deps = createDeps();
      const promise = executeHubRunJs({ code: '1+1' }, deps);

      await tick();
      const worker = getWorker();

      worker.onErrorCallback!(new Error('Worker crashed unexpectedly'));

      const result = await promise;
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Worker crashed unexpectedly');
    });

    it('returns no-output message when result is null and no console', async () => {
      const deps = createDeps();
      const promise = executeHubRunJs({ code: 'void 0' }, deps);

      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'done',
        result: null,
        consoleOutput: [],
      });

      const result = await promise;
      expect(result.is_error).toBeUndefined();
      expect(result.content).toBe('Code executed successfully (no output)');
    });
  });

  // ---- flo.state.* calls ----

  describe('flo.state calls', () => {
    it('flo.state.get dispatches to stateStore', async () => {
      const stateStore = new HubAgentStateStore();
      stateStore.set('score', 100);
      const deps = createDeps({ stateStore });

      const promise = executeHubRunJs({ code: 'await flo.state.get("score")' }, deps);
      await tick();
      const worker = getWorker();

      // Simulate flo_call from worker
      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'state.get',
        args: ['score'],
      });

      await tick();

      // Verify postMessage was called with the result
      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        result: 100,
      });

      // Complete the execution
      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });

    it('flo.state.set dispatches to stateStore', async () => {
      const stateStore = new HubAgentStateStore();
      const deps = createDeps({ stateStore });

      const promise = executeHubRunJs({ code: 'await flo.state.set("x", 42)' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'state.set',
        args: ['x', 42],
      });

      await tick();

      expect(stateStore.get('x')).toBe(42);
      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        result: undefined,
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });

    it('flo.state.set returns error when limit exceeded', async () => {
      const stateStore = new HubAgentStateStore(undefined, { maxKeys: 1 });
      stateStore.set('existing', 'value');
      const deps = createDeps({ stateStore });

      const promise = executeHubRunJs({ code: 'await flo.state.set("new", "v")' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'state.set',
        args: ['new', 'v'],
      });

      await tick();

      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        error: expect.stringContaining('limit'),
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });

    it('flo.state.getAll dispatches to stateStore', async () => {
      const stateStore = new HubAgentStateStore();
      stateStore.set('a', 1);
      stateStore.set('b', 2);
      const deps = createDeps({ stateStore });

      const promise = executeHubRunJs({ code: 'await flo.state.getAll()' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'state.getAll',
        args: [],
      });

      await tick();

      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        result: { a: 1, b: 2 },
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });
  });

  // ---- flo.storage.* calls ----

  describe('flo.storage calls', () => {
    it('flo.storage.get dispatches to storageStore', async () => {
      const storageStore = new HubAgentStorageStore();
      storageStore.set('key1', 'value1');
      const deps = createDeps({ storageStore });

      const promise = executeHubRunJs({ code: 'await flo.storage.get("key1")' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'storage.get',
        args: ['key1'],
      });

      await tick();

      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        result: 'value1',
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });

    it('flo.storage.set dispatches to storageStore', async () => {
      const storageStore = new HubAgentStorageStore();
      const deps = createDeps({ storageStore });

      const promise = executeHubRunJs({ code: 'await flo.storage.set("k", "v")' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'storage.set',
        args: ['k', 'v'],
      });

      await tick();

      expect(storageStore.get('k')).toBe('v');

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });

    it('flo.storage.set returns error when limit exceeded', async () => {
      const storageStore = new HubAgentStorageStore(undefined, { maxKeys: 1 });
      storageStore.set('existing', 'value');
      const deps = createDeps({ storageStore });

      const promise = executeHubRunJs({ code: 'await flo.storage.set("new", "v")' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'storage.set',
        args: ['new', 'v'],
      });

      await tick();

      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        error: expect.stringContaining('limit'),
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });

    it('flo.storage.delete dispatches to storageStore', async () => {
      const storageStore = new HubAgentStorageStore();
      storageStore.set('toDelete', 'gone');
      const deps = createDeps({ storageStore });

      const promise = executeHubRunJs({ code: 'await flo.storage.delete("toDelete")' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'storage.delete',
        args: ['toDelete'],
      });

      await tick();

      expect(storageStore.get('toDelete')).toBeUndefined();

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });

    it('flo.storage.list dispatches to storageStore', async () => {
      const storageStore = new HubAgentStorageStore();
      storageStore.set('x', 1);
      storageStore.set('y', 2);
      const deps = createDeps({ storageStore });

      const promise = executeHubRunJs({ code: 'await flo.storage.list()' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'storage.list',
        args: [],
      });

      await tick();

      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        result: ['x', 'y'],
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });
  });

  // ---- flo.push ----

  describe('flo.push', () => {
    it('calls pushManager.sendPush', async () => {
      const mockPushManager = {
        sendPush: vi.fn().mockResolvedValue(undefined),
      };
      const deps = createDeps({ pushManager: mockPushManager as any });

      const promise = executeHubRunJs({ code: 'await flo.push({title: "Hi", body: "Hello"})' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'push',
        args: [{ title: 'Hi', body: 'Hello' }],
      });

      await tick();

      expect(mockPushManager.sendPush).toHaveBeenCalledWith({ title: 'Hi', body: 'Hello' });
      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        result: undefined,
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });

    it('returns error without pushManager', async () => {
      const deps = createDeps({ pushManager: undefined });

      const promise = executeHubRunJs({ code: 'await flo.push({title: "Hi"})' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'push',
        args: [{ title: 'Hi' }],
      });

      await tick();

      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        error: 'Push notifications not configured on this hub',
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });
  });

  // ---- flo.emit ----

  describe('flo.emit', () => {
    it('calls scheduler.fireEvent', async () => {
      const mockScheduler = {
        fireEvent: vi.fn(),
      };
      const deps = createDeps({ scheduler: mockScheduler as any });

      const promise = executeHubRunJs({ code: 'await flo.emit("data_ready", {count: 5})' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'emit',
        args: ['data_ready', { count: 5 }],
      });

      await tick();

      expect(mockScheduler.fireEvent).toHaveBeenCalledWith('data_ready', 'hub-test-agent', { count: 5 });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });
  });

  // ---- flo.notify ----

  describe('flo.notify', () => {
    it('queues message on runner', async () => {
      const mockRunner = {
        queueMessage: vi.fn(),
        emitRunnerEvent: vi.fn(),
      };
      const deps = createDeps({ runner: mockRunner as any });

      const promise = executeHubRunJs({ code: 'await flo.notify("check this")' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'notify',
        args: ['check this'],
      });

      await tick();

      expect(mockRunner.queueMessage).toHaveBeenCalledWith('check this');

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });
  });

  // ---- flo.notify_user ----

  describe('flo.notify_user', () => {
    it('emits runner event (push handled by event forwarding, not here)', async () => {
      const mockRunner = {
        queueMessage: vi.fn(),
        emitRunnerEvent: vi.fn(),
      };
      const mockPushManager = {
        sendPush: vi.fn().mockResolvedValue(undefined),
      };
      const deps = createDeps({
        runner: mockRunner as any,
        pushManager: mockPushManager as any,
      });

      const promise = executeHubRunJs({ code: 'await flo.notify_user("important update")' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'notify_user',
        args: ['important update'],
      });

      await tick();

      // Emits runner event — agent-handler.ts event forwarding sends push from there
      expect(mockRunner.emitRunnerEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notify_user',
          data: { message: 'important update' },
        }),
      );
      // Push is NOT sent directly here — single push path via event forwarding
      expect(mockPushManager.sendPush).not.toHaveBeenCalled();

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });
  });

  // ---- flo.callTool ----

  describe('flo.callTool', () => {
    it('dispatches tool call', async () => {
      const mockExecuteToolCall = vi.fn().mockResolvedValue({ content: 'tool result', is_error: false });
      const deps = createDeps({ executeToolCall: mockExecuteToolCall });

      const promise = executeHubRunJs({ code: 'await flo.callTool("bash", {command: "echo hi"})' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'callTool',
        args: ['bash', { command: 'echo hi' }],
      });

      await tick();

      expect(mockExecuteToolCall).toHaveBeenCalledWith('bash', { command: 'echo hi' });
      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        result: { content: 'tool result', is_error: false },
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });

    it('blocks recursive runjs calls', async () => {
      const mockExecuteToolCall = vi.fn();
      const deps = createDeps({ executeToolCall: mockExecuteToolCall });

      const promise = executeHubRunJs({ code: 'await flo.callTool("runjs", {code: "1"})' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'callTool',
        args: ['runjs', { code: '1' }],
      });

      await tick();

      expect(mockExecuteToolCall).not.toHaveBeenCalled();
      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        error: 'Recursive runjs calls are not allowed',
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });
  });

  // ---- flo.ask ----

  describe('flo.ask', () => {
    it('returns error (would deadlock)', async () => {
      const deps = createDeps();

      const promise = executeHubRunJs({ code: 'await flo.ask()' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'ask',
        args: [],
      });

      await tick();

      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        error: expect.stringContaining('deadlock'),
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });
  });

  // ---- Unknown method ----

  describe('unknown flo method', () => {
    it('returns error', async () => {
      const deps = createDeps();

      const promise = executeHubRunJs({ code: 'await flo.unknown()' }, deps);
      await tick();
      const worker = getWorker();

      worker.onMessageCallback!({
        type: 'flo_call',
        id: 'call-1',
        method: 'nonexistent',
        args: [],
      });

      await tick();

      expect(worker.postMessageSpy).toHaveBeenCalledWith({
        type: 'flo_result',
        id: 'call-1',
        error: 'Unknown flo.* method: nonexistent',
      });

      worker.onMessageCallback!({ type: 'done', result: null, consoleOutput: [] });
      await promise;
    });
  });

  // ---- Timeout ----

  describe('timeout', () => {
    it('terminates worker after 5 minutes', async () => {
      vi.useFakeTimers();
      const deps = createDeps();

      const promise = executeHubRunJs({ code: 'while(true){}' }, deps);

      // Let the MockWorker constructor run synchronously (it already has by now)
      // But we need to advance past microtasks for the on() handlers to register
      await vi.advanceTimersByTimeAsync(0);

      const worker = getWorker();
      expect(worker.terminated).toBe(false);

      // Advance past the 5 minute timeout
      await vi.advanceTimersByTimeAsync(300000);

      const result = await promise;
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('timed out');
      expect(result.content).toContain('5 minute');
      expect(worker.terminated).toBe(true);
    });
  });
});
