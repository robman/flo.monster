/**
 * Notification panel at the top of the shell.
 * Summary bar shows when notifications exist; expandable list of notifications.
 */

export interface Notification {
  id: string;
  agentId: string;
  agentName: string;
  message: string;
  timestamp: number;
  read: boolean;
}

export type BadgeCallback = (agentId: string, count: number) => void;

export class NotificationPanel {
  private element: HTMLElement;
  private summaryEl: HTMLElement;
  private listEl: HTMLElement;
  private notifications: Notification[] = [];
  private expanded = false;
  private maxNotifications = 50;
  private maxAge = 24 * 60 * 60 * 1000; // 24h
  private badgeCallback: BadgeCallback | null = null;

  constructor(parent: HTMLElement, insertBefore?: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'notification-panel';

    // Summary bar
    this.summaryEl = document.createElement('div');
    this.summaryEl.className = 'notification-panel__summary';
    this.summaryEl.addEventListener('click', () => this.toggle());

    // Expanded list
    this.listEl = document.createElement('div');
    this.listEl.className = 'notification-panel__list';
    this.listEl.style.display = 'none';

    this.element.appendChild(this.summaryEl);
    this.element.appendChild(this.listEl);

    if (insertBefore) {
      parent.insertBefore(this.element, insertBefore);
    } else {
      parent.appendChild(this.element);
    }

    this.render();
  }

  onBadgeChange(callback: BadgeCallback): void {
    this.badgeCallback = callback;
  }

  add(agentId: string, agentName: string, message: string): void {
    // Prune old notifications
    this.prune();

    const notification: Notification = {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      agentId,
      agentName,
      message,
      timestamp: Date.now(),
      read: false,
    };

    this.notifications.unshift(notification);

    // Trim to max
    if (this.notifications.length > this.maxNotifications) {
      this.notifications = this.notifications.slice(0, this.maxNotifications);
    }

    this.render();
    this.updateBadges();
  }

  markRead(agentId: string): void {
    let changed = false;
    for (const n of this.notifications) {
      if (n.agentId === agentId && !n.read) {
        n.read = true;
        changed = true;
      }
    }
    if (changed) {
      this.render();
      this.updateBadges();
    }
  }

  dismiss(notificationId: string): void {
    this.notifications = this.notifications.filter(n => n.id !== notificationId);
    this.render();
    this.updateBadges();
  }

  clearAll(): void {
    this.notifications = [];
    this.expanded = false;
    this.render();
    this.updateBadges();
  }

  getUnreadCount(agentId?: string): number {
    return this.notifications.filter(n =>
      !n.read && (agentId ? n.agentId === agentId : true)
    ).length;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    this.element.remove();
  }

  private toggle(): void {
    this.expanded = !this.expanded;
    this.listEl.style.display = this.expanded ? 'block' : 'none';
    this.render();
  }

  private prune(): void {
    const cutoff = Date.now() - this.maxAge;
    this.notifications = this.notifications.filter(n => n.timestamp > cutoff);
  }

  private updateBadges(): void {
    if (!this.badgeCallback) return;
    // Compute per-agent unread counts
    const counts = new Map<string, number>();
    for (const n of this.notifications) {
      if (!n.read) {
        counts.set(n.agentId, (counts.get(n.agentId) || 0) + 1);
      }
    }
    // Fire callback for each agent that has (or had) notifications
    const allAgentIds = new Set(this.notifications.map(n => n.agentId));
    for (const agentId of allAgentIds) {
      this.badgeCallback(agentId, counts.get(agentId) || 0);
    }
  }

  private render(): void {
    const unread = this.getUnreadCount();

    // Hide panel entirely when empty
    if (this.notifications.length === 0) {
      this.element.style.display = 'none';
      return;
    }
    this.element.style.display = '';

    // Summary bar
    const latest = this.notifications[0];
    const chevron = this.expanded ? '\u25B2' : '\u25BC';
    this.summaryEl.innerHTML = '';

    const bellSpan = document.createElement('span');
    bellSpan.className = 'notification-panel__bell';
    bellSpan.textContent = unread > 0 ? `\uD83D\uDD14 ${unread}` : '\uD83D\uDD15';

    const previewSpan = document.createElement('span');
    previewSpan.className = 'notification-panel__preview';
    previewSpan.textContent = `${latest.agentName}: ${latest.message}`;

    const chevronSpan = document.createElement('span');
    chevronSpan.className = 'notification-panel__chevron';
    chevronSpan.textContent = chevron;

    this.summaryEl.appendChild(bellSpan);
    this.summaryEl.appendChild(previewSpan);
    this.summaryEl.appendChild(chevronSpan);

    // List
    if (this.expanded) {
      this.listEl.innerHTML = '';

      for (const n of this.notifications) {
        const item = document.createElement('div');
        item.className = `notification-panel__item${n.read ? '' : ' notification-panel__item--unread'}`;

        const info = document.createElement('div');
        info.className = 'notification-panel__item-info';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'notification-panel__item-name';
        nameSpan.textContent = n.agentName;

        const timeSpan = document.createElement('span');
        timeSpan.className = 'notification-panel__item-time';
        timeSpan.textContent = this.formatTime(n.timestamp);

        info.appendChild(nameSpan);
        info.appendChild(timeSpan);

        const msgEl = document.createElement('div');
        msgEl.className = 'notification-panel__item-message';
        msgEl.textContent = n.message;

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'notification-panel__item-dismiss';
        dismissBtn.textContent = '\u00d7';
        dismissBtn.setAttribute('aria-label', 'Dismiss');
        dismissBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.dismiss(n.id);
        });

        item.appendChild(info);
        item.appendChild(msgEl);
        item.appendChild(dismissBtn);
        this.listEl.appendChild(item);
      }

      // Clear all link
      if (this.notifications.length > 0) {
        const clearAll = document.createElement('button');
        clearAll.className = 'notification-panel__clear-all';
        clearAll.textContent = 'Clear all';
        clearAll.addEventListener('click', (e) => {
          e.stopPropagation();
          this.clearAll();
        });
        this.listEl.appendChild(clearAll);
      }
    }
  }

  private formatTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(timestamp).toLocaleDateString();
  }
}
