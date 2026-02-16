/**
 * Model settings section with provider + model selection
 */

import { getModelsForProvider, getAvailableProviders } from '@flo-monster/core';
import type { PersistenceLayer, AppSettings } from '../../shell/persistence.js';
import { populateSelect } from '../dom-helpers.js';

export function createModelSection(
  settings: AppSettings,
  persistence: PersistenceLayer,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'model-section';

  // Provider selector
  const providerLabel = document.createElement('label');
  providerLabel.className = 'form-field__label';
  providerLabel.textContent = 'Provider';
  el.appendChild(providerLabel);

  const providerSelect = document.createElement('select');
  providerSelect.className = 'form-field__select settings-provider-select';

  const providers = getAvailableProviders();
  populateSelect(
    providerSelect,
    providers.map(p => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) })),
    settings.defaultProvider || 'anthropic',
  );
  el.appendChild(providerSelect);

  // Model selector (filtered by provider)
  const modelLabel = document.createElement('label');
  modelLabel.className = 'form-field__label';
  modelLabel.textContent = 'Model';
  el.appendChild(modelLabel);

  const modelSelect = document.createElement('select');
  modelSelect.className = 'form-field__select settings-model-select';

  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.className = 'form-field__input settings-model-input';
  modelInput.placeholder = 'e.g. llama3.2, qwen2.5-coder';
  modelInput.style.display = 'none';

  const ollamaHint = document.createElement('small');
  ollamaHint.className = 'form-field__hint';
  ollamaHint.textContent = 'Requires a model with tool use support. See ollama.com/search?c=tools';
  ollamaHint.style.display = 'none';

  function populateModels(provider: string) {
    if (provider === 'ollama') {
      modelSelect.style.display = 'none';
      modelInput.style.display = '';
      ollamaHint.style.display = '';
      modelInput.value = settings.defaultModel || '';
    } else {
      modelSelect.style.display = '';
      modelInput.style.display = 'none';
      ollamaHint.style.display = 'none';
      const models = getModelsForProvider(provider);
      populateSelect(
        modelSelect,
        models.map(m => ({ value: m.id, label: m.displayName })),
        settings.defaultModel,
      );
      // If no model is selected (provider changed), select first
      if (modelSelect.selectedIndex === -1 && modelSelect.options.length > 0) {
        modelSelect.selectedIndex = 0;
      }
    }
  }

  populateModels(settings.defaultProvider || 'anthropic');
  el.appendChild(modelSelect);
  el.appendChild(modelInput);
  el.appendChild(ollamaHint);

  // Provider change handler
  providerSelect.addEventListener('change', async () => {
    populateModels(providerSelect.value);
    const current = await persistence.getSettings();
    current.defaultProvider = providerSelect.value;
    current.defaultModel = providerSelect.value === 'ollama'
      ? modelInput.value.trim()
      : modelSelect.value;
    await persistence.saveSettings(current);
  });

  // Model change handler (select)
  modelSelect.addEventListener('change', async () => {
    if (modelSelect.style.display === 'none') return;
    const current = await persistence.getSettings();
    current.defaultModel = modelSelect.value;
    await persistence.saveSettings(current);
  });

  // Model change handler (text input for ollama)
  modelInput.addEventListener('change', async () => {
    const current = await persistence.getSettings();
    current.defaultModel = modelInput.value.trim();
    await persistence.saveSettings(current);
  });

  return el;
}
