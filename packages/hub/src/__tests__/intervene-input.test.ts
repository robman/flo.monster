/**
 * Tests for InterveneInputExecutor — input event relay to Playwright.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InterveneInputExecutor, type FocusState } from '../intervene-input.js';
import { InterveneManager } from '../intervene-manager.js';

// Mock Playwright Page
function createMockPage() {
  return {
    mouse: {
      click: vi.fn(async () => {}),
      dblclick: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      wheel: vi.fn(async () => {}),
    },
    keyboard: {
      down: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
    },
  } as any;
}

// Mock BrowseSessionManager
function createMockSessionManager(page: any) {
  return {
    getPage: vi.fn((_agentId: string) => page),
    hasSession: vi.fn(() => true),
  } as any;
}

describe('InterveneInputExecutor', () => {
  let manager: InterveneManager;
  let page: ReturnType<typeof createMockPage>;
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let executor: InterveneInputExecutor;

  beforeEach(() => {
    manager = new InterveneManager();
    page = createMockPage();
    sessionManager = createMockSessionManager(page);
    executor = new InterveneInputExecutor(manager, sessionManager);
  });

  it('should execute click event', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    const result = await executor.execute('client-1', 'agent-1', {
      kind: 'click',
      x: 100,
      y: 200,
      button: 'left',
    });

    expect(result).toBe(true);
    expect(page.mouse.click).toHaveBeenCalledWith(100, 200, { button: 'left' });
  });

  it('should execute dblclick event', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    await executor.execute('client-1', 'agent-1', {
      kind: 'dblclick',
      x: 50,
      y: 60,
    });

    expect(page.mouse.dblclick).toHaveBeenCalledWith(50, 60);
  });

  it('should execute keydown event', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    await executor.execute('client-1', 'agent-1', {
      kind: 'keydown',
      key: 'Enter',
    });

    expect(page.keyboard.down).toHaveBeenCalledWith('Enter');
  });

  it('should execute keyup event', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    await executor.execute('client-1', 'agent-1', {
      kind: 'keyup',
      key: 'Enter',
    });

    expect(page.keyboard.up).toHaveBeenCalledWith('Enter');
  });

  it('should execute type event', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    await executor.execute('client-1', 'agent-1', {
      kind: 'type',
      text: 'hello world',
    });

    expect(page.keyboard.type).toHaveBeenCalledWith('hello world');
  });

  it('should execute scroll event', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    await executor.execute('client-1', 'agent-1', {
      kind: 'scroll',
      deltaX: 0,
      deltaY: 100,
    });

    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 100);
  });

  it('should execute mousemove event', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    await executor.execute('client-1', 'agent-1', {
      kind: 'mousemove',
      x: 300,
      y: 400,
    });

    expect(page.mouse.move).toHaveBeenCalledWith(300, 400);
  });

  it('should execute mousedown event', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    await executor.execute('client-1', 'agent-1', {
      kind: 'mousedown',
      button: 'right',
    });

    expect(page.mouse.down).toHaveBeenCalledWith({ button: 'right' });
  });

  it('should execute mouseup event', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    await executor.execute('client-1', 'agent-1', {
      kind: 'mouseup',
      button: 'middle',
    });

    expect(page.mouse.up).toHaveBeenCalledWith({ button: 'middle' });
  });

  it('should reject unauthorized client', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    const result = await executor.execute('client-2', 'agent-1', {
      kind: 'click',
      x: 100,
      y: 200,
    });

    expect(result).toBe(false);
    expect(page.mouse.click).not.toHaveBeenCalled();
  });

  it('should reject when no intervention session exists', async () => {
    const result = await executor.execute('client-1', 'agent-1', {
      kind: 'click',
      x: 100,
      y: 200,
    });

    expect(result).toBe(false);
  });

  it('should reject when no browse page exists', async () => {
    const noPageManager = createMockSessionManager(null);
    noPageManager.getPage = vi.fn(() => null);
    const exec = new InterveneInputExecutor(manager, noPageManager);

    manager.requestIntervene('agent-1', 'client-1', 'visible');

    const result = await exec.execute('client-1', 'agent-1', {
      kind: 'click',
      x: 100,
      y: 200,
    });

    expect(result).toBe(false);
  });

  it('should touch the session on each event', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');
    const session = manager.getSession('agent-1')!;
    const originalActivity = session.lastActivity;

    // Advance time a bit
    await new Promise(r => setTimeout(r, 10));

    await executor.execute('client-1', 'agent-1', {
      kind: 'click',
      x: 100,
      y: 200,
    });

    expect(session.lastActivity).toBeGreaterThanOrEqual(originalActivity);
  });

  it('should log events in visible mode', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    await executor.execute('client-1', 'agent-1', {
      kind: 'click',
      x: 100,
      y: 200,
    });

    const session = manager.getSession('agent-1')!;
    expect(session.eventLog).toHaveLength(1);
    expect(session.eventLog[0].kind).toBe('click');
  });

  it('should NOT log events in private mode', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'private');

    await executor.execute('client-1', 'agent-1', {
      kind: 'click',
      x: 100,
      y: 200,
    });

    const session = manager.getSession('agent-1')!;
    expect(session.eventLog).toHaveLength(0);
  });

  it('should return false when Playwright command throws', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');
    page.mouse.click.mockRejectedValueOnce(new Error('Element not found'));

    const result = await executor.execute('client-1', 'agent-1', {
      kind: 'click',
      x: 100,
      y: 200,
    });

    expect(result).toBe(false);
  });

  it('should handle unknown event kinds gracefully', async () => {
    manager.requestIntervene('agent-1', 'client-1', 'visible');

    const result = await executor.execute('client-1', 'agent-1', {
      kind: 'unknown_event',
    });

    // Should still succeed (just logs a warning)
    expect(result).toBe(true);
  });

  describe('focus detection', () => {
    // Add evaluate to the mock page
    function createMockPageWithFocus(focusResult: any = { focused: false }) {
      const p = createMockPage();
      p.evaluate = vi.fn(async (_fn: Function) => {
        // The function is executed in browser context, but for testing we just return the mock result
        return focusResult;
      });
      return p;
    }

    it('should call onFocusChange after click when activeElement is input', async () => {
      const focusResult = { focused: true, tagName: 'INPUT', inputType: 'email', inputMode: 'email' };
      const focusPage = createMockPageWithFocus(focusResult);
      const focusSM = createMockSessionManager(focusPage);
      const onFocusChange = vi.fn();
      const mgr = new InterveneManager();
      const exec = new InterveneInputExecutor(mgr, focusSM, onFocusChange);

      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      await exec.execute('client-1', 'agent-1', {
        kind: 'click',
        x: 100,
        y: 200,
        button: 'left',
      });

      await new Promise(r => setTimeout(r, 10));

      expect(onFocusChange).toHaveBeenCalledWith('client-1', 'agent-1', {
        focused: true,
        tagName: 'INPUT',
        inputType: 'email',
        inputMode: 'email',
      });
    });

    it('should NOT call onFocusChange for non-click events (mousemove)', async () => {
      const focusPage = createMockPageWithFocus({ focused: true, tagName: 'INPUT', inputType: 'text' });
      const focusSM = createMockSessionManager(focusPage);
      const onFocusChange = vi.fn();
      const mgr = new InterveneManager();
      const exec = new InterveneInputExecutor(mgr, focusSM, onFocusChange);

      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      await exec.execute('client-1', 'agent-1', {
        kind: 'mousemove',
        x: 300,
        y: 400,
      });

      await new Promise(r => setTimeout(r, 10));

      expect(onFocusChange).not.toHaveBeenCalled();
    });

    it('should NOT call onFocusChange for scroll events', async () => {
      const focusPage = createMockPageWithFocus({ focused: true, tagName: 'INPUT', inputType: 'text' });
      const focusSM = createMockSessionManager(focusPage);
      const onFocusChange = vi.fn();
      const mgr = new InterveneManager();
      const exec = new InterveneInputExecutor(mgr, focusSM, onFocusChange);

      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      await exec.execute('client-1', 'agent-1', {
        kind: 'scroll',
        deltaX: 0,
        deltaY: 100,
      });

      await new Promise(r => setTimeout(r, 10));

      expect(onFocusChange).not.toHaveBeenCalled();
    });

    it('should call onFocusChange on dblclick', async () => {
      const focusResult = { focused: true, tagName: 'INPUT', inputType: 'email', inputMode: 'email' };
      const focusPage = createMockPageWithFocus(focusResult);
      const focusSM = createMockSessionManager(focusPage);
      const onFocusChange = vi.fn();
      const mgr = new InterveneManager();
      const exec = new InterveneInputExecutor(mgr, focusSM, onFocusChange);

      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      await exec.execute('client-1', 'agent-1', {
        kind: 'dblclick',
        x: 50,
        y: 60,
      });

      await new Promise(r => setTimeout(r, 10));

      expect(onFocusChange).toHaveBeenCalledWith('client-1', 'agent-1', {
        focused: true,
        tagName: 'INPUT',
        inputType: 'email',
        inputMode: 'email',
      });
    });

    it('should only notify on state change (dedup)', async () => {
      const focusResult = { focused: true, tagName: 'INPUT', inputType: 'text' };
      const focusPage = createMockPageWithFocus(focusResult);
      const focusSM = createMockSessionManager(focusPage);
      const onFocusChange = vi.fn();
      const mgr = new InterveneManager();
      const exec = new InterveneInputExecutor(mgr, focusSM, onFocusChange);

      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      // First click — triggers focused=true notification
      await exec.execute('client-1', 'agent-1', {
        kind: 'click',
        x: 100,
        y: 200,
        button: 'left',
      });
      await new Promise(r => setTimeout(r, 10));
      expect(onFocusChange).toHaveBeenCalledTimes(1);

      // Clear the spy
      onFocusChange.mockClear();

      // Second click — still focused=true, should NOT notify again
      await exec.execute('client-1', 'agent-1', {
        kind: 'click',
        x: 110,
        y: 210,
        button: 'left',
      });
      await new Promise(r => setTimeout(r, 10));
      expect(onFocusChange).not.toHaveBeenCalled();
    });

    it('should send blur notification when focus moves away', async () => {
      const focusResult = { focused: true, tagName: 'INPUT', inputType: 'text' };
      const focusPage = createMockPageWithFocus(focusResult);
      const focusSM = createMockSessionManager(focusPage);
      const onFocusChange = vi.fn();
      const mgr = new InterveneManager();
      const exec = new InterveneInputExecutor(mgr, focusSM, onFocusChange);

      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      // First click — triggers focused=true
      await exec.execute('client-1', 'agent-1', {
        kind: 'click',
        x: 100,
        y: 200,
        button: 'left',
      });
      await new Promise(r => setTimeout(r, 10));
      expect(onFocusChange).toHaveBeenCalledTimes(1);

      // Change page.evaluate to return unfocused
      focusPage.evaluate.mockImplementation(async () => ({ focused: false }));

      // Another click — triggers blur notification
      await exec.execute('client-1', 'agent-1', {
        kind: 'click',
        x: 500,
        y: 500,
        button: 'left',
      });
      await new Promise(r => setTimeout(r, 10));
      expect(onFocusChange).toHaveBeenCalledTimes(2);
      expect(onFocusChange).toHaveBeenLastCalledWith('client-1', 'agent-1', { focused: false });
    });

    it('should re-notify after clearFocusState resets tracking', async () => {
      const focusResult = { focused: true, tagName: 'INPUT', inputType: 'text' };
      const focusPage = createMockPageWithFocus(focusResult);
      const focusSM = createMockSessionManager(focusPage);
      const onFocusChange = vi.fn();
      const mgr = new InterveneManager();
      const exec = new InterveneInputExecutor(mgr, focusSM, onFocusChange);

      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      // First click — triggers focused=true
      await exec.execute('client-1', 'agent-1', {
        kind: 'click',
        x: 100,
        y: 200,
        button: 'left',
      });
      await new Promise(r => setTimeout(r, 10));
      expect(onFocusChange).toHaveBeenCalledTimes(1);

      // Clear focus state
      exec.clearFocusState('agent-1');

      // Same click again — should notify again since state was cleared
      await exec.execute('client-1', 'agent-1', {
        kind: 'click',
        x: 100,
        y: 200,
        button: 'left',
      });
      await new Promise(r => setTimeout(r, 10));
      expect(onFocusChange).toHaveBeenCalledTimes(2);
    });

    it('should not throw if onFocusChange not provided', async () => {
      const focusPage = createMockPageWithFocus({ focused: true, tagName: 'INPUT', inputType: 'text' });
      const focusSM = createMockSessionManager(focusPage);
      const mgr = new InterveneManager();
      // No onFocusChange callback — original 2-arg constructor
      const exec = new InterveneInputExecutor(mgr, focusSM);

      mgr.requestIntervene('agent-1', 'client-1', 'visible');

      const result = await exec.execute('client-1', 'agent-1', {
        kind: 'click',
        x: 100,
        y: 200,
        button: 'left',
      });

      await new Promise(r => setTimeout(r, 10));

      expect(result).toBe(true);
      // page.evaluate should NOT be called since there's no callback
      expect(focusPage.evaluate).not.toHaveBeenCalled();
    });
  });
});
