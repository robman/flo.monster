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
  message?: string;         // message to send on trigger
  maxRuns?: number;
  id?: string;              // for remove/enable/disable
}

export const scheduleToolDef: ToolDef = {
  name: 'schedule',
  description: 'Schedule cron jobs and event triggers for autonomous execution. ' +
    'Actions: add (create schedule), remove (delete by id), list (show all), enable/disable (toggle). ' +
    'Types: cron (periodic, e.g. "*/5 * * * *" = every 5 min), event (reactive, e.g. "state:score" with condition "> 100"). ' +
    'When triggered, the agent receives the specified message as if sent by a user. ' +
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
        description: 'Condition for event triggers. Examples: "> 100", "< 5", "== done", "changed", "always", or JS expression',
      },
      message: {
        type: 'string',
        description: 'Message sent to agent when triggered (required for add)',
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
        if (!input.message) {
          return { content: 'Missing required parameter: message', is_error: true };
        }

        const id = scheduler.addSchedule({
          hubAgentId,
          type: input.type,
          cronExpression: input.cron,
          eventName: input.event,
          eventCondition: input.condition,
          message: input.message,
          maxRuns: input.maxRuns,
        });

        return {
          content: JSON.stringify({
            success: true,
            id,
            type: input.type,
            ...(input.cron ? { cron: input.cron } : {}),
            ...(input.event ? { event: input.event } : {}),
            ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
          }),
        };
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
              message: s.message,
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
