import { getModelsForProvider, getAvailableProviders } from '@flo-monster/core';
import type { AgentContainer } from '../../agent/agent-container.js';
import type { AgentSettingsCallbacks } from './panel.js';
import { populateSelect } from '../dom-helpers.js';

/**
 * Create the Model section content for the agent settings panel.
 * Contains a provider select + model select (with ollama text input).
 */
export function createModelSection(
  agent: AgentContainer,
  callbacks: AgentSettingsCallbacks,
): HTMLElement {
  const el = document.createElement('div');
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.style.gap = 'var(--spacing-sm)';

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
    agent.config.provider || 'anthropic',
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
      modelInput.value = agent.config.model || '';
    } else {
      modelSelect.style.display = '';
      modelInput.style.display = 'none';
      ollamaHint.style.display = 'none';
      const models = getModelsForProvider(provider);
      populateSelect(
        modelSelect,
        models.map(m => ({ value: m.id, label: m.displayName })),
        agent.config.model,
      );
      if (modelSelect.selectedIndex === -1 && modelSelect.options.length > 0) {
        modelSelect.selectedIndex = 0;
      }
    }
  }

  populateModels(agent.config.provider || 'anthropic');
  el.appendChild(modelSelect);
  el.appendChild(modelInput);
  el.appendChild(ollamaHint);

  // Provider change handler
  providerSelect.addEventListener('change', () => {
    populateModels(providerSelect.value);
    const model = providerSelect.value === 'ollama'
      ? modelInput.value.trim()
      : modelSelect.value;
    const changes = { provider: providerSelect.value, model };
    agent.updateConfig(changes);
    callbacks.onConfigChange?.(agent.id, changes);
  });

  // Model change handler (select)
  modelSelect.addEventListener('change', () => {
    if (modelSelect.style.display === 'none') return;
    const changes = { model: modelSelect.value };
    agent.updateConfig(changes);
    callbacks.onConfigChange?.(agent.id, changes);
  });

  // Model change handler (text input for ollama)
  modelInput.addEventListener('change', () => {
    const changes = { model: modelInput.value.trim() };
    agent.updateConfig(changes);
    callbacks.onConfigChange?.(agent.id, changes);
  });

  return el;
}
