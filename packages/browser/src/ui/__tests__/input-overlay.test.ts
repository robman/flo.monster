/**
 * Tests for InputOverlay — NDC coordinate mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InputOverlay } from '../input-overlay.js';

// Mock StreamClient
function createMockStreamClient() {
  return {
    sendInputEvent: vi.fn(),
    connected: true,
  } as any;
}

describe('InputOverlay', () => {
  let container: HTMLElement;
  let streamClient: ReturnType<typeof createMockStreamClient>;

  beforeEach(() => {
    container = document.createElement('div');
    // Mock getBoundingClientRect
    container.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 1280, height: 720,
      bottom: 720, right: 1280, x: 0, y: 0,
      toJSON: () => {},
    });
    streamClient = createMockStreamClient();
  });

  it('should create an overlay element in the container', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const el = container.querySelector('.input-overlay');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('tabindex')).toBe('0');

    overlay.destroy();
  });

  it('should send click events with mapped coordinates', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    // The overlay element in the container
    const el = container.querySelector('.input-overlay') as HTMLElement;
    el.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 1280, height: 720,
      bottom: 720, right: 1280, x: 0, y: 0,
      toJSON: () => {},
    });

    // Simulate click at center
    el.dispatchEvent(new MouseEvent('click', {
      clientX: 640,
      clientY: 360,
      button: 0,
      bubbles: true,
    }));

    expect(streamClient.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'click',
        x: 640,
        y: 360,
        button: 'left',
      }),
    );

    overlay.destroy();
  });

  it('should handle letterboxing (wider container)', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const el = container.querySelector('.input-overlay') as HTMLElement;
    // Container is wider than viewport aspect ratio (2:1 vs 16:9)
    el.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 2560, height: 720,
      bottom: 720, right: 2560, x: 0, y: 0,
      toJSON: () => {},
    });

    // With 2560x720 container and 1280x720 viewport:
    // scale = min(2560/1280, 720/720) = min(2, 1) = 1
    // renderedWidth = 1280, renderedHeight = 720
    // offsetX = (2560 - 1280) / 2 = 640
    // Click at the center of the rendered area: x=640 + 640 = 1280
    el.dispatchEvent(new MouseEvent('click', {
      clientX: 640 + 640,  // center of rendered area
      clientY: 360,
      button: 0,
      bubbles: true,
    }));

    expect(streamClient.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'click',
        x: 640,
        y: 360,
      }),
    );

    overlay.destroy();
  });

  it('should clean up on destroy', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    overlay.destroy();

    const el = container.querySelector('.input-overlay');
    expect(el).toBeNull();
  });

  it('should send keyboard events', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const el = container.querySelector('.input-overlay') as HTMLElement;

    // Printable character sends 'type' event
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
    }));

    expect(streamClient.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'type',
        text: 'a',
      }),
    );

    streamClient.sendInputEvent.mockClear();

    // Control key sends 'keydown' event
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
    }));

    expect(streamClient.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'keydown',
        key: 'Enter',
      }),
    );

    overlay.destroy();
  });

  // --- Touch tests ---

  /**
   * Helper to create touch events in jsdom (which lacks TouchEvent constructor).
   */
  function createTouchEvent(type: string, touches: { clientX: number; clientY: number }[]): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: touches });
    Object.defineProperty(event, 'changedTouches', { value: touches });
    Object.defineProperty(event, 'preventDefault', { value: vi.fn() });
    return event;
  }

  it('should send click on touch tap', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const el = container.querySelector('.input-overlay') as HTMLElement;
    el.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 1280, height: 720,
      bottom: 720, right: 1280, x: 0, y: 0,
      toJSON: () => {},
    });

    // Touchstart at center
    el.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 640, clientY: 360 }]));
    // Touchend at same position (quick tap)
    el.dispatchEvent(createTouchEvent('touchend', [{ clientX: 640, clientY: 360 }]));

    expect(streamClient.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'click',
        x: 640,
        y: 360,
        button: 'left',
      }),
    );

    overlay.destroy();
  });

  it('should send scroll events on touch drag', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const el = container.querySelector('.input-overlay') as HTMLElement;
    el.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 1280, height: 720,
      bottom: 720, right: 1280, x: 0, y: 0,
      toJSON: () => {},
    });

    // Touchstart at (100, 100)
    el.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    // Touchmove 50px down — exceeds 10px threshold, triggers scroll
    el.dispatchEvent(createTouchEvent('touchmove', [{ clientX: 100, clientY: 150 }]));

    expect(streamClient.sendInputEvent).toHaveBeenCalledTimes(1);
    const scrollCall = streamClient.sendInputEvent.mock.calls[0][0];
    expect(scrollCall.kind).toBe('scroll');
    expect(scrollCall.deltaX + 0).toBe(0); // -(100-100)*2 = -0, coerce to 0
    expect(scrollCall.deltaY).toBe(-100); // -(150-100)*2 = -100

    overlay.destroy();
  });

  it('should not send click on long press', () => {
    vi.useFakeTimers();

    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const el = container.querySelector('.input-overlay') as HTMLElement;
    el.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 1280, height: 720,
      bottom: 720, right: 1280, x: 0, y: 0,
      toJSON: () => {},
    });

    // Touchstart
    el.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 640, clientY: 360 }]));

    // Advance time by 400ms (exceeds 300ms tap threshold)
    vi.advanceTimersByTime(400);

    // Touchend after long delay
    el.dispatchEvent(createTouchEvent('touchend', [{ clientX: 640, clientY: 360 }]));

    // No click event should have been sent
    expect(streamClient.sendInputEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'click' }),
    );

    overlay.destroy();
    vi.useRealTimers();
  });

  it('should ignore multi-finger touch', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const el = container.querySelector('.input-overlay') as HTMLElement;
    el.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 1280, height: 720,
      bottom: 720, right: 1280, x: 0, y: 0,
      toJSON: () => {},
    });

    // Touchstart with 2 fingers
    el.dispatchEvent(createTouchEvent('touchstart', [
      { clientX: 100, clientY: 100 },
      { clientX: 200, clientY: 200 },
    ]));
    // Touchend
    el.dispatchEvent(createTouchEvent('touchend', [
      { clientX: 100, clientY: 100 },
      { clientX: 200, clientY: 200 },
    ]));

    expect(streamClient.sendInputEvent).not.toHaveBeenCalled();

    overlay.destroy();
  });

  it('should handle touch tap with letterboxing', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const el = container.querySelector('.input-overlay') as HTMLElement;
    // Container wider than viewport aspect ratio (2:1 vs 16:9)
    el.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 2560, height: 720,
      bottom: 720, right: 2560, x: 0, y: 0,
      toJSON: () => {},
    });

    // With 2560x720 container and 1280x720 viewport:
    // scale = min(2560/1280, 720/720) = min(2, 1) = 1
    // renderedWidth = 1280, renderedHeight = 720
    // offsetX = (2560 - 1280) / 2 = 640
    // Tap at center of rendered area: x=640+640=1280, y=360
    el.dispatchEvent(createTouchEvent('touchstart', [{ clientX: 640 + 640, clientY: 360 }]));
    el.dispatchEvent(createTouchEvent('touchend', [{ clientX: 640 + 640, clientY: 360 }]));

    expect(streamClient.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'click',
        x: 640,
        y: 360,
      }),
    );

    overlay.destroy();
  });

  // --- Hidden input tests ---

  it('should relay insertText input events as type events', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const hiddenInput = container.querySelector('.input-overlay__hidden-input') as HTMLInputElement;
    expect(hiddenInput).not.toBeNull();

    hiddenInput.dispatchEvent(new InputEvent('input', {
      inputType: 'insertText',
      data: 'a',
      bubbles: true,
    }));

    expect(streamClient.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'type',
        text: 'a',
      }),
    );

    overlay.destroy();
  });

  it('should relay deleteContentBackward as Backspace keydown+keyup', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const hiddenInput = container.querySelector('.input-overlay__hidden-input') as HTMLInputElement;

    hiddenInput.dispatchEvent(new InputEvent('input', {
      inputType: 'deleteContentBackward',
      bubbles: true,
    }));

    expect(streamClient.sendInputEvent).toHaveBeenCalledTimes(2);
    expect(streamClient.sendInputEvent).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ kind: 'keydown', key: 'Backspace' }),
    );
    expect(streamClient.sendInputEvent).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ kind: 'keyup', key: 'Backspace' }),
    );

    overlay.destroy();
  });

  // --- Focus handling tests ---

  it('should set inputMode on handleRemoteFocusChange with focused=true but not focus', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const hiddenInput = container.querySelector('.input-overlay__hidden-input') as HTMLInputElement;
    const focusSpy = vi.spyOn(hiddenInput, 'focus');
    focusSpy.mockClear();

    overlay.handleRemoteFocusChange({ focused: true, inputMode: 'email' });

    // inputMode attribute should be set for when showKeyboard() is called
    expect(hiddenInput.getAttribute('inputmode')).toBe('email');
    // But focus should NOT be called — keyboard is shown via explicit showKeyboard() from user gesture
    expect(focusSpy).not.toHaveBeenCalled();

    overlay.destroy();
  });

  it('should blur hidden input on handleRemoteFocusChange with focused=false', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const hiddenInput = container.querySelector('.input-overlay__hidden-input') as HTMLInputElement;
    const blurSpy = vi.spyOn(hiddenInput, 'blur');

    overlay.handleRemoteFocusChange({ focused: false });

    expect(blurSpy).toHaveBeenCalled();

    overlay.destroy();
  });

  // --- Cleanup test ---

  it('should remove hidden input on destroy', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    // Verify hidden input exists
    expect(container.querySelector('.input-overlay__hidden-input')).not.toBeNull();

    overlay.destroy();

    // Verify hidden input is removed
    expect(container.querySelector('.input-overlay__hidden-input')).toBeNull();
  });

  // --- Canvas zoom NDC adjustment tests ---

  it('should adjust click coordinates for canvas zoom', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const el = container.querySelector('.input-overlay') as HTMLElement;
    // Container matches viewport aspect ratio (no letterboxing)
    el.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 1280, height: 720,
      bottom: 720, right: 1280, x: 0, y: 0,
      toJSON: () => {},
    });

    // Set 2x zoom centered on (640, 360):
    // At 2x centered: pan = mid - (mid / 1) * 2 = 640 - 640*2 = -640, 360 - 360*2 = -360
    overlay.setCanvasZoom({ scale: 2, panX: -640, panY: -360 });

    // Click at center of overlay (640, 360)
    // Unzoomed: ((640 - (-640)) / 2, (360 - (-360)) / 2) = (640, 360)
    // → maps to remote viewport center (640, 360)
    el.dispatchEvent(new MouseEvent('click', {
      clientX: 640, clientY: 360, button: 0, bubbles: true,
    }));

    expect(streamClient.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'click', x: 640, y: 360 }),
    );

    streamClient.sendInputEvent.mockClear();

    // Click at top-left of overlay (0, 0)
    // Unzoomed: ((0 - (-640)) / 2, (0 - (-360)) / 2) = (320, 180)
    // → maps to remote viewport (320, 180) — quarter point
    el.dispatchEvent(new MouseEvent('click', {
      clientX: 0, clientY: 0, button: 0, bubbles: true,
    }));

    expect(streamClient.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'click', x: 320, y: 180 }),
    );

    overlay.destroy();
  });

  it('should return null for clicks in letterbox area when zoomed', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const el = container.querySelector('.input-overlay') as HTMLElement;
    // Container is square — will letterbox the 16:9 viewport
    el.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 720, height: 720,
      bottom: 720, right: 720, x: 0, y: 0,
      toJSON: () => {},
    });

    // No zoom — click in letterbox area (top of container, above rendered area)
    // scale = min(720/1280, 720/720) = 0.5625
    // renderedHeight = 720 * 0.5625 = 405, offsetY = (720 - 405)/2 = 157.5
    // Click at y=0 → localY=0 < offsetY=157.5 → null (letterbox)
    el.dispatchEvent(new MouseEvent('click', {
      clientX: 360, clientY: 0, button: 0, bubbles: true,
    }));

    expect(streamClient.sendInputEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'click' }),
    );

    overlay.destroy();
  });

  it('should reset zoom adjustment when setCanvasZoom called with scale=1', () => {
    const overlay = new InputOverlay(container, streamClient, {
      viewportWidth: 1280,
      viewportHeight: 720,
    });

    const el = container.querySelector('.input-overlay') as HTMLElement;
    el.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 1280, height: 720,
      bottom: 720, right: 1280, x: 0, y: 0,
      toJSON: () => {},
    });

    // Set zoom then reset
    overlay.setCanvasZoom({ scale: 2, panX: -640, panY: -360 });
    overlay.setCanvasZoom({ scale: 1, panX: 0, panY: 0 });

    // Click at center — should map to center without zoom adjustment
    el.dispatchEvent(new MouseEvent('click', {
      clientX: 640, clientY: 360, button: 0, bubbles: true,
    }));

    expect(streamClient.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'click', x: 640, y: 360 }),
    );

    overlay.destroy();
  });
});
