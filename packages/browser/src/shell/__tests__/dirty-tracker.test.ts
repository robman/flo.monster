import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirtyTracker } from '../dirty-tracker.js';

describe('DirtyTracker', () => {
  let tracker: DirtyTracker;

  beforeEach(() => {
    tracker = new DirtyTracker();
  });

  describe('markDirty', () => {
    it('marks an agent as dirty', () => {
      tracker.markDirty('agent-1', 'message');
      expect(tracker.isDirty('agent-1')).toBe(true);
    });

    it('tracks multiple reasons', () => {
      tracker.markDirty('agent-1', 'message');
      tracker.markDirty('agent-1', 'dom');
      expect(tracker.getDirtyReasons('agent-1')).toEqual(
        expect.arrayContaining(['message', 'dom'])
      );
    });

    it('does not duplicate reasons', () => {
      tracker.markDirty('agent-1', 'message');
      tracker.markDirty('agent-1', 'message');
      expect(tracker.getDirtyReasons('agent-1')).toEqual(['message']);
    });

    it('notifies callback on first dirty mark', () => {
      const cb = vi.fn();
      tracker.onChange(cb);
      tracker.markDirty('agent-1', 'message');
      expect(cb).toHaveBeenCalledWith('agent-1', true);
    });

    it('does not notify on subsequent dirty marks for same agent', () => {
      const cb = vi.fn();
      tracker.onChange(cb);
      tracker.markDirty('agent-1', 'message');
      tracker.markDirty('agent-1', 'dom');
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('markClean', () => {
    it('clears dirty state', () => {
      tracker.markDirty('agent-1', 'message');
      tracker.markClean('agent-1');
      expect(tracker.isDirty('agent-1')).toBe(false);
    });

    it('clears all reasons', () => {
      tracker.markDirty('agent-1', 'message');
      tracker.markDirty('agent-1', 'dom');
      tracker.markClean('agent-1');
      expect(tracker.getDirtyReasons('agent-1')).toEqual([]);
    });

    it('notifies callback', () => {
      const cb = vi.fn();
      tracker.markDirty('agent-1', 'message');
      tracker.onChange(cb);
      tracker.markClean('agent-1');
      expect(cb).toHaveBeenCalledWith('agent-1', false);
    });

    it('does nothing if agent is not dirty', () => {
      const cb = vi.fn();
      tracker.onChange(cb);
      tracker.markClean('agent-1');
      expect(cb).not.toHaveBeenCalled();
    });

    it('updates lastSaveAt timestamp', () => {
      tracker.markDirty('agent-1', 'message');
      tracker.markClean('agent-1');
      expect(tracker.getTimeSinceLastSave('agent-1')).toBeLessThan(100);
    });
  });

  describe('isDirty', () => {
    it('returns false for unknown agent', () => {
      expect(tracker.isDirty('unknown')).toBe(false);
    });

    it('returns true for dirty agent', () => {
      tracker.markDirty('agent-1', 'file');
      expect(tracker.isDirty('agent-1')).toBe(true);
    });

    it('returns false after markClean', () => {
      tracker.markDirty('agent-1', 'file');
      tracker.markClean('agent-1');
      expect(tracker.isDirty('agent-1')).toBe(false);
    });
  });

  describe('hasAnyDirty', () => {
    it('returns false when no agents are dirty', () => {
      expect(tracker.hasAnyDirty()).toBe(false);
    });

    it('returns true when at least one agent is dirty', () => {
      tracker.markDirty('agent-1', 'message');
      expect(tracker.hasAnyDirty()).toBe(true);
    });

    it('returns false after all cleaned', () => {
      tracker.markDirty('agent-1', 'message');
      tracker.markDirty('agent-2', 'dom');
      tracker.markClean('agent-1');
      tracker.markClean('agent-2');
      expect(tracker.hasAnyDirty()).toBe(false);
    });
  });

  describe('getDirtyAgents', () => {
    it('returns empty array when none dirty', () => {
      expect(tracker.getDirtyAgents()).toEqual([]);
    });

    it('returns only dirty agent IDs', () => {
      tracker.markDirty('agent-1', 'message');
      tracker.markDirty('agent-2', 'dom');
      tracker.markDirty('agent-3', 'file');
      tracker.markClean('agent-2');
      expect(tracker.getDirtyAgents()).toEqual(
        expect.arrayContaining(['agent-1', 'agent-3'])
      );
      expect(tracker.getDirtyAgents()).not.toContain('agent-2');
    });
  });

  describe('getTimeSinceLastSave', () => {
    it('returns Infinity for unknown agent', () => {
      expect(tracker.getTimeSinceLastSave('unknown')).toBe(Infinity);
    });

    it('returns Infinity if never saved', () => {
      tracker.markDirty('agent-1', 'message');
      expect(tracker.getTimeSinceLastSave('agent-1')).toBe(Infinity);
    });

    it('returns time since last markClean', async () => {
      tracker.markDirty('agent-1', 'message');
      tracker.markClean('agent-1');
      // Should be very small, just measured
      expect(tracker.getTimeSinceLastSave('agent-1')).toBeLessThan(100);
    });
  });

  describe('getTimeSinceDirty', () => {
    it('returns Infinity for unknown agent', () => {
      expect(tracker.getTimeSinceDirty('unknown')).toBe(Infinity);
    });

    it('returns time since first dirty mark', () => {
      tracker.markDirty('agent-1', 'message');
      expect(tracker.getTimeSinceDirty('agent-1')).toBeLessThan(100);
    });

    it('returns Infinity after markClean', () => {
      tracker.markDirty('agent-1', 'message');
      tracker.markClean('agent-1');
      expect(tracker.getTimeSinceDirty('agent-1')).toBe(Infinity);
    });
  });

  describe('onChange', () => {
    it('returns an unsubscribe function', () => {
      const cb = vi.fn();
      const unsub = tracker.onChange(cb);
      tracker.markDirty('agent-1', 'message');
      expect(cb).toHaveBeenCalledTimes(1);

      unsub();
      tracker.markDirty('agent-2', 'dom');
      expect(cb).toHaveBeenCalledTimes(1); // not called again
    });

    it('supports multiple callbacks', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      tracker.onChange(cb1);
      tracker.onChange(cb2);
      tracker.markDirty('agent-1', 'message');
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('does not break if callback throws', () => {
      const badCb = vi.fn().mockImplementation(() => { throw new Error('boom'); });
      const goodCb = vi.fn();
      tracker.onChange(badCb);
      tracker.onChange(goodCb);
      tracker.markDirty('agent-1', 'message');
      expect(goodCb).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeAgent', () => {
    it('removes tracking for the agent', () => {
      tracker.markDirty('agent-1', 'message');
      tracker.removeAgent('agent-1');
      expect(tracker.isDirty('agent-1')).toBe(false);
      expect(tracker.getDirtyAgents()).not.toContain('agent-1');
    });

    it('notifies callback if agent was dirty', () => {
      tracker.markDirty('agent-1', 'message');
      const cb = vi.fn();
      tracker.onChange(cb);
      tracker.removeAgent('agent-1');
      expect(cb).toHaveBeenCalledWith('agent-1', false);
    });

    it('does not notify if agent was not dirty', () => {
      const cb = vi.fn();
      tracker.onChange(cb);
      tracker.removeAgent('agent-1');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('clears all entries', () => {
      tracker.markDirty('agent-1', 'message');
      tracker.markDirty('agent-2', 'dom');
      tracker.clear();
      expect(tracker.hasAnyDirty()).toBe(false);
      expect(tracker.getDirtyAgents()).toEqual([]);
    });
  });
});
