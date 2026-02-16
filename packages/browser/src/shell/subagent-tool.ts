import type { ToolPlugin, ToolResult, AgentConfig } from '@flo-monster/core';
import type { AgentManager } from './agent-manager.js';
import type { MessageRelay } from './message-relay.js';
import type { HookManager } from './hook-manager.js';

export const MAX_DEPTH = 3;

export const agentDepthMap = new Map<string, number>();

interface SubagentToolDeps {
  agentManager: AgentManager;
  messageRelay: MessageRelay;
  hookManager: HookManager;
  workerCode: string;
}

function extractLastAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.role === 'assistant') {
      const content = msg.content;
      if (typeof content === 'string') {
        return content;
      }
      if (Array.isArray(content)) {
        for (let j = content.length - 1; j >= 0; j--) {
          const block = content[j] as Record<string, unknown>;
          if (block.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
        }
      }
    }
  }
  return null;
}

export function createSubagentToolPlugin(deps: SubagentToolDeps): ToolPlugin {
  return {
    definition: {
      name: 'subagent',
      description:
        'Spawn an autonomous subagent to handle a subtask. The subagent shares your DOM and can create/modify UI elements. It has its own conversation context and returns its final text response when complete. Use for: complex subtasks, parallel work, specialized operations.',
      input_schema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The task for the subagent to perform',
          },
          systemPrompt: {
            type: 'string',
            description: 'Optional custom system prompt for the subagent',
          },
          maxTokensPerSubagent: {
            type: 'number',
            description: 'Optional token budget for this subagent (limits total tokens used)',
          },
          maxCostPerSubagent: {
            type: 'number',
            description: 'Optional cost budget in USD for this subagent',
          },
        },
        required: ['task'],
      },
    },

    async execute(input, context): Promise<ToolResult> {
      if (typeof input.task !== 'string' || input.task.trim() === '') {
        return {
          content: 'Error: task must be a non-empty string',
          is_error: true,
        };
      }

      const parentDepth = agentDepthMap.get(context.agentId) ?? 0;
      if (parentDepth >= MAX_DEPTH) {
        return {
          content: `Error: maximum subagent depth of ${MAX_DEPTH} reached`,
          is_error: true,
        };
      }

      // Get the parent agent to spawn subworker in its iframe
      const parentAgent = deps.agentManager.getAgent(context.agentId);
      if (!parentAgent) {
        return {
          content: 'Error: parent agent not found',
          is_error: true,
        };
      }

      // Generate unique subworker ID
      const subworkerId = `sub-${crypto.randomUUID()}`;
      const subName = `${context.agentConfig.name} > ${subworkerId}`;

      // Build subworker config
      const systemPrompt =
        typeof input.systemPrompt === 'string'
          ? input.systemPrompt
          : context.agentConfig.systemPrompt;

      // Apply per-subagent limits if provided
      const tokenBudget =
        typeof input.maxTokensPerSubagent === 'number'
          ? input.maxTokensPerSubagent
          : context.agentConfig.tokenBudget;
      const costBudgetUsd =
        typeof input.maxCostPerSubagent === 'number'
          ? input.maxCostPerSubagent
          : context.agentConfig.costBudgetUsd;

      const subConfig: AgentConfig = {
        id: subworkerId,
        name: subName,
        model: context.agentConfig.model,
        systemPrompt,
        tools: context.agentConfig.tools,
        maxTokens: context.agentConfig.maxTokens,
        tokenBudget,
        costBudgetUsd,
        networkPolicy: context.agentConfig.networkPolicy,
      };

      let subworkerState = 'pending';
      let eventUnsubscribe: (() => void) | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanupListeners = () => {
        if (eventUnsubscribe) {
          eventUnsubscribe();
          eventUnsubscribe = null;
        }
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      try {
        // Track depth
        agentDepthMap.set(subworkerId, parentDepth + 1);

        // Initialize storage for subworker conversation context
        await deps.messageRelay.initAgentStorage(subworkerId);
        // Spawn subworker in parent's iframe (shares DOM!)
        parentAgent.spawnSubworker(subworkerId, subConfig, deps.workerCode);

        // Send hooks config to subworker
        parentAgent.sendSubworkerHooksConfig(
          subworkerId,
          deps.hookManager.getHooksConfig().activeHookTypes,
        );

        // Wait for subworker to complete
        const completionPromise = new Promise<void>((resolve, reject) => {
          const terminalStates = new Set(['error', 'stopped', 'killed']);

          timeoutId = setTimeout(() => {
            timeoutId = null;
            reject(new Error('Subagent timed out after 5 minutes'));
          }, 300_000);

          eventUnsubscribe = parentAgent.onEvent((event) => {
            // Filter for events from our subworker
            const eventWorkerId = (event as any).workerId;
            if (eventWorkerId !== subworkerId) return;

            if (event.type === 'state_change') {
              subworkerState = event.to;
              if (terminalStates.has(event.to)) {
                cleanupListeners();
                resolve();
              }
            }
            if (event.type === 'loop_complete') {
              cleanupListeners();
              resolve();
            }
          });
        });

        // Send task to subworker
        parentAgent.sendUserMessage(input.task as string, subworkerId);

        // Wait for completion
        try {
          await completionPromise;
        } catch {
          // Timeout - clean up
          cleanupListeners();
          parentAgent.killSubworker(subworkerId);
          agentDepthMap.delete(subworkerId);
          return {
            content: 'Error: Subagent timed out after 5 minutes',
            is_error: true,
          };
        }

        // Load conversation context for subworker
        const messages = await deps.messageRelay.loadConversationContext(subworkerId);
        const lastText = extractLastAssistantText(messages);

        // Clean up subworker
        parentAgent.killSubworker(subworkerId);
        agentDepthMap.delete(subworkerId);

        if (subworkerState === 'error') {
          return {
            content: 'Subagent encountered an error',
            is_error: true,
          };
        }

        if (lastText === null) {
          return {
            content: '(Subagent completed but produced no text response)',
          };
        }

        return {
          content: lastText,
        };
      } catch (err) {
        // Clean up on error
        cleanupListeners();
        parentAgent.killSubworker(subworkerId);
        agentDepthMap.delete(subworkerId);
        return {
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }
    },
  };
}
