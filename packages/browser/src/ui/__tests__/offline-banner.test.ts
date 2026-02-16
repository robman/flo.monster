import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OfflineBanner } from '../offline-banner.js';

describe('OfflineBanner', () => {
  let parent: HTMLElement;
  let banner: OfflineBanner;

  beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    // Default to online
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
  });

  afterEach(() => {
    banner?.destroy();
    parent.remove();
  });

  it('creates banner element as first child of parent', () => {
    const existingChild = document.createElement('div');
    parent.appendChild(existingChild);
    banner = new OfflineBanner(parent);
    expect(parent.firstChild).toBe(banner.getElement());
  });

  it('is hidden when online', () => {
    banner = new OfflineBanner(parent);
    expect(banner.getElement().style.display).toBe('none');
  });

  it('shows when offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
    banner = new OfflineBanner(parent);
    expect(banner.getElement().style.display).toBe('flex');
  });

  it('has correct text', () => {
    banner = new OfflineBanner(parent);
    expect(banner.getElement().textContent).toBe("You're offline");
  });

  it('has offline-banner class', () => {
    banner = new OfflineBanner(parent);
    expect(banner.getElement().className).toBe('offline-banner');
  });

  it('responds to offline event', () => {
    banner = new OfflineBanner(parent);
    expect(banner.getElement().style.display).toBe('none');
    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
    window.dispatchEvent(new Event('offline'));
    expect(banner.getElement().style.display).toBe('flex');
  });

  it('responds to online event', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
    banner = new OfflineBanner(parent);
    expect(banner.getElement().style.display).toBe('flex');
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
    window.dispatchEvent(new Event('online'));
    expect(banner.getElement().style.display).toBe('none');
  });

  it('toggles has-offline-banner class on body', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
    banner = new OfflineBanner(parent);
    expect(document.body.classList.contains('has-offline-banner')).toBe(true);
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
    window.dispatchEvent(new Event('online'));
    expect(document.body.classList.contains('has-offline-banner')).toBe(false);
  });

  it('removes has-offline-banner class on destroy', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
    banner = new OfflineBanner(parent);
    expect(document.body.classList.contains('has-offline-banner')).toBe(true);
    banner.destroy();
    expect(document.body.classList.contains('has-offline-banner')).toBe(false);
  });

  it('destroy() removes element', () => {
    banner = new OfflineBanner(parent);
    banner.destroy();
    expect(parent.querySelector('.offline-banner')).toBeNull();
  });
});
