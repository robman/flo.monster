import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NetworkIndicator } from './network-indicator.js';

describe('NetworkIndicator', () => {
  let parent: HTMLElement;
  let indicator: NetworkIndicator;

  beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    indicator = new NetworkIndicator(parent);
  });

  afterEach(() => {
    parent.remove();
  });

  it('should render the indicator in the parent', () => {
    expect(parent.querySelector('.network-indicator')).not.toBeNull();
    expect(parent.querySelector('.network-indicator__icon')).not.toBeNull();
  });

  it('should start with hidden badge', () => {
    const badge = parent.querySelector('.network-indicator__badge') as HTMLElement;
    expect(badge.hidden).toBe(true);
  });

  it('should show badge after recording activity', () => {
    indicator.recordActivity('https://example.com/api');

    const badge = parent.querySelector('.network-indicator__badge') as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1');
  });

  it('should increment count for same origin', () => {
    indicator.recordActivity('https://example.com/api/users');
    indicator.recordActivity('https://example.com/api/posts');

    const badge = parent.querySelector('.network-indicator__badge') as HTMLElement;
    expect(badge.textContent).toBe('2');
  });

  it('should track different origins separately', () => {
    indicator.recordActivity('https://example.com/api');
    indicator.recordActivity('https://other.com/data');

    const badge = parent.querySelector('.network-indicator__badge') as HTMLElement;
    expect(badge.textContent).toBe('2');
  });

  it('should flash the icon on activity', () => {
    indicator.recordActivity('https://example.com/api');

    const icon = parent.querySelector('.network-indicator__icon') as HTMLElement;
    expect(icon.classList.contains('network-indicator__icon--active')).toBe(true);
  });

  it('should show popover on click', () => {
    indicator.recordActivity('https://example.com/api');

    const icon = parent.querySelector('.network-indicator__icon') as HTMLElement;
    icon.click();

    const popover = parent.querySelector('.network-indicator__popover');
    expect(popover).not.toBeNull();

    const title = popover?.querySelector('.network-indicator__popover-title');
    expect(title?.textContent).toContain('1 requests');
  });

  it('should toggle popover on click', () => {
    const icon = parent.querySelector('.network-indicator__icon') as HTMLElement;

    icon.click();
    expect(parent.querySelector('.network-indicator__popover')).not.toBeNull();

    icon.click();
    expect(parent.querySelector('.network-indicator__popover')).toBeNull();
  });

  it('should reset activity tracking', () => {
    indicator.recordActivity('https://example.com/api');
    indicator.reset();

    const badge = parent.querySelector('.network-indicator__badge') as HTMLElement;
    expect(badge.hidden).toBe(true);
  });

  it('should cap badge at 99+', () => {
    for (let i = 0; i < 100; i++) {
      indicator.recordActivity(`https://example.com/api/${i}`);
    }

    const badge = parent.querySelector('.network-indicator__badge') as HTMLElement;
    expect(badge.textContent).toBe('99+');
  });

  it('should show empty message in popover when no activity', () => {
    const icon = parent.querySelector('.network-indicator__icon') as HTMLElement;
    icon.click();

    const empty = parent.querySelector('.network-indicator__popover-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('No network activity');
  });

  it('should show origins in popover rows', () => {
    indicator.recordActivity('https://example.com/api/users');
    indicator.recordActivity('https://other.com/data');

    const icon = parent.querySelector('.network-indicator__icon') as HTMLElement;
    icon.click();

    const rows = parent.querySelectorAll('.network-indicator__popover-row');
    expect(rows.length).toBe(2);
  });

  it('should close popover on reset', () => {
    indicator.recordActivity('https://example.com/api');

    const icon = parent.querySelector('.network-indicator__icon') as HTMLElement;
    icon.click();
    expect(parent.querySelector('.network-indicator__popover')).not.toBeNull();

    indicator.reset();
    expect(parent.querySelector('.network-indicator__popover')).toBeNull();
  });

  it('should return the container element via getElement', () => {
    const el = indicator.getElement();
    expect(el.className).toBe('network-indicator');
    expect(parent.contains(el)).toBe(true);
  });

  it('should handle invalid URLs gracefully', () => {
    indicator.recordActivity('not-a-valid-url');

    const badge = parent.querySelector('.network-indicator__badge') as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1');
  });
});
