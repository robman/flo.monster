/**
 * Worker thread entry point for hub-side runjs execution.
 * Uses SES Compartments for sandboxing — freezes all intrinsics to prevent
 * prototype chain escapes while sharing the worker's event loop for async support.
 */

import { parentPort, workerData } from 'node:worker_threads';
import 'ses';

interface FloCallMessage {
  type: 'flo_call';
  id: string;
  method: string;
  args: unknown[];
}

interface FloResultMessage {
  type: 'flo_result';
  id: string;
  result?: unknown;
  error?: string;
}

interface DoneMessage {
  type: 'done';
  result: unknown;
  consoleOutput: string[];
}

interface ErrorMessage {
  type: 'error';
  error: string;
  consoleOutput: string[];
}

const { code, agentId } = workerData as { code: string; agentId: string };

// Freeze all intrinsics to prevent prototype chain escapes
// (e.g., this.constructor.constructor("return process")())
// Capture powered Date and Math BEFORE lockdown.
// After lockdown, the host realm keeps %InitialDate% (powered) and %InitialMath% (with random()),
// but Compartments get %SharedDate% (throws on new Date()/Date.now()) and
// %SharedMath% (throws on Math.random()). We pass the powered versions as endowments.
// Note: dateTaming/mathTaming options are deprecated in SES 1.14+ and do nothing.
const PoweredDate = Date;
const PoweredMath = Math;

lockdown({
  errorTaming: 'unsafe',       // Allow full stack traces for debugging
  consoleTaming: 'unsafe',     // We provide our own sandboxed console
  stackFiltering: 'verbose',   // Detailed stacks in errors
  overrideTaming: 'min',       // Minimal override protection
  localeTaming: 'unsafe',      // Allow .toLocaleString() etc.
});

// Track pending flo.* bridge calls
let nextCallId = 1;
const pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// Capture console output
const consoleOutput: string[] = [];

// Handle results from main thread
parentPort!.on('message', (msg: FloResultMessage) => {
  if (msg.type === 'flo_result') {
    const pending = pendingCalls.get(msg.id);
    if (pending) {
      pendingCalls.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    }
  }
});

/**
 * Call a flo.* method on the main thread and wait for the result.
 */
function callMain(method: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `call-${nextCallId++}`;
    pendingCalls.set(id, { resolve, reject });
    const msg: FloCallMessage = { type: 'flo_call', id, method, args };
    parentPort!.postMessage(msg);
  });
}

/**
 * Create the flo.* bridge object exposed to agent code.
 */
function createFloBridge() {
  return {
    agent: {
      id: agentId,
    },
    state: {
      get: (key: string) => callMain('state.get', [key]),
      set: (key: string, value: unknown) => callMain('state.set', [key, value]),
      getAll: () => callMain('state.getAll', []),
    },
    storage: {
      get: (key: string) => callMain('storage.get', [key]),
      set: (key: string, value: unknown) => callMain('storage.set', [key, value]),
      delete: (key: string) => callMain('storage.delete', [key]),
      list: () => callMain('storage.list', []),
    },
    fetch: (url: string, options?: Record<string, unknown>) => callMain('fetch', [url, options]),
    push: (payload: Record<string, unknown>) => callMain('push', [payload]),
    notify: (message: string) => callMain('notify', [message]),
    notify_user: (message: string) => callMain('notify_user', [message]),
    emit: (eventName: string, data?: unknown) => callMain('emit', [eventName, data]),
    callTool: (name: string, input: Record<string, unknown>) => callMain('callTool', [name, input]),
    ask: () => callMain('ask', []),
    log: (...args: unknown[]) => {
      consoleOutput.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    },
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
  };
}

/**
 * Create a sandboxed console that captures output.
 */
function createSandboxedConsole() {
  return {
    log: (...args: unknown[]) => {
      consoleOutput.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    },
    error: (...args: unknown[]) => {
      consoleOutput.push('[error] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    },
    warn: (...args: unknown[]) => {
      consoleOutput.push('[warn] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    },
    info: (...args: unknown[]) => {
      consoleOutput.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    },
  };
}

// Execute the agent code in a SES Compartment
(async () => {
  // Catch unhandled promise rejections from user code.
  // This handles the case where agent code is already wrapped in an async IIFE
  // like (async () => { ... })() — our wrapping creates a nested IIFE where the
  // inner rejection floats as an unhandled promise rejection instead of propagating.
  let floatingRejection: unknown = null;
  const onRejection = (reason: unknown) => { floatingRejection = reason; };
  process.on('unhandledRejection', onRejection);

  try {
    const flo = harden(createFloBridge());
    const sandboxedConsole = harden(createSandboxedConsole());

    // Provide helpful error traps for browser globals that agents commonly try to use.
    // Without these, `document.getElementById(...)` gives the cryptic
    // "Cannot read properties of undefined (reading 'getElementById')".
    // With these, it gives "document is not available in hub runjs — use flo.callTool(...)".
    const browserTrap = (name: string) => new Proxy({}, {
      get(_target, prop) {
        throw new ReferenceError(
          `${name}.${String(prop)} is not available in hub runjs (no browser). ` +
          `Use flo.callTool("dom", {action: "modify", selector: "#id", innerHTML: "..."}) to update the DOM.`
        );
      },
    });

    // Create a SES Compartment with flo.* bridge, console, and timer globals.
    // SES provides safe intrinsics (Promise, JSON, Math, Date, etc.) automatically
    // with all prototypes frozen — no constructor.constructor escape possible.
    const compartment = new Compartment({
      flo,
      console: sandboxedConsole,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date: PoweredDate,
      Math: PoweredMath,
      document: browserTrap('document'),
      window: browserTrap('window'),
    });

    // Wrap in async IIFE so agent code can use top-level await.
    // The Compartment shares the worker's event loop, so Promises resolve normally.
    const wrappedCode = `(async () => { ${code} })()`;
    const result = await compartment.evaluate(wrappedCode);

    // Wait a tick to catch floating promise rejections from double-wrapped IIFEs
    await new Promise(r => setTimeout(r, 0));

    if (floatingRejection) {
      throw floatingRejection;
    }

    const msg: DoneMessage = {
      type: 'done',
      result: result !== undefined ? result : null,
      consoleOutput,
    };
    parentPort!.postMessage(msg);
  } catch (err) {
    const msg: ErrorMessage = {
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
      consoleOutput,
    };
    parentPort!.postMessage(msg);
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }
})();
