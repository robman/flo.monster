/**
 * Schedule tool — allows agents to create/manage cron jobs and event triggers.
 */

import type { Scheduler } from '../scheduler.js';
import type { ToolDef, ToolResult } from './index.js';

export interface ScheduleToolInput {
  action: 'add' | 'remove' | 'list' | 'enable' | 'disable';
  type?: 'cron' | 'event';
  cron?: string;            // cron expression
  event?: string;           // event name (e.g., "state:score", "browser:connected")
  condition?: string;       // for event triggers (e.g., "> 100", "changed")
  message?: string;         // message to send on trigger (wakes agent)
  tool?: string;            // tool to execute directly (no agent wakeup)
  toolInput?: Record<string, unknown>;  // input for direct tool execution
  maxRuns?: number;
  id?: string;              // for remove/enable/disable
}

export const scheduleToolDef: ToolDef = {
  name: 'schedule',
  description: 'Schedule cron jobs and event triggers for autonomous execution. ' +
    'Actions: add (create schedule), remove (delete by id), list (show all), enable/disable (toggle). ' +
    'Types: cron (periodic, e.g. "*/5 * * * *" = every 5 min), event (reactive, e.g. "state:score" with condition "> 100"). ' +
    'Two trigger modes: "message" wakes the agent with a user message, "tool" executes a tool directly without waking the agent. ' +
    'Specify exactly one of message or tool. ' +
    'Max 10 schedules per agent, minimum 1-minute cron interval.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'remove', 'list', 'enable', 'disable'],
        description: 'The schedule action to perform',
      },
      type: {
        type: 'string',
        enum: ['cron', 'event'],
        description: 'Schedule type (required for add)',
      },
      cron: {
        type: 'string',
        description: 'Cron expression: "minute hour day month weekday". Supports *, */N, N, N-M, N,M. Example: "*/5 * * * *" (every 5 min)',
      },
      event: {
        type: 'string',
        description: 'Event name to listen for. Examples: "state:score", "browser:connected", "browser:disconnected"',
      },
      condition: {
        type: 'string',
        description: 'Condition for event triggers. Examples: "> 100", ">= 50", "< 5", "<= 10", "== done", "!= failed", "changed", "always"',
      },
      message: {
        type: 'string',
        description: 'Message sent to agent when triggered — wakes the agent for an LLM loop. Use this OR tool, not both.',
      },
      tool: {
        type: 'string',
        description: 'Tool name to execute directly when triggered — no LLM loop. E.g. "runjs" to run code directly. Use this OR message, not both.',
      },
      toolInput: {
        type: 'object',
        description: 'Input for the tool when using direct tool execution. E.g. { "code": "flo.push({title: \\"Reminder\\", body: \\"Check tasks\\"})" }',
      },
      maxRuns: {
        type: 'number',
        description: 'Maximum number of times to trigger (optional, unlimited if not set)',
      },
      id: {
        type: 'string',
        description: 'Schedule ID (required for remove/enable/disable)',
      },
    },
    required: ['action'] as const,
  },
};

export function executeScheduleTool(
  input: ScheduleToolInput,
  hubAgentId: string,
  scheduler: Scheduler,
): ToolResult {
  try {
    switch (input.action) {
      case 'add': {
        if (!input.type) {
          return { content: 'Missing required parameter: type (cron or event)', is_error: true };
        }
        if (!input.message && !input.tool) {
          return { content: 'Missing required parameter: message or tool', is_error: true };
        }
        if (input.message && input.tool) {
          return { content: 'Cannot specify both message and tool — use one or the other', is_error: true };
        }
        if (input.tool && !input.toolInput) {
          return { content: `toolInput is required when tool is specified — provide the tool's input parameters as a JSON object. For example: tool: "runjs", toolInput: { "code": "your code here" }`, is_error: true };
        }

        const id = scheduler.addSchedule({
          hubAgentId,
          type: input.type,
          cronExpression: input.cron,
          eventName: input.event,
          eventCondition: input.condition,
          message: input.message,
          tool: input.tool,
          toolInput: input.toolInput,
          maxRuns: input.maxRuns,
        });

        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const response: Record<string, unknown> = {
          success: true,
          id,
          type: input.type,
          ...(input.cron ? { cron: input.cron } : {}),
          ...(input.event ? { event: input.event } : {}),
          ...(input.tool ? { tool: input.tool } : {}),
          ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
          timezone: tz,
        };
        if (input.cron) {
          response.note = `Cron will run in the server's local timezone (${tz}). Verify the cron expression matches the user's intended time in this timezone.`;
        }
        return { content: JSON.stringify(response) };
      }

      case 'remove': {
        if (!input.id) {
          return { content: 'Missing required parameter: id', is_error: true };
        }
        const removed = scheduler.removeSchedule(hubAgentId, input.id);
        if (!removed) {
          return { content: `Schedule not found: ${input.id}`, is_error: true };
        }
        return { content: JSON.stringify({ success: true, removedId: input.id }) };
      }

      case 'list': {
        const schedules = scheduler.getSchedules(hubAgentId);
        return {
          content: JSON.stringify({
            count: schedules.length,
            schedules: schedules.map(s => ({
              id: s.id,
              type: s.type,
              enabled: s.enabled,
              ...(s.cronExpression ? { cron: s.cronExpression } : {}),
              ...(s.eventName ? { event: s.eventName } : {}),
              ...(s.eventCondition ? { condition: s.eventCondition } : {}),
              ...(s.message ? { message: s.message } : {}),
              ...(s.tool ? { tool: s.tool } : {}),
              ...(s.toolInput ? { toolInput: s.toolInput } : {}),
              runCount: s.runCount,
              ...(s.maxRuns !== undefined ? { maxRuns: s.maxRuns } : {}),
              ...(s.lastRunAt ? { lastRunAt: s.lastRunAt } : {}),
            })),
          }),
        };
      }

      case 'enable': {
        if (!input.id) {
          return { content: 'Missing required parameter: id', is_error: true };
        }
        const okEnable = scheduler.enableSchedule(hubAgentId, input.id);
        if (!okEnable) {
          return { content: `Schedule not found: ${input.id}`, is_error: true };
        }
        return { content: JSON.stringify({ success: true, id: input.id, enabled: true }) };
      }

      case 'disable': {
        if (!input.id) {
          return { content: 'Missing required parameter: id', is_error: true };
        }
        const okDisable = scheduler.disableSchedule(hubAgentId, input.id);
        if (!okDisable) {
          return { content: `Schedule not found: ${input.id}`, is_error: true };
        }
        return { content: JSON.stringify({ success: true, id: input.id, enabled: false }) };
      }

      default:
        return { content: `Unknown schedule action: ${(input as any).action}`, is_error: true };
    }
  } catch (err) {
    return { content: `Schedule error: ${(err as Error).message}`, is_error: true };
  }
}
