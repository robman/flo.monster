/**
 * InputOverlay — transparent div overlaid on the viewport canvas that captures
 * user input events (mouse, keyboard) and sends them to the hub via StreamClient.
 *
 * NDC coordinate mapping accounts for aspect-ratio-preserved canvas rendering (letterboxing).
 */

import type { StreamClient } from '../shell/stream-client.js';
import type { ZoomTransform } from './pinch-zoom.js';

export interface InputOverlayConfig {
  /** Remote viewport width in pixels */
  viewportWidth: number;
  /** Remote viewport height in pixels */
  viewportHeight: number;
}

export class InputOverlay {
  private overlay: HTMLDivElement;
  private config: InputOverlayConfig;
  private streamClient: StreamClient;
  private boundHandlers: Map<string, EventListener> = new Map();
  private hiddenInput: HTMLInputElement | null = null;

  // Canvas zoom transform (for NDC adjustment)
  private canvasZoom: ZoomTransform | null = null;

  // Touch state
  private touchStartTime: number = 0;
  private touchStartX: number = 0;
  private touchStartY: number = 0;
  private touchLastX: number = 0;
  private touchLastY: number = 0;
  private touchDragging: boolean = false;
  private lastTouchEndTime: number = 0;

  constructor(
    container: HTMLElement,
    streamClient: StreamClient,
    config: InputOverlayConfig,
  ) {
    this.streamClient = streamClient;
    this.config = config;

    this.overlay = document.createElement('div');
    this.overlay.className = 'input-overlay';
    this.overlay.tabIndex = 0; // For keyboard capture
    this.overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      cursor: crosshair;
      z-index: 10;
      outline: none;
    `;

    container.appendChild(this.overlay);

    this.hiddenInput = document.createElement('input');
    this.hiddenInput.className = 'input-overlay__hidden-input';
    this.hiddenInput.setAttribute('autocomplete', 'off');
    this.hiddenInput.setAttribute('autocorrect', 'off');
    this.hiddenInput.setAttribute('autocapitalize', 'off');
    this.hiddenInput.setAttribute('spellcheck', 'false');
    this.hiddenInput.style.cssText = `
      position: absolute;
      left: -9999px;
      top: 50%;
      width: 1px;
      height: 1px;
      opacity: 0;
      font-size: 16px;
      border: none;
      outline: none;
    `;
    container.appendChild(this.hiddenInput);

    this.hiddenInput.addEventListener('input', (e: Event) => {
      const ie = e as InputEvent;
      if (ie.inputType === 'insertText' && ie.data) {
        this.sendEvent({ kind: 'type', text: ie.data });
      } else if (ie.inputType === 'deleteContentBackward') {
        this.sendEvent({ kind: 'keydown', key: 'Backspace' });
        this.sendEvent({ kind: 'keyup', key: 'Backspace' });
      } else if (ie.inputType === 'insertLineBreak') {
        this.sendEvent({ kind: 'keydown', key: 'Enter' });
        this.sendEvent({ kind: 'keyup', key: 'Enter' });
      }
      // Clear the input so next keystroke gets fresh event
      this.hiddenInput!.value = '';
    });

    this.hiddenInput.addEventListener('keydown', (e: Event) => {
      const ke = e as KeyboardEvent;
      // Only relay non-printable keys (arrows, tab, escape, etc) — printable handled by 'input' event
      if (ke.key.length > 1 || ke.ctrlKey || ke.metaKey || ke.altKey) {
        ke.preventDefault();
        this.sendEvent({ kind: 'keydown', key: ke.key });
      }
    });
    this.hiddenInput.addEventListener('keyup', (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key.length > 1 || ke.ctrlKey || ke.metaKey || ke.altKey) {
        ke.preventDefault();
        this.sendEvent({ kind: 'keyup', key: ke.key });
      }
    });

    this.overlay.focus();

    this.attachListeners();
  }

  private attachListeners(): void {
    const addHandler = (event: string, handler: EventListener) => {
      this.boundHandlers.set(event, handler);
      this.overlay.addEventListener(event, handler);
    };

    addHandler('click', (e: Event) => {
      const coords = this.mapCoordinates(e as MouseEvent);
      if (coords) {
        this.sendEvent({ kind: 'click', x: coords.x, y: coords.y, button: this.mapButton((e as MouseEvent).button) });
      }
    });

    addHandler('dblclick', (e: Event) => {
      const coords = this.mapCoordinates(e as MouseEvent);
      if (coords) {
        this.sendEvent({ kind: 'dblclick', x: coords.x, y: coords.y });
      }
    });

    addHandler('mousedown', (e: Event) => {
      const coords = this.mapCoordinates(e as MouseEvent);
      if (coords) {
        this.sendEvent({ kind: 'mousedown', x: coords.x, y: coords.y, button: this.mapButton((e as MouseEvent).button) });
      }
    });

    addHandler('mouseup', (e: Event) => {
      const coords = this.mapCoordinates(e as MouseEvent);
      if (coords) {
        this.sendEvent({ kind: 'mouseup', x: coords.x, y: coords.y, button: this.mapButton((e as MouseEvent).button) });
      }
    });

    addHandler('mousemove', (e: Event) => {
      const coords = this.mapCoordinates(e as MouseEvent);
      if (coords) {
        this.sendEvent({ kind: 'mousemove', x: coords.x, y: coords.y });
      }
    });

    addHandler('keydown', (e: Event) => {
      const ke = e as KeyboardEvent;
      ke.preventDefault();
      // For printable characters, send 'type' event. For control keys, send 'keydown'.
      if (ke.key.length === 1 && !ke.ctrlKey && !ke.metaKey && !ke.altKey) {
        this.sendEvent({ kind: 'type', text: ke.key });
      } else {
        this.sendEvent({ kind: 'keydown', key: ke.key });
      }
    });

    addHandler('keyup', (e: Event) => {
      const ke = e as KeyboardEvent;
      ke.preventDefault();
      // Only send keyup for non-printable keys
      if (ke.key.length > 1 || ke.ctrlKey || ke.metaKey || ke.altKey) {
        this.sendEvent({ kind: 'keyup', key: ke.key });
      }
    });

    // Wheel needs passive: false for preventDefault — add directly
    const wheelHandler = (e: Event) => {
      const we = e as WheelEvent;
      we.preventDefault();
      this.sendEvent({ kind: 'scroll', deltaX: we.deltaX, deltaY: we.deltaY });
    };
    this.boundHandlers.set('wheel', wheelHandler);
    this.overlay.addEventListener('wheel', wheelHandler, { passive: false });

    // Touch handlers — passive: false for preventDefault, added directly like wheel
    const touchStartHandler = (e: Event) => {
      const te = e as TouchEvent;
      if (te.touches.length !== 1) return;
      const touch = te.touches[0];
      this.touchStartTime = Date.now();
      this.touchStartX = touch.clientX;
      this.touchStartY = touch.clientY;
      this.touchLastX = touch.clientX;
      this.touchLastY = touch.clientY;
      this.touchDragging = false;
      te.preventDefault();
    };
    this.boundHandlers.set('touchstart', touchStartHandler);
    this.overlay.addEventListener('touchstart', touchStartHandler, { passive: false });

    const touchMoveHandler = (e: Event) => {
      const te = e as TouchEvent;
      if (te.touches.length !== 1) return;
      const touch = te.touches[0];
      const currentX = touch.clientX;
      const currentY = touch.clientY;
      const totalDx = currentX - this.touchStartX;
      const totalDy = currentY - this.touchStartY;
      if (Math.sqrt(totalDx * totalDx + totalDy * totalDy) > 10) {
        this.touchDragging = true;
      }
      if (this.touchDragging) {
        const deltaX = -(currentX - this.touchLastX) * 2;
        const deltaY = -(currentY - this.touchLastY) * 2;
        this.sendEvent({ kind: 'scroll', deltaX, deltaY });
      }
      this.touchLastX = currentX;
      this.touchLastY = currentY;
      te.preventDefault();
    };
    this.boundHandlers.set('touchmove', touchMoveHandler);
    this.overlay.addEventListener('touchmove', touchMoveHandler, { passive: false });

    const touchEndHandler = (e: Event) => {
      this.lastTouchEndTime = Date.now();
      const duration = this.lastTouchEndTime - this.touchStartTime;
      const dx = this.touchLastX - this.touchStartX;
      const dy = this.touchLastY - this.touchStartY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (!this.touchDragging && duration < 300 && distance < 10) {
        const coords = this.mapClientCoords(this.touchLastX, this.touchLastY);
        if (coords) {
          this.sendEvent({ kind: 'click', x: coords.x, y: coords.y, button: 'left' });
        }
      }
    };
    this.boundHandlers.set('touchend', touchEndHandler);
    this.overlay.addEventListener('touchend', touchEndHandler, { passive: false });

    // Prevent context menu
    addHandler('contextmenu', (e: Event) => {
      e.preventDefault();
    });
  }

  /**
   * Set the current canvas zoom transform for NDC adjustment.
   * Called by AgentView when the PinchZoomHandler changes the canvas transform.
   */
  setCanvasZoom(transform: ZoomTransform): void {
    this.canvasZoom = transform.scale === 1 ? null : transform;
  }

  /**
   * Map client coordinates (clientX, clientY) to remote viewport coordinates.
   * Accounts for aspect-ratio-preserved rendering (letterboxing) and canvas zoom.
   * Extracted for reuse by both mouse and touch events.
   */
  private mapClientCoords(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.overlay.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    // Position relative to overlay (= container)
    let localX = clientX - rect.left;
    let localY = clientY - rect.top;

    // If canvas is zoomed, reverse the zoom transform to get unzoomed canvas coords.
    // CSS transform on canvas: translate(panX, panY) scale(scale) with origin 0,0
    // Screen pos = content pos * scale + pan → content pos = (screen pos - pan) / scale
    if (this.canvasZoom) {
      const { scale, panX, panY } = this.canvasZoom;
      localX = (localX - panX) / scale;
      localY = (localY - panY) / scale;
    }

    const { viewportWidth, viewportHeight } = this.config;

    // Calculate the rendered area within the canvas (matching aspect ratio, letterboxing)
    const scale = Math.min(
      rect.width / viewportWidth,
      rect.height / viewportHeight,
    );
    const renderedWidth = viewportWidth * scale;
    const renderedHeight = viewportHeight * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;

    // Check if position is within the rendered area
    if (localX < offsetX || localX > offsetX + renderedWidth ||
        localY < offsetY || localY > offsetY + renderedHeight) {
      return null; // In letterbox area
    }

    // Map to remote viewport coordinates
    const x = Math.round((localX - offsetX) / renderedWidth * viewportWidth);
    const y = Math.round((localY - offsetY) / renderedHeight * viewportHeight);

    return { x, y };
  }

  /**
   * Map mouse event coordinates to remote viewport coordinates.
   */
  private mapCoordinates(e: MouseEvent): { x: number; y: number } | null {
    return this.mapClientCoords(e.clientX, e.clientY);
  }

  private mapButton(button: number): string {
    switch (button) {
      case 0: return 'left';
      case 1: return 'middle';
      case 2: return 'right';
      default: return 'left';
    }
  }

  private sendEvent(event: Record<string, unknown>): void {
    this.streamClient.sendInputEvent(event as any);
  }

  handleRemoteFocusChange(notification: { focused: boolean; inputType?: string; inputMode?: string }): void {
    if (notification.focused) {
      // Store inputMode for when the user taps the Keyboard button
      if (this.hiddenInput && notification.inputMode) {
        this.hiddenInput.setAttribute('inputmode', notification.inputMode);
      }
    } else {
      this.hideKeyboard();
    }
  }

  showKeyboard(inputMode?: string): void {
    if (!this.hiddenInput) return;
    if (inputMode) {
      this.hiddenInput.setAttribute('inputmode', inputMode);
    } else {
      this.hiddenInput.removeAttribute('inputmode');
    }
    this.hiddenInput.focus();
  }

  hideKeyboard(): void {
    if (!this.hiddenInput) return;
    this.hiddenInput.blur();
    // Refocus the overlay for desktop keyboard capture
    this.overlay.focus();
  }

  /**
   * Remove the overlay and detach all listeners.
   */
  destroy(): void {
    for (const [event, handler] of this.boundHandlers) {
      this.overlay.removeEventListener(event, handler);
    }
    this.boundHandlers.clear();
    this.overlay.remove();
    if (this.hiddenInput) {
      this.hiddenInput.remove();
      this.hiddenInput = null;
    }
  }
}
