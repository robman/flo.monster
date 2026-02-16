import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NotificationPanel } from '../notification-panel.js';

describe('NotificationPanel', () => {
  let parent: HTMLElement;
  let panel: NotificationPanel;

  beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    panel = new NotificationPanel(parent);
  });

  afterEach(() => {
    panel.destroy();
    parent.remove();
  });

  it('is hidden when no notifications', () => {
    const el = panel.getElement();
    expect(el.style.display).toBe('none');
  });

  it('shows panel when notification is added', () => {
    panel.add('agent-1', 'Agent One', 'Hello world');
    const el = panel.getElement();
    expect(el.style.display).toBe('');
  });

  it('shows latest notification preview in summary', () => {
    panel.add('agent-1', 'Agent One', 'First message');
    panel.add('agent-2', 'Agent Two', 'Second message');
    const preview = panel.getElement().querySelector('.notification-panel__preview');
    expect(preview?.textContent).toBe('Agent Two: Second message');
  });

  it('shows unread count in bell', () => {
    panel.add('agent-1', 'Agent One', 'msg1');
    panel.add('agent-2', 'Agent Two', 'msg2');
    const bell = panel.getElement().querySelector('.notification-panel__bell');
    // Bell shows bell icon + count
    expect(bell?.textContent).toContain('2');
  });

  it('expands and collapses list on click', () => {
    panel.add('agent-1', 'Agent One', 'Hello');
    const summary = panel.getElement().querySelector('.notification-panel__summary') as HTMLElement;
    const list = panel.getElement().querySelector('.notification-panel__list') as HTMLElement;

    // Initially collapsed
    expect(list.style.display).toBe('none');

    // Click to expand
    summary.click();
    expect(list.style.display).toBe('block');

    // Click to collapse
    summary.click();
    expect(list.style.display).toBe('none');
  });

  it('shows notification items when expanded', () => {
    panel.add('agent-1', 'Agent One', 'First');
    panel.add('agent-2', 'Agent Two', 'Second');

    // Expand
    const summary = panel.getElement().querySelector('.notification-panel__summary') as HTMLElement;
    summary.click();

    const items = panel.getElement().querySelectorAll('.notification-panel__item');
    expect(items.length).toBe(2);

    // Most recent first
    const firstItemName = items[0].querySelector('.notification-panel__item-name');
    expect(firstItemName?.textContent).toBe('Agent Two');
  });

  it('dismiss removes a notification', () => {
    panel.add('agent-1', 'Agent One', 'Hello');
    panel.add('agent-2', 'Agent Two', 'World');

    // Expand to render items
    const summary = panel.getElement().querySelector('.notification-panel__summary') as HTMLElement;
    summary.click();

    // Dismiss the first (most recent) notification
    const dismissBtn = panel.getElement().querySelector('.notification-panel__item-dismiss') as HTMLElement;
    dismissBtn.click();

    // Should have one remaining
    const items = panel.getElement().querySelectorAll('.notification-panel__item');
    expect(items.length).toBe(1);
  });

  it('clearAll removes all notifications', () => {
    panel.add('agent-1', 'Agent One', 'msg1');
    panel.add('agent-2', 'Agent Two', 'msg2');

    panel.clearAll();
    expect(panel.getElement().style.display).toBe('none');
    expect(panel.getUnreadCount()).toBe(0);
  });

  it('clearAll button works from expanded list', () => {
    panel.add('agent-1', 'Agent One', 'msg1');

    // Expand
    const summary = panel.getElement().querySelector('.notification-panel__summary') as HTMLElement;
    summary.click();

    const clearBtn = panel.getElement().querySelector('.notification-panel__clear-all') as HTMLElement;
    clearBtn.click();

    expect(panel.getElement().style.display).toBe('none');
  });

  it('markRead clears unread for specific agent', () => {
    panel.add('agent-1', 'Agent One', 'msg1');
    panel.add('agent-1', 'Agent One', 'msg2');
    panel.add('agent-2', 'Agent Two', 'msg3');

    expect(panel.getUnreadCount()).toBe(3);
    expect(panel.getUnreadCount('agent-1')).toBe(2);

    panel.markRead('agent-1');

    expect(panel.getUnreadCount()).toBe(1);
    expect(panel.getUnreadCount('agent-1')).toBe(0);
    expect(panel.getUnreadCount('agent-2')).toBe(1);
  });

  it('markRead does nothing if already read', () => {
    panel.add('agent-1', 'Agent One', 'msg1');
    panel.markRead('agent-1');
    expect(panel.getUnreadCount('agent-1')).toBe(0);

    // Calling again should not cause issues
    panel.markRead('agent-1');
    expect(panel.getUnreadCount('agent-1')).toBe(0);
  });

  it('badge callback fires with correct counts', () => {
    const callback = vi.fn();
    panel.onBadgeChange(callback);

    panel.add('agent-1', 'Agent One', 'msg1');

    expect(callback).toHaveBeenCalledWith('agent-1', 1);

    panel.add('agent-1', 'Agent One', 'msg2');

    expect(callback).toHaveBeenCalledWith('agent-1', 2);
  });

  it('badge callback reports zero when all read', () => {
    const callback = vi.fn();
    panel.onBadgeChange(callback);

    panel.add('agent-1', 'Agent One', 'msg1');
    callback.mockClear();

    panel.markRead('agent-1');

    expect(callback).toHaveBeenCalledWith('agent-1', 0);
  });

  it('badge callback reports per-agent counts', () => {
    const callback = vi.fn();
    panel.onBadgeChange(callback);

    panel.add('agent-1', 'Agent One', 'msg1');
    panel.add('agent-2', 'Agent Two', 'msg2');

    // After adding agent-2, both agents should get a callback
    expect(callback).toHaveBeenCalledWith('agent-1', 1);
    expect(callback).toHaveBeenCalledWith('agent-2', 1);
  });

  it('auto-prunes old notifications', () => {
    // Mock Date.now to add old notifications
    const realNow = Date.now;
    const oldTimestamp = realNow() - 25 * 60 * 60 * 1000; // 25 hours ago

    Date.now = () => oldTimestamp;
    panel.add('agent-1', 'Agent One', 'Old message');

    Date.now = realNow;
    // Adding a new one triggers prune
    panel.add('agent-2', 'Agent Two', 'New message');

    // Old notification should be pruned
    expect(panel.getUnreadCount()).toBe(1);
    expect(panel.getUnreadCount('agent-1')).toBe(0);
    expect(panel.getUnreadCount('agent-2')).toBe(1);

    Date.now = realNow;
  });

  it('limits to max 50 notifications', () => {
    for (let i = 0; i < 55; i++) {
      panel.add('agent-1', 'Agent One', `Message ${i}`);
    }
    expect(panel.getUnreadCount()).toBe(50);
  });

  it('inserts before specified element', () => {
    const container = document.createElement('div');
    const existingChild = document.createElement('div');
    existingChild.className = 'existing';
    container.appendChild(existingChild);
    document.body.appendChild(container);

    const panelWithInsert = new NotificationPanel(container, existingChild);
    const children = Array.from(container.children);
    expect(children[0]).toBe(panelWithInsert.getElement());
    expect(children[1]).toBe(existingChild);

    panelWithInsert.destroy();
    container.remove();
  });

  it('formats time correctly', () => {
    // We test this indirectly by checking the rendered time labels
    panel.add('agent-1', 'Agent One', 'msg1');

    // Expand to render items
    const summary = panel.getElement().querySelector('.notification-panel__summary') as HTMLElement;
    summary.click();

    const timeEl = panel.getElement().querySelector('.notification-panel__item-time');
    expect(timeEl?.textContent).toBe('just now');
  });

  it('shows muted bell when all notifications are read', () => {
    panel.add('agent-1', 'Agent One', 'msg1');
    panel.markRead('agent-1');

    const bell = panel.getElement().querySelector('.notification-panel__bell');
    // Muted bell (no count)
    expect(bell?.textContent).toBe('\uD83D\uDD15');
  });

  it('unread items have unread class', () => {
    panel.add('agent-1', 'Agent One', 'msg1');

    // Expand
    const summary = panel.getElement().querySelector('.notification-panel__summary') as HTMLElement;
    summary.click();

    const item = panel.getElement().querySelector('.notification-panel__item');
    expect(item?.classList.contains('notification-panel__item--unread')).toBe(true);

    // Mark read and re-render by expanding again
    panel.markRead('agent-1');

    // Re-expand to trigger re-render
    summary.click(); // collapse
    summary.click(); // expand

    const readItem = panel.getElement().querySelector('.notification-panel__item');
    expect(readItem?.classList.contains('notification-panel__item--unread')).toBe(false);
  });

  it('destroy removes element from DOM', () => {
    const el = panel.getElement();
    expect(parent.contains(el)).toBe(true);
    panel.destroy();
    expect(parent.contains(el)).toBe(false);
  });
});
