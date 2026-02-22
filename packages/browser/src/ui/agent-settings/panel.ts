import type { AgentContainer } from '../../agent/agent-container.js';
import type { HubClient } from '../../shell/hub-client.js';
import { createModelSection } from './model-section.js';
import { createPromptSection } from './prompt-section.js';
import { createToolsSection } from './tools-section.js';
import { createBudgetSection } from './budget-section.js';
import { createNetworkSection } from './network-section.js';
import { createHubSection } from './hub-section.js';
import { createSandboxSection } from './sandbox-section.js';
import { createContextSection } from './context-section.js';

export interface AgentSettingsCallbacks {
  onConfigChange?: (agentId: string, changes: Partial<import('@flo-monster/core').AgentConfig>) => void;
  onRestartAgent?: (agentId: string) => void;
  onResetUsage?: (agentId: string) => void;
}

export class AgentSettingsPanel {
  private container: HTMLElement;
  private panelEl: HTMLElement | null = null;
  private backdropEl: HTMLElement | null = null;
  private _isVisible = false;
  private agent: AgentContainer | null = null;
  private callbacks: AgentSettingsCallbacks;
  private hubClient: HubClient | null = null;

  constructor(container: HTMLElement, callbacks?: AgentSettingsCallbacks) {
    this.container = container;
    this.callbacks = callbacks || {};
  }

  setHubClient(client: HubClient): void {
    this.hubClient = client;
  }

  show(agent: AgentContainer): void {
    if (this._isVisible) return;
    this._isVisible = true;
    this.agent = agent;

    // Create backdrop
    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'settings-backdrop';
    this.backdropEl.addEventListener('click', () => this.hide());

    // Create panel
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'settings-panel';

    const header = document.createElement('div');
    header.className = 'settings-panel__header';

    const title = document.createElement('h2');
    title.className = 'settings-panel__title';
    title.textContent = agent.config.name + ' Settings';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn settings-panel__close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.hide());

    header.appendChild(title);
    header.appendChild(closeBtn);

    const content = document.createElement('div');
    content.className = 'settings-panel__content';

    // Section: Model
    content.appendChild(this.createSection('Model', createModelSection(agent, this.callbacks), true));

    // Section: System Prompt
    content.appendChild(this.createSection('System Prompt', createPromptSection(agent, this.callbacks)));

    // Section: Tools
    content.appendChild(this.createSection('Tools', createToolsSection(agent, this.callbacks, this.hubClient)));

    // Section: Budget
    content.appendChild(this.createSection('Budget', createBudgetSection(agent, this.callbacks, this.callbacks.onResetUsage)));

    // Section: Network Policy
    content.appendChild(this.createSection('Network Policy', createNetworkSection(agent, this.callbacks, this.hubClient)));

    // Section: Hub (only show if hubClient has connections)
    if (this.hubClient && this.hubClient.getConnections().length > 0) {
      content.appendChild(this.createSection('Hub', createHubSection(agent, this.callbacks, this.hubClient)));
    }

    // Section: Context Strategy
    content.appendChild(this.createSection('Context Strategy', createContextSection(agent, this.callbacks)));

    // Section: Sandbox Permissions
    content.appendChild(this.createSection('Sandbox Permissions', createSandboxSection(agent, this.callbacks)));

    this.panelEl.appendChild(header);
    this.panelEl.appendChild(content);

    this.container.appendChild(this.backdropEl);
    this.container.appendChild(this.panelEl);

    // Trigger animation
    requestAnimationFrame(() => {
      this.panelEl?.classList.add('settings-panel--open');
      this.backdropEl?.classList.add('settings-backdrop--visible');
    });
  }

  hide(): void {
    if (!this._isVisible) return;
    this._isVisible = false;

    this.panelEl?.classList.remove('settings-panel--open');
    this.backdropEl?.classList.remove('settings-backdrop--visible');

    const cleanup = () => {
      this.panelEl?.remove();
      this.backdropEl?.remove();
      this.panelEl = null;
      this.backdropEl = null;
    };

    if (this.panelEl) {
      this.panelEl.addEventListener('transitionend', cleanup, { once: true });
      setTimeout(cleanup, 400);
    } else {
      cleanup();
    }
  }

  toggle(agent: AgentContainer): void {
    if (this._isVisible) {
      this.hide();
    } else {
      this.show(agent);
    }
  }

  isVisible(): boolean {
    return this._isVisible;
  }

  private createSection(title: string, content: HTMLElement, open = false): HTMLElement {
    const details = document.createElement('details');
    details.className = 'settings-section';
    if (open) details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'settings-section__title';
    summary.textContent = title;

    details.appendChild(summary);
    details.appendChild(content);
    return details;
  }
}
