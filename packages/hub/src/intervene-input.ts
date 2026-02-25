/**
 * InterveneInputExecutor — translates browser input events to Playwright page commands.
 *
 * Verifies the sending client is the intervening client via InterveneManager.
 * Touches the session (resets inactivity timer).
 * Logs events in visible mode (skips in private mode).
 */

import type { Page } from 'playwright-core';
import type { InterveneManager } from './intervene-manager.js';
import type { BrowseSessionManager } from './browse-session.js';
import type { InputEvent } from './stream-server.js';

export interface FocusState {
  focused: boolean;
  inputType?: string;
  inputMode?: string;
  tagName?: string;
}

export class InterveneInputExecutor {
  private lastFocusState = new Map<string, boolean>();

  constructor(
    private interveneManager: InterveneManager,
    private browseSessionManager: BrowseSessionManager,
    private onFocusChange?: (clientId: string, agentId: string, state: FocusState) => void,
  ) {}

  /**
   * Execute an input event from a client.
   * Returns true if executed, false if rejected (unauthorized, no session, etc).
   */
  async execute(clientId: string, agentId: string, event: InputEvent): Promise<boolean> {
    // Verify the client is the active intervener for this agent
    const session = this.interveneManager.getSession(agentId);
    if (!session || session.clientId !== clientId) {
      return false;
    }

    // Get the Playwright page for this agent's browse session
    const page = this.browseSessionManager.getPage(agentId);
    if (!page) {
      return false;
    }

    // Touch the session (reset inactivity timer)
    this.interveneManager.touch(agentId);

    // Log the event (InterveneManager handles visible vs private)
    this.interveneManager.logEvent(agentId, event.kind, event as Record<string, unknown>);

    // Execute the Playwright command
    try {
      await this.executeCommand(page, event);

      // Check for focus changes after click/dblclick
      if ((event.kind === 'click' || event.kind === 'dblclick') && this.onFocusChange) {
        this.checkFocusChange(clientId, agentId, page).catch(() => {});
      }

      return true;
    } catch (err) {
      console.warn(`[InterveneInputExecutor] Failed to execute ${event.kind}:`, err);
      return false;
    }
  }

  /**
   * Detect the current focus state on the remote page.
   */
  private async detectFocusState(page: Page): Promise<FocusState> {
    try {
      return await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) {
          return { focused: false };
        }
        const tag = el.tagName.toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable) {
          return {
            focused: true,
            tagName: tag,
            inputType: (el as HTMLInputElement).type || 'text',
            inputMode: (el as HTMLElement).inputMode || undefined,
          };
        }
        return { focused: false };
      });
    } catch {
      return { focused: false };
    }
  }

  /**
   * Check focus state after a click and notify on change.
   * Fire-and-forget — errors are silently caught.
   */
  private async checkFocusChange(clientId: string, agentId: string, page: Page): Promise<void> {
    const state = await this.detectFocusState(page);
    const lastFocused = this.lastFocusState.get(agentId) ?? false;

    if (state.focused !== lastFocused) {
      this.lastFocusState.set(agentId, state.focused);
      this.onFocusChange?.(clientId, agentId, state);
    }
  }

  /**
   * Clear tracked focus state for an agent (call on intervention end).
   */
  clearFocusState(agentId: string): void {
    this.lastFocusState.delete(agentId);
  }

  private async executeCommand(page: Page, event: InputEvent): Promise<void> {
    switch (event.kind) {
      case 'click':
        await page.mouse.click(
          event.x as number ?? 0,
          event.y as number ?? 0,
          { button: (event.button as 'left' | 'right' | 'middle') ?? 'left' },
        );
        break;

      case 'dblclick':
        await page.mouse.dblclick(
          event.x as number ?? 0,
          event.y as number ?? 0,
        );
        break;

      case 'mousedown':
        await page.mouse.down({
          button: (event.button as 'left' | 'right' | 'middle') ?? 'left',
        });
        break;

      case 'mouseup':
        await page.mouse.up({
          button: (event.button as 'left' | 'right' | 'middle') ?? 'left',
        });
        break;

      case 'mousemove':
        await page.mouse.move(
          event.x as number ?? 0,
          event.y as number ?? 0,
        );
        break;

      case 'keydown':
        await page.keyboard.down(event.key as string ?? '');
        break;

      case 'keyup':
        await page.keyboard.up(event.key as string ?? '');
        break;

      case 'type':
        await page.keyboard.type(event.text as string ?? '');
        break;

      case 'scroll':
        await page.mouse.wheel(
          event.deltaX as number ?? 0,
          event.deltaY as number ?? 0,
        );
        break;

      default:
        console.warn(`[InterveneInputExecutor] Unknown event kind: ${event.kind}`);
    }
  }
}
