/**
 * Network activity indicator component for the status bar.
 * Shows a globe icon that flashes on network activity,
 * with a clickable popover showing activity summary.
 */

export interface NetworkActivity {
  origin: string;
  count: number;
  lastAccess: number;
  direction: 'outgoing';
}

export class NetworkIndicator {
  private container: HTMLElement;
  private indicator: HTMLElement;
  private badge: HTMLElement;
  private popover: HTMLElement | null = null;
  private activities = new Map<string, NetworkActivity>();
  private flashTimeout: ReturnType<typeof setTimeout> | null = null;
  private totalRequests = 0;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('span');
    this.container.className = 'network-indicator';
    this.container.title = 'Network activity';

    // Globe icon (using HTML entity)
    this.indicator = document.createElement('span');
    this.indicator.className = 'network-indicator__icon';
    this.indicator.textContent = '\u{1F310}'; // globe with meridians
    this.indicator.addEventListener('click', () => this.togglePopover());
    this.container.appendChild(this.indicator);

    // Activity badge
    this.badge = document.createElement('span');
    this.badge.className = 'network-indicator__badge';
    this.badge.hidden = true;
    this.container.appendChild(this.badge);

    parent.appendChild(this.container);
  }

  /**
   * Record a network activity (called by message relay when fetch occurs).
   */
  recordActivity(url: string): void {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = url;
    }

    const existing = this.activities.get(origin);
    if (existing) {
      existing.count++;
      existing.lastAccess = Date.now();
    } else {
      this.activities.set(origin, {
        origin,
        count: 1,
        lastAccess: Date.now(),
        direction: 'outgoing',
      });
    }

    this.totalRequests++;
    this.flash();
    this.updateBadge();
    this.updatePopover();
  }

  /**
   * Flash the indicator to show activity.
   */
  private flash(): void {
    this.indicator.classList.add('network-indicator__icon--active');

    if (this.flashTimeout) {
      clearTimeout(this.flashTimeout);
    }

    this.flashTimeout = setTimeout(() => {
      this.indicator.classList.remove('network-indicator__icon--active');
      this.flashTimeout = null;
    }, 600);
  }

  private updateBadge(): void {
    if (this.totalRequests > 0) {
      this.badge.textContent = this.totalRequests > 99 ? '99+' : String(this.totalRequests);
      this.badge.hidden = false;
    } else {
      this.badge.hidden = true;
    }
  }

  private togglePopover(): void {
    if (this.popover) {
      this.popover.remove();
      this.popover = null;
      return;
    }
    this.showPopover();
  }

  private showPopover(): void {
    this.popover = document.createElement('div');
    this.popover.className = 'network-indicator__popover';

    const title = document.createElement('div');
    title.className = 'network-indicator__popover-title';
    title.textContent = `Network Activity (${this.totalRequests} requests)`;
    this.popover.appendChild(title);

    if (this.activities.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'network-indicator__popover-empty';
      empty.textContent = 'No network activity yet';
      this.popover.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'network-indicator__popover-list';

      // Sort by most recent
      const sorted = Array.from(this.activities.values())
        .sort((a, b) => b.lastAccess - a.lastAccess);

      for (const activity of sorted) {
        const row = document.createElement('div');
        row.className = 'network-indicator__popover-row';

        const originEl = document.createElement('span');
        originEl.className = 'network-indicator__popover-origin';
        originEl.textContent = activity.origin;

        const countEl = document.createElement('span');
        countEl.className = 'network-indicator__popover-count';
        countEl.textContent = `${activity.count}\u00D7`;

        row.appendChild(originEl);
        row.appendChild(countEl);
        list.appendChild(row);
      }

      this.popover.appendChild(list);
    }

    // Close on click outside
    const closeHandler = (e: MouseEvent) => {
      if (this.popover && !this.popover.contains(e.target as Node) && !this.container.contains(e.target as Node)) {
        this.popover.remove();
        this.popover = null;
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);

    this.container.appendChild(this.popover);
  }

  private updatePopover(): void {
    // If popover is open, refresh it
    if (this.popover) {
      this.popover.remove();
      this.popover = null;
      this.showPopover();
    }
  }

  /**
   * Get the container element.
   */
  getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Reset all activity tracking.
   */
  reset(): void {
    this.activities.clear();
    this.totalRequests = 0;
    this.updateBadge();
    if (this.popover) {
      this.popover.remove();
      this.popover = null;
    }
  }
}
