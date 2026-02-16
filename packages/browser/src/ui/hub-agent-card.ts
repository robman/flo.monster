import type { HubAgentProxy } from '../shell/hub-agent-proxy.js';

export interface HubAgentCardCallbacks {
  onSelect: (hubAgentId: string) => void;
  onPause?: (hubAgentId: string) => void;
  onResume?: (hubAgentId: string) => void;
  onStop?: (hubAgentId: string) => void;
  onKill?: (hubAgentId: string) => void;
  onRestore?: (hubAgentId: string) => void;
}

export class HubAgentCard {
  private element: HTMLElement;
  private nameEl: HTMLElement;
  private locationEl: HTMLElement;
  private stateEl: HTMLElement;
  private costEl: HTMLElement;
  private controlsEl: HTMLElement;
  private proxy: HubAgentProxy;
  private callbacks: HubAgentCardCallbacks;
  private unsubscribe: (() => void) | null = null;
  private _disabled = false;

  constructor(proxy: HubAgentProxy, callbacks: HubAgentCardCallbacks, hubName: string) {
    this.proxy = proxy;
    this.callbacks = callbacks;

    this.element = document.createElement('div');
    this.element.className = 'agent-card agent-card--remote';
    this.element.dataset.hubAgentId = proxy.hubAgentId;

    // Name
    this.nameEl = document.createElement('div');
    this.nameEl.className = 'agent-card__name';
    this.nameEl.textContent = proxy.agentName;

    // Location indicator (always remote)
    this.locationEl = document.createElement('div');
    this.locationEl.className = 'agent-card__location';
    const hubIcon = document.createElement('span');
    hubIcon.className = 'agent-card__hub-icon';
    hubIcon.textContent = '\u2601'; // Cloud icon
    this.locationEl.appendChild(hubIcon);
    this.locationEl.appendChild(document.createTextNode(' ' + hubName));

    // State
    this.stateEl = document.createElement('div');
    this.stateEl.className = 'agent-card__state';
    this.updateState(proxy.state);

    // Cost
    this.costEl = document.createElement('div');
    this.costEl.className = 'agent-card__cost';
    this.costEl.textContent = `$${proxy.totalCost.toFixed(4)}`;

    // Controls
    this.controlsEl = document.createElement('div');
    this.controlsEl.className = 'agent-card__controls';
    this.renderControls(proxy.state);

    // Assemble
    this.element.appendChild(this.nameEl);
    this.element.appendChild(this.locationEl);
    this.element.appendChild(this.stateEl);
    this.element.appendChild(this.costEl);
    this.element.appendChild(this.controlsEl);

    // Card click -> select
    this.element.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.agent-card__controls')) {
        this.callbacks.onSelect(proxy.hubAgentId);
      }
    });

    // Subscribe to proxy events
    this.unsubscribe = proxy.onEvent((event) => {
      if (event.type === 'state_change') {
        const data = event.data as { to: string };
        this.updateState(data.to);
        this.renderControls(data.to);
      }
    });
  }

  getElement(): HTMLElement {
    return this.element;
  }

  updateState(state: string): void {
    const stateColors: Record<string, string> = {
      pending: 'var(--color-text-muted)',
      running: 'var(--color-success)',
      paused: 'var(--color-warning)',
      stopped: 'var(--color-text-muted)',
      error: 'var(--color-error)',
      killed: 'var(--color-text-muted)',
    };

    const stateLabels: Record<string, string> = {
      pending: 'Pending',
      running: 'Running',
      paused: 'Paused',
      stopped: 'Stopped',
      error: 'Error',
      killed: 'Killed',
    };

    const color = stateColors[state] || 'var(--color-text-muted)';
    this.stateEl.textContent = '';
    const dot = document.createElement('span');
    dot.style.color = color;
    dot.textContent = '\u25CF';
    this.stateEl.appendChild(dot);
    this.stateEl.appendChild(document.createTextNode(' ' + (stateLabels[state] || state)));
  }

  updateCost(cost: number): void {
    this.costEl.textContent = `$${cost.toFixed(4)}`;
  }

  private renderControls(state: string): void {
    this.controlsEl.textContent = '';

    const addButton = (label: string, title: string, onClick: () => void, className?: string) => {
      const btn = document.createElement('button');
      btn.className = 'agent-card__control-btn' + (className ? ' ' + className : '');
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      this.controlsEl.appendChild(btn);
    };

    switch (state) {
      case 'running':
        addButton('\u23F8', 'Pause', () => this.callbacks.onPause?.(this.proxy.hubAgentId));
        addButton('\u23F9', 'Stop', () => this.callbacks.onStop?.(this.proxy.hubAgentId));
        addButton('\u2715', 'Kill', () => this.callbacks.onKill?.(this.proxy.hubAgentId), 'agent-card__control-btn--danger');
        break;
      case 'paused':
        addButton('\u25B6', 'Resume', () => this.callbacks.onResume?.(this.proxy.hubAgentId));
        addButton('\u23F9', 'Stop', () => this.callbacks.onStop?.(this.proxy.hubAgentId));
        addButton('\u2715', 'Kill', () => this.callbacks.onKill?.(this.proxy.hubAgentId), 'agent-card__control-btn--danger');
        break;
      case 'stopped':
      case 'killed':
        // No restart for hub agents — only restore locally
        break;
    }

    // Restore button (pull agent back to browser)
    if (this.callbacks.onRestore) {
      addButton('\u2B07', 'Restore Locally', () => this.callbacks.onRestore?.(this.proxy.hubAgentId));
    }

    // Re-apply disabled state after re-rendering controls
    if (this._disabled) {
      const buttons = this.controlsEl.querySelectorAll('button');
      buttons.forEach(btn => {
        (btn as HTMLButtonElement).disabled = true;
      });
    }
  }

  setDisabled(disabled: boolean): void {
    this._disabled = disabled;
    const buttons = this.controlsEl.querySelectorAll('button');
    buttons.forEach(btn => {
      (btn as HTMLButtonElement).disabled = disabled;
    });
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.element.remove();
  }
}
