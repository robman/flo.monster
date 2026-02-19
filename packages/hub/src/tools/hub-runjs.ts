/**
 * Hub-side runjs tool executor.
 * Spawns a worker thread with a SES Compartment sandbox, handles flo.* bridge calls
 * by dispatching to hub services, enforces 5 minute timeout.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { appendFile, stat, writeFile } from 'node:fs/promises';
import type { HubAgentStateStore } from './hub-state.js';
import type { HubAgentStorageStore } from './hub-storage.js';
import type { PushManager } from '../push-manager.js';
import type { Scheduler } from '../scheduler.js';
import type { HeadlessAgentRunner } from '../agent-runner.js';
import type { HubConfig } from '../config.js';
import type { ToolDef, ToolResult } from './index.js';
import { executeSafeFetch } from '../utils/safe-fetch.js';

export interface HubRunJsDeps {
  agentId: string;
  stateStore: HubAgentStateStore;
  storageStore: HubAgentStorageStore;
  pushManager?: PushManager;
  scheduler?: Scheduler;
  hubConfig: HubConfig;
  runner?: HeadlessAgentRunner;
  executeToolCall?: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  agentDataDir?: string;
}

/** Maximum runjs log file size (1MB) */
const MAX_LOG_SIZE = 1024 * 1024;

export interface RunJsLogEntry {
  ts: number;
  code: string;      // truncated to 200 chars
  result?: unknown;
  error?: string;
  consoleOutput: string[];
  durationMs: number;
}

async function logRunJsExecution(agentDataDir: string, entry: RunJsLogEntry): Promise<void> {
  const logPath = join(agentDataDir, 'runjs.log');
  try {
    // Check file size — truncate if over 1MB
    try {
      const stats = await stat(logPath);
      if (stats.size > MAX_LOG_SIZE) {
        // Overwrite with just this entry (simple rotation)
        await writeFile(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
        return;
      }
    } catch {
      // File doesn't exist yet — that's fine
    }
    await appendFile(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    // Logging failure should never break execution
  }
}

export const hubRunJsToolDef: ToolDef = {
  name: 'runjs',
  description: 'Execute JavaScript code on the hub server (runs even when browser is closed). ' +
    'Code runs in a sandboxed VM with access to flo.* API: ' +
    'flo.state.get/set/getAll, flo.storage.get/set/delete/list, ' +
    'flo.fetch(url, options), flo.push({title, body}), flo.notify(message), ' +
    'flo.notify_user(message), flo.emit(eventName, data), flo.callTool(name, input), ' +
    'flo.sleep(ms), flo.agent.id, flo.log(...args). ' +
    'setTimeout/setInterval are also available. ' +
    'IMPORTANT: This runs on the server, NOT in a browser. ' +
    'document, window, and all browser APIs are NOT available and will throw ReferenceError. ' +
    'To update the DOM, use flo.callTool("dom", {action: "modify", selector: "#id", innerHTML: "..."}). ' +
    'No Node.js builtins (require, process, fs) are available. ' +
    'Returns the result of the last expression and any console output.',
  input_schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript code to execute' },
      context: {
        type: 'string',
        enum: ['worker', 'iframe'],
        description: 'Execution context. "worker" (default) runs on hub, "iframe" is not supported on the hub.',
      },
    },
    required: ['code'] as const,
  },
};

interface FloCallMessage {
  type: 'flo_call';
  id: string;
  method: string;
  args: unknown[];
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

type WorkerMessage = FloCallMessage | DoneMessage | ErrorMessage;

/** Default timeout for runjs execution (5 minutes) */
const RUNJS_TIMEOUT_MS = 300000;

/**
 * Handle a flo.* bridge call from the worker thread.
 */
async function handleFloCall(
  method: string,
  args: unknown[],
  deps: HubRunJsDeps,
): Promise<unknown> {
  switch (method) {
    case 'state.get':
      return deps.stateStore.get(args[0] as string);

    case 'state.set': {
      const stateResult = deps.stateStore.set(args[0] as string, args[1]);
      if (stateResult.error) {
        throw new Error(stateResult.error);
      }
      return undefined;
    }

    case 'state.getAll':
      return deps.stateStore.getAll();

    case 'storage.get':
      return deps.storageStore.get(args[0] as string);

    case 'storage.set': {
      const storageResult = deps.storageStore.set(args[0] as string, args[1]);
      if (storageResult.error) {
        throw new Error(storageResult.error);
      }
      return undefined;
    }

    case 'storage.delete':
      deps.storageStore.delete(args[0] as string);
      return undefined;

    case 'storage.list':
      return deps.storageStore.list();

    case 'fetch': {
      const url = args[0] as string;
      const options = (args[1] as Record<string, unknown>) || {};
      const result = await executeSafeFetch(url, {
        method: options.method as string | undefined,
        headers: options.headers as Record<string, string> | undefined,
        body: options.body as string | undefined,
        blockedPatterns: deps.hubConfig.fetchProxy?.blockedPatterns,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      return { status: result.status, body: result.body };
    }

    case 'push':
      if (!deps.pushManager) {
        throw new Error('Push notifications not configured on this hub');
      }
      await deps.pushManager.sendPush(args[0] as { title: string; body: string; tag?: string; agentId?: string });
      return undefined;

    case 'notify':
      if (!deps.runner) {
        throw new Error('Runner not available for notify');
      }
      // Queue a message for after the current loop
      deps.runner.queueMessage(args[0] as string);
      return undefined;

    case 'notify_user': {
      const message = args[0] as string;
      // Emit a runner event — the event forwarding in agent-handler.ts
      // picks this up and sends the push notification (single path, no duplicates)
      if (deps.runner) {
        deps.runner.emitRunnerEvent({ type: 'notify_user', timestamp: Date.now(), data: { message } });
      }
      return undefined;
    }

    case 'emit':
      if (!deps.scheduler) {
        throw new Error('Scheduler not available');
      }
      deps.scheduler.fireEvent(args[0] as string, deps.agentId, args[1]);
      return undefined;

    case 'callTool': {
      const toolName = args[0] as string;
      if (toolName === 'runjs') {
        throw new Error('Recursive runjs calls are not allowed');
      }
      if (!deps.executeToolCall) {
        throw new Error('Tool execution not available');
      }
      return deps.executeToolCall(toolName, args[1] as Record<string, unknown>);
    }

    case 'ask':
      throw new Error('flo.ask() is not available during runjs execution — would deadlock the agentic loop');

    default:
      throw new Error(`Unknown flo.* method: ${method}`);
  }
}

/**
 * Format the runjs result for output.
 */
function formatResult(result: unknown, consoleOutput: string[]): string {
  const parts: string[] = [];

  if (consoleOutput.length > 0) {
    parts.push('Console output:\n' + consoleOutput.join('\n'));
  }

  if (result !== null && result !== undefined) {
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    parts.push('Result: ' + resultStr);
  }

  return parts.length > 0 ? parts.join('\n\n') : 'Code executed successfully (no output)';
}

/**
 * Get the path to the compiled worker script.
 */
function getWorkerPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const jsPath = join(currentDir, 'runjs-worker.js');
  if (existsSync(jsPath)) return jsPath;
  // Development: tsx handles .ts files via inherited --import loader
  return join(currentDir, 'runjs-worker.ts');
}

/**
 * Execute JavaScript code on the hub in a sandboxed worker thread.
 */
export async function executeHubRunJs(
  input: { code: string; context?: string },
  deps: HubRunJsDeps,
): Promise<ToolResult> {
  const startTime = Date.now();

  // Fallback: if context:"iframe" reaches hub execution (no browser connected, or
  // scheduled task with baked-in context), run as worker instead of failing.
  // The router in runner-tool-executor.ts prefers routing context:"iframe" to the
  // browser when one is available.
  if (input.context === 'iframe') {
    input = { ...input, context: 'worker' };
  }

  const result = await new Promise<ToolResult>((resolve) => {
    const workerPath = getWorkerPath();

    let worker: Worker;
    try {
      worker = new Worker(workerPath, {
        workerData: { code: input.code, agentId: deps.agentId },
      });
    } catch (err) {
      resolve({
        content: `Failed to start runjs worker: ${(err as Error).message}`,
        is_error: true,
      });
      return;
    }

    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        worker.terminate();
        resolve({
          content: 'runjs execution timed out (5 minute limit)',
          is_error: true,
        });
      }
    }, RUNJS_TIMEOUT_MS);

    worker.on('message', async (msg: WorkerMessage) => {
      if (msg.type === 'flo_call') {
        try {
          const callResult = await handleFloCall(msg.method, msg.args, deps);
          worker.postMessage({ type: 'flo_result', id: msg.id, result: callResult });
        } catch (err) {
          worker.postMessage({ type: 'flo_result', id: msg.id, error: (err as Error).message });
        }
        return;
      }

      if (msg.type === 'done') {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          worker.terminate();
          resolve({ content: formatResult(msg.result, msg.consoleOutput) });
        }
        return;
      }

      if (msg.type === 'error') {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          worker.terminate();
          const parts: string[] = [];
          if (msg.consoleOutput.length > 0) {
            parts.push('Console output:\n' + msg.consoleOutput.join('\n'));
          }
          parts.push('Error: ' + msg.error);
          resolve({
            content: parts.join('\n\n'),
            is_error: true,
          });
        }
        return;
      }
    });

    worker.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          content: `runjs worker error: ${err.message}`,
          is_error: true,
        });
      }
    });
  });

  // Log execution if agent data dir is configured
  if (deps.agentDataDir) {
    const entry: RunJsLogEntry = {
      ts: startTime,
      code: input.code.length > 200 ? input.code.slice(0, 200) + '...' : input.code,
      consoleOutput: [],
      durationMs: Date.now() - startTime,
    };
    if (result.is_error) {
      entry.error = result.content;
    } else {
      entry.result = result.content;
    }
    void logRunJsExecution(deps.agentDataDir, entry);
  }

  return result;
}
