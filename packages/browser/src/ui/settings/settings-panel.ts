/**
 * Settings panel - main coordinator
 */

import type { PersistenceLayer, AppSettings } from '../../shell/persistence.js';
import type { ExtensionLoader } from '../../shell/extension-loader.js';
import type { ExtensionConfigStore } from '../../shell/extension-config-store.js';
import type { HubClient } from '../../shell/hub-client.js';
import type { KeyStore } from '../../shell/key-store.js';
import type { HookManager } from '../../shell/hook-manager.js';
import type { SkillManager } from '../../shell/skill-manager.js';
import type { TemplateManager } from '../../shell/template-manager.js';

import { createApiKeySection } from './api-key-section.js';
import { createProxySection } from './proxy-section.js';
import { createModelSection } from './model-section.js';
import { createBudgetSection } from './budget-section.js';
import { createNetworkPolicySection } from './network-policy-section.js';
import { createHubSection, createHubSettingsSection, createWebProxySection, createKeySourceSection } from './hub-section.js';
import { createExtensionsSection } from './extensions-section.js';
import { createDataSection } from './data-section.js';
import { createWebToolRoutingSection } from './web-tool-routing-section.js';
import { createHooksSection } from './hooks-section.js';
import { createSkillsSection } from './skills-section.js';
import { createTemplatesSection } from './templates-section.js';
import { createVersionSection } from './version-section.js';

export class SettingsPanel {
  private container: HTMLElement;
  private panelEl: HTMLElement | null = null;
  private backdropEl: HTMLElement | null = null;
  private _isVisible = false;
  private persistence: PersistenceLayer;
  private extensionLoader: ExtensionLoader;
  private extensionConfigStore?: ExtensionConfigStore;
  private hubClient?: HubClient;
  private keyStore?: KeyStore;
  private hookManager?: HookManager;
  private skillManager?: SkillManager;
  private templateManager?: TemplateManager;
  private onApiKeyChange: (key: string, provider?: string) => void;
  private onApiKeyDelete: (provider?: string, hash?: string) => void;
  private onProxySettingsChange?: (settings: { corsProxyUrl?: string; useBuiltinProxy?: boolean }) => void;
  private onEnablePush?: (hubConnectionId: string) => void;
  private onSwitchToLocalKeys?: () => Promise<void>;

  constructor(container: HTMLElement, deps: {
    persistence: PersistenceLayer;
    extensionLoader: ExtensionLoader;
    extensionConfigStore?: ExtensionConfigStore;
    hubClient?: HubClient;
    keyStore?: KeyStore;
    hookManager?: HookManager;
    skillManager?: SkillManager;
    templateManager?: TemplateManager;
    onApiKeyChange: (key: string, provider?: string) => void;
    onApiKeyDelete: (provider?: string, hash?: string) => void;
    onProxySettingsChange?: (settings: { corsProxyUrl?: string; useBuiltinProxy?: boolean }) => void;
    onEnablePush?: (hubConnectionId: string) => void;
    onSwitchToLocalKeys?: () => Promise<void>;
  }) {
    this.container = container;
    this.persistence = deps.persistence;
    this.extensionLoader = deps.extensionLoader;
    this.extensionConfigStore = deps.extensionConfigStore;
    this.hubClient = deps.hubClient;
    this.keyStore = deps.keyStore;
    this.hookManager = deps.hookManager;
    this.skillManager = deps.skillManager;
    this.templateManager = deps.templateManager;
    this.onApiKeyChange = deps.onApiKeyChange;
    this.onApiKeyDelete = deps.onApiKeyDelete;
    this.onProxySettingsChange = deps.onProxySettingsChange;
    this.onEnablePush = deps.onEnablePush;
    this.onSwitchToLocalKeys = deps.onSwitchToLocalKeys;
  }

  setKeyStore(keyStore: KeyStore): void {
    this.keyStore = keyStore;
  }

  async show(): Promise<void> {
    if (this._isVisible) return;
    this._isVisible = true;

    // Load current settings
    const settings = await this.persistence.getSettings();

    // Create backdrop
    this.backdropEl = document.createElement('div');
    this.backdropEl.className = 'settings-backdrop';
    this.backdropEl.addEventListener('click', () => this.hide());

    // Create panel
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'settings-panel';

    const header = document.createElement('div');
    header.className = 'settings-panel__header';
    header.innerHTML = `
      <h2 class="settings-panel__title">Settings</h2>
      <button class="icon-btn settings-panel__close" aria-label="Close">&times;</button>
    `;
    header.querySelector('.settings-panel__close')!.addEventListener('click', () => this.hide());

    const content = document.createElement('div');
    content.className = 'settings-panel__content';

    // Helper for rerendering
    const rerender = () => {
      this.hide();
      this.show();
    };

    // Section: API Key (open)
    content.appendChild(this.createSection('API Key',
      createApiKeySection(this.keyStore, this.persistence, this.onApiKeyChange, this.onApiKeyDelete), true));

    // Section: Default Model (open)
    content.appendChild(this.createSection('Default Model',
      createModelSection(settings, this.persistence), true));

    // Section: API Proxy
    content.appendChild(this.createSection('API Proxy',
      createProxySection(settings, this.persistence, this.onProxySettingsChange)));

    // Section: Budget
    content.appendChild(this.createSection('Budget',
      createBudgetSection(settings, this.persistence)));

    // Section: Hub Connections
    if (this.hubClient) {
      content.appendChild(this.createSection('Hub Connections',
        createHubSection(this.hubClient, this.container, this.persistence, rerender, this.onSwitchToLocalKeys)));
    }

    // Section: API Key Source (only show if hub with shared providers is connected)
    if (this.hubClient) {
      const keySourceSection = createKeySourceSection(this.hubClient, this.persistence, settings, rerender, this.onSwitchToLocalKeys);
      if (keySourceSection) {
        content.appendChild(keySourceSection);
      }
    }

    // Section: Hub Settings (only show if there's at least one hub connection)
    if (this.hubClient && this.hubClient.getConnections().length > 0) {
      content.appendChild(this.createSection('Hub Settings',
        createHubSettingsSection(settings, this.persistence, this.hubClient, this.onEnablePush)));
    }

    // Section: Web Proxy (only show if there's at least one hub connection)
    if (this.hubClient && this.hubClient.getConnections().length > 0) {
      content.appendChild(this.createSection('Web Proxy',
        createWebProxySection(settings, this.persistence)));
    }

    // Section: Default Network Policy
    content.appendChild(this.createSection('Default Network Policy',
      createNetworkPolicySection(settings, this.persistence)));

    // Section: Web Tool Routing
    content.appendChild(this.createSection('Web Tool Routing',
      createWebToolRoutingSection(settings, this.persistence)));

    // Section: Extensions
    content.appendChild(this.createSection('Extensions',
      createExtensionsSection(settings, this.persistence, this.extensionLoader, rerender, this.extensionConfigStore)));

    // Section: Hooks
    if (this.hookManager) {
      content.appendChild(this.createSection('Hooks',
        createHooksSection(settings, this.persistence, this.hookManager, rerender)));
    }

    // Section: Skills
    if (this.skillManager) {
      content.appendChild(this.createSection('Skills',
        createSkillsSection(settings, this.persistence, this.skillManager, rerender)));
    }

    // Section: Templates
    if (this.templateManager) {
      content.appendChild(this.createSection('Templates',
        createTemplatesSection(settings, this.persistence, this.templateManager, rerender)));
    }

    // Section: Data
    content.appendChild(this.createSection('Data',
      createDataSection(this.persistence)));

    // Section: Version & Updates
    content.appendChild(this.createSection('Version & Updates',
      createVersionSection()));

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

    // Capture element references BEFORE scheduling cleanup
    // This ensures we remove the correct (old) elements even if show() creates new ones
    const panelToRemove = this.panelEl;
    const backdropToRemove = this.backdropEl;

    panelToRemove?.classList.remove('settings-panel--open');
    backdropToRemove?.classList.remove('settings-backdrop--visible');

    // Clear instance references immediately so show() can create fresh elements
    this.panelEl = null;
    this.backdropEl = null;

    // Remove after animation using captured references
    const cleanup = () => {
      panelToRemove?.remove();
      backdropToRemove?.remove();
    };

    // Wait for transition
    if (panelToRemove) {
      panelToRemove.addEventListener('transitionend', cleanup, { once: true });
      // Fallback timeout in case transition doesn't fire
      setTimeout(cleanup, 400);
    } else {
      cleanup();
    }
  }

  isVisible(): boolean {
    return this._isVisible;
  }

  toggle(): void {
    if (this._isVisible) {
      this.hide();
    } else {
      this.show();
    }
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
