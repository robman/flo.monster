import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, type ScheduleEntry, type SchedulerDeps } from '../scheduler.js';

function createMockRunner(state = 'running' as string, busy = false) {
  return {
    getState: vi.fn(() => state),
    busy,
    sendMessage: vi.fn(),
    queueMessage: vi.fn(),
  };
}

describe('Scheduler', () => {
  describe('parseCronField', () => {
    it('parses * (all values)', () => {
      expect(Scheduler.parseCronField('*', 0, 59)).toHaveLength(60);
      expect(Scheduler.parseCronField('*', 0, 59)[0]).toBe(0);
      expect(Scheduler.parseCronField('*', 0, 59)[59]).toBe(59);
    });

    it('parses */N (step)', () => {
      expect(Scheduler.parseCronField('*/5', 0, 59)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
      expect(Scheduler.parseCronField('*/15', 0, 59)).toEqual([0, 15, 30, 45]);
    });

    it('parses specific value', () => {
      expect(Scheduler.parseCronField('5', 0, 59)).toEqual([5]);
      expect(Scheduler.parseCronField('0', 0, 23)).toEqual([0]);
    });

    it('parses range N-M', () => {
      expect(Scheduler.parseCronField('1-5', 0, 59)).toEqual([1, 2, 3, 4, 5]);
      expect(Scheduler.parseCronField('10-12', 1, 31)).toEqual([10, 11, 12]);
    });

    it('parses comma-separated values', () => {
      expect(Scheduler.parseCronField('1,3,5', 0, 59)).toEqual([1, 3, 5]);
      expect(Scheduler.parseCronField('0,30', 0, 59)).toEqual([0, 30]);
    });

    it('parses combined comma + range', () => {
      expect(Scheduler.parseCronField('1-3,7,10-12', 0, 59)).toEqual([1, 2, 3, 7, 10, 11, 12]);
    });

    it('deduplicates values', () => {
      expect(Scheduler.parseCronField('5,5,5', 0, 59)).toEqual([5]);
    });

    it('throws on invalid step', () => {
      expect(() => Scheduler.parseCronField('*/0', 0, 59)).toThrow();
      expect(() => Scheduler.parseCronField('*/abc', 0, 59)).toThrow();
    });

    it('throws on out-of-range values', () => {
      expect(() => Scheduler.parseCronField('60', 0, 59)).toThrow();
      expect(() => Scheduler.parseCronField('-1', 0, 59)).toThrow();
    });

    it('throws on invalid range', () => {
      expect(() => Scheduler.parseCronField('5-3', 0, 59)).toThrow();  // start > end
      expect(() => Scheduler.parseCronField('0-60', 0, 59)).toThrow(); // end > max
    });
  });

  describe('parseCron', () => {
    it('parses standard 5-field expression', () => {
      const result = Scheduler.parseCron('*/5 * * * *');
      expect(result.minutes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
      expect(result.hours).toHaveLength(24);
      expect(result.daysOfMonth).toHaveLength(31);
      expect(result.months).toHaveLength(12);
      expect(result.daysOfWeek).toHaveLength(7);
    });

    it('throws on wrong field count', () => {
      expect(() => Scheduler.parseCron('*/5 * *')).toThrow('expected 5 fields');
      expect(() => Scheduler.parseCron('*/5 * * * * *')).toThrow('expected 5 fields');
    });

    it('parses "0 9 * * 1-5" (9am weekdays)', () => {
      const result = Scheduler.parseCron('0 9 * * 1-5');
      expect(result.minutes).toEqual([0]);
      expect(result.hours).toEqual([9]);
      expect(result.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('shouldRunCron', () => {
    it('matches every-minute expression', () => {
      const now = new Date(2026, 1, 10, 14, 30, 0); // Feb 10, 2026 14:30 (Tuesday)
      expect(Scheduler.shouldRunCron('* * * * *', now)).toBe(true);
    });

    it('matches specific minute', () => {
      const now = new Date(2026, 1, 10, 14, 30, 0);
      expect(Scheduler.shouldRunCron('30 * * * *', now)).toBe(true);
      expect(Scheduler.shouldRunCron('31 * * * *', now)).toBe(false);
    });

    it('matches every-5-minutes at :30', () => {
      const now = new Date(2026, 1, 10, 14, 30, 0);
      expect(Scheduler.shouldRunCron('*/5 * * * *', now)).toBe(true);
    });

    it('does not match every-5-minutes at :32', () => {
      const now = new Date(2026, 1, 10, 14, 32, 0);
      expect(Scheduler.shouldRunCron('*/5 * * * *', now)).toBe(false);
    });

    it('matches specific day of week', () => {
      // Feb 10, 2026 is a Tuesday (day 2)
      const now = new Date(2026, 1, 10, 14, 30, 0);
      expect(Scheduler.shouldRunCron('* * * * 2', now)).toBe(true);
      expect(Scheduler.shouldRunCron('* * * * 3', now)).toBe(false);
    });
  });

  describe('evaluateCondition', () => {
    it('"always" returns true', () => {
      expect(Scheduler.evaluateCondition('always', 42)).toBe(true);
    });

    it('"changed" returns true', () => {
      expect(Scheduler.evaluateCondition('changed', 'anything')).toBe(true);
    });

    it('"> N" comparison', () => {
      expect(Scheduler.evaluateCondition('> 100', 101)).toBe(true);
      expect(Scheduler.evaluateCondition('> 100', 100)).toBe(false);
      expect(Scheduler.evaluateCondition('> 100', 99)).toBe(false);
    });

    it('"< N" comparison', () => {
      expect(Scheduler.evaluateCondition('< 5', 4)).toBe(true);
      expect(Scheduler.evaluateCondition('< 5', 5)).toBe(false);
    });

    it('">= N" comparison', () => {
      expect(Scheduler.evaluateCondition('>= 10', 10)).toBe(true);
      expect(Scheduler.evaluateCondition('>= 10', 9)).toBe(false);
    });

    it('"<= N" comparison', () => {
      expect(Scheduler.evaluateCondition('<= 10', 10)).toBe(true);
      expect(Scheduler.evaluateCondition('<= 10', 11)).toBe(false);
    });

    it('"== value" string comparison', () => {
      expect(Scheduler.evaluateCondition('== done', 'done')).toBe(true);
      expect(Scheduler.evaluateCondition('== done', 'pending')).toBe(false);
    });

    it('"!= value" comparison', () => {
      expect(Scheduler.evaluateCondition('!= done', 'pending')).toBe(true);
      expect(Scheduler.evaluateCondition('!= done', 'done')).toBe(false);
    });

    it('arbitrary JS expressions return false (safe)', () => {
      expect(Scheduler.evaluateCondition('val > 50 && val < 200', 100)).toBe(false);
      expect(Scheduler.evaluateCondition('process.exit()', undefined)).toBe(false);
    });

    it('invalid expression returns false', () => {
      expect(Scheduler.evaluateCondition('{{invalid}}', 42)).toBe(false);
    });
  });

  describe('schedule CRUD', () => {
    let scheduler: Scheduler;
    let deps: SchedulerDeps;

    beforeEach(() => {
      deps = { getRunner: vi.fn() };
      scheduler = new Scheduler(deps);
    });

    it('addSchedule returns unique IDs', () => {
      const id1 = scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'cron',
        cronExpression: '*/5 * * * *',
        message: 'tick',
      });
      const id2 = scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'state:score',
        message: 'score changed',
      });
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^sched-/);
    });

    it('addSchedule throws on missing cronExpression for cron type', () => {
      expect(() => scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'cron',
        message: 'tick',
      })).toThrow('cronExpression required');
    });

    it('addSchedule throws on missing eventName for event type', () => {
      expect(() => scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        message: 'event',
      })).toThrow('eventName required');
    });

    it('addSchedule throws on invalid cron expression', () => {
      expect(() => scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'cron',
        cronExpression: 'bad cron',
        message: 'tick',
      })).toThrow();
    });

    it('addSchedule enforces max 10 per agent', () => {
      for (let i = 0; i < 10; i++) {
        scheduler.addSchedule({
          hubAgentId: 'agent-1',
          type: 'cron',
          cronExpression: `${i} * * * *`,
          message: `tick ${i}`,
        });
      }
      expect(() => scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'cron',
        cronExpression: '0 0 * * *',
        message: '11th',
      })).toThrow('Maximum 10');
    });

    it('getSchedules filters by agent', () => {
      scheduler.addSchedule({ hubAgentId: 'agent-1', type: 'cron', cronExpression: '* * * * *', message: 'a' });
      scheduler.addSchedule({ hubAgentId: 'agent-2', type: 'cron', cronExpression: '* * * * *', message: 'b' });
      scheduler.addSchedule({ hubAgentId: 'agent-1', type: 'event', eventName: 'x', message: 'c' });

      expect(scheduler.getSchedules('agent-1')).toHaveLength(2);
      expect(scheduler.getSchedules('agent-2')).toHaveLength(1);
      expect(scheduler.getSchedules('agent-3')).toHaveLength(0);
    });

    it('removeSchedule removes by id for correct agent', () => {
      const id = scheduler.addSchedule({ hubAgentId: 'agent-1', type: 'cron', cronExpression: '* * * * *', message: 'a' });
      expect(scheduler.removeSchedule('agent-1', id)).toBe(true);
      expect(scheduler.getSchedules('agent-1')).toHaveLength(0);
    });

    it('removeSchedule returns false for wrong agent', () => {
      const id = scheduler.addSchedule({ hubAgentId: 'agent-1', type: 'cron', cronExpression: '* * * * *', message: 'a' });
      expect(scheduler.removeSchedule('agent-2', id)).toBe(false);
      expect(scheduler.getSchedules('agent-1')).toHaveLength(1);
    });

    it('removeSchedule returns false for non-existent id', () => {
      expect(scheduler.removeSchedule('agent-1', 'sched-999')).toBe(false);
    });

    it('enable/disable toggles entry for owning agent', () => {
      const id = scheduler.addSchedule({ hubAgentId: 'agent-1', type: 'cron', cronExpression: '* * * * *', message: 'a' });
      expect(scheduler.getSchedules('agent-1')[0].enabled).toBe(true);

      expect(scheduler.disableSchedule('agent-1', id)).toBe(true);
      expect(scheduler.getSchedules('agent-1')[0].enabled).toBe(false);

      expect(scheduler.enableSchedule('agent-1', id)).toBe(true);
      expect(scheduler.getSchedules('agent-1')[0].enabled).toBe(true);
    });

    it('enableSchedule returns false for wrong agent', () => {
      const id = scheduler.addSchedule({ hubAgentId: 'agent-1', type: 'cron', cronExpression: '* * * * *', message: 'a' });
      expect(scheduler.enableSchedule('agent-2', id)).toBe(false);
      // Entry should remain unchanged (enabled by default)
      expect(scheduler.getSchedules('agent-1')[0].enabled).toBe(true);
    });

    it('disableSchedule returns false for wrong agent', () => {
      const id = scheduler.addSchedule({ hubAgentId: 'agent-1', type: 'cron', cronExpression: '* * * * *', message: 'a' });
      expect(scheduler.disableSchedule('agent-2', id)).toBe(false);
      // Entry should remain unchanged (enabled by default)
      expect(scheduler.getSchedules('agent-1')[0].enabled).toBe(true);
    });

    it('enableSchedule returns false for non-existent id', () => {
      expect(scheduler.enableSchedule('agent-1', 'sched-999')).toBe(false);
    });

    it('disableSchedule returns false for non-existent id', () => {
      expect(scheduler.disableSchedule('agent-1', 'sched-999')).toBe(false);
    });

    it('addSchedule with tool and toolInput succeeds', () => {
      const id = scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'cron',
        cronExpression: '*/5 * * * *',
        tool: 'runjs',
        toolInput: { code: 'flo.push({title: "Hi", body: "Test"})' },
      });
      expect(id).toBe('sched-1');
      const entries = scheduler.getSchedules('agent-1');
      expect(entries[0].tool).toBe('runjs');
      expect(entries[0].toolInput).toEqual({ code: 'flo.push({title: "Hi", body: "Test"})' });
      expect(entries[0].message).toBeUndefined();
    });

    it('addSchedule rejects both message and tool', () => {
      expect(() => scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'cron',
        cronExpression: '*/5 * * * *',
        message: 'check stuff',
        tool: 'runjs',
      })).toThrow('Cannot specify both message and tool');
    });

    it('addSchedule rejects tool without toolInput', () => {
      expect(() => scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'cron',
        cronExpression: '*/5 * * * *',
        tool: 'runjs',
      })).toThrow('toolInput is required when tool is specified');
    });

    it('addSchedule rejects neither message nor tool', () => {
      expect(() => scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'cron',
        cronExpression: '*/5 * * * *',
      })).toThrow('Must specify either message or tool');
    });

    it('removeAllForAgent clears all entries for agent', () => {
      scheduler.addSchedule({ hubAgentId: 'agent-1', type: 'cron', cronExpression: '* * * * *', message: 'a' });
      scheduler.addSchedule({ hubAgentId: 'agent-1', type: 'cron', cronExpression: '*/5 * * * *', message: 'b' });
      scheduler.addSchedule({ hubAgentId: 'agent-2', type: 'cron', cronExpression: '* * * * *', message: 'c' });

      scheduler.removeAllForAgent('agent-1');
      expect(scheduler.getSchedules('agent-1')).toHaveLength(0);
      expect(scheduler.getSchedules('agent-2')).toHaveLength(1);
    });
  });

  describe('fireEvent', () => {
    it('triggers matching event entries', () => {
      const runner = createMockRunner();
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps);

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'browser:connected',
        message: 'Browser connected!',
      });

      scheduler.fireEvent('browser:connected', 'agent-1');
      expect(runner.sendMessage).toHaveBeenCalledWith('Browser connected!');
    });

    it('does not trigger disabled entries', () => {
      const runner = createMockRunner();
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps);

      const id = scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test',
        message: 'triggered',
      });
      scheduler.disableSchedule('agent-1', id);

      scheduler.fireEvent('test', 'agent-1');
      expect(runner.sendMessage).not.toHaveBeenCalled();
    });

    it('does not trigger for different agent', () => {
      const runner = createMockRunner();
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps);

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test',
        message: 'triggered',
      });

      scheduler.fireEvent('test', 'agent-2');
      expect(runner.sendMessage).not.toHaveBeenCalled();
    });

    it('does not trigger for different event name', () => {
      const runner = createMockRunner();
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps);

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'state:score',
        message: 'triggered',
      });

      scheduler.fireEvent('state:health', 'agent-1');
      expect(runner.sendMessage).not.toHaveBeenCalled();
    });

    it('evaluates condition and triggers when true', () => {
      const runner = createMockRunner();
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps);

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'state:score',
        eventCondition: '> 100',
        message: 'High score!',
      });

      scheduler.fireEvent('state:score', 'agent-1', 150);
      expect(runner.sendMessage).toHaveBeenCalledWith('High score!');
    });

    it('evaluates condition and skips when false', () => {
      const runner = createMockRunner();
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps);

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'state:score',
        eventCondition: '> 100',
        message: 'High score!',
      });

      scheduler.fireEvent('state:score', 'agent-1', 50);
      expect(runner.sendMessage).not.toHaveBeenCalled();
    });

    it('skips when agent is not running', () => {
      const runner = createMockRunner('paused');
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps);

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test',
        message: 'triggered',
      });

      scheduler.fireEvent('test', 'agent-1');
      expect(runner.sendMessage).not.toHaveBeenCalled();
    });

    it('skips when agent is busy', () => {
      const runner = createMockRunner('running', true);
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps);

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test',
        message: 'triggered',
      });

      scheduler.fireEvent('test', 'agent-1');
      expect(runner.sendMessage).not.toHaveBeenCalled();
    });

    it('maxRuns disables entry after N runs', () => {
      const runner = createMockRunner();
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps);

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test',
        message: 'triggered',
        maxRuns: 2,
      });

      scheduler.fireEvent('test', 'agent-1');
      scheduler.fireEvent('test', 'agent-1');
      scheduler.fireEvent('test', 'agent-1');  // should not trigger

      expect(runner.sendMessage).toHaveBeenCalledTimes(2);
      expect(scheduler.getSchedules('agent-1')[0].enabled).toBe(false);
    });

    it('increments runCount and sets lastRunAt', () => {
      const runner = createMockRunner();
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps);

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test',
        message: 'triggered',
      });

      scheduler.fireEvent('test', 'agent-1');
      const entry = scheduler.getSchedules('agent-1')[0];
      expect(entry.runCount).toBe(1);
      expect(entry.lastRunAt).toBeGreaterThan(0);
    });

    it('tool-based entry calls executeToolForAgent', async () => {
      const executeToolForAgent = vi.fn().mockResolvedValue({ content: 'ok' });
      const runner = createMockRunner();
      const scheduler = new Scheduler({ getRunner: vi.fn(() => runner as any), executeToolForAgent });

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test_event',
        tool: 'runjs',
        toolInput: { code: 'flo.push({title: "Test", body: "msg"})' },
      });

      scheduler.fireEvent('test_event', 'agent-1');

      // Wait for async execution
      await new Promise(r => setTimeout(r, 10));

      expect(executeToolForAgent).toHaveBeenCalledWith('agent-1', 'runjs', { code: 'flo.push({title: "Test", body: "msg"})' });
      expect(runner.sendMessage).not.toHaveBeenCalled();
    });

    it('tool-based entry does not call runner.sendMessage', async () => {
      const executeToolForAgent = vi.fn().mockResolvedValue({ content: 'ok' });
      const runner = createMockRunner();
      const scheduler = new Scheduler({ getRunner: vi.fn(() => runner as any), executeToolForAgent });

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test_event',
        tool: 'runjs',
        toolInput: { code: '1+1' },
      });

      scheduler.fireEvent('test_event', 'agent-1');
      await new Promise(r => setTimeout(r, 10));

      expect(runner.sendMessage).not.toHaveBeenCalled();
    });

    it('tool-based entry notifies agent on executeToolForAgent rejection', async () => {
      const executeToolForAgent = vi.fn().mockRejectedValue(new Error('Tool crashed'));
      const runner = createMockRunner();
      runner.queueMessage = vi.fn();
      const scheduler = new Scheduler({ getRunner: vi.fn(() => runner as any), executeToolForAgent });

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test_event',
        tool: 'bash',
        toolInput: { command: 'ls /bad/path' },
      });

      scheduler.fireEvent('test_event', 'agent-1');
      await new Promise(r => setTimeout(r, 20));

      // runCount should still increment despite failure
      const entries = scheduler.getSchedules('agent-1');
      expect(entries[0].runCount).toBe(1);
      expect(entries[0].lastRunAt).toBeGreaterThan(0);
      // Agent should be notified of the failure
      expect(runner.queueMessage).toHaveBeenCalledTimes(1);
      expect(runner.queueMessage).toHaveBeenCalledWith(
        expect.stringContaining('Tool crashed')
      );
      expect(runner.queueMessage).toHaveBeenCalledWith(
        expect.stringContaining('Scheduled task')
      );
    });

    it('tool-based entry notifies agent on is_error result', async () => {
      const executeToolForAgent = vi.fn().mockResolvedValue({ content: 'document.getElementById is not available', is_error: true });
      const runner = createMockRunner();
      runner.queueMessage = vi.fn();
      const scheduler = new Scheduler({ getRunner: vi.fn(() => runner as any), executeToolForAgent });

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test_event',
        tool: 'runjs',
        toolInput: { code: 'document.getElementById("x")' },
      });

      scheduler.fireEvent('test_event', 'agent-1');
      await new Promise(r => setTimeout(r, 20));

      expect(runner.queueMessage).toHaveBeenCalledTimes(1);
      expect(runner.queueMessage).toHaveBeenCalledWith(
        expect.stringContaining('document.getElementById is not available')
      );
    });

    it('tool-based entry does not notify agent on success', async () => {
      const executeToolForAgent = vi.fn().mockResolvedValue({ content: 'ok' });
      const runner = createMockRunner();
      runner.queueMessage = vi.fn();
      const scheduler = new Scheduler({ getRunner: vi.fn(() => runner as any), executeToolForAgent });

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test_event',
        tool: 'runjs',
        toolInput: { code: '1+1' },
      });

      scheduler.fireEvent('test_event', 'agent-1');
      await new Promise(r => setTimeout(r, 20));

      expect(runner.queueMessage).not.toHaveBeenCalled();
    });

    it('tool-based entry respects maxRuns even on execution failure', async () => {
      const executeToolForAgent = vi.fn().mockRejectedValue(new Error('Always fails'));
      const runner = createMockRunner();
      runner.queueMessage = vi.fn();
      const scheduler = new Scheduler({ getRunner: vi.fn(() => runner as any), executeToolForAgent });

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test_event',
        tool: 'runjs',
        toolInput: { code: '1' },
        maxRuns: 2,
      });

      scheduler.fireEvent('test_event', 'agent-1');
      await new Promise(r => setTimeout(r, 10));
      scheduler.fireEvent('test_event', 'agent-1');
      await new Promise(r => setTimeout(r, 10));
      scheduler.fireEvent('test_event', 'agent-1'); // Should not execute — maxRuns reached
      await new Promise(r => setTimeout(r, 10));

      expect(executeToolForAgent).toHaveBeenCalledTimes(2);
      expect(scheduler.getSchedules('agent-1')[0].enabled).toBe(false);
    });

    it('tool-based entry respects maxRuns', async () => {
      const executeToolForAgent = vi.fn().mockResolvedValue({ content: 'ok' });
      const runner = createMockRunner();
      const scheduler = new Scheduler({ getRunner: vi.fn(() => runner as any), executeToolForAgent });

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'event',
        eventName: 'test_event',
        tool: 'runjs',
        toolInput: { code: '1+1' },
        maxRuns: 1,
      });

      scheduler.fireEvent('test_event', 'agent-1');
      await new Promise(r => setTimeout(r, 10));

      const entries = scheduler.getSchedules('agent-1');
      expect(entries[0].enabled).toBe(false);
      expect(entries[0].runCount).toBe(1);
    });
  });

  describe('cron timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires cron entries at matching times', () => {
      const runner = createMockRunner();
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps, 1000); // 1s tick for testing

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'cron',
        cronExpression: '* * * * *',  // every minute
        message: 'cron tick',
      });

      scheduler.start();

      // Advance time to trigger tick
      vi.advanceTimersByTime(1000);

      expect(runner.sendMessage).toHaveBeenCalledWith('cron tick');

      scheduler.stop();
    });

    it('does not fire cron entries that do not match current time', () => {
      const runner = createMockRunner();
      const deps: SchedulerDeps = { getRunner: vi.fn(() => runner as any) };
      const scheduler = new Scheduler(deps, 1000);

      // Set time to :30
      vi.setSystemTime(new Date(2026, 1, 10, 14, 30, 0));

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'cron',
        cronExpression: '0 * * * *',  // only at :00
        message: 'cron tick',
      });

      scheduler.start();
      vi.advanceTimersByTime(1000);

      expect(runner.sendMessage).not.toHaveBeenCalled();

      scheduler.stop();
    });
  });

  describe('serialize/restore', () => {
    it('roundtrip preserves entries', () => {
      const deps: SchedulerDeps = { getRunner: vi.fn() };
      const scheduler1 = new Scheduler(deps);

      scheduler1.addSchedule({ hubAgentId: 'agent-1', type: 'cron', cronExpression: '*/5 * * * *', message: 'tick' });
      scheduler1.addSchedule({ hubAgentId: 'agent-1', type: 'event', eventName: 'state:x', message: 'event' });

      const serialized = scheduler1.serialize();
      expect(serialized).toHaveLength(2);

      const scheduler2 = new Scheduler(deps);
      scheduler2.restore(serialized);

      expect(scheduler2.getSchedules('agent-1')).toHaveLength(2);
    });

    it('restore updates nextId to avoid collisions', () => {
      const deps: SchedulerDeps = { getRunner: vi.fn() };
      const scheduler = new Scheduler(deps);

      scheduler.restore([{
        id: 'sched-50',
        hubAgentId: 'agent-1',
        type: 'cron',
        cronExpression: '* * * * *',
        message: 'old',
        enabled: true,
        runCount: 5,
        createdAt: 1000,
      }]);

      const newId = scheduler.addSchedule({ hubAgentId: 'agent-1', type: 'event', eventName: 'x', message: 'new' });
      // New ID should be > 50
      const num = parseInt(newId.replace('sched-', ''), 10);
      expect(num).toBeGreaterThan(50);
    });

    it('serialize/restore preserves tool and toolInput', () => {
      const deps: SchedulerDeps = { getRunner: vi.fn() };
      const scheduler = new Scheduler(deps);

      scheduler.addSchedule({
        hubAgentId: 'agent-1',
        type: 'cron',
        cronExpression: '0 * * * *',
        tool: 'runjs',
        toolInput: { code: 'test' },
      });

      const serialized = scheduler.serialize();
      const newScheduler = new Scheduler({ getRunner: () => undefined as any });
      newScheduler.restore(serialized);

      const entries = newScheduler.getSchedules('agent-1');
      expect(entries[0].tool).toBe('runjs');
      expect(entries[0].toolInput).toEqual({ code: 'test' });
    });
  });
});
