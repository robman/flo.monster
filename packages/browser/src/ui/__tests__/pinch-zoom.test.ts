/**
 * Tests for PinchZoomHandler — pinch-zoom gestures on a container element.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PinchZoomHandler } from '../pinch-zoom.js';

// Helper to create touch events in jsdom
function createTouchEvent(type: string, touches: { clientX: number; clientY: number }[]): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as any;
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'changedTouches', { value: touches });
  event.preventDefault = vi.fn();
  event.stopPropagation = vi.fn();
  return event;
}

describe('PinchZoomHandler', () => {
  let container: HTMLElement;
  let target: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    target = document.createElement('div');
    container.appendChild(target);
    document.body.appendChild(container);

    // Mock getBoundingClientRect on the container
    container.getBoundingClientRect = () => ({
      top: 0, left: 0, width: 400, height: 800,
      bottom: 800, right: 400, x: 0, y: 0,
      toJSON: () => {},
    });
  });

  it('constructor creates handler and attaches listeners', () => {
    const addSpy = vi.spyOn(container, 'addEventListener');
    const handler = new PinchZoomHandler(container, target);

    // Should attach touch events + gesture events (7 total)
    const capturedEvents = addSpy.mock.calls.map(c => c[0]);
    expect(capturedEvents).toContain('touchstart');
    expect(capturedEvents).toContain('touchmove');
    expect(capturedEvents).toContain('touchend');
    expect(capturedEvents).toContain('touchcancel');
    expect(capturedEvents).toContain('gesturestart');
    expect(capturedEvents).toContain('gesturechange');
    expect(capturedEvents).toContain('gestureend');

    // All should use capture: true
    for (const call of addSpy.mock.calls) {
      const options = call[2] as AddEventListenerOptions;
      expect(options?.capture).toBe(true);
    }

    handler.destroy();
  });

  it('two-finger touchstart calls preventDefault and stopPropagation', () => {
    const handler = new PinchZoomHandler(container, target);

    const event = createTouchEvent('touchstart', [
      { clientX: 100, clientY: 300 },
      { clientX: 300, clientY: 500 },
    ]);

    container.dispatchEvent(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();

    handler.destroy();
  });

  it('single-finger touchstart does NOT call preventDefault or stopPropagation', () => {
    const handler = new PinchZoomHandler(container, target);

    const event = createTouchEvent('touchstart', [
      { clientX: 200, clientY: 400 },
    ]);

    container.dispatchEvent(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();

    handler.destroy();
  });

  it('pinch out (fingers spread apart) increases scale and applies transform', () => {
    const handler = new PinchZoomHandler(container, target);

    // Start pinch with two fingers 100px apart
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 150, clientY: 400 },
      { clientX: 250, clientY: 400 },
    ]);
    container.dispatchEvent(startEvent);

    // Move fingers 200px apart (double the distance)
    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 100, clientY: 400 },
      { clientX: 300, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent);

    const transform = handler.getTransform();
    expect(transform.scale).toBe(2); // distance doubled -> scale 2x

    // Verify CSS transform is applied
    expect(target.style.transform).toContain('scale(2)');
    expect(target.style.transformOrigin).toBe('0 0');

    handler.destroy();
  });

  it('pinch in (fingers come together) decreases scale', () => {
    const handler = new PinchZoomHandler(container, target);

    // Start pinch with two fingers 200px apart
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 100, clientY: 400 },
      { clientX: 300, clientY: 400 },
    ]);
    container.dispatchEvent(startEvent);

    // First zoom in to 2x
    const moveEvent1 = createTouchEvent('touchmove', [
      { clientX: 0, clientY: 400 },
      { clientX: 400, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent1);
    expect(handler.getTransform().scale).toBe(2);

    // Then bring fingers closer (back to 200px distance -> back to 1x)
    const moveEvent2 = createTouchEvent('touchmove', [
      { clientX: 100, clientY: 400 },
      { clientX: 300, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent2);
    expect(handler.getTransform().scale).toBe(1);

    handler.destroy();
  });

  it('scale is clamped to minScale (1)', () => {
    const handler = new PinchZoomHandler(container, target);

    // Start with fingers 200px apart
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 100, clientY: 400 },
      { clientX: 300, clientY: 400 },
    ]);
    container.dispatchEvent(startEvent);

    // Move fingers to only 50px apart (0.25x ratio) — should clamp to 1
    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 175, clientY: 400 },
      { clientX: 225, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent);

    expect(handler.getTransform().scale).toBe(1);

    handler.destroy();
  });

  it('scale is clamped to maxScale (5)', () => {
    const handler = new PinchZoomHandler(container, target);

    // Start with fingers 20px apart
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 190, clientY: 400 },
      { clientX: 210, clientY: 400 },
    ]);
    container.dispatchEvent(startEvent);

    // Move fingers 400px apart (20x ratio) — should clamp to 5
    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 0, clientY: 400 },
      { clientX: 400, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent);

    expect(handler.getTransform().scale).toBe(5);

    handler.destroy();
  });

  it('snaps to 1x when scale < 1.05 on touchend', () => {
    const handler = new PinchZoomHandler(container, target);

    // Start with fingers 200px apart
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 100, clientY: 400 },
      { clientX: 300, clientY: 400 },
    ]);
    container.dispatchEvent(startEvent);

    // Move to slight zoom (1.04x = 208px apart)
    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 96, clientY: 400 },
      { clientX: 304, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent);

    const scaleBeforeEnd = handler.getTransform().scale;
    expect(scaleBeforeEnd).toBeCloseTo(1.04, 1);

    // End the pinch
    const endEvent = createTouchEvent('touchend', []);
    container.dispatchEvent(endEvent);

    // Should snap to exactly 1
    const transform = handler.getTransform();
    expect(transform.scale).toBe(1);
    expect(transform.panX).toBe(0);
    expect(transform.panY).toBe(0);
    expect(target.style.transform).toBe('');

    handler.destroy();
  });

  it('does NOT snap to 1x when scale >= 1.05 on touchend', () => {
    const handler = new PinchZoomHandler(container, target);

    // Start with fingers 200px apart
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 100, clientY: 400 },
      { clientX: 300, clientY: 400 },
    ]);
    container.dispatchEvent(startEvent);

    // Move to 1.5x zoom (300px apart)
    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 50, clientY: 400 },
      { clientX: 350, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent);

    // End the pinch
    const endEvent = createTouchEvent('touchend', []);
    container.dispatchEvent(endEvent);

    // Should keep the zoom
    expect(handler.getTransform().scale).toBe(1.5);

    handler.destroy();
  });

  it('pan is clamped so content fills container (no empty space)', () => {
    const handler = new PinchZoomHandler(container, target);

    // Start pinch at the far left of container
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 10, clientY: 400 },
      { clientX: 30, clientY: 400 },
    ]);
    container.dispatchEvent(startEvent);

    // Zoom to 2x — this will try to set pan based on pinch midpoint
    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 0, clientY: 400 },
      { clientX: 40, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent);

    const transform = handler.getTransform();
    // With scale=2, panX must be between w*(1-scale)=-400 and 0
    expect(transform.panX).toBeLessThanOrEqual(0);
    expect(transform.panX).toBeGreaterThanOrEqual(-400); // 400 * (1 - 2)
    // panY must be between h*(1-scale)=-800 and 0
    expect(transform.panY).toBeLessThanOrEqual(0);
    expect(transform.panY).toBeGreaterThanOrEqual(-800); // 800 * (1 - 2)

    handler.destroy();
  });

  it('resetZoom() clears transform', () => {
    const handler = new PinchZoomHandler(container, target);

    // Zoom in first
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 150, clientY: 400 },
      { clientX: 250, clientY: 400 },
    ]);
    container.dispatchEvent(startEvent);

    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 50, clientY: 400 },
      { clientX: 350, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent);

    expect(handler.getTransform().scale).toBeGreaterThan(1);

    // Reset
    handler.resetZoom();

    const transform = handler.getTransform();
    expect(transform.scale).toBe(1);
    expect(transform.panX).toBe(0);
    expect(transform.panY).toBe(0);
    expect(target.style.transform).toBe('');

    handler.destroy();
  });

  it('destroy() removes event listeners and clears transform', () => {
    const removeSpy = vi.spyOn(container, 'removeEventListener');
    const handler = new PinchZoomHandler(container, target);

    // Apply a transform first
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 150, clientY: 400 },
      { clientX: 250, clientY: 400 },
    ]);
    container.dispatchEvent(startEvent);

    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 50, clientY: 400 },
      { clientX: 350, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent);

    expect(target.style.transform).not.toBe('');

    handler.destroy();

    // Transform should be cleared
    expect(target.style.transform).toBe('');
    expect(target.style.transformOrigin).toBe('');

    // All 7 listeners should be removed with capture: true
    const removedEvents = removeSpy.mock.calls.map(c => c[0]);
    expect(removedEvents).toContain('touchstart');
    expect(removedEvents).toContain('touchmove');
    expect(removedEvents).toContain('touchend');
    expect(removedEvents).toContain('touchcancel');
    expect(removedEvents).toContain('gesturestart');
    expect(removedEvents).toContain('gesturechange');
    expect(removedEvents).toContain('gestureend');

    for (const call of removeSpy.mock.calls) {
      const options = call[2] as AddEventListenerOptions;
      expect(options?.capture).toBe(true);
    }

    // After destroy, touch events should not change target
    target.style.transform = '';
    const event2 = createTouchEvent('touchstart', [
      { clientX: 100, clientY: 300 },
      { clientX: 300, clientY: 500 },
    ]);
    container.dispatchEvent(event2);
    // Since listeners are removed, no-op
    expect(target.style.transform).toBe('');
  });

  it('onChange callback fires with correct transform values', () => {
    const onChange = vi.fn();
    const handler = new PinchZoomHandler(container, target, onChange);

    // Start pinch
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 150, clientY: 400 },
      { clientX: 250, clientY: 400 },
    ]);
    container.dispatchEvent(startEvent);

    // Zoom to 2x
    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 100, clientY: 400 },
      { clientX: 300, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent);

    expect(onChange).toHaveBeenCalledTimes(1);
    const callArg = onChange.mock.calls[0][0];
    expect(callArg.scale).toBe(2);
    expect(typeof callArg.panX).toBe('number');
    expect(typeof callArg.panY).toBe('number');

    handler.destroy();
  });

  it('onChange fires on resetZoom()', () => {
    const onChange = vi.fn();
    const handler = new PinchZoomHandler(container, target, onChange);

    handler.resetZoom();

    expect(onChange).toHaveBeenCalledWith({ scale: 1, panX: 0, panY: 0 });

    handler.destroy();
  });

  it('pan calculation keeps content point under pinch midpoint stable', () => {
    const handler = new PinchZoomHandler(container, target);

    // Start with fingers at (100,300) and (300,500), midpoint=(200,400)
    // Initial distance = sqrt(200^2 + 200^2) = sqrt(80000) ~= 282.84
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 100, clientY: 300 },
      { clientX: 300, clientY: 500 },
    ]);
    container.dispatchEvent(startEvent);

    // Move fingers to (50,250) and (350,550) — midpoint stays at (200,400)
    // New distance = sqrt(300^2 + 300^2) = sqrt(180000) ~= 424.26
    // Scale ratio = 424.26 / 282.84 = 1.5
    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 50, clientY: 250 },
      { clientX: 350, clientY: 550 },
    ]);
    container.dispatchEvent(moveEvent);

    const transform = handler.getTransform();

    // Scale should be 1.5
    expect(transform.scale).toBeCloseTo(1.5, 5);

    // The content point originally at screen (200,400) should still be at (200,400)
    // Content point = (screenMid - pan) / scale
    // For the midpoint to be stable: contentPoint * newScale + newPan = screenMid
    // => newPan = screenMid - contentPoint * newScale
    // contentPoint = (200 - 0) / 1 = 200 (at initial scale=1, pan=0)
    // Expected panX = 200 - 200 * 1.5 = -100
    // Expected panY = 400 - 400 * 1.5 = -200
    // But pan is clamped: panX >= 400*(1-1.5)=-200, panY >= 800*(1-1.5)=-400
    // panX=-100 is within [-200, 0], panY=-200 is within [-400, 0] — no clamping
    expect(transform.panX).toBeCloseTo(-100, 5);
    expect(transform.panY).toBeCloseTo(-200, 5);

    // Verify: content point (200,400) maps to screen (200,400):
    // screenX = contentX * scale + panX = 200 * 1.5 + (-100) = 200
    // screenY = contentY * scale + panY = 400 * 1.5 + (-200) = 400
    const screenX = 200 * transform.scale + transform.panX;
    const screenY = 400 * transform.scale + transform.panY;
    expect(screenX).toBeCloseTo(200, 5);
    expect(screenY).toBeCloseTo(400, 5);

    handler.destroy();
  });

  it('touchmove with single finger does not interfere when not pinching', () => {
    const handler = new PinchZoomHandler(container, target);

    // Single-finger touchmove (no pinch started)
    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 200, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent);

    expect(moveEvent.preventDefault).not.toHaveBeenCalled();
    expect(moveEvent.stopPropagation).not.toHaveBeenCalled();

    handler.destroy();
  });

  it('touchend with single finger does not interfere when not pinching', () => {
    const handler = new PinchZoomHandler(container, target);

    // Single-finger touchend (no pinch started)
    const endEvent = createTouchEvent('touchend', []);
    container.dispatchEvent(endEvent);

    expect(endEvent.preventDefault).not.toHaveBeenCalled();
    expect(endEvent.stopPropagation).not.toHaveBeenCalled();

    handler.destroy();
  });

  it('touchcancel ends the pinch', () => {
    const handler = new PinchZoomHandler(container, target);

    // Start pinch
    const startEvent = createTouchEvent('touchstart', [
      { clientX: 150, clientY: 400 },
      { clientX: 250, clientY: 400 },
    ]);
    container.dispatchEvent(startEvent);

    // Zoom in
    const moveEvent = createTouchEvent('touchmove', [
      { clientX: 50, clientY: 400 },
      { clientX: 350, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent);
    expect(handler.getTransform().scale).toBeGreaterThan(1);

    // Cancel with 0 touches — should end pinch
    const cancelEvent = createTouchEvent('touchcancel', []);
    container.dispatchEvent(cancelEvent);

    // After cancel, further moves should not change anything
    const scale = handler.getTransform().scale;
    const moveEvent2 = createTouchEvent('touchmove', [
      { clientX: 0, clientY: 400 },
      { clientX: 400, clientY: 400 },
    ]);
    container.dispatchEvent(moveEvent2);
    expect(handler.getTransform().scale).toBe(scale);

    handler.destroy();
  });

  it('getTransform() returns initial state before any interaction', () => {
    const handler = new PinchZoomHandler(container, target);

    const transform = handler.getTransform();
    expect(transform).toEqual({ scale: 1, panX: 0, panY: 0 });

    handler.destroy();
  });

  it('sequential pinch gestures accumulate scale correctly', () => {
    const handler = new PinchZoomHandler(container, target);

    // First pinch: zoom to 2x
    const start1 = createTouchEvent('touchstart', [
      { clientX: 150, clientY: 400 },
      { clientX: 250, clientY: 400 },
    ]);
    container.dispatchEvent(start1);

    const move1 = createTouchEvent('touchmove', [
      { clientX: 100, clientY: 400 },
      { clientX: 300, clientY: 400 },
    ]);
    container.dispatchEvent(move1);
    expect(handler.getTransform().scale).toBe(2);

    // End first pinch
    const end1 = createTouchEvent('touchend', []);
    container.dispatchEvent(end1);

    // Second pinch: zoom to 2x from current 2x = 4x total
    // Start with fingers 100px apart
    const start2 = createTouchEvent('touchstart', [
      { clientX: 150, clientY: 400 },
      { clientX: 250, clientY: 400 },
    ]);
    container.dispatchEvent(start2);

    // Double the distance
    const move2 = createTouchEvent('touchmove', [
      { clientX: 100, clientY: 400 },
      { clientX: 300, clientY: 400 },
    ]);
    container.dispatchEvent(move2);

    expect(handler.getTransform().scale).toBe(4);

    handler.destroy();
  });
});
