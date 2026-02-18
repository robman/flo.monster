import { describe, it, expect, vi } from 'vitest';
import { executeScheduleTool, type ScheduleToolInput } from '../tools/schedule.js';
import { Scheduler, type SchedulerDeps } from '../scheduler.js';

function createScheduler(): Scheduler {
  const deps: SchedulerDeps = { getRunner: vi.fn() };
  return new Scheduler(deps);
}

describe('schedule tool', () => {
  describe('add action', () => {
    it('adds a cron schedule', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'add', type: 'cron', cron: '*/5 * * * *', message: 'Check status' },
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.success).toBe(true);
      expect(parsed.id).toMatch(/^sched-/);
      expect(parsed.type).toBe('cron');
      expect(parsed.cron).toBe('*/5 * * * *');
    });

    it('adds an event schedule', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'add', type: 'event', event: 'state:score', condition: '> 100', message: 'High score alert' },
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.success).toBe(true);
      expect(parsed.event).toBe('state:score');
    });

    it('returns error when type is missing', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'add', message: 'test' } as ScheduleToolInput,
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('type');
    });

    it('returns error when neither message nor tool is provided', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'add', type: 'cron', cron: '* * * * *' } as ScheduleToolInput,
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('message or tool');
    });

    it('add action with tool and toolInput succeeds', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool({
        action: 'add',
        type: 'cron',
        cron: '*/5 * * * *',
        tool: 'runjs',
        toolInput: { code: 'flo.push({title: "Test", body: "msg"})' },
      }, 'agent-1', scheduler);

      expect(result.is_error).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.success).toBe(true);
      expect(parsed.tool).toBe('runjs');
    });

    it('add action with both message and tool returns error', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool({
        action: 'add',
        type: 'cron',
        cron: '*/5 * * * *',
        message: 'check stuff',
        tool: 'runjs',
      }, 'agent-1', scheduler);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Cannot specify both message and tool');
    });

    it('add action with neither message nor tool returns error', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool({
        action: 'add',
        type: 'cron',
        cron: '*/5 * * * *',
      } as ScheduleToolInput, 'agent-1', scheduler);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('message or tool');
    });

    it('returns error for invalid cron expression', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'add', type: 'cron', cron: 'invalid', message: 'test' },
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Schedule error');
    });

    it('includes maxRuns in response when provided', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'add', type: 'cron', cron: '* * * * *', message: 'test', maxRuns: 3 },
        'agent-1',
        scheduler,
      );
      const parsed = JSON.parse(result.content);
      expect(parsed.maxRuns).toBe(3);
    });
  });

  describe('remove action', () => {
    it('removes an existing schedule', () => {
      const scheduler = createScheduler();
      const addResult = executeScheduleTool(
        { action: 'add', type: 'cron', cron: '* * * * *', message: 'test' },
        'agent-1',
        scheduler,
      );
      const id = JSON.parse(addResult.content).id;

      const result = executeScheduleTool(
        { action: 'remove', id },
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBeUndefined();
      expect(JSON.parse(result.content).success).toBe(true);
    });

    it('returns error when id is missing', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'remove' } as ScheduleToolInput,
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('id');
    });

    it('returns error for non-existent schedule', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'remove', id: 'sched-999' },
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not found');
    });
  });

  describe('list action', () => {
    it('lists all schedules for agent', () => {
      const scheduler = createScheduler();
      executeScheduleTool(
        { action: 'add', type: 'cron', cron: '*/5 * * * *', message: 'tick' },
        'agent-1',
        scheduler,
      );
      executeScheduleTool(
        { action: 'add', type: 'event', event: 'test', message: 'event' },
        'agent-1',
        scheduler,
      );

      const result = executeScheduleTool(
        { action: 'list' },
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.count).toBe(2);
      expect(parsed.schedules).toHaveLength(2);
    });

    it('list action shows tool and toolInput', () => {
      const scheduler = createScheduler();
      // First add a tool-based schedule
      executeScheduleTool({
        action: 'add',
        type: 'cron',
        cron: '*/5 * * * *',
        tool: 'runjs',
        toolInput: { code: 'test' },
      }, 'agent-1', scheduler);

      const result = executeScheduleTool({ action: 'list' }, 'agent-1', scheduler);
      const parsed = JSON.parse(result.content);
      expect(parsed.schedules[0].tool).toBe('runjs');
      expect(parsed.schedules[0].toolInput).toEqual({ code: 'test' });
    });

    it('returns empty list for agent with no schedules', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'list' },
        'agent-1',
        scheduler,
      );
      const parsed = JSON.parse(result.content);
      expect(parsed.count).toBe(0);
      expect(parsed.schedules).toHaveLength(0);
    });
  });

  describe('enable/disable actions', () => {
    it('disables a schedule', () => {
      const scheduler = createScheduler();
      const addResult = executeScheduleTool(
        { action: 'add', type: 'cron', cron: '* * * * *', message: 'test' },
        'agent-1',
        scheduler,
      );
      const id = JSON.parse(addResult.content).id;

      const result = executeScheduleTool(
        { action: 'disable', id },
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBeUndefined();
      expect(JSON.parse(result.content).enabled).toBe(false);
    });

    it('enables a schedule', () => {
      const scheduler = createScheduler();
      const addResult = executeScheduleTool(
        { action: 'add', type: 'cron', cron: '* * * * *', message: 'test' },
        'agent-1',
        scheduler,
      );
      const id = JSON.parse(addResult.content).id;

      scheduler.disableSchedule('agent-1', id);
      const result = executeScheduleTool(
        { action: 'enable', id },
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBeUndefined();
      expect(JSON.parse(result.content).enabled).toBe(true);
    });

    it('returns error when id is missing for enable', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'enable' } as ScheduleToolInput,
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBe(true);
    });

    it('returns error when id is missing for disable', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'disable' } as ScheduleToolInput,
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBe(true);
    });

    it('enable returns error for schedule owned by different agent', () => {
      const scheduler = createScheduler();
      const addResult = executeScheduleTool(
        { action: 'add', type: 'cron', cron: '* * * * *', message: 'test' },
        'agent-1',
        scheduler,
      );
      const id = JSON.parse(addResult.content).id;

      // agent-2 tries to enable agent-1's schedule
      const result = executeScheduleTool(
        { action: 'enable', id },
        'agent-2',
        scheduler,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('disable returns error for schedule owned by different agent', () => {
      const scheduler = createScheduler();
      const addResult = executeScheduleTool(
        { action: 'add', type: 'cron', cron: '* * * * *', message: 'test' },
        'agent-1',
        scheduler,
      );
      const id = JSON.parse(addResult.content).id;

      // agent-2 tries to disable agent-1's schedule
      const result = executeScheduleTool(
        { action: 'disable', id },
        'agent-2',
        scheduler,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('not found');
    });
  });

  describe('unknown action', () => {
    it('returns error for unknown action', () => {
      const scheduler = createScheduler();
      const result = executeScheduleTool(
        { action: 'unknown' } as any,
        'agent-1',
        scheduler,
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Unknown');
    });
  });
});
