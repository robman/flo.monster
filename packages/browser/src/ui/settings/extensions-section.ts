/**
 * Extensions settings section
 */

import type { PersistenceLayer, AppSettings } from '../../shell/persistence.js';
import type { ExtensionLoader } from '../../shell/extension-loader.js';
import type { ExtensionConfigStore } from '../../shell/extension-config-store.js';
import type { ExtensionConfigField, Extension } from '@flo-monster/core';
import { createEmptyState } from '../dom-helpers.js';

export interface ExtensionsSectionDeps {
  settings: AppSettings;
  persistence: PersistenceLayer;
  extensionLoader: ExtensionLoader;
  configStore?: ExtensionConfigStore;
  onRerender: () => void;
}

/**
 * Show a config dialog for extension installation
 * Returns collected config values or null if cancelled
 */
function showConfigDialog(
  extension: Extension,
  configFields: Record<string, ExtensionConfigField>,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    // Create backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'extension-config-dialog';

    const title = document.createElement('h3');
    title.className = 'extension-config-dialog__title';
    title.textContent = `Configure ${extension.name}`;
    dialog.appendChild(title);

    if (extension.description) {
      const desc = document.createElement('p');
      desc.className = 'extension-config-dialog__desc';
      desc.textContent = extension.description;
      dialog.appendChild(desc);
    }

    // Create form
    const form = document.createElement('form');
    form.className = 'extension-config-dialog__form';

    const fieldInputs: Record<string, HTMLInputElement> = {};

    for (const [key, field] of Object.entries(configFields)) {
      const fieldWrapper = document.createElement('div');
      fieldWrapper.className = 'form-field';

      const label = document.createElement('label');
      label.className = 'form-field__label';
      label.textContent = field.label + (field.required ? ' *' : '');
      fieldWrapper.appendChild(label);

      if (field.description) {
        const hint = document.createElement('span');
        hint.className = 'form-field__hint';
        hint.textContent = field.description;
        fieldWrapper.appendChild(hint);
      }

      const input = document.createElement('input');
      input.className = 'form-field__input';
      input.name = key;

      switch (field.type) {
        case 'secret':
          input.type = 'password';
          input.placeholder = 'Enter secret value...';
          break;
        case 'number':
          input.type = 'number';
          if (field.default !== undefined) input.value = String(field.default);
          break;
        case 'boolean':
          input.type = 'checkbox';
          if (field.default) input.checked = true;
          break;
        default:
          input.type = 'text';
          if (field.default !== undefined) input.value = String(field.default);
      }

      if (field.required) {
        input.required = true;
      }

      fieldWrapper.appendChild(input);
      form.appendChild(fieldWrapper);
      fieldInputs[key] = input;
    }

    dialog.appendChild(form);

    // Error display
    const errorEl = document.createElement('div');
    errorEl.className = 'extension-config-dialog__error';
    errorEl.hidden = true;
    dialog.appendChild(errorEl);

    // Buttons
    const buttons = document.createElement('div');
    buttons.className = 'extension-config-dialog__buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      backdrop.remove();
      resolve(null);
    });

    const installBtn = document.createElement('button');
    installBtn.type = 'submit';
    installBtn.className = 'btn btn--primary';
    installBtn.textContent = 'Install';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(installBtn);
    dialog.appendChild(buttons);

    // Form submission
    form.addEventListener('submit', (e) => {
      e.preventDefault();

      // Validate required fields
      const values: Record<string, unknown> = {};
      let hasError = false;

      for (const [key, field] of Object.entries(configFields)) {
        const input = fieldInputs[key];

        if (field.type === 'boolean') {
          values[key] = input.checked;
        } else if (field.type === 'number') {
          values[key] = input.value ? Number(input.value) : undefined;
        } else {
          values[key] = input.value || undefined;
        }

        if (field.required && !values[key] && values[key] !== 0 && values[key] !== false) {
          hasError = true;
          errorEl.textContent = `${field.label} is required`;
          errorEl.hidden = false;
          input.focus();
          return;
        }
      }

      if (!hasError) {
        backdrop.remove();
        resolve(values);
      }
    });

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    // Focus first input
    const firstInput = Object.values(fieldInputs)[0];
    if (firstInput) firstInput.focus();
  });
}

export function createExtensionsSection(
  settings: AppSettings,
  persistence: PersistenceLayer,
  extensionLoader: ExtensionLoader,
  onRerender: () => void,
  configStore?: ExtensionConfigStore,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-extensions';

  const loaded = extensionLoader.getLoaded();

  if (loaded.length === 0) {
    el.appendChild(createEmptyState('No extensions loaded', 'settings-extensions__empty'));
  } else {
    const list = document.createElement('div');
    list.className = 'settings-extensions__list';

    for (const ext of loaded) {
      const item = document.createElement('div');
      item.className = 'settings-extensions__item';

      const info = document.createElement('div');
      info.className = 'settings-extensions__info';
      const nameStrong = document.createElement('strong');
      nameStrong.textContent = ext.name;
      const versionSpan = document.createElement('span');
      versionSpan.className = 'settings-extensions__version';
      versionSpan.textContent = `v${ext.version}`;
      info.appendChild(nameStrong);
      info.appendChild(document.createTextNode(' '));
      info.appendChild(versionSpan);
      if (ext.description) {
        const desc = document.createElement('div');
        desc.className = 'settings-extensions__desc';
        desc.textContent = ext.description;
        info.appendChild(desc);
      }

      // Config indicator
      if (ext.config && Object.keys(ext.config).length > 0) {
        const configIndicator = document.createElement('span');
        configIndicator.className = 'settings-extensions__config-indicator';
        configIndicator.textContent = '\u2699';
        configIndicator.title = 'This extension has configuration';
        info.appendChild(configIndicator);
      }

      const toggle = document.createElement('label');
      toggle.className = 'settings-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = settings.enabledExtensions.includes(ext.id);
      checkbox.addEventListener('change', async () => {
        const current = await persistence.getSettings();
        if (checkbox.checked) {
          if (!current.enabledExtensions.includes(ext.id)) {
            current.enabledExtensions.push(ext.id);
          }
        } else {
          current.enabledExtensions = current.enabledExtensions.filter(id => id !== ext.id);
        }
        await persistence.saveSettings(current);
      });
      const slider = document.createElement('span');
      slider.className = 'settings-toggle__slider';
      toggle.appendChild(checkbox);
      toggle.appendChild(slider);

      item.appendChild(info);
      item.appendChild(toggle);
      list.appendChild(item);
    }
    el.appendChild(list);
  }

  // Add URL button
  const addBtn = document.createElement('button');
  addBtn.className = 'btn settings-extensions__add';
  addBtn.textContent = 'Add Extension URL';
  addBtn.addEventListener('click', async () => {
    const url = window.prompt('Enter extension URL:');
    if (url && url.trim()) {
      try {
        const extension = await extensionLoader.loadFromUrl({
          id: 'ext-' + Date.now(),
          name: 'Custom Extension',
          version: '0.0.0',
          entryUrl: url.trim(),
        });

        // If extension has config fields, show config dialog
        if (extension.config && Object.keys(extension.config).length > 0 && configStore) {
          const configValues = await showConfigDialog(extension, extension.config);

          if (configValues === null) {
            // User cancelled, unload the extension
            extensionLoader.unload(extension.id);
            return;
          }

          // Determine which fields are secrets
          const secretFields = Object.entries(extension.config)
            .filter(([, field]) => field.type === 'secret')
            .map(([key]) => key);

          // Save config
          await configStore.setConfig(extension.id, configValues, secretFields);
        }

        // Re-render the panel
        onRerender();
      } catch (err) {
        window.alert('Failed to load extension: ' + String(err));
      }
    }
  });
  el.appendChild(addBtn);

  return el;
}
