import type { AgentContainer } from '../agent/agent-container.js';
import type { AgentState } from '@flo-monster/core';
import { SaveIndicator, type SaveState } from './save-indicator.js';

export type AgentLocation =
  | { type: 'local' }
  | { type: 'remote'; hubId: string; hubName: string };

export interface AgentCardCallbacks {
  onSelect: (agentId: string) => void;
  onPause?: (agentId: string) => void;
  onResume?: (agentId: string) => void;
  onStop?: (agentId: string) => void;
  onKill?: (agentId: string) => void;
  onRestart?: (agentId: string) => void;
  onClose?: (agentId: string) => void;
  onSettings?: (agentId: string) => void;
  onFiles?: (agentId: string) => void;
  onPersist?: (agentId: string) => void;
  onSaveAsTemplate?: (agentId: string) => void;
}

export class AgentCard {
  private element: HTMLElement;
  private nameEl: HTMLElement;
  private badgeEl: HTMLElement;
  private locationEl: HTMLElement | null = null;
  private stateEl: HTMLElement;
  private costEl: HTMLElement;
  private controlsEl: HTMLElement;
  private agent: AgentContainer;
  private callbacks: AgentCardCallbacks;
  private unsubscribe: (() => void) | null = null;
  private location: AgentLocation = { type: 'local' };
  private saveIndicator: SaveIndicator | null = null;
  private modeToggleEl: HTMLElement | null = null;
  private _disabled = false;

  constructor(agent: AgentContainer, callbacks: AgentCardCallbacks, location?: AgentLocation) {
    this.agent = agent;
    this.callbacks = callbacks;
    this.location = location || { type: 'local' };

    this.element = document.createElement('div');
    this.element.className = 'agent-card';
    this.element.dataset.agentId = agent.id;

    // Apply remote styling if applicable
    if (this.location.type === 'remote') {
      this.element.classList.add('agent-card--remote');
    }

    this.nameEl = document.createElement('div');
    this.nameEl.className = 'agent-card__name';
    this.nameEl.textContent = agent.config.name;

    this.badgeEl = document.createElement('span');
    this.badgeEl.className = 'agent-card__badge';
    this.badgeEl.style.display = 'none';

    // Location indicator for remote agents
    if (this.location.type === 'remote') {
      this.locationEl = document.createElement('div');
      this.locationEl.className = 'agent-card__location';
      const hubIcon = document.createElement('span');
      hubIcon.className = 'agent-card__hub-icon';
      hubIcon.textContent = '\u2601'; // Cloud icon
      this.locationEl.appendChild(hubIcon);
      const hubName = document.createTextNode(' ' + this.location.hubName);
      this.locationEl.appendChild(hubName);
    }

    this.stateEl = document.createElement('div');
    this.stateEl.className = 'agent-card__state';
    this.updateState(agent.state);

    this.costEl = document.createElement('div');
    this.costEl.className = 'agent-card__cost';
    this.costEl.textContent = '$0.00';

    // Save indicator (initially hidden, shown when agent is persisted to hub)
    this.saveIndicator = new SaveIndicator();
    // Hide save indicator by default (shown for hub-persisted agents)
    this.saveIndicator.getElement().style.display = 'none';

    // Controls row
    this.controlsEl = document.createElement('div');
    this.controlsEl.className = 'agent-card__controls';
    this.renderControls(agent.state);

    this.element.appendChild(this.nameEl);
    this.element.appendChild(this.badgeEl);
    if (this.locationEl) {
      this.element.appendChild(this.locationEl);
    }
    this.element.appendChild(this.stateEl);
    this.element.appendChild(this.costEl);
    this.element.appendChild(this.saveIndicator!.getElement());
    this.element.appendChild(this.controlsEl);

    // Card click goes to agent view (but not if a control button was clicked)
    this.element.addEventListener('click', (e) => {
      // Only fire select if the click was NOT on a control button
      if (!(e.target as HTMLElement).closest('.agent-card__controls')) {
        this.callbacks.onSelect(agent.id);
      }
    });

    // Subscribe to state changes
    this.unsubscribe = agent.onEvent((event) => {
      if (event.type === 'state_change') {
        this.updateState(event.to);
        this.renderControls(event.to);
      }
    });
  }

  getElement(): HTMLElement {
    return this.element;
  }

  updateState(state: AgentState): void {
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

  setBadgeCount(count: number): void {
    if (count <= 0) {
      this.badgeEl.style.display = 'none';
      return;
    }
    this.badgeEl.style.display = '';
    this.badgeEl.textContent = count > 9 ? '9+' : String(count);
  }

  private renderControls(state: AgentState): void {
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
        addButton('\u23F8', 'Pause', () => this.callbacks.onPause?.(this.agent.id));
        addButton('\u23F9', 'Stop', () => this.callbacks.onStop?.(this.agent.id));
        addButton('\u2715', 'Kill', () => this.callbacks.onKill?.(this.agent.id), 'agent-card__control-btn--danger');
        break;
      case 'paused':
        addButton('\u25B6', 'Resume', () => this.callbacks.onResume?.(this.agent.id));
        addButton('\u23F9', 'Stop', () => this.callbacks.onStop?.(this.agent.id));
        addButton('\u2715', 'Kill', () => this.callbacks.onKill?.(this.agent.id), 'agent-card__control-btn--danger');
        break;
      case 'stopped':
      case 'killed':
        addButton('\u21BB', 'Restart', () => this.callbacks.onRestart?.(this.agent.id));
        addButton('\uD83D\uDDD1', 'Delete', () => this.callbacks.onClose?.(this.agent.id), 'agent-card__control-btn--danger');
        break;
      case 'error':
        addButton('\u21BB', 'Restart', () => this.callbacks.onRestart?.(this.agent.id));
        addButton('\u2715', 'Kill', () => this.callbacks.onKill?.(this.agent.id), 'agent-card__control-btn--danger');
        break;
    }

    // Always add files and settings buttons (except pending)
    if (state !== 'pending') {
      addButton('\uD83D\uDCC2', 'Files', () => this.callbacks.onFiles?.(this.agent.id));
      addButton('\u2699', 'Settings', () => this.callbacks.onSettings?.(this.agent.id));
      addButton('\uD83D\uDCBE', 'Save as Template', () => this.callbacks.onSaveAsTemplate?.(this.agent.id));
      // Mode toggle: Browser ↔ Hub
      this.renderModeToggle();
    }
    // Re-apply disabled state after re-rendering controls
    if (this._disabled) {
      const buttons = this.controlsEl.querySelectorAll('button');
      buttons.forEach(btn => {
        (btn as HTMLButtonElement).disabled = true;
      });
    }
  }

  private renderModeToggle(): void {
    // Remove previous toggle if present
    if (this.modeToggleEl) {
      this.modeToggleEl.remove();
      this.modeToggleEl = null;
    }

    if (this.location.type === 'local') {
      // Only render if onPersist callback is provided
      if (!this.callbacks.onPersist) return;

      const chip = document.createElement('span');
      chip.className = 'agent-card__mode-toggle agent-card__mode-toggle--browser';
      chip.textContent = '\uD83D\uDDA5'; // 🖥 U+1F5A5
      chip.title = 'Running in browser \u2014 click to persist to hub';
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onPersist?.(this.agent.id);
      });
      this.modeToggleEl = chip;
      this.controlsEl.appendChild(chip);
    } else if (this.location.type === 'remote') {
      const chip = document.createElement('span');
      chip.className = 'agent-card__mode-toggle agent-card__mode-toggle--hub';
      chip.textContent = '\u2601 ' + this.location.hubName;
      chip.title = 'Running on hub: ' + this.location.hubName;
      this.modeToggleEl = chip;
      this.controlsEl.appendChild(chip);
    }
  }

  /**
   * Get the current location of the agent
   */
  getLocation(): AgentLocation {
    return this.location;
  }

  /**
   * Update the location of the agent (e.g., after persisting to a hub)
   */
  setLocation(location: AgentLocation): void {
    this.location = location;

    // Update styling
    if (location.type === 'remote') {
      this.element.classList.add('agent-card--remote');

      // Add or update location element
      if (!this.locationEl) {
        this.locationEl = document.createElement('div');
        this.locationEl.className = 'agent-card__location';
        this.nameEl.after(this.locationEl);
      }
      this.locationEl.textContent = '';
      const hubIcon = document.createElement('span');
      hubIcon.className = 'agent-card__hub-icon';
      hubIcon.textContent = '\u2601';
      this.locationEl.appendChild(hubIcon);
      this.locationEl.appendChild(document.createTextNode(' ' + location.hubName));
    } else {
      this.element.classList.remove('agent-card--remote');
      if (this.locationEl) {
        this.locationEl.remove();
        this.locationEl = null;
      }
    }

    // Re-render controls and mode toggle
    this.renderControls(this.agent.state);
  }

  updateCost(cost: number): void {
    this.costEl.textContent = `$${cost.toFixed(4)}`;
  }

  /**
   * Update the save state indicator
   */
  setSaveState(state: SaveState): void {
    this.saveIndicator?.setState(state);
  }

  /**
   * Show or hide the save indicator
   */
  showSaveIndicator(show: boolean): void {
    if (this.saveIndicator) {
      this.saveIndicator.getElement().style.display = show ? '' : 'none';
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
    this.saveIndicator?.dispose();
    this.saveIndicator = null;
    this.element.remove();
  }
}
