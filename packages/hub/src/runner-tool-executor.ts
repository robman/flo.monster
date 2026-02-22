/**
 * Centralized tool execution for hub agent runners.
 * Routes tool calls to hub-local tools or returns errors for browser-only tools.
 */

import type { AgentConfig } from '@flo-monster/core';
import type { HubConfig } from './config.js';
import type { HookExecutor } from './hook-executor.js';
import type { HubSkillManager } from './skill-manager.js';
import type { BrowserToolRouter } from './browser-tool-router.js';
import type { DeclarativeHookEvaluator } from './declarative-hook-evaluator.js';
import { getHubCapabilities } from './capabilities.js';
import { executeTool, type ToolInput, type ToolResult, type SkillApprovalFn } from './tools/index.js';
import { HubAgentStateStore, executeHubState } from './tools/hub-state.js';
import { HubAgentStorageStore, executeHubStorage } from './tools/hub-storage.js';
import { executeHubFiles, type HubFilesInput } from './tools/hub-files.js';
import { executeHubDom } from './tools/hub-dom.js';
import type { HubDomContainer } from './dom-container.js';
import { executeScheduleTool, type ScheduleToolInput } from './tools/schedule.js';
import { executeHubContextSearch } from './tools/context-search.js';
import { executeHubRunJs, type HubRunJsDeps } from './tools/hub-runjs.js';
import type { Scheduler } from './scheduler.js';
import type { PushManager } from './push-manager.js';
import type { HeadlessAgentRunner } from './agent-runner.js';
import type { ContentBlock } from '@flo-monster/core';

export type { ToolResult } from './tools/index.js';

/** Tools that only work in the browser (sandboxed iframe) */
const BROWSER_ONLY_TOOLS = new Set([
  'view_state',
  'audit_log',
  'agent_respond',
  'worker_message',
]);

/** Tools available on the hub server */
const HUB_TOOLS = new Set([
  'bash',
  'filesystem',
  'list_skills',
  'load_skill',
  'context_search',
  'schedule',
]);

export interface RunnerToolExecutorDeps {
  hubConfig: HubConfig;
  hookExecutor?: HookExecutor;
  skillManager?: HubSkillManager;
  requestSkillApproval?: SkillApprovalFn;
  browserToolRouter?: BrowserToolRouter;
  hubAgentId?: string;
  agentConfig?: AgentConfig;
  stateStore?: HubAgentStateStore;
  storageStore?: HubAgentStorageStore;
  filesRoot?: string;
  domContainer?: HubDomContainer;
  scheduler?: Scheduler;
  agentSandbox?: string;
  getMessages?: () => Array<{ role: string; content: ContentBlock[]; turnId?: string }>;
  declarativeHookEvaluator?: DeclarativeHookEvaluator;
  pushManager?: PushManager;
  runner?: HeadlessAgentRunner;
  agentDataDir?: string;
  onFileChange?: (path: string, content: string | undefined, action: 'write' | 'delete') => void;
}

/**
 * Create a tool executor function for use in LoopDeps.executeToolCall.
 */
export function createToolExecutor(deps: RunnerToolExecutorDeps): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
  return async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    return executeRunnerToolCall(name, input, deps);
  };
}

/**
 * Execute a tool call for a hub agent runner.
 */
async function executeRunnerToolCall(
  name: string,
  input: Record<string, unknown>,
  deps: RunnerToolExecutorDeps,
): Promise<ToolResult> {
  // Hub-side capabilities handler
  if (name === 'capabilities') {
    if (deps.agentConfig && deps.hubAgentId) {
      const result = getHubCapabilities(deps.agentConfig, deps.hubAgentId, deps.browserToolRouter, {
        hasStateStore: !!deps.stateStore,
        hasFilesRoot: !!deps.filesRoot,
        hasDomContainer: !!deps.domContainer,
        hasScheduler: !!deps.scheduler,
      });
      return { content: JSON.stringify(result, null, 2) };
    }
    // Fallback to browser routing if no config
    if (deps.browserToolRouter && deps.hubAgentId) {
      return deps.browserToolRouter.routeToBrowser(deps.hubAgentId, name, input);
    }
    return {
      content: 'Capabilities information unavailable on hub',
      is_error: true,
    };
  }

  // Hub-side state store: execute locally if available, else route to browser
  if (name === 'state') {
    if (deps.stateStore) {
      return executeHubState(input as { action: string; key?: string; value?: unknown; condition?: string; message?: string }, deps.stateStore);
    }
    // Fall through to browser routing if no state store
    if (deps.browserToolRouter && deps.hubAgentId) {
      return deps.browserToolRouter.routeToBrowser(deps.hubAgentId, name, input);
    }
    return {
      content: 'Tool "state" requires either a hub state store or a connected browser.',
      is_error: true,
    };
  }

  // Hub-side files: execute locally if available, else route to browser
  if (name === 'files') {
    if (deps.filesRoot) {
      const result = await executeHubFiles(input as unknown as HubFilesInput, deps.filesRoot);
      if (!result.is_error && deps.onFileChange) {
        const fileInput = input as unknown as HubFilesInput;
        if (fileInput.action === 'write_file' && fileInput.path) {
          deps.onFileChange(fileInput.path, fileInput.content, 'write');
        } else if (fileInput.action === 'delete_file' && fileInput.path) {
          deps.onFileChange(fileInput.path, undefined, 'delete');
        }
      }
      return result;
    }
    if (deps.browserToolRouter && deps.hubAgentId) {
      return deps.browserToolRouter.routeToBrowser(deps.hubAgentId, name, input);
    }
    return {
      content: 'Tool "files" requires either a hub files root or a connected browser.',
      is_error: true,
    };
  }

  // Hub-side DOM: prefer browser if connected, else use hub container for structural ops
  if (name === 'dom') {
    // If browser is connected, route all DOM ops there (real rendering)
    if (deps.browserToolRouter && deps.hubAgentId && deps.browserToolRouter.isAvailable(deps.hubAgentId)) {
      return deps.browserToolRouter.routeToBrowser(deps.hubAgentId, name, input);
    }
    // No browser — use hub container for structural ops
    if (deps.domContainer) {
      return executeHubDom(input as any, deps.domContainer);
    }
    return {
      content: 'Tool "dom" requires either a connected browser or a hub DOM container.',
      is_error: true,
    };
  }

  // Hub-side schedule tool
  if (name === 'schedule') {
    if (deps.scheduler && deps.hubAgentId) {
      return executeScheduleTool(input as unknown as ScheduleToolInput, deps.hubAgentId, deps.scheduler);
    }
    return {
      content: 'Schedule tool requires a hub scheduler. This tool is only available for hub agents.',
      is_error: true,
    };
  }

  // Hub-side storage: execute locally if available, else route to browser
  if (name === 'storage') {
    if (deps.storageStore) {
      return executeHubStorage(input as { action: string; key?: string; value?: unknown }, deps.storageStore);
    }
    // Fall through to browser routing if no storage store
    if (deps.browserToolRouter && deps.hubAgentId) {
      return deps.browserToolRouter.routeToBrowser(deps.hubAgentId, name, input);
    }
    return {
      content: 'Tool "storage" requires either a hub storage store or a connected browser.',
      is_error: true,
    };
  }

  // Hub-side runjs: route context:"iframe" to browser if available, else execute locally
  if (name === 'runjs') {
    const runJsInput = input as { code: string; context?: string };

    // context:"iframe" requires a real browser (DOM APIs, document, etc.)
    if (runJsInput.context === 'iframe' && deps.browserToolRouter && deps.hubAgentId
        && deps.browserToolRouter.isAvailable(deps.hubAgentId)) {
      return deps.browserToolRouter.routeToBrowser(deps.hubAgentId, name, input);
    }

    if (deps.stateStore && deps.storageStore && deps.hubAgentId) {
      // Create a reference to the executor for flo.callTool() support
      const executor = createToolExecutor(deps);
      const runJsDeps: HubRunJsDeps = {
        agentId: deps.hubAgentId,
        stateStore: deps.stateStore,
        storageStore: deps.storageStore,
        pushManager: deps.pushManager,
        scheduler: deps.scheduler,
        hubConfig: deps.hubConfig,
        runner: deps.runner,
        executeToolCall: executor,
        agentDataDir: deps.agentDataDir,
      };
      return executeHubRunJs(runJsInput, runJsDeps);
    }
    // Fall through to browser routing if no hub deps
    if (deps.browserToolRouter && deps.hubAgentId) {
      return deps.browserToolRouter.routeToBrowser(deps.hubAgentId, name, input);
    }
    return {
      content: 'Tool "runjs" requires either hub state/storage stores or a connected browser.',
      is_error: true,
    };
  }

  // Browser-only tools: route through connected browser if available
  if (BROWSER_ONLY_TOOLS.has(name)) {
    if (deps.browserToolRouter && deps.hubAgentId) {
      return deps.browserToolRouter.routeToBrowser(deps.hubAgentId, name, input);
    }
    return {
      content: `Tool "${name}" is a browser-only tool and is not available on the hub server. This tool requires a connected browser with a sandboxed iframe.`,
      is_error: true,
    };
  }

  // Hub-side context_search: search agent's message history directly
  if (name === 'context_search') {
    if (deps.getMessages) {
      return executeHubContextSearch(input, deps.getMessages() as Array<Record<string, unknown>>);
    }
    // Fallback to browser if no getMessages
    if (deps.browserToolRouter && deps.hubAgentId) {
      return deps.browserToolRouter.routeToBrowser(deps.hubAgentId, name, input);
    }
    return {
      content: 'Tool "context_search" requires message history or a connected browser.',
      is_error: true,
    };
  }

  // Per-agent bash sandbox: override sandbox path for hub-persisted agents
  if (name === 'bash' && deps.agentSandbox) {
    const sandboxedConfig: HubConfig = {
      ...deps.hubConfig,
      sandboxPath: deps.agentSandbox,
    };
    try {
      return await executeTool(
        name,
        input as ToolInput,
        sandboxedConfig,
        deps.hookExecutor,
        deps.skillManager,
        deps.requestSkillApproval,
        deps.hubAgentId,
        deps.declarativeHookEvaluator,
      );
    } catch (err) {
      return {
        content: `Tool execution error: ${(err as Error).message}`,
        is_error: true,
      };
    }
  }

  // Route to hub tools
  try {
    return await executeTool(
      name,
      input as ToolInput,
      deps.hubConfig,
      deps.hookExecutor,
      deps.skillManager,
      deps.requestSkillApproval,
      deps.hubAgentId,
      deps.declarativeHookEvaluator,
    );
  } catch (err) {
    return {
      content: `Tool execution error: ${(err as Error).message}`,
      is_error: true,
    };
  }
}

/**
 * Check if a tool name is a browser-only tool.
 */
export function isBrowserOnlyTool(name: string): boolean {
  return BROWSER_ONLY_TOOLS.has(name);
}

/**
 * Check if a tool name is a hub tool.
 */
export function isHubTool(name: string): boolean {
  return HUB_TOOLS.has(name);
}
