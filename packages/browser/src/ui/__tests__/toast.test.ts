import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToastManager, showToast } from '../toast.js';

describe('ToastManager', () => {
  let manager: ToastManager;

  beforeEach(() => {
    manager = new ToastManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  it('creates a container in document.body', () => {
    const container = document.querySelector('.toast-container');
    expect(container).toBeTruthy();
  });

  it('shows a toast with message', () => {
    manager.show({ message: 'Hello', duration: 0 });
    const toast = document.querySelector('.toast');
    expect(toast).toBeTruthy();
    expect(toast!.querySelector('.toast__text')!.textContent).toBe('Hello');
  });

  it('applies type class', () => {
    manager.show({ message: 'Warn', type: 'warning', duration: 0 });
    expect(document.querySelector('.toast--warning')).toBeTruthy();
  });

  it('applies error type class', () => {
    manager.show({ message: 'Error', type: 'error', duration: 0 });
    expect(document.querySelector('.toast--error')).toBeTruthy();
  });

  it('limits to max 3 toasts', () => {
    manager.show({ message: '1', duration: 0 });
    manager.show({ message: '2', duration: 0 });
    manager.show({ message: '3', duration: 0 });
    manager.show({ message: '4', duration: 0 });
    // Internal array is immediately pruned; DOM removal is async (transitionend)
    expect(manager['toasts'].length).toBeLessThanOrEqual(3);
  });

  it('has dismiss button by default', () => {
    manager.show({ message: 'test', duration: 0 });
    expect(document.querySelector('.toast__close')).toBeTruthy();
  });

  it('hides dismiss button when dismissable is false', () => {
    manager.show({ message: 'test', duration: 0, dismissable: false });
    expect(document.querySelector('.toast__close')).toBeNull();
  });

  it('removes toast on dismiss click', () => {
    manager.show({ message: 'test', duration: 0 });
    const closeBtn = document.querySelector('.toast__close') as HTMLElement;
    closeBtn.click();
    // After removal, should be gone from internal array
    expect(manager['toasts'].length).toBe(0);
  });

  it('auto-removes after duration', () => {
    vi.useFakeTimers();
    manager.show({ message: 'temp', duration: 1000 });
    expect(manager['toasts'].length).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(manager['toasts'].length).toBe(0);
    vi.useRealTimers();
  });

  it('clear() removes all toasts', () => {
    manager.show({ message: '1', duration: 0 });
    manager.show({ message: '2', duration: 0 });
    manager.clear();
    expect(manager['toasts'].length).toBe(0);
  });

  it('destroy() removes container from DOM', () => {
    manager.destroy();
    expect(document.querySelector('.toast-container')).toBeNull();
  });
});

describe('showToast()', () => {
  afterEach(() => {
    // Clean up singleton
    const container = document.querySelector('.toast-container');
    if (container) container.remove();
  });

  it('creates singleton and shows toast', () => {
    const toast = showToast({ message: 'singleton test', duration: 0 });
    expect(toast).toBeTruthy();
    expect(document.querySelector('.toast-container')).toBeTruthy();
  });
});
