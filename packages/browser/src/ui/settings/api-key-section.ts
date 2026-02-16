/**
 * API Key settings section
 */

import type { KeyStore, KeyEntry } from '../../shell/key-store.js';
import type { PersistenceLayer } from '../../shell/persistence.js';
import { createEmptyState, populateSelect } from '../dom-helpers.js';

const SUPPORTED_PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'gemini', name: 'Google Gemini' },
];

export function createApiKeySection(
  keyStore: KeyStore | undefined,
  persistence: PersistenceLayer,
  onApiKeyChange: (key: string, provider?: string) => void,
  onApiKeyDelete: (provider?: string, hash?: string) => void,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-api-key';

  // List of existing keys
  const keyList = document.createElement('div');
  keyList.className = 'settings-api-key__list';

  const renderKeyList = () => {
    keyList.innerHTML = '';
    const keys = keyStore?.listKeys() || [];

    if (keys.length === 0) {
      keyList.appendChild(createEmptyState('No API keys configured', 'settings-api-key__empty'));
    } else {
      // Group keys by provider
      const byProvider = new Map<string, KeyEntry[]>();
      for (const key of keys) {
        const list = byProvider.get(key.provider) || [];
        list.push(key);
        byProvider.set(key.provider, list);
      }

      for (const [provider, providerKeys] of byProvider) {
        const providerGroup = document.createElement('div');
        providerGroup.className = 'settings-api-key__provider-group';

        const providerName = SUPPORTED_PROVIDERS.find(p => p.id === provider)?.name || provider;
        const providerHeader = document.createElement('div');
        providerHeader.className = 'settings-api-key__provider-header';
        providerHeader.textContent = providerName;
        providerGroup.appendChild(providerHeader);

        for (const key of providerKeys) {
          const keyItem = document.createElement('div');
          keyItem.className = 'settings-api-key__item';

          const keyInfo = document.createElement('div');
          keyInfo.className = 'settings-api-key__info';

          const keyLabel = document.createElement('span');
          keyLabel.className = 'settings-api-key__label';
          keyLabel.textContent = key.label || 'API Key';
          keyInfo.appendChild(keyLabel);

          const keyHash = document.createElement('span');
          keyHash.className = 'settings-api-key__hash';
          keyHash.textContent = key.hash.substring(0, 8) + '...';
          keyInfo.appendChild(keyHash);

          // Mark default key
          const defaultHash = keyStore?.getDefault(provider);
          if (defaultHash === key.hash) {
            const defaultBadge = document.createElement('span');
            defaultBadge.className = 'settings-api-key__default-badge';
            defaultBadge.textContent = 'default';
            keyInfo.appendChild(defaultBadge);
          }

          const keyActions = document.createElement('div');
          keyActions.className = 'settings-api-key__item-actions';

          // Set as default button (only if not already default)
          if (defaultHash !== key.hash) {
            const setDefaultBtn = document.createElement('button');
            setDefaultBtn.className = 'btn btn--small';
            setDefaultBtn.textContent = 'Set Default';
            setDefaultBtn.addEventListener('click', async () => {
              keyStore?.setDefault(provider, key.hash);
              // Save to persistence
              const settings = await persistence.getSettings();
              settings.keyStoreData = keyStore?.exportEntries();
              await persistence.saveSettings(settings);
              renderKeyList();
            });
            keyActions.appendChild(setDefaultBtn);
          }

          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'btn btn--small settings-api-key__delete';
          deleteBtn.textContent = 'Remove';
          deleteBtn.addEventListener('click', () => {
            if (window.confirm('Remove this API key?')) {
              onApiKeyDelete(provider, key.hash);
              renderKeyList();
            }
          });
          keyActions.appendChild(deleteBtn);

          keyItem.appendChild(keyInfo);
          keyItem.appendChild(keyActions);
          providerGroup.appendChild(keyItem);
        }

        keyList.appendChild(providerGroup);
      }
    }
  };

  renderKeyList();

  // Add new key form
  const addKeyForm = document.createElement('div');
  addKeyForm.className = 'settings-api-key__add-form';

  const providerSelect = document.createElement('select');
  providerSelect.className = 'form-field__select settings-api-key__provider-select';
  populateSelect(
    providerSelect,
    SUPPORTED_PROVIDERS.map(p => ({ value: p.id, label: p.name })),
  );

  const addBtn = document.createElement('button');
  addBtn.className = 'btn settings-api-key__add';
  addBtn.textContent = 'Add Key';
  addBtn.addEventListener('click', () => {
    const provider = providerSelect.value;
    const newKey = window.prompt(`Enter ${SUPPORTED_PROVIDERS.find(p => p.id === provider)?.name || provider} API key:`);
    if (newKey && newKey.trim()) {
      const label = window.prompt('Label for this key (optional):') || undefined;
      onApiKeyChange(newKey.trim(), provider);
      // Re-render after a short delay to allow the key to be added
      setTimeout(renderKeyList, 100);
    }
  });

  addKeyForm.appendChild(providerSelect);
  addKeyForm.appendChild(addBtn);

  // Delete all button
  const deleteAllBtn = document.createElement('button');
  deleteAllBtn.className = 'btn settings-api-key__delete-all';
  deleteAllBtn.textContent = 'Delete All Keys';
  deleteAllBtn.addEventListener('click', () => {
    if (window.confirm('Delete all API keys? You will need to re-enter them.')) {
      onApiKeyDelete();
    }
  });

  el.appendChild(keyList);
  el.appendChild(addKeyForm);
  el.appendChild(deleteAllBtn);
  return el;
}
