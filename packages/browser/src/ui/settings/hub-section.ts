/**
 * Hub settings sections
 */

import type { NetworkPolicy } from '@flo-monster/core';
import type { PersistenceLayer, AppSettings, SavedHubConnection } from '../../shell/persistence.js';
import type { HubClient, HubConnection } from '../../shell/hub-client.js';
import { configureHubMode } from '../../shell/sw-registration.js';
import { createFormField, createEmptyState } from '../dom-helpers.js';

export function createHubSection(
  hubClient: HubClient,
  container: HTMLElement,
  persistence: PersistenceLayer,
  onRerender: () => void,
  onSwitchToLocalKeys?: () => Promise<void>,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-hubs';

  const connections = hubClient.getConnections();

  if (connections.length === 0) {
    el.appendChild(createEmptyState('No hubs connected', 'settings-hubs__empty'));
  } else {
    const list = document.createElement('div');
    list.className = 'settings-hubs__list';

    for (const conn of connections) {
      const item = document.createElement('div');
      item.className = 'settings-hubs__item';

      const info = document.createElement('div');
      info.className = 'settings-hubs__info';

      const nameEl = document.createElement('strong');
      nameEl.textContent = conn.name;
      info.appendChild(nameEl);

      const urlEl = document.createElement('div');
      urlEl.className = 'settings-hubs__url';
      urlEl.textContent = conn.url;
      info.appendChild(urlEl);

      const statusEl = document.createElement('div');
      statusEl.className = 'settings-hubs__status';
      statusEl.textContent = conn.connected
        ? `Connected (${conn.tools.length} tools)`
        : 'Disconnected';
      statusEl.style.color = conn.connected ? '#4ade80' : '#f87171';
      info.appendChild(statusEl);

      const disconnectBtn = document.createElement('button');
      disconnectBtn.className = 'btn settings-hubs__disconnect';
      disconnectBtn.textContent = 'Disconnect';
      disconnectBtn.addEventListener('click', async () => {
        hubClient.disconnect(conn.id);
        // Remove from persistence
        await removeHubConnection(persistence, conn.url);
        // If this specific hub was the API key source, switch to local keys
        if (onSwitchToLocalKeys) {
          const settings = await persistence.getSettings();
          if (settings.apiKeySource === 'hub' && settings.hubForApiKey === conn.id) {
            await onSwitchToLocalKeys();
          }
        }
        // Re-render the panel
        onRerender();
      });

      item.appendChild(info);
      item.appendChild(disconnectBtn);
      list.appendChild(item);
    }
    el.appendChild(list);
  }

  // Add hub button
  const addBtn = document.createElement('button');
  addBtn.className = 'btn settings-hubs__add';
  addBtn.textContent = 'Add Hub';
  addBtn.addEventListener('click', () => {
    showAddHubDialog(container, hubClient, persistence, onRerender);
  });
  el.appendChild(addBtn);

  return el;
}

/**
 * Create a section for selecting the API key source (local vs hub)
 * This is shown when at least one hub with shared providers is connected.
 */
export function createKeySourceSection(
  hubClient: HubClient,
  persistence: PersistenceLayer,
  currentSettings: AppSettings,
  onRerender: () => void,
  onSwitchToLocalKeys?: () => Promise<void>,
): HTMLElement | null {
  const connections = hubClient.getConnections();
  const connectionsWithSharedKeys = connections.filter(
    c => c.connected && c.sharedProviders && c.sharedProviders.length > 0
  );

  if (connectionsWithSharedKeys.length === 0) {
    return null;
  }

  const apiKeySource = currentSettings.apiKeySource || 'local';
  const sharedHub = connectionsWithSharedKeys[0];

  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('h4');
  title.className = 'settings-section__title';
  title.textContent = 'API Key Source';
  section.appendChild(title);

  const options = document.createElement('div');
  options.className = 'key-source-options';

  // Local key option
  const localLabel = document.createElement('label');
  localLabel.className = 'key-source-option';

  const localRadio = document.createElement('input');
  localRadio.type = 'radio';
  localRadio.name = 'key-source';
  localRadio.value = 'local';
  localRadio.checked = apiKeySource !== 'hub';

  const localSpan = document.createElement('span');
  localSpan.textContent = 'Use my own API key';

  localLabel.appendChild(localRadio);
  localLabel.appendChild(localSpan);
  options.appendChild(localLabel);

  // Hub key option
  const hubLabel = document.createElement('label');
  hubLabel.className = 'key-source-option';

  const hubRadio = document.createElement('input');
  hubRadio.type = 'radio';
  hubRadio.name = 'key-source';
  hubRadio.value = 'hub';
  hubRadio.checked = apiKeySource === 'hub';

  const hubSpan = document.createElement('span');
  hubSpan.textContent = `Use hub's shared key (${sharedHub.sharedProviders?.join(', ')})`;

  hubLabel.appendChild(hubRadio);
  hubLabel.appendChild(hubSpan);
  options.appendChild(hubLabel);

  section.appendChild(options);

  // Handle changes
  const handleChange = async (value: 'local' | 'hub') => {
    const settings = await persistence.getSettings();

    if (value === 'hub') {
      settings.apiKeySource = 'hub';
      settings.hubForApiKey = sharedHub.id;

      // Configure SW for hub mode
      try {
        await configureHubMode(true, sharedHub.httpApiUrl, undefined);
      } catch (err) {
        console.warn('[settings] Failed to configure hub mode:', err);
      }
    } else {
      // Switch to local keys — clear hub mode in SW, send local keys, update settings
      if (onSwitchToLocalKeys) {
        try {
          await onSwitchToLocalKeys();
        } catch (err) {
          console.warn('[settings] Failed to switch to local keys:', err);
        }
      } else {
        // Fallback if no callback (shouldn't happen in practice)
        settings.apiKeySource = 'local';
        settings.hubForApiKey = undefined;
        try {
          await configureHubMode(false);
        } catch (err) {
          console.warn('[settings] Failed to disable hub mode:', err);
        }
        await persistence.saveSettings(settings);
      }
    }

    if (value === 'hub') {
      await persistence.saveSettings(settings);
    }
    onRerender();
  };

  localRadio.addEventListener('change', () => {
    if (localRadio.checked) {
      handleChange('local');
    }
  });

  hubRadio.addEventListener('change', () => {
    if (hubRadio.checked) {
      handleChange('hub');
    }
  });

  return section;
}

export function createHubSettingsSection(
  settings: AppSettings,
  persistence: PersistenceLayer,
  hubClient?: HubClient,
  onEnablePush?: (hubConnectionId: string) => void,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-hub-settings';

  // Default sandbox path
  const { field: sandboxField, input: sandboxInput } = createFormField({
    label: 'Default Sandbox Path',
    type: 'input',
    className: 'settings-hub-settings__sandbox-path',
    placeholder: '(uses hub default)',
    value: settings.defaultHubSandboxPath || '',
  });

  const sandboxHelp = document.createElement('div');
  sandboxHelp.className = 'settings-hub-settings__help';
  sandboxHelp.textContent = 'Default working directory for hub tools (can be overridden per-agent)';
  sandboxField.appendChild(sandboxHelp);

  // Save handler
  sandboxInput.addEventListener('change', async () => {
    const current = await persistence.getSettings();
    current.defaultHubSandboxPath = sandboxInput.value.trim() || undefined;
    await persistence.saveSettings(current);
  });

  el.appendChild(sandboxField);

  // Push notifications
  if (hubClient && onEnablePush) {
    const connections = hubClient.getConnections();
    if (connections.length > 0) {
      const pushField = document.createElement('div');
      pushField.className = 'settings-hub-settings__push';

      const pushLabel = document.createElement('div');
      pushLabel.className = 'settings-hub-settings__push-label';
      pushLabel.textContent = 'Push Notifications';
      pushField.appendChild(pushLabel);

      const pushHelp = document.createElement('div');
      pushHelp.className = 'settings-hub-settings__help';
      pushHelp.textContent = 'Receive notifications when agents need attention and no browser window is active.';
      pushField.appendChild(pushHelp);

      // Check capabilities before showing the button
      const hasPushApi = 'PushManager' in window && 'Notification' in window && 'serviceWorker' in navigator;
      const vapidKey = hubClient.getVapidKey(connections[0].id);
      const permissionDenied = hasPushApi && Notification.permission === 'denied';

      if (!hasPushApi) {
        const hint = document.createElement('div');
        hint.className = 'settings-hub-settings__push-hint';
        hint.textContent = 'Push notifications are not supported in this browser. Try installing the app or using a different browser.';
        pushField.appendChild(hint);
      } else if (!vapidKey) {
        const hint = document.createElement('div');
        hint.className = 'settings-hub-settings__push-hint';
        hint.textContent = 'Push notifications are not enabled on this hub. Set vapidEmail in hub.json and restart the hub.';
        pushField.appendChild(hint);
      } else if (permissionDenied) {
        const hint = document.createElement('div');
        hint.className = 'settings-hub-settings__push-hint';
        hint.textContent = 'Notifications are blocked. Check your browser notification settings for this site.';
        pushField.appendChild(hint);
      } else {
        const pushBtn = document.createElement('button');
        pushBtn.className = 'btn btn--primary settings-hub-settings__push-btn';
        pushBtn.textContent = 'Enable Notifications';
        pushBtn.addEventListener('click', () => {
          onEnablePush(connections[0].id);
        });
        pushField.appendChild(pushBtn);
      }

      el.appendChild(pushField);
    }
  }

  return el;
}

export function showAddHubDialog(
  container: HTMLElement,
  hubClient: HubClient,
  persistence: PersistenceLayer,
  onRerender: () => void,
): void {
  // Create a simple dialog for adding a hub
  const overlay = document.createElement('div');
  overlay.className = 'settings-hubs__dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'settings-hubs__dialog';

  dialog.innerHTML = `
    <h3>Add Hub Connection</h3>
    <div class="form-field">
      <label class="form-field__label">Hub URL</label>
      <input type="url" class="form-field__input" id="hub-url" placeholder="ws://127.0.0.1:8765">
    </div>
    <div class="form-field">
      <label class="form-field__label">Name</label>
      <input type="text" class="form-field__input" id="hub-name" placeholder="My Hub">
    </div>
    <div class="form-field">
      <label class="form-field__label">Auth Token (optional for localhost)</label>
      <input type="password" class="form-field__input" id="hub-token" placeholder="Leave empty for localhost">
    </div>
    <div class="settings-hubs__dialog-error" id="hub-error" style="display: none;"></div>
    <div class="settings-hubs__dialog-actions">
      <button class="btn" id="hub-cancel">Cancel</button>
      <button class="btn btn--primary" id="hub-connect">Connect</button>
    </div>
  `;

  overlay.appendChild(dialog);
  container.appendChild(overlay);

  const urlInput = dialog.querySelector('#hub-url') as HTMLInputElement;
  const nameInput = dialog.querySelector('#hub-name') as HTMLInputElement;
  const tokenInput = dialog.querySelector('#hub-token') as HTMLInputElement;
  const errorEl = dialog.querySelector('#hub-error') as HTMLElement;
  const cancelBtn = dialog.querySelector('#hub-cancel') as HTMLButtonElement;
  const connectBtn = dialog.querySelector('#hub-connect') as HTMLButtonElement;

  const closeDialog = () => {
    overlay.remove();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  cancelBtn.addEventListener('click', closeDialog);

  connectBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    const name = nameInput.value.trim() || 'Hub';
    const token = tokenInput.value.trim() || undefined;

    if (!url) {
      errorEl.textContent = 'URL is required';
      errorEl.style.display = 'block';
      return;
    }

    // Validate URL format
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      errorEl.textContent = 'URL must start with ws:// or wss://';
      errorEl.style.display = 'block';
      return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';
    errorEl.style.display = 'none';

    try {
      await hubClient.connect(url, name, token);
      // Save to persistence
      await saveHubConnection(persistence, { url, name, token });
      closeDialog();
      // Re-render the panel to show new connection
      onRerender();
    } catch (err) {
      errorEl.textContent = 'Connection failed: ' + String(err);
      errorEl.style.display = 'block';
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect';
    }
  });
}

export function createWebProxySection(
  settings: AppSettings,
  persistence: PersistenceLayer,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-web-proxy';

  const policy = settings.defaultNetworkPolicy || { mode: 'allow-all' as const };

  // Toggle: Enable hub proxy routing
  const toggleField = document.createElement('div');
  toggleField.className = 'settings-web-proxy__toggle-field';

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'settings-web-proxy__toggle-label';
  toggleLabel.textContent = 'Enable hub proxy routing';

  const toggle = document.createElement('label');
  toggle.className = 'settings-toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'settings-web-proxy__enabled-checkbox';
  checkbox.checked = policy.useHubProxy === true;
  const slider = document.createElement('span');
  slider.className = 'settings-toggle__slider';
  toggle.appendChild(checkbox);
  toggle.appendChild(slider);

  toggleField.appendChild(toggleLabel);
  toggleField.appendChild(toggle);

  // Textarea: Proxy patterns
  const { field: patternsField, input: patternsTextarea } = createFormField({
    label: 'Proxy patterns (glob format, one per line)',
    type: 'textarea',
    className: 'settings-web-proxy__patterns',
    wrapperClassName: 'settings-web-proxy__patterns-field',
    rows: 4,
    placeholder: 'https://api.example.com/*\nhttps://*.internal.corp/*',
    value: (policy.hubProxyPatterns || []).join('\n'),
  });

  // Help text
  const helpText = document.createElement('div');
  helpText.className = 'settings-web-proxy__help';
  helpText.textContent = 'URLs matching these patterns will be routed through the hub proxy. Use * as a wildcard.';
  patternsField.appendChild(helpText);

  // Show/hide patterns based on toggle
  const updatePatternsVisibility = () => {
    if (checkbox.checked) {
      patternsField.style.display = 'block';
    } else {
      patternsField.style.display = 'none';
    }
  };

  updatePatternsVisibility();

  // Save handler
  const saveWebProxy = async () => {
    const current = await persistence.getSettings();
    const currentPolicy = current.defaultNetworkPolicy || { mode: 'allow-all' as const };

    const patterns = patternsTextarea.value
      .split('\n')
      .map(p => p.trim())
      .filter(p => p.length > 0);

    const newPolicy: NetworkPolicy = {
      ...currentPolicy,
      useHubProxy: checkbox.checked,
      hubProxyPatterns: patterns.length > 0 ? patterns : undefined,
    };

    current.defaultNetworkPolicy = newPolicy;
    await persistence.saveSettings(current);
  };

  checkbox.addEventListener('change', () => {
    updatePatternsVisibility();
    saveWebProxy();
  });
  patternsTextarea.addEventListener('blur', saveWebProxy);

  el.appendChild(toggleField);
  el.appendChild(patternsField);
  return el;
}

async function saveHubConnection(
  persistence: PersistenceLayer,
  connection: SavedHubConnection,
): Promise<void> {
  const settings = await persistence.getSettings();
  const connections = settings.hubConnections || [];
  // Check if already exists (by URL)
  const existingIndex = connections.findIndex(c => c.url === connection.url);
  if (existingIndex >= 0) {
    // Update existing
    connections[existingIndex] = connection;
  } else {
    // Add new
    connections.push(connection);
  }
  settings.hubConnections = connections;
  await persistence.saveSettings(settings);
}

async function removeHubConnection(
  persistence: PersistenceLayer,
  url: string,
): Promise<void> {
  const settings = await persistence.getSettings();
  if (settings.hubConnections) {
    settings.hubConnections = settings.hubConnections.filter(c => c.url !== url);
    await persistence.saveSettings(settings);
  }
}
